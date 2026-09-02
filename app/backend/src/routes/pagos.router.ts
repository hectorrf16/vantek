/**
 * ──────────────────────────────────────────────────────────────────────────────
 * pagos.router.ts — Anticipos / pagos por obra REST router
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Express router mounted at /api/trabajos/:trabajoId/pagos. Lists, creates and
 *   deletes the advance-payment ledger of an obra, delegating to PagosService.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · express (Router) → routing (mergeParams to read :trabajoId)
 *     · ../middleware/errorHandler (asyncHandler) → wrap async routes
 *     · ../services/pagos.service (* as PagosService) → all logic
 *   Used by:
 *     · index.ts → app.use('/api/trabajos/:trabajoId/pagos', router)
 *
 * ENDPOINTS
 *   · GET    /        → list payments of the obra + { total }
 *   · POST   /        → add a payment (tipo/valor[/base/nota/fecha]); 404 if obra missing
 *   · DELETE /:pagoId → delete a payment (204; 404 if not found)
 *
 * INPUTS / OUTPUTS
 *   Input:  :trabajoId param + payment body
 *   Output: JSON { data, total } / created payment / 204 / { error }
 *
 * NOTES
 *   · Service errors carry statusCode → HTTP code (404 unknown obra).
 *   · default export = the configured Router.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import * as PagosService from '../services/pagos.service';
import { pagoSchema, parsear } from '../utils/validacion';

const router = Router({ mergeParams: true });

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const trabajoId = req.params.trabajoId;
    const data = PagosService.listarPagos(trabajoId);
    const total = PagosService.totalPagos(trabajoId);
    res.json({ data, total });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const trabajoId = req.params.trabajoId;
    const datos = parsear(pagoSchema, req.body ?? {});
    const pago = PagosService.crearPago(trabajoId, {
      tipo: datos.tipo,
      valor: datos.valor,
      base: datos.base ?? null,
      nota: datos.nota ?? undefined,
      fecha: datos.fecha,
    });
    res.status(201).json({ data: pago });
  })
);

router.delete(
  '/:pagoId',
  asyncHandler(async (req, res) => {
    const ok = PagosService.eliminarPago(req.params.trabajoId, req.params.pagoId);
    if (!ok) return res.status(404).json({ error: 'Pago no encontrado' });
    res.status(204).end();
  })
);

export default router;
