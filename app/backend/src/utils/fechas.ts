/**
 * ──────────────────────────────────────────────────────────────────────────────
 * fechas.ts — Fechas de negocio en hora local
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Produces the "today" of the business (local timezone of the machine), not
 *   the UTC date. new Date().toISOString().slice(0,10) returns the UTC day, so
 *   between midnight and 01:00/02:00 Spanish time it stamps documents with
 *   YESTERDAY's date.
 *
 * RELATIONSHIPS
 *   Imports: (none)
 *   Used by: services/facturas.service.ts, services/presupuestos.service.ts,
 *            services/pagos.service.ts → default document dates
 *
 * EXPORTS
 *   · hoyISO() → 'YYYY-MM-DD' in local time
 *
 * NOTES
 *   · Keep in sync with app/frontend/src/utils/fechas.ts.
 * ──────────────────────────────────────────────────────────────────────────────
 */

export function hoyISO(fecha: Date = new Date()): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
