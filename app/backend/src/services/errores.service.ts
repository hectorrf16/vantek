/**
 * ──────────────────────────────────────────────────────────────────────────────
 * errores.service.ts — Registro y consulta de errores del servidor
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Persists 5xx errors in the `errores` table and offers query/count/
 *   deletion by date range. Feeds the error report that is sent by email
 *   to the technician from Configuración.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · uuid (v4) → ID of each error record
 *     · @db/connection (getDb) → SQLite handle
 *   Used by:
 *     · middleware/errorHandler.ts → registrarError() in the global handler
 *     · routes/config.router.ts → list/count/delete + report sending
 *
 * EXPORTS
 *   · registrarError(datos) → inserts an error (never throws)
 *   · listarErrores(desde?, hasta?) → ErrorRow[] for the range
 *   · contarErrores(desde?, hasta?) → number of errors in the range
 *   · borrarErrores(desde?, hasta?) → deleted rows (after a successful send)
 *   · (type) ErrorRow
 *
 * INPUTS / OUTPUTS
 *   Input:  error data / YYYY-MM-DD range; state of the errores table
 *   Output: ErrorRow rows, counters; INSERT/DELETE in SQLite
 *
 * NOTES
 *   · registrarError catches any exception: logging must not bring down the
 *     global error handler.
 *   · rangoFechas normalizes to SQLite datetime bounds (00:00:00 / 23:59:59).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@db/connection';

export interface ErrorRow {
  id: string;
  mensaje: string;
  stack: string | null;
  ruta: string | null;
  metodo: string | null;
  status: number | null;
  created_at: string;
}

// Registra un error en la base de datos. Nunca lanza: el logging de errores
// no debe poder tumbar el manejador global de errores.
export function registrarError(datos: {
  mensaje: string;
  stack?: string | null;
  ruta?: string | null;
  metodo?: string | null;
  status?: number | null;
}): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO errores (id, mensaje, stack, ruta, metodo, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv4(),
      datos.mensaje,
      datos.stack ?? null,
      datos.ruta ?? null,
      datos.metodo ?? null,
      datos.status ?? null
    );
  } catch (err) {
    console.error('[Errores] No se pudo registrar el error:', err);
  }
}

// Normaliza un rango de fechas (YYYY-MM-DD) a límites datetime SQLite.
function rangoFechas(desde?: string, hasta?: string): { desde: string; hasta: string } {
  const d = desde && /^\d{4}-\d{2}-\d{2}$/.test(desde) ? `${desde} 00:00:00` : '0000-01-01 00:00:00';
  const h = hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta) ? `${hasta} 23:59:59` : '9999-12-31 23:59:59';
  return { desde: d, hasta: h };
}

export function listarErrores(desde?: string, hasta?: string): ErrorRow[] {
  const db = getDb();
  const r = rangoFechas(desde, hasta);
  return db
    .prepare(
      `SELECT * FROM errores
       WHERE created_at BETWEEN ? AND ?
       ORDER BY created_at DESC`
    )
    .all(r.desde, r.hasta) as ErrorRow[];
}

export function contarErrores(desde?: string, hasta?: string): number {
  const db = getDb();
  const r = rangoFechas(desde, hasta);
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM errores WHERE created_at BETWEEN ? AND ?`)
    .get(r.desde, r.hasta) as { total: number };
  return row.total;
}

// Borra los errores de un rango de fechas. Se llama tras un envío correcto.
export function borrarErrores(desde?: string, hasta?: string): number {
  const db = getDb();
  const r = rangoFechas(desde, hasta);
  const info = db
    .prepare(`DELETE FROM errores WHERE created_at BETWEEN ? AND ?`)
    .run(r.desde, r.hasta);
  return info.changes;
}

// Poda de mantenimiento. Sin ella la tabla crece indefinidamente dentro de la
// base de datos de facturas: solo se vaciaba tras un envío manual con éxito,
// que es justo lo que falla cuando el problema recurrente es el propio SMTP.
const DIAS_RETENCION = 90;
const MAX_FILAS = 5000;

export function podarErrores(): number {
  try {
    const db = getDb();
    const antiguos = db
      .prepare(`DELETE FROM errores WHERE created_at < datetime('now', ?)`)
      .run(`-${DIAS_RETENCION} days`).changes;
    const excedente = db
      .prepare(
        `DELETE FROM errores WHERE id IN (
           SELECT id FROM errores ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )`
      )
      .run(MAX_FILAS).changes;
    return antiguos + excedente;
  } catch (err) {
    console.error('[Errores] No se pudo podar la tabla de errores:', err);
    return 0;
  }
}
