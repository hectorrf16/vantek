/**
 * ──────────────────────────────────────────────────────────────────────────────
 * validacion.ts — Esquemas zod para los endpoints que escriben dinero
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Validates the request bodies that end up in monetary columns. Routers used
 *   to pass req.body straight to SQL, so a malformed payload either produced an
 *   opaque 500 from a CHECK/NOT NULL constraint or silently wrote NaN/null.
 *
 * RELATIONSHIPS
 *   Imports: zod
 *   Used by: routes/facturas.router.ts, routes/presupuestos.router.ts,
 *            routes/pagos.router.ts
 *
 * EXPORTS
 *   · lineasSchema → array of document lines
 *   · pagoSchema   → advance payment
 *   · parsear(schema, body) → parsed value, or throws Error with statusCode 400
 *
 * NOTES
 *   · errorHandler turns a ZodError into a 400; parsear() gives a message the
 *     user can actually act on instead of the raw issue dump.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';

const numeroFinito = z.number().finite();

export const lineaSchema = z.object({
  descripcion: z.string().min(1, 'La descripción no puede estar vacía'),
  detalle: z.string().nullish(),
  cantidad: numeroFinito.positive('La cantidad debe ser mayor que cero'),
  unidad: z.string().nullish(),
  precio_unitario: numeroFinito.min(0, 'El precio no puede ser negativo'),
  coste_unitario: numeroFinito.min(0).nullish(),
  margen_porcentaje: numeroFinito.nullish(),
  tipo: z.enum(['material', 'manual', 'concepto']),
  es_libre: z.boolean().optional(),
  albaran_linea_id: z.string().nullish(),
});

export const lineasSchema = z.array(lineaSchema);

export const pagoSchema = z.object({
  tipo: z.enum(['fijo', 'porcentaje']),
  valor: numeroFinito.positive('El importe debe ser mayor que cero'),
  base: numeroFinito.min(0).nullish(),
  nota: z.string().nullish(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida').optional(),
});

export function parsear<T>(schema: z.ZodType<T>, body: unknown): T {
  const resultado = schema.safeParse(body);
  if (resultado.success) return resultado.data;

  const primero = resultado.error.issues[0];
  const ruta = primero.path.length ? `${primero.path.join('.')}: ` : '';
  const err = new Error(`${ruta}${primero.message}`) as Error & { statusCode?: number };
  err.statusCode = 400;
  throw err;
}
