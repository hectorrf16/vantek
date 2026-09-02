/**
 * ──────────────────────────────────────────────────────────────────────────────
 * trabajos.service.ts — CRUD de trabajos (obras/reparaciones) y su contexto
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Business logic for the trabajo: the leaf of the hierarchy Cliente→Agrupador→
 *   Trabajo. Lists and creates/edits trabajos, resolves them with full context
 *   (cliente + agrupador) for breadcrumbs and document headers, and exposes
 *   the albaranes assigned to each trabajo.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @db/connection (getDb) → SQLite handle
 *     · uuid (v4) → IDs of new trabajos
 *     · ../types (Trabajo, TrabajoConContexto, TrabajoBrief) → row types
 *     · @utils/config (getAppConfig) → default margen on create
 *   Used by:
 *     · routes/clientes.router.ts → trabajos nested under the agrupador
 *
 * EXPORTS
 *   · trabajosService.findByAgrupador(agrupadorId) → trabajos of the agrupador
 *   · trabajosService.findById(id) → a trabajo or null
 *   · trabajosService.findWithContext(id) → trabajo + cliente/agrupador
 *   · trabajosService.create(data) → created trabajo (inherited margen)
 *   · trabajosService.update(id, data) → updated trabajo or null
 *   · trabajosService.findAlbaranes(trabajoId) → albaranes assigned to the trabajo
 *
 * INPUTS / OUTPUTS
 *   Input:  trabajo ids/data; state of the DB; config (margen)
 *   Output: Trabajo/context rows; INSERT/UPDATE in SQLite
 *
 * NOTES
 *   · estado is 'activo' | 'completado' | 'cancelado'; derived from the seguimiento.
 *   · The per-trabajo margen inherits from documentos.margen_defecto if not specified.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getDb } from '@db/connection';
import { v4 as uuidv4 } from 'uuid';
import { Trabajo, TrabajoConContexto } from '../types';
import { getAppConfig } from '@utils/config';

export const trabajosService = {

  findByAgrupador(agrupadorId: string): Trabajo[] {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM trabajos WHERE agrupador_id = ? ORDER BY created_at DESC
    `).all(agrupadorId) as Trabajo[];
  },

  findById(id: string): Trabajo | null {
    const db = getDb();
    return db.prepare(`SELECT * FROM trabajos WHERE id = ?`).get(id) as Trabajo | null;
  },

  // Trabajo con contexto completo para breadcrumb y cabecera de documentos
  findWithContext(id: string): TrabajoConContexto | null {
    const db = getDb();
    return db.prepare(`
      SELECT
        t.id, t.nombre, t.descripcion, t.margen_porcentaje, t.estado,
        t.agrupador_id, t.created_at, t.updated_at,
        a.label as agrupador_label,
        c.id as cliente_id, c.nombre as cliente_nombre, c.empresa as cliente_empresa
      FROM trabajos t
      JOIN agrupadores a ON a.id = t.agrupador_id
      JOIN clientes c ON c.id = a.cliente_id
      WHERE t.id = ?
    `).get(id) as TrabajoConContexto | null;
  },

  create(data: {
    agrupador_id: string;
    nombre: string;
    descripcion?: string;
    margen_porcentaje?: number;
  }): Trabajo {
    const db = getDb();
    const config = getAppConfig();
    const id = uuidv4();
    const now = new Date().toISOString();
    const margen = data.margen_porcentaje ?? config.documentos.margen_defecto;

    db.prepare(`
      INSERT INTO trabajos (id, agrupador_id, nombre, descripcion, margen_porcentaje, estado, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'activo', ?, ?)
    `).run(id, data.agrupador_id, data.nombre, data.descripcion ?? null, margen, now, now);

    return this.findById(id)!;
  },

  update(id: string, data: {
    nombre?: string;
    descripcion?: string;
    margen_porcentaje?: number;
    estado?: string;
  }): Trabajo | null {
    const db = getDb();
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE trabajos SET
        nombre = COALESCE(?, nombre),
        descripcion = COALESCE(?, descripcion),
        margen_porcentaje = COALESCE(?, margen_porcentaje),
        estado = COALESCE(?, estado),
        updated_at = ?
      WHERE id = ?
    `).run(
      data.nombre ?? null,
      data.descripcion ?? null,
      data.margen_porcentaje ?? null,
      data.estado ?? null,
      now, id
    );

    return this.findById(id);
  },

  // Albaranes asignados a este trabajo (para la sección interna)
  findAlbaranes(trabajoId: string) {
    const db = getDb();
    return db.prepare(`
      SELECT DISTINCT
        al.id, al.proveedor_nombre, al.numero, al.fecha, al.notas, al.created_at,
        COUNT(alt.id) as lineas_asignadas
      FROM albaranes al
      JOIN albaran_lineas alinea ON alinea.albaran_id = al.id
      JOIN albaran_linea_trabajo alt ON alt.albaran_linea_id = alinea.id
      WHERE alt.trabajo_id = ?
      GROUP BY al.id
      ORDER BY al.fecha DESC
    `).all(trabajoId);
  }
};