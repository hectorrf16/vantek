/**
 * ──────────────────────────────────────────────────────────────────────────────
 * presupuestos.service.ts — Lógica de negocio de presupuestos
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Core of presupuestos: list/get, create, update header, save lines,
 *   autosave borrador, change state (with sync to seguimiento), version
 *   PDFs, delete and export its lines to create a factura. Uses the same
 *   editor as facturas but WITHOUT IVA in the total.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · uuid (v4) → IDs of presupuestos, lines and versions
 *     · @db/connection (getDb) → SQLite handle (transactions)
 *     · @utils/config (getAppConfig) → default IVA, max versions
 *     · ./seguimiento.service (syncSeguimientoDesdeDocumento) → syncs the seguimiento
 *   Used by:
 *     · routes/presupuestos.router.ts → exposes the presupuesto endpoints
 *     · facturas.service.ts → imports exportarLineasParaFactura when creating a factura
 *
 * EXPORTS
 *   · listarPresupuestos(filtros) / obtenerPresupuesto(id) → query
 *   · crearPresupuesto(data) → borrador presupuesto (atomic transaction)
 *   · actualizarPresupuesto(id, {notas?,fecha?}) → edits header
 *   · guardarLineas(id, lineas) → replaces lines; guardarBorrador(id, data)
 *   · cambiarEstado(id, estado) → updates state and syncs the seguimiento
 *   · guardarVersion(id, pdfPath) → permanent version (purges old ones)
 *   · eliminarPresupuesto(id); exportarLineasParaFactura(id)
 *
 * INPUTS / OUTPUTS
 *   Input:  presupuesto and line ids/data; state of the DB; global config
 *   Output: presupuesto rows with totals; INSERT/UPDATE/DELETE
 *
 * NOTES
 *   · Presupuestos do NOT carry IVA in the total (calcularTotales: total = subtotal).
 *   · cliente_direccion comes from a.label (agrupador), not clientes.direccion.
 *   · When moving to 'aceptado'/'enviado', syncSeguimientoDesdeDocumento moves the seguimiento.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@db/connection';
import { getAppConfig } from '@utils/config';
import { totalesDocumento } from '@utils/dinero';
import { hoyISO } from '@utils/fechas';
import { eliminarPdf } from '@services/pdf.service';
import { syncSeguimientoDesdeDocumento } from './seguimiento.service';

// ─── Tipos internos ───────────────────────────────────────────────────────────

export type EstadoPresupuesto =
  | 'borrador'
  | 'enviado'
  | 'aceptado'
  | 'rechazado'
  | 'caducado';

export interface LineaPresupuesto {
  id: string;
  presupuesto_id: string;
  descripcion: string;
  detalle: string | null;
  cantidad: number;
  unidad: string | null;
  precio_unitario: number;
  coste_unitario: number | null;
  margen_porcentaje: number | null;
  tipo: 'material' | 'manual' | 'concepto';
  orden: number;
}

export interface PresupuestoRow {
  id: string;
  trabajo_id: string;
  numero: string | null;
  estado: EstadoPresupuesto;
  fecha: string;
  notas: string | null;
  iva_porcentaje: number;
  borrador_data: string | null;
  borrador_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcularTotales(lineas: LineaPresupuesto[]) {
  // Los presupuestos no llevan IVA en el total (según spec)
  const { subtotal } = totalesDocumento(lineas, 0);
  return { subtotal, total: subtotal };
}

// ─── Listado ──────────────────────────────────────────────────────────────────

export async function listarPresupuestos(filtros: {
  trabajo_id?: string;
  estado?: EstadoPresupuesto;
  cliente_id?: string;
}) {
  const db = getDb();
  const condiciones: string[] = [];
  const params: unknown[] = [];

  if (filtros.trabajo_id) {
    condiciones.push('p.trabajo_id = ?');
    params.push(filtros.trabajo_id);
  }
  if (filtros.estado) {
    condiciones.push('p.estado = ?');
    params.push(filtros.estado);
  }
  if (filtros.cliente_id) {
    condiciones.push('c.id = ?');
    params.push(filtros.cliente_id);
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT
        p.id, p.trabajo_id, p.numero, p.estado, p.fecha, p.notas,
        p.iva_porcentaje, p.created_at, p.updated_at,
        t.nombre AS trabajo_nombre,
        a.id AS agrupador_id, a.label AS agrupador_label,
        c.id AS cliente_id, c.nombre AS cliente_nombre,
        (SELECT COALESCE(SUM(pl.precio_unitario * pl.cantidad), 0)
         FROM presupuesto_lineas pl WHERE pl.presupuesto_id = p.id) AS importe
       FROM presupuestos p
       JOIN trabajos t ON t.id = p.trabajo_id
       JOIN agrupadores a ON a.id = t.agrupador_id
       JOIN clientes c ON c.id = a.cliente_id
       ${where}
       ORDER BY p.fecha DESC, p.created_at DESC`
    )
    .all(...params);

  return rows;
}

// ─── Detalle ──────────────────────────────────────────────────────────────────

export async function obtenerPresupuesto(id: string) {
  const db = getDb();

  const presupuesto = db
    .prepare(
      `SELECT
        p.*,
        t.nombre AS trabajo_nombre, t.margen_porcentaje AS trabajo_margen,
        a.id AS agrupador_id, a.label AS agrupador_label,
        c.id AS cliente_id, c.nombre AS cliente_nombre,
        c.empresa AS cliente_empresa, c.dni_cif AS cliente_dni_cif,
        c.email AS cliente_email,
        a.label AS cliente_direccion
       FROM presupuestos p
       JOIN trabajos t ON t.id = p.trabajo_id
       JOIN agrupadores a ON a.id = t.agrupador_id
       JOIN clientes c ON c.id = a.cliente_id
       WHERE p.id = ?`
    )
    .get(id) as (PresupuestoRow & Record<string, unknown>) | undefined;

  if (!presupuesto) return null;

  const lineas = db
    .prepare(
      `SELECT * FROM presupuesto_lineas
       WHERE presupuesto_id = ?
       ORDER BY orden ASC`
    )
    .all(id) as LineaPresupuesto[];

  const versiones = db
    .prepare(
      `SELECT id, numero_version, pdf_path, created_at
       FROM presupuesto_versiones
       WHERE presupuesto_id = ?
       ORDER BY numero_version DESC`
    )
    .all(id);

  return {
    ...presupuesto,
    lineas,
    versiones,
    totales: calcularTotales(lineas),
  };
}

// ─── Crear ────────────────────────────────────────────────────────────────────

export async function crearPresupuesto(data: {
  trabajo_id: string;
  fecha?: string;
  notas?: string;
  lineas?: Omit<LineaPresupuesto, 'id' | 'presupuesto_id' | 'orden'>[];
}) {
  const db = getDb();
  const config = getAppConfig();
  const id = uuidv4();
  const fecha = data.fecha ?? hoyISO();
  const iva = config.documentos?.iva_porcentaje ?? 21;

  const resultado = db.transaction(() => {
    db.prepare(
      `INSERT INTO presupuestos
       (id, trabajo_id, estado, fecha, notas, iva_porcentaje, created_at, updated_at)
       VALUES (?, ?, 'borrador', ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(id, data.trabajo_id, fecha, data.notas ?? null, iva);

    if (data.lineas?.length) {
      const stmtLinea = db.prepare(
        `INSERT INTO presupuesto_lineas
         (id, presupuesto_id, descripcion, detalle, cantidad, unidad,
          precio_unitario, coste_unitario, margen_porcentaje, tipo, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      data.lineas.forEach((l, idx) => {
        stmtLinea.run(
          uuidv4(), id, l.descripcion, l.detalle ?? null, l.cantidad, l.unidad ?? null,
          l.precio_unitario, l.coste_unitario ?? null,
          l.margen_porcentaje ?? null, l.tipo, idx
        );
      });
    }

    return id;
  })();

  return obtenerPresupuesto(resultado);
}

// ─── Actualizar cabecera ──────────────────────────────────────────────────────

export async function actualizarPresupuesto(
  id: string,
  data: { notas?: string; fecha?: string }
) {
  const db = getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (data.notas !== undefined) { sets.push('notas = ?'); params.push(data.notas); }
  if (data.fecha !== undefined) { sets.push('fecha = ?'); params.push(data.fecha); }

  if (!sets.length) return obtenerPresupuesto(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE presupuestos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return obtenerPresupuesto(id);
}

// ─── Reemplazar líneas completas (guardar explícito) ─────────────────────────

export async function guardarLineas(
  presupuesto_id: string,
  lineas: Omit<LineaPresupuesto, 'id' | 'presupuesto_id' | 'orden'>[]
) {
  const db = getDb();

  const stmt = db.prepare(
    `INSERT INTO presupuesto_lineas
     (id, presupuesto_id, descripcion, detalle, cantidad, unidad,
      precio_unitario, coste_unitario, margen_porcentaje, tipo, orden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Transacción: sin ella, un INSERT fallido a mitad dejaba el presupuesto sin
  // ninguna línea (el DELETE previo ya se había confirmado).
  db.transaction(() => {
    db.prepare('DELETE FROM presupuesto_lineas WHERE presupuesto_id = ?').run(
      presupuesto_id
    );
    lineas.forEach((l, idx) => {
      stmt.run(
        uuidv4(), presupuesto_id, l.descripcion, l.detalle ?? null, l.cantidad, l.unidad ?? null,
        l.precio_unitario, l.coste_unitario ?? null,
        l.margen_porcentaje ?? null, l.tipo, idx
      );
    });
    db.prepare(
      `UPDATE presupuestos SET updated_at = datetime('now') WHERE id = ?`
    ).run(presupuesto_id);
  })();
}

// ─── Autoguardado de borrador ─────────────────────────────────────────────────

export async function guardarBorrador(
  id: string,
  data: unknown
) {
  const db = getDb();
  db.prepare(
    `UPDATE presupuestos
     SET borrador_data = ?, borrador_updated_at = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(data), id);
}

// ─── Cambio de estado ─────────────────────────────────────────────────────────

// Transiciones de estado permitidas para un presupuesto. Un estado solo puede
// moverse a los destinos listados (más el propio estado, que es un no-op). Esto
// evita que reenviar/reimprimir un presupuesto antiguo lo arrastre hacia atrás:
// p. ej. un presupuesto 'aceptado' (la obra ya empezó) no vuelve a 'enviado'
// solo por mandar de nuevo el PDF. Las salidas laterales válidas (rechazar,
// caducar, reabrir como borrador, recotizar) sí están permitidas.
const TRANSICIONES_PRESUPUESTO: Record<EstadoPresupuesto, EstadoPresupuesto[]> = {
  borrador:  ['enviado', 'aceptado', 'rechazado', 'caducado'],
  enviado:   ['aceptado', 'rechazado', 'caducado', 'borrador'],
  aceptado:  [],                       // terminal: la obra ya está en curso
  rechazado: ['enviado', 'borrador'],  // recotizar / reabrir
  caducado:  ['enviado', 'borrador'],  // recotizar / reabrir
};

export async function cambiarEstado(
  id: string,
  estado: EstadoPresupuesto
) {
  const db = getDb();

  const actual = db
    .prepare('SELECT estado FROM presupuestos WHERE id = ?')
    .get(id) as { estado: EstadoPresupuesto } | undefined;
  if (!actual) return obtenerPresupuesto(id);

  // Guardia de transición: si el destino no es válido desde el estado actual
  // (y no es el mismo estado), se ignora sin error. Así reenviar el PDF de un
  // presupuesto ya cerrado no cambia su estado, pero el envío en sí no falla.
  if (estado !== actual.estado &&
      !TRANSICIONES_PRESUPUESTO[actual.estado].includes(estado)) {
    return obtenerPresupuesto(id);
  }

  db.prepare(
    `UPDATE presupuestos
     SET estado = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(estado, id);

  const fila = db
    .prepare('SELECT trabajo_id FROM presupuestos WHERE id = ?')
    .get(id) as { trabajo_id: string } | undefined;
  if (fila?.trabajo_id) {
    syncSeguimientoDesdeDocumento(fila.trabajo_id, 'presupuesto', estado);
  }
  return obtenerPresupuesto(id);
}

// ─── Guardar versión permanente ───────────────────────────────────────────────

export async function guardarVersion(
  presupuesto_id: string,
  pdf_path: string
) {
  const db = getDb();
  const config = getAppConfig();
  const maxVersiones = config.documentos?.max_versiones ?? 10;

  // Obtener número siguiente
  const last = db
    .prepare(
      `SELECT MAX(numero_version) AS last FROM presupuesto_versiones
       WHERE presupuesto_id = ?`
    )
    .get(presupuesto_id) as { last: number | null };
  const numero_version = (last.last ?? 0) + 1;

  // Snapshot del documento para la columna datos (NOT NULL)
  const snapshot = await obtenerPresupuesto(presupuesto_id);
  const datos = JSON.stringify(snapshot ?? {});

  db.prepare(
    `INSERT INTO presupuesto_versiones
     (id, presupuesto_id, numero_version, datos, pdf_path, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(uuidv4(), presupuesto_id, numero_version, datos, pdf_path);

  // Purgar versiones antiguas si se supera el límite
  const versiones = db
    .prepare(
      `SELECT id, pdf_path FROM presupuesto_versiones
       WHERE presupuesto_id = ?
       ORDER BY numero_version ASC`
    )
    .all(presupuesto_id) as { id: string; pdf_path: string | null }[];

  if (versiones.length > maxVersiones) {
    const aBorrar = versiones.slice(0, versiones.length - maxVersiones);
    const stmtDel = db.prepare('DELETE FROM presupuesto_versiones WHERE id = ?');
    aBorrar.forEach(v => { eliminarPdf(v.pdf_path); stmtDel.run(v.id); });
  }

  return numero_version;
}

// ─── Eliminar presupuesto ─────────────────────────────────────────────────────

export async function eliminarPresupuesto(id: string) {
  const db = getDb();

  // facturas.presupuesto_origen_id referencia esta fila sin ON DELETE: borrar
  // sin comprobarlo lanzaba SQLITE_CONSTRAINT (un 500 opaco) después de haber
  // borrado ya líneas y versiones.
  const usos = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facturas
       WHERE presupuesto_origen_id = ? OR presupuesto_id = ?`
    )
    .get(id, id) as { cnt: number };
  if (usos.cnt > 0) {
    const e = new Error(
      'El presupuesto ha generado una factura: elimina antes la factura.'
    ) as Error & { statusCode?: number };
    e.statusCode = 409;
    throw e;
  }

  const pdfs = db
    .prepare('SELECT pdf_path FROM presupuesto_versiones WHERE presupuesto_id = ?')
    .all(id) as { pdf_path: string | null }[];

  db.transaction(() => {
    db.prepare('DELETE FROM presupuesto_lineas WHERE presupuesto_id = ?').run(id);
    db.prepare('DELETE FROM presupuesto_versiones WHERE presupuesto_id = ?').run(id);
    db.prepare('DELETE FROM presupuestos WHERE id = ?').run(id);
  })();

  pdfs.forEach(v => eliminarPdf(v.pdf_path));
}

// ─── Importar líneas desde presupuesto (para crear factura) ──────────────────

export async function exportarLineasParaFactura(presupuesto_id: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT descripcion, detalle, cantidad, unidad, precio_unitario,
              coste_unitario, margen_porcentaje, tipo
       FROM presupuesto_lineas
       WHERE presupuesto_id = ?
       ORDER BY orden ASC`
    )
    .all(presupuesto_id) as Omit<
      LineaPresupuesto,
      'id' | 'presupuesto_id' | 'orden'
    >[];
}