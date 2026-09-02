/**
 * ──────────────────────────────────────────────────────────────────────────────
 * dinero.ts — Redondeo y totales monetarios (única fuente de verdad del backend)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Single rounding policy for every monetary amount: half-up to cents. Also
 *   computes document totals so that, by construction, base + IVA === total
 *   (the printed invoice can never be off by a cent).
 *
 * RELATIONSHIPS
 *   Imports: (none)
 *   Used by:
 *     · services/facturas.service.ts, services/presupuestos.service.ts → totals
 *     · services/pagos.service.ts → resolves percentage payments to euros
 *
 * EXPORTS
 *   · redondear(n) → half-up rounding to cents
 *   · totalesDocumento(lineas, ivaPorcentaje) → { subtotal, iva, total }
 *
 * NOTES
 *   · Keep in sync with app/frontend/src/utils/dinero.ts (same policy, same
 *     results). A divergence shows up as a cent of difference between the
 *     editor, the listing and the PDF.
 *   · toFixed(2) is NOT used: binary floats round half-cents down
 *     ((8.575).toFixed(2) === '8.57'), which silently underprices lines.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** Redondeo a céntimos, medio hacia arriba. */
export function redondear(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const escalado = n * 100;
  // El épsilon corrige el error binario de casos como 8.575*100 = 857.4999…
  return Math.round(escalado + (escalado >= 0 ? Number.EPSILON * Math.abs(escalado) : -Number.EPSILON * Math.abs(escalado))) / 100;
}

export interface LineaImporte {
  precio_unitario: number;
  cantidad: number;
}

/**
 * Totales de un documento. El IVA se calcula sobre la base YA redondeada y el
 * total es la suma de ambos redondeados, de modo que base + IVA = total exacto.
 */
export function totalesDocumento(lineas: LineaImporte[], ivaPorcentaje = 0) {
  const subtotal = redondear(
    lineas.reduce((acc, l) => acc + redondear(l.precio_unitario * l.cantidad), 0)
  );
  const iva = redondear(subtotal * (ivaPorcentaje / 100));
  return { subtotal, iva, total: redondear(subtotal + iva) };
}
