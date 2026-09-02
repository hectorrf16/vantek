/**
 * ──────────────────────────────────────────────────────────────────────────────
 * facturas.service.ts — Lógica de negocio de facturas (ciclo de vida y líneas)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Core of facturas: list/get, create (optionally importing a presupuesto),
 *   manage lines, transfer albarán lines with margen, close (annual
 *   numbering), change state, version PDFs and delete. Also detects dirty
 *   borradores for the launcher.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · uuid (v4) → IDs of facturas, lines and versions
 *     · @db/connection (getDb) → SQLite handle (transactions)
 *     · @utils/config (getAppConfig) → default IVA, max versions
 *     · @services/presupuestos.service (exportarLineasParaFactura) → import lines
 *     · ./seguimiento.service (syncSeguimientoDesdeDocumento) → syncs the seguimiento
 *   Used by:
 *     · routes/facturas.router.ts → exposes all factura endpoints
 *
 * EXPORTS
 *   · listarFacturas(filtros) / obtenerFactura(id) → query
 *   · crearFactura(data) → borrador factura (imports presupuesto if applicable)
 *   · guardarLineas(facturaId, lineas) → replaces the lines
 *   · agregarLineasDesdeAlbaran(trabajoId, albaranLineaIds) → transfers lines with margen
 *   · guardarBorrador(id, data) → autosave
 *   · cerrarFactura(id) → assigns annual number; cambiarEstado(id, estado)
 *   · guardarVersion(id, pdfPath) → permanent version (purges old ones)
 *   · eliminarFactura(id); hayBorradorSucio()
 *
 * INPUTS / OUTPUTS
 *   Input:  factura and line ids/data; state of the DB; global config
 *   Output: factura rows with computed totals; INSERT/UPDATE/DELETE
 *
 * NOTES
 *   · precio_unitario is the final price to the cliente; coste_unitario and margen are internal.
 *   · cerrarFactura only validates it is in borrador; the frontend applies the business rules.
 *   · cliente_direccion comes from a.label (agrupador), not clientes.direccion (does not exist).
 *   · The async resolution of presupuesto lines happens BEFORE opening the transaction.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@db/connection';
import { getAppConfig } from '@utils/config';
import { redondear, totalesDocumento } from '@utils/dinero';
import { hoyISO } from '@utils/fechas';
import { eliminarPdf } from '@services/pdf.service';
import { exportarLineasParaFactura } from '@services/presupuestos.service';
import { syncSeguimientoDesdeDocumento } from './seguimiento.service';

// ─── Tipos internos ───────────────────────────────────────────────────────────

export type EstadoFactura =
  | 'borrador'
  | 'cerrada'
  | 'entregada'
  | 'pendiente_pago'
  | 'pagada';

export interface LineaFactura {
  id: string;
  factura_id: string;
  descripcion: string;
  detalle: string | null;
  cantidad: number;
  unidad: string | null;
  precio_unitario: number;
  coste_unitario: number | null;
  margen_porcentaje: number | null;
  tipo: 'material' | 'manual' | 'concepto';
  es_libre: boolean;
  albaran_linea_id: string | null;
  orden: number;
}

export interface FacturaRow {
  id: string;
  trabajo_id: string;
  presupuesto_origen_id: string | null;
  numero: string | null;
  anio_numero: number | null;
  estado: EstadoFactura;
  fecha: string;
  fecha_cierre: string | null;
  notas: string | null;
  iva_porcentaje: number;
  borrador_data: string | null;
  borrador_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcularTotales(lineas: LineaFactura[], iva_porcentaje: number) {
  const { subtotal, iva, total } = totalesDocumento(lineas, iva_porcentaje);
  return { subtotal, iva, iva_porcentaje, total };
}

// Una factura emitida (con número asignado) es un documento legal: ni sus
// líneas ni su existencia pueden modificarse por API. Para corregirla hay que
// reabrirla explícitamente (pierde el número) o emitir una rectificativa.
function exigirBorrador(id: string, accion: string): void {
  const db = getDb();
  const fila = db
    .prepare('SELECT estado FROM facturas WHERE id = ?')
    .get(id) as { estado: EstadoFactura } | undefined;
  if (!fila) {
    const e = new Error('Factura no encontrada') as Error & { statusCode?: number };
    e.statusCode = 404;
    throw e;
  }
  if (fila.estado !== 'borrador') {
    const e = new Error(
      `La factura ya está emitida (${fila.estado}): no se puede ${accion}. Reábrela como borrador si necesitas corregirla.`
    ) as Error & { statusCode?: number };
    e.statusCode = 409;
    throw e;
  }
}

// El siguiente número sale del MÁXIMO de la serie del año, nunca de un COUNT:
// reabrir o borrar una factura cerrada reducía el conteo y el siguiente cierre
// reemitía un número ya usado. El índice único de la migración v10 lo blinda.
async function siguienteNumeroFactura(anio: number): Promise<string> {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MAX(CAST(numero AS INTEGER)) AS maxn FROM facturas
       WHERE anio_numero = ? AND numero IS NOT NULL`
    )
    .get(anio) as { maxn: number | null };
  const siguiente = (row.maxn ?? 0) + 1;
  return String(siguiente).padStart(4, '0');
}

// ─── Listado ──────────────────────────────────────────────────────────────────

export async function listarFacturas(filtros: {
  trabajo_id?: string;
  estado?: EstadoFactura;
  cliente_id?: string;
}) {
  const db = getDb();
  const condiciones: string[] = [];
  const params: unknown[] = [];

  if (filtros.trabajo_id) {
    condiciones.push('f.trabajo_id = ?');
    params.push(filtros.trabajo_id);
  }
  if (filtros.estado) {
    condiciones.push('f.estado = ?');
    params.push(filtros.estado);
  }
  if (filtros.cliente_id) {
    condiciones.push('c.id = ?');
    params.push(filtros.cliente_id);
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT
        f.id, f.trabajo_id, f.numero, f.estado, f.fecha, f.fecha_cierre,
        f.iva_porcentaje, f.created_at, f.updated_at,
        t.nombre AS trabajo_nombre,
        a.id AS agrupador_id, a.label AS agrupador_label,
        c.id AS cliente_id, c.nombre AS cliente_nombre,
        (SELECT COALESCE(SUM(fl.precio_unitario * fl.cantidad), 0)
         FROM factura_lineas fl WHERE fl.factura_id = f.id) AS subtotal,
        (SELECT COALESCE(SUM(fl.precio_unitario * fl.cantidad), 0)
         FROM factura_lineas fl WHERE fl.factura_id = f.id)
         * (1 + f.iva_porcentaje / 100.0) AS total
       FROM facturas f
       JOIN trabajos t ON t.id = f.trabajo_id
       JOIN agrupadores a ON a.id = t.agrupador_id
       JOIN clientes c ON c.id = a.cliente_id
       ${where}
       ORDER BY f.fecha DESC, f.created_at DESC`
    )
    .all(...params);
}

// ─── Detalle ──────────────────────────────────────────────────────────────────

export async function obtenerFactura(id: string) {
  const db = getDb();

  const factura = db
    .prepare(
      `SELECT
        f.*,
        t.nombre AS trabajo_nombre, t.margen_porcentaje AS trabajo_margen,
        a.id AS agrupador_id, a.label AS agrupador_label,
        c.id AS cliente_id, c.nombre AS cliente_nombre,
        c.empresa AS cliente_empresa, c.dni_cif AS cliente_dni_cif,
        c.telefono AS cliente_telefono, c.email AS cliente_email,
        a.label AS cliente_direccion
       FROM facturas f
       JOIN trabajos t ON t.id = f.trabajo_id
       JOIN agrupadores a ON a.id = t.agrupador_id
       JOIN clientes c ON c.id = a.cliente_id
       WHERE f.id = ?`
    )
    .get(id) as (FacturaRow & Record<string, unknown>) | undefined;

  if (!factura) return null;

  const lineas = db
    .prepare(
      `SELECT * FROM factura_lineas
       WHERE factura_id = ?
       ORDER BY orden ASC`
    )
    .all(id) as LineaFactura[];

  const versiones = db
    .prepare(
      `SELECT id, numero_version, pdf_path, created_at
       FROM factura_versiones
       WHERE factura_id = ?
       ORDER BY numero_version DESC`
    )
    .all(id);

  const totales = calcularTotales(lineas, factura.iva_porcentaje as number);
  const anticipoRow = db
    .prepare(
      `SELECT COALESCE(SUM(importe), 0) AS total FROM obra_pagos WHERE trabajo_id = ?`
    )
    .get(factura.trabajo_id) as { total: number };
  const anticipo_total = redondear(anticipoRow.total);
  const anticipo_aplicado = anticipoAplicadoAFactura(
    factura.trabajo_id,
    id,
    anticipo_total
  );
  const restante = redondear(totales.total - anticipo_aplicado);

  return {
    ...factura,
    lineas,
    versiones,
    totales,
    anticipo_total,
    anticipo_aplicado,
    restante,
  };
}

// Los anticipos son de la OBRA, no de una factura. Si la obra tiene varias
// facturas, el anticipo se consume por orden de creación: antes se restaba
// entero en todas, infravalorando el importe pendiente de cada una.
function anticipoAplicadoAFactura(
  trabajoId: string,
  facturaId: string,
  anticipoTotal: number
): number {
  if (anticipoTotal <= 0) return 0;
  const db = getDb();

  const facturas = db
    .prepare(
      `SELECT f.id, f.iva_porcentaje,
        (SELECT COALESCE(SUM(fl.precio_unitario * fl.cantidad), 0)
         FROM factura_lineas fl WHERE fl.factura_id = f.id) AS subtotal
       FROM facturas f
       WHERE f.trabajo_id = ?
       ORDER BY f.created_at ASC, f.rowid ASC`
    )
    .all(trabajoId) as { id: string; iva_porcentaje: number; subtotal: number }[];

  let disponible = anticipoTotal;
  for (const f of facturas) {
    const total = redondear(
      redondear(f.subtotal) * (1 + (f.iva_porcentaje ?? 0) / 100)
    );
    const aplicado = redondear(Math.min(disponible, total));
    if (f.id === facturaId) return aplicado;
    disponible = redondear(disponible - aplicado);
    if (disponible <= 0) break;
  }
  return 0;
}

// ─── Crear ────────────────────────────────────────────────────────────────────

export async function crearFactura(data: {
  trabajo_id: string;
  fecha?: string;
  notas?: string;
  presupuesto_origen_id?: string;
  lineas?: Omit<LineaFactura, 'id' | 'factura_id' | 'orden'>[];
}) {
  const db = getDb();
  const config = getAppConfig();
  const id = uuidv4();
  const fecha = data.fecha ?? hoyISO();
  const iva = config.documentos?.iva_porcentaje ?? 21;

 // Resolver líneas ANTES de la transacción (puede ser async)
  let lineas = data.lineas;
  if (!lineas?.length && data.presupuesto_origen_id) {
    lineas = await exportarLineasParaFactura(data.presupuesto_origen_id) as typeof lineas;
  }

  const resultado = db.transaction(() => {
    db.prepare(
      `INSERT INTO facturas
       (id, trabajo_id, presupuesto_origen_id, estado, fecha, notas,
        iva_porcentaje, created_at, updated_at)
       VALUES (?, ?, ?, 'borrador', ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(
      id, data.trabajo_id, data.presupuesto_origen_id ?? null,
      fecha, data.notas ?? null, iva
    );

    if (lineas?.length) {
      const stmt = db.prepare(
        `INSERT INTO factura_lineas
         (id, factura_id, descripcion, detalle, cantidad, unidad, precio_unitario,
          coste_unitario, margen_porcentaje, tipo, es_libre, albaran_linea_id, orden)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      lineas.forEach((l, idx) => {
        stmt.run(
          uuidv4(), id, l.descripcion, l.detalle ?? null, l.cantidad, l.unidad ?? null,
          l.precio_unitario, l.coste_unitario ?? null,
          l.margen_porcentaje ?? null, l.tipo,
          l.es_libre ? 1 : 0, l.albaran_linea_id ?? null, idx
        );
      });
    }

    return id;
  })();

  return obtenerFactura(resultado);
}

// ─── Guardar líneas ───────────────────────────────────────────────────────────
export async function guardarLineas(
  factura_id: string,
  lineas: Omit<LineaFactura, 'id' | 'factura_id' | 'orden'>[]
) {
  const db = getDb();
  exigirBorrador(factura_id, 'editar sus líneas');

  const stmt = db.prepare(
    `INSERT INTO factura_lineas
     (id, factura_id, descripcion, detalle, cantidad, unidad, precio_unitario,
      coste_unitario, margen_porcentaje, tipo, es_libre, albaran_linea_id, orden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Transacción: sin ella, un INSERT fallido a mitad dejaba la factura sin
  // ninguna línea (el DELETE previo ya se había confirmado).
  db.transaction(() => {
    db.prepare('DELETE FROM factura_lineas WHERE factura_id = ?').run(factura_id);
    lineas.forEach((l, idx) => {
      stmt.run(
        uuidv4(), factura_id, l.descripcion, l.detalle ?? null, l.cantidad, l.unidad ?? null,
        l.precio_unitario, l.coste_unitario ?? null,
        l.margen_porcentaje ?? null, l.tipo,
        l.es_libre ? 1 : 0, l.albaran_linea_id ?? null, idx
      );
    });
    db.prepare(
      `UPDATE facturas SET updated_at = datetime('now') WHERE id = ?`
    ).run(factura_id);
  })();
}

// ─── Añadir líneas de albarán a la factura borrador del trabajo ────────────────
export async function agregarLineasDesdeAlbaran(
  trabajoId: string,
  albaranLineaIds: string[],
): Promise<{ factura_id: string; agregadas: number; omitidas: number }> {
  const db = getDb();

  const trabajo = db
    .prepare('SELECT id, margen_porcentaje FROM trabajos WHERE id = ?')
    .get(trabajoId) as { id: string; margen_porcentaje: number | null } | undefined;
  if (!trabajo) throw new Error('Trabajo no encontrado');

  // Buscar la factura borrador del trabajo; si no hay, crear una.
  const borrador = db
    .prepare(
      `SELECT id FROM facturas
       WHERE trabajo_id = ? AND estado = 'borrador'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(trabajoId) as { id: string } | undefined;

  let facturaId: string;
  if (borrador) {
    facturaId = borrador.id;
  } else {
    const nueva = await crearFactura({ trabajo_id: trabajoId });
    facturaId = nueva!.id;
  }

  // Solo líneas realmente asignadas a este trabajo.
  const asignadas = new Set(
    (db
      .prepare(
        `SELECT albaran_linea_id AS id FROM albaran_linea_trabajo WHERE trabajo_id = ?`
      )
      .all(trabajoId) as { id: string }[]).map(r => r.id)
  );

  // Líneas de albarán ya presentes en la factura (evitar duplicados).
  const yaPresentes = new Set(
    (db
      .prepare(
        `SELECT albaran_linea_id AS id FROM factura_lineas
         WHERE factura_id = ? AND albaran_linea_id IS NOT NULL`
      )
      .all(facturaId) as { id: string }[]).map(r => r.id)
  );

  const idsValidos = albaranLineaIds.filter(
    id => asignadas.has(id) && !yaPresentes.has(id)
  );

  if (idsValidos.length === 0) {
    return { factura_id: facturaId, agregadas: 0, omitidas: albaranLineaIds.length };
  }

  const lineas = db
    .prepare(
      `SELECT id, descripcion, cantidad, unidad, precio_unitario
       FROM albaran_lineas WHERE id IN (${idsValidos.map(() => '?').join(',')})`
    )
    .all(...idsValidos) as {
      id: string;
      descripcion: string;
      cantidad: number;
      unidad: string | null;
      precio_unitario: number;
    }[];

  const margen = trabajo.margen_porcentaje ?? 0;
  const ordenRow = db
    .prepare('SELECT COALESCE(MAX(orden), -1) AS max FROM factura_lineas WHERE factura_id = ?')
    .get(facturaId) as { max: number };
  let orden = ordenRow.max + 1;

  const stmt = db.prepare(
    `INSERT INTO factura_lineas
     (id, factura_id, descripcion, cantidad, unidad, precio_unitario,
      coste_unitario, margen_porcentaje, tipo, es_libre, albaran_linea_id, orden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'material', 0, ?, ?)`
  );

  const insertar = db.transaction(() => {
    for (const l of lineas) {
      const coste = l.precio_unitario;
      const precioFinal = redondear(coste * (1 + margen / 100));
      stmt.run(
        uuidv4(), facturaId, l.descripcion, l.cantidad, l.unidad ?? null,
        precioFinal, coste, margen, l.id, orden++
      );
    }
    db.prepare(`UPDATE facturas SET updated_at = datetime('now') WHERE id = ?`).run(facturaId);
  });
  insertar();

  return {
    factura_id: facturaId,
    agregadas: lineas.length,
    omitidas: albaranLineaIds.length - lineas.length,
  };
}

// ─── Autoguardado ─────────────────────────────────────────────────────────────

export async function guardarBorrador(id: string, data: unknown) {
  const db = getDb();
  db.prepare(
    `UPDATE facturas
     SET borrador_data = ?, borrador_updated_at = datetime('now')
     WHERE id = ?`
  ).run(JSON.stringify(data), id);
}

// ─── Cerrar factura ───────────────────────────────────────────────────────────

export interface ResultadoCierre {
  ok: boolean;
  factura?: Awaited<ReturnType<typeof obtenerFactura>>;
  error?: string;
}

export async function cerrarFactura(id: string): Promise<ResultadoCierre> {
  const db = getDb();
  const factura = await obtenerFactura(id);
  if (!factura) return { ok: false, error: 'Factura no encontrada' };
  if (factura.estado !== 'borrador') {
    return { ok: false, error: 'La factura no está en borrador' };
  }
  // Un número de la serie legal no puede consumirse en un documento vacío.
  if (!factura.lineas.length) {
    return { ok: false, error: 'La factura no tiene líneas: no se puede cerrar' };
  }
  if (factura.totales.total <= 0) {
    return { ok: false, error: 'El importe total de la factura debe ser mayor que cero' };
  }

  // El año de la serie sale de la FECHA de la factura, no del reloj: una
  // factura de diciembre cerrada en enero pertenece a la serie de diciembre.
  const anioFecha = new Date(String(factura.fecha)).getFullYear();
  const anio = Number.isFinite(anioFecha) ? anioFecha : new Date().getFullYear();

  // Numerar y marcar en una sola transacción: dos cierres simultáneos no
  // pueden leer el mismo MAX y asignar el mismo número.
  const cerrar = db.transaction((numero: string) => {
    db.prepare(
      `UPDATE facturas
       SET estado = 'cerrada', numero = ?, anio_numero = ?,
           fecha_cierre = datetime('now'), updated_at = datetime('now')
       WHERE id = ? AND estado = 'borrador'`
    ).run(numero, anio, id);
  });
  cerrar(await siguienteNumeroFactura(anio));

  // El cierre no pasa por cambiarEstado, así que la sincronización con el
  // seguimiento (cerrada → pendiente_facturar) hay que dispararla aquí.
  if (factura.trabajo_id) {
    syncSeguimientoDesdeDocumento(factura.trabajo_id, 'factura', 'cerrada');
  }

  return { ok: true, factura: await obtenerFactura(id) };
}

// ─── Cambiar estado ───────────────────────────────────────────────────────────

// Transiciones de estado permitidas para una factura. Evita que reenviar/
// reimprimir una factura antigua la arrastre hacia atrás: una factura 'pagada'
// o 'pendiente_pago' no vuelve a 'entregada' solo por mandar de nuevo el PDF.
// Reabrir como borrador (acción explícita del usuario, con aviso) se permite
// desde cualquier estado.
const TRANSICIONES_FACTURA: Record<EstadoFactura, EstadoFactura[]> = {
  borrador:       ['cerrada'],
  cerrada:        ['entregada', 'pendiente_pago', 'pagada', 'borrador'],
  entregada:      ['pendiente_pago', 'pagada', 'borrador'],
  pendiente_pago: ['pagada', 'borrador'],
  pagada:         ['borrador'],   // solo reapertura explícita
};

export async function cambiarEstado(id: string, estado: EstadoFactura) {
  const db = getDb();

  const actual = db
    .prepare('SELECT estado FROM facturas WHERE id = ?')
    .get(id) as { estado: EstadoFactura } | undefined;
  if (!actual) return obtenerFactura(id);

  // Guardia de transición: destino no válido desde el estado actual (y distinto
  // del mismo estado) → se ignora sin error. Reenviar el PDF de una factura ya
  // cerrada/cobrada no cambia su estado, pero el envío en sí no falla.
  if (estado !== actual.estado &&
      !TRANSICIONES_FACTURA[actual.estado].includes(estado)) {
    return obtenerFactura(id);
  }

  // Reabrir como borrador: limpiar número si vuelve a borrador
  if (estado === 'borrador') {
    db.prepare(
      `UPDATE facturas
       SET estado = 'borrador', numero = NULL, anio_numero = NULL,
           fecha_cierre = NULL, updated_at = datetime('now')
       WHERE id = ?`
    ).run(id);
  } else {
    db.prepare(
      `UPDATE facturas SET estado = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(estado, id);

    const fila = db
      .prepare('SELECT trabajo_id FROM facturas WHERE id = ?')
      .get(id) as { trabajo_id: string } | undefined;
    if (fila?.trabajo_id) {
      syncSeguimientoDesdeDocumento(fila.trabajo_id, 'factura', estado);
    }
  }


  return obtenerFactura(id);
}

// ─── Guardar versión permanente ───────────────────────────────────────────────

export async function guardarVersion(factura_id: string, pdf_path: string) {
  const db = getDb();
  const config = getAppConfig();
  const maxVersiones = config.documentos?.max_versiones ?? 10;

  const last = db
    .prepare(
      `SELECT MAX(numero_version) AS last FROM factura_versiones
       WHERE factura_id = ?`
    )
    .get(factura_id) as { last: number | null };
  const numero_version = (last.last ?? 0) + 1;

  // Snapshot del documento para la columna datos (NOT NULL)
  const snapshot = await obtenerFactura(factura_id);
  const datos = JSON.stringify(snapshot ?? {});

  db.prepare(
    `INSERT INTO factura_versiones
     (id, factura_id, numero_version, datos, pdf_path, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(uuidv4(), factura_id, numero_version, datos, pdf_path);

  // Purgar antiguas
  const versiones = db
    .prepare(
      `SELECT id, pdf_path FROM factura_versiones
       WHERE factura_id = ?
       ORDER BY numero_version ASC`
    )
    .all(factura_id) as { id: string; pdf_path: string | null }[];

  if (versiones.length > maxVersiones) {
    const aBorrar = versiones.slice(0, versiones.length - maxVersiones);
    const stmtDel = db.prepare('DELETE FROM factura_versiones WHERE id = ?');
    aBorrar.forEach(v => { eliminarPdf(v.pdf_path); stmtDel.run(v.id); });
  }

  return numero_version;
}

// ─── Eliminar ─────────────────────────────────────────────────────────────────

export async function eliminarFactura(id: string) {
  const db = getDb();
  exigirBorrador(id, 'eliminar');

  const pdfs = db
    .prepare('SELECT pdf_path FROM factura_versiones WHERE factura_id = ?')
    .all(id) as { pdf_path: string | null }[];

  db.transaction(() => {
    db.prepare('DELETE FROM factura_lineas WHERE factura_id = ?').run(id);
    db.prepare('DELETE FROM factura_versiones WHERE factura_id = ?').run(id);
    db.prepare('DELETE FROM facturas WHERE id = ?').run(id);
  })();

  pdfs.forEach(v => eliminarPdf(v.pdf_path));
}

// ─── Borrador sucio (para el launcher) ───────────────────────────────────────

export async function hayBorradorSucio(): Promise<boolean> {
  const db = getDb();

  const facturas = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM facturas
       WHERE borrador_updated_at IS NOT NULL
         AND borrador_updated_at > updated_at`
    )
    .get() as { cnt: number };

  const presupuestos = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM presupuestos
       WHERE borrador_updated_at IS NOT NULL
         AND borrador_updated_at > updated_at`
    )
    .get() as { cnt: number };

  return facturas.cnt > 0 || presupuestos.cnt > 0;
}