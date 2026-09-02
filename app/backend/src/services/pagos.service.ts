/**
 * ──────────────────────────────────────────────────────────────────────────────
 * pagos.service.ts — Anticipos / pagos parciales por obra (trabajo)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Ledger of advance payments a cliente hands to the businessman for a given
 *   obra (trabajo). Handles a single upfront payment or several partial ones.
 *   Each entry is stored as resolved euros (importe); if entered as a percentage
 *   the tipo/valor/base are kept for display. The factura's "restante" is
 *   total-con-IVA minus the sum of these importes.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · uuid (v4) → payment IDs
 *     · @db/connection (getDb) → SQLite handle
 *   Used by:
 *     · routes/pagos.router.ts → exposes the per-obra payment endpoints
 *     · facturas.service.ts computes anticipo_total directly via SQL (no import)
 *
 * EXPORTS
 *   · listarPagos(trabajoId) → ObraPago[]
 *   · totalPagos(trabajoId) → number (sum of importe)
 *   · crearPago(trabajoId, data) → ObraPago (resolves importe from tipo/valor/base)
 *   · eliminarPago(trabajoId, pagoId) → boolean
 *
 * INPUTS / OUTPUTS
 *   Input:  trabajo id + payment data (tipo, valor, base, nota, fecha)
 *   Output: obra_pagos rows; computed importe in euros
 *
 * NOTES
 *   · importe is authoritative and stored rounded to cents. For 'porcentaje'
 *     it is valor% of the base the frontend passed (the current document total).
 *   · Deleting the parent trabajo cascades (ON DELETE CASCADE).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@db/connection';
import { redondear } from '@utils/dinero';
import { hoyISO } from '@utils/fechas';
import type { ObraPago, ObraPagoTipo } from '../types';

export function listarPagos(trabajoId: string): ObraPago[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, trabajo_id, tipo, valor, importe, base, nota, fecha, created_at
       FROM obra_pagos
       WHERE trabajo_id = ?
       ORDER BY fecha ASC, created_at ASC`
    )
    .all(trabajoId) as ObraPago[];
}

export function totalPagos(trabajoId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(importe), 0) AS total FROM obra_pagos WHERE trabajo_id = ?`
    )
    .get(trabajoId) as { total: number };
  return row.total;
}

export function crearPago(
  trabajoId: string,
  data: { tipo: ObraPagoTipo; valor: number; base?: number | null; nota?: string; fecha?: string }
): ObraPago {
  const db = getDb();

  const trabajo = db.prepare('SELECT id FROM trabajos WHERE id = ?').get(trabajoId);
  if (!trabajo) {
    const err = new Error('Trabajo no encontrado') as Error & { statusCode?: number };
    err.statusCode = 404;
    throw err;
  }

  const tipo: ObraPagoTipo = data.tipo === 'porcentaje' ? 'porcentaje' : 'fijo';
  const valor = Number(data.valor) || 0;
  const base = tipo === 'porcentaje' ? (Number(data.base) || 0) : null;
  const importe = tipo === 'porcentaje' ? redondear((valor / 100) * (base ?? 0)) : redondear(valor);

  const id = uuidv4();
  const fecha = data.fecha ?? hoyISO();

  db.prepare(
    `INSERT INTO obra_pagos (id, trabajo_id, tipo, valor, importe, base, nota, fecha)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, trabajoId, tipo, valor, importe, base, data.nota ?? null, fecha);

  return db
    .prepare(
      `SELECT id, trabajo_id, tipo, valor, importe, base, nota, fecha, created_at
       FROM obra_pagos WHERE id = ?`
    )
    .get(id) as ObraPago;
}

export function eliminarPago(trabajoId: string, pagoId: string): boolean {
  const db = getDb();
  const res = db
    .prepare('DELETE FROM obra_pagos WHERE id = ? AND trabajo_id = ?')
    .run(pagoId, trabajoId);
  return res.changes > 0;
}
