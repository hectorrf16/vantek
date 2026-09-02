/**
 * ──────────────────────────────────────────────────────────────────────────────
 * dinero.ts — Redondeo y totales monetarios del frontend
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Same rounding policy as the backend so the editor, the listings and the
 *   generated PDF never differ by a cent.
 *
 * RELATIONSHIPS
 *   Imports: (none)
 *   Used by: pages/Documentos/components/DocumentoEditor.tsx and any screen
 *            that derives a price from coste × margen
 *
 * EXPORTS
 *   · redondear(n) → half-up rounding to cents
 *   · totalesDocumento(lineas, ivaPorcentaje) → { subtotal, iva, total }
 *
 * NOTES
 *   · Mirror of app/backend/src/utils/dinero.ts — keep both in sync.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Redondeo a céntimos, medio hacia arriba. */
export function redondear(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const escalado = n * 100;
  const ajuste = Number.EPSILON * Math.abs(escalado);
  return Math.round(escalado + (escalado >= 0 ? ajuste : -ajuste)) / 100;
}

export interface LineaImporte {
  precio_unitario: number;
  cantidad: number;
}

export function totalesDocumento(lineas: LineaImporte[], ivaPorcentaje = 0) {
  const subtotal = redondear(
    lineas.reduce((acc, l) => acc + redondear(l.precio_unitario * l.cantidad), 0)
  );
  const iva = redondear(subtotal * (ivaPorcentaje / 100));
  return { subtotal, iva, total: redondear(subtotal + iva) };
}
