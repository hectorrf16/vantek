/**
 * ──────────────────────────────────────────────────────────────────────────────
 * albaranes.service.ts — Albaranes de proveedor y asignación de líneas a obras
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Business logic for supplier albaranes (internal use, never visible to the
 *   cliente). Manages header + lines and the assignment of lines to one or more
 *   trabajos through the albaran_linea_trabajo table. The state
 *   (sin_asignar/parcial/asignado) is computed, not stored.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @db/connection (getDb) → SQLite handle
 *     · uuid (v4) → IDs of albaranes, lines and assignments
 *     · ../types (Albaran, AlbaranListItem, AlbaranLinea) → row types
 *   Used by:
 *     · routes/albaranes.router.ts → exposes the CRUD and assignment actions
 *     · facturas.service.ts (indirect) → consumes lines assigned to a trabajo
 *
 * EXPORTS
 *   · albanesService.findAll(filtros?) → listing with computed state and filters
 *   · albanesService.findById(id) → albarán with lines and assigned trabajos
 *   · albanesService.findByTrabajo(trabajoId) → albaranes/lines of a trabajo
 *   · albanesService.create(data) → albarán with its lines (transaction)
 *   · albanesService.update(id, data) → edits header and reconciles lines
 *   · albanesService.asignarLineas(albaranId, trabajoId, lineaIds?) → assigns to obra
 *   · albanesService.moverLinea(lineaId, desde, hasta) → moves a line between obras
 *   · albanesService.desasignarLineas(lineaIds, trabajoId) → unassigns from obra
 *   · albanesService.delete(id) → 'no_existe' | 'en_uso' | 'ok'
 *
 * INPUTS / OUTPUTS
 *   Input:  albarán/line data, trabajo ids, listing filters
 *   Output: Albaran rows; INSERT/UPDATE/DELETE in SQLite (transactional)
 *
 * NOTES
 *   · The albarán state is derived: 0 assigned = sin_asignar, all = asignado.
 *   · update deletes absent lines; delete is blocked ('en_uso') if a line
 *     was already used in a factura (factura_lineas.albaran_linea_id).
 *   · Albarán prices are COST; the margen is applied when transferring them to a factura.
 *   · The export is named `albanesService` (without the 'r').
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getDb } from '@db/connection';
import { v4 as uuidv4 } from 'uuid';
import { Albaran, AlbaranListItem, AlbaranLinea } from '../types';

export const albanesService = {

  findAll(filtros?: {
    estado?: 'sin_asignar' | 'parcial' | 'asignado';
    proveedor?: string;
    fecha_desde?: string;
    fecha_hasta?: string;
  }): AlbaranListItem[] {
    const db = getDb();
    const params: unknown[] = [];

    let where = 'WHERE 1=1';

    if (filtros?.proveedor) {
      where += ' AND al.proveedor_nombre LIKE ?';
      params.push(`%${filtros.proveedor}%`);
    }
    if (filtros?.fecha_desde) {
      where += ' AND al.fecha >= ?';
      params.push(filtros.fecha_desde);
    }
    if (filtros?.fecha_hasta) {
      where += ' AND al.fecha <= ?';
      params.push(filtros.fecha_hasta);
    }

    // Los recuentos van por subconsulta y NO por GROUP BY (al.id, t.id): al
    // agrupar también por trabajo, un albarán parcialmente asignado salía
    // duplicado (una fila "asignado" y otra "sin_asignar") y el estado
    // "parcial" era matemáticamente inalcanzable.
    const rows = db.prepare(`
      SELECT
        al.id, al.proveedor_nombre, al.numero, al.fecha, al.created_at,
        (SELECT COUNT(*) FROM albaran_lineas alinea
          WHERE alinea.albaran_id = al.id) AS lineas_count,
        (SELECT COUNT(DISTINCT alt.albaran_linea_id)
           FROM albaran_linea_trabajo alt
           JOIN albaran_lineas alinea ON alinea.id = alt.albaran_linea_id
          WHERE alinea.albaran_id = al.id) AS lineas_asignadas
      FROM albaranes al
      ${where}
      ORDER BY al.fecha DESC
    `).all(...params) as any[];

    const result = rows.map(r => ({
      ...r,
      estado: r.lineas_asignadas === 0
        ? 'sin_asignar'
        : r.lineas_asignadas < r.lineas_count
          ? 'parcial'
          : 'asignado'
    }));

    if (!filtros?.estado) return result;
    if (filtros.estado === 'parcial') return result.filter(r => r.estado === 'parcial');
    if (filtros.estado === 'sin_asignar') return result.filter(r => r.estado === 'sin_asignar');
    if (filtros.estado === 'asignado') return result.filter(r => r.estado === 'asignado');
    return result;
  },

  findById(id: string): Albaran | null {
    const db = getDb();
    const albaran = db.prepare(`SELECT * FROM albaranes WHERE id = ?`).get(id) as Albaran | undefined;
    if (!albaran) return null;

    const lineas = db.prepare(`
      SELECT * FROM albaran_lineas
      WHERE albaran_id = ?
      ORDER BY orden ASC
    `).all(id) as any[];

    // Consulta aparte en lugar de dos GROUP_CONCAT emparejados por índice: un
    // nombre de obra con una coma descuadraba la correspondencia id↔nombre.
    const asignaciones = db.prepare(`
      SELECT alt.albaran_linea_id, alt.trabajo_id, t.nombre AS trabajo_nombre
      FROM albaran_linea_trabajo alt
      JOIN albaran_lineas alinea ON alinea.id = alt.albaran_linea_id
      LEFT JOIN trabajos t ON t.id = alt.trabajo_id
      WHERE alinea.albaran_id = ?
    `).all(id) as {
      albaran_linea_id: string;
      trabajo_id: string;
      trabajo_nombre: string | null;
    }[];

    const porLinea = new Map<string, { trabajo_id: string; trabajo_nombre: string }[]>();
    for (const a of asignaciones) {
      const lista = porLinea.get(a.albaran_linea_id) ?? [];
      lista.push({ trabajo_id: a.trabajo_id, trabajo_nombre: a.trabajo_nombre ?? '' });
      porLinea.set(a.albaran_linea_id, lista);
    }

    albaran.lineas = lineas.map(l => ({
      ...l,
      trabajos_asignados: porLinea.get(l.id) ?? [],
    }));

    return albaran;
  },

  // Albaranes asignados a un trabajo (para el selector al añadir ítems a factura)
  findByTrabajo(trabajoId: string): Albaran[] {
    const db = getDb();
    const albaranes = db.prepare(`
      SELECT DISTINCT al.*
      FROM albaranes al
      JOIN albaran_lineas alinea ON alinea.albaran_id = al.id
      JOIN albaran_linea_trabajo alt ON alt.albaran_linea_id = alinea.id
      WHERE alt.trabajo_id = ?
      ORDER BY al.fecha DESC
    `).all(trabajoId) as Albaran[];

    for (const al of albaranes) {
      al.lineas = db.prepare(`
        SELECT alinea.*
        FROM albaran_lineas alinea
        JOIN albaran_linea_trabajo alt ON alt.albaran_linea_id = alinea.id
        WHERE alinea.albaran_id = ? AND alt.trabajo_id = ?
        ORDER BY alinea.orden ASC
      `).all(al.id, trabajoId) as AlbaranLinea[];
    }

    return albaranes;
  },

  create(data: {
    proveedor_nombre?: string;
    numero?: string;
    fecha: string;
    notas?: string;
    lineas: {
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      unidad?: string;
    }[];
  }): Albaran {
    const db = getDb();
    const id = uuidv4();
    const now = new Date().toISOString();

    const insert = db.transaction(() => {
      db.prepare(`
        INSERT INTO albaranes (id, proveedor_nombre, numero, fecha, notas, ocr_procesado, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(id, data.proveedor_nombre ?? null, data.numero ?? null,
             data.fecha, data.notas ?? null, now, now);

      for (const [i, linea] of data.lineas.entries()) {
        db.prepare(`
          INSERT INTO albaran_lineas (id, albaran_id, descripcion, cantidad, precio_unitario, unidad, orden, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), id, linea.descripcion, linea.cantidad,
               linea.precio_unitario, linea.unidad ?? null, i, now);
      }
    });

    insert();
    return this.findById(id)!;
  },

  // Editar cabecera y líneas de un albarán existente.
  // Las líneas con id existente se actualizan; las nuevas (sin id) se insertan;
  // las que ya no vienen en el payload se eliminan (cascada a sus asignaciones).
  update(id: string, data: {
    proveedor_nombre?: string;
    numero?: string;
    fecha: string;
    notas?: string;
    lineas: {
      id?: string;
      descripcion: string;
      cantidad: number;
      precio_unitario: number;
      unidad?: string;
    }[];
  }): Albaran | null {
    const db = getDb();
    const existe = db.prepare(`SELECT id FROM albaranes WHERE id = ?`).get(id);
    if (!existe) return null;

    const now = new Date().toISOString();

    const actualizar = db.transaction(() => {
      db.prepare(`
        UPDATE albaranes
        SET proveedor_nombre = ?, numero = ?, fecha = ?, notas = ?, updated_at = ?
        WHERE id = ?
      `).run(data.proveedor_nombre ?? null, data.numero ?? null,
             data.fecha, data.notas ?? null, now, id);

      const existentes = (db.prepare(`SELECT id FROM albaran_lineas WHERE albaran_id = ?`)
        .all(id) as { id: string }[]).map(r => r.id);
      const entrantes = data.lineas.filter(l => l.id).map(l => l.id as string);

      // Eliminar líneas que ya no están en el payload
      for (const lid of existentes) {
        if (!entrantes.includes(lid)) {
          db.prepare(`DELETE FROM albaran_lineas WHERE id = ?`).run(lid);
        }
      }

      // Insertar / actualizar manteniendo el orden del array
      data.lineas.forEach((linea, i) => {
        if (linea.id && existentes.includes(linea.id)) {
          db.prepare(`
            UPDATE albaran_lineas
            SET descripcion = ?, cantidad = ?, precio_unitario = ?, unidad = ?, orden = ?
            WHERE id = ?
          `).run(linea.descripcion, linea.cantidad, linea.precio_unitario,
                 linea.unidad ?? null, i, linea.id);
        } else {
          db.prepare(`
            INSERT INTO albaran_lineas (id, albaran_id, descripcion, cantidad, precio_unitario, unidad, orden, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uuidv4(), id, linea.descripcion, linea.cantidad,
                 linea.precio_unitario, linea.unidad ?? null, i, now);
        }
      });
    });

    actualizar();
    return this.findById(id)!;
  },

  // Asignar líneas a un trabajo (por defecto todas si no se especifican)
  asignarLineas(albaranId: string, trabajoId: string, lineaIds?: string[]): void {
    const db = getDb();

    const lineas = lineaIds
      ? db.prepare(
          `SELECT id FROM albaran_lineas WHERE albaran_id = ? AND id IN (${lineaIds.map(() => '?').join(',')})`
        ).all(albaranId, ...lineaIds) as { id: string }[]
      : db.prepare(`SELECT id FROM albaran_lineas WHERE albaran_id = ?`)
          .all(albaranId) as { id: string }[];

    const asignar = db.transaction(() => {
      for (const linea of lineas) {
        db.prepare(`
          INSERT OR IGNORE INTO albaran_linea_trabajo (id, albaran_linea_id, trabajo_id)
          VALUES (?, ?, ?)
        `).run(uuidv4(), linea.id, trabajoId);
      }
    });

    asignar();
  },

  // Mover una línea concreta de un trabajo a otro
  moverLinea(lineaId: string, desdeTrabajo: string, hastaTrabajo: string): void {
    const db = getDb();
    db.prepare(`
      UPDATE albaran_linea_trabajo SET trabajo_id = ?
      WHERE albaran_linea_id = ? AND trabajo_id = ?
    `).run(hastaTrabajo, lineaId, desdeTrabajo);
  },

  // Desasignar líneas de un trabajo
  desasignarLineas(lineaIds: string[], trabajoId: string): void {
    const db = getDb();
    const desasignar = db.transaction(() => {
      for (const lineaId of lineaIds) {
        db.prepare(`
          DELETE FROM albaran_linea_trabajo WHERE albaran_linea_id = ? AND trabajo_id = ?
        `).run(lineaId, trabajoId);
      }
    });
    desasignar();
  },

  // Eliminar un albarán completo (cabecera + líneas + asignaciones por cascada).
  // Se bloquea si alguna línea ya se usó en una factura.
  // Devuelve 'no_existe' | 'en_uso' | 'ok'.
  delete(id: string): 'no_existe' | 'en_uso' | 'ok' {
    const db = getDb();
    const existe = db.prepare(`SELECT id FROM albaranes WHERE id = ?`).get(id);
    if (!existe) return 'no_existe';

    const enUso = db.prepare(`
      SELECT COUNT(*) AS n
      FROM factura_lineas fl
      JOIN albaran_lineas al ON al.id = fl.albaran_linea_id
      WHERE al.albaran_id = ?
    `).get(id) as { n: number };

    if (enUso.n > 0) return 'en_uso';

    // albaran_lineas y albaran_linea_trabajo se borran por ON DELETE CASCADE
    db.prepare(`DELETE FROM albaranes WHERE id = ?`).run(id);
    return 'ok';
  }
};