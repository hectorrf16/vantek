/**
 * ──────────────────────────────────────────────────────────────────────────────
 * format.ts — Formateo de moneda y fechas
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Single definition of the currency and date formatters that were previously
 *   re-implemented in eight different pages, with slightly different options.
 *
 * RELATIONSHIPS
 *   Imports: (none)
 *   Used by: listing pages, document editor, dashboard, seguimiento, pagos
 *
 * EXPORTS
 *   · fmt(n) → '1.234,56 €'
 *   · fmtFecha(s) → '31/12/2026' ('—' when there is no date)
 *   · hoyISO() → 'YYYY-MM-DD' in local time
 * ──────────────────────────────────────────────────────────────────────────────
 */

const MONEDA = new Intl.NumberFormat('es-ES', {
  style: 'currency',
  currency: 'EUR',
});

export function fmt(n: number | null | undefined): string {
  return MONEDA.format(Number(n) || 0);
}

export function fmtFecha(valor: string | null | undefined): string {
  if (!valor) return '—';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return String(valor);
  return d.toLocaleDateString('es-ES');
}

/** Fecha de hoy en hora local; toISOString() daría el día UTC (ayer de madrugada). */
export function hoyISO(fecha: Date = new Date()): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
