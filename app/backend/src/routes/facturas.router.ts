/**
 * ──────────────────────────────────────────────────────────────────────────────
 * facturas.router.ts — Invoices (facturas) REST router
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Express router mounted at /api/facturas. Handles invoice lifecycle: list,
 *   detail, create (optionally importing a presupuesto), line saving, autosave,
 *   close (assign number), state changes, PDF generation/serving and email send.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @services/facturas.service (* as svc) → all invoice logic
 *     · @services/pdf.service (generarPdf) → render PDF with Puppeteer
 *     · @services/email.service (enviarFactura) → email the invoice
 *     · @utils/paths (PDFS_DIR) → resolve stored PDF files
 *   Used by:
 *     · index.ts → app.use('/api/facturas', router)
 *
 * ENDPOINTS
 *   · GET    /                 → list (?trabajo_id/estado/cliente_id)
 *   · GET    /:id              → detail (404 if missing)
 *   · POST   /                 → create (trabajo_id required; imports presupuesto)
 *   · PUT    /:id/lineas        → save lines
 *   · POST   /desde-albaran     → add albarán lines to the trabajo draft invoice
 *   · POST   /:id/borrador      → autosave draft
 *   · POST   /:id/cerrar        → close & assign number (422 on validation fail)
 *   · POST   /:id/estado        → change state (entregada/pendiente_pago/pagada/reopen)
 *   · POST   /:id/pdf           → generate PDF + store version
 *   · GET    /:id/pdf/latest    → serve latest PDF (404 if none)
 *   · POST   /:id/enviar        → email invoice then set estado=entregada
 *   · DELETE /:id              → delete invoice
 *
 * INPUTS / OUTPUTS
 *   Input:  HTTP req params/query/body
 *   Output: JSON factura data / { ok } / file (PDF) / { error }
 *
 * NOTES
 *   · Close business rules live in the frontend; backend only rejects if the
 *     document doesn't exist or isn't a borrador.
 *   · default export = the configured Router.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import path from 'path';
import { asyncHandler } from '@middleware/errorHandler';
import * as svc from '@services/facturas.service';
import { generarPdf } from '@services/pdf.service';
import { enviarFactura } from '@services/email.service';
import { PDFS_DIR } from '@utils/paths';
import { lineasSchema, parsear } from '@utils/validacion';

const router = Router();

// Listado
router.get('/', asyncHandler(async (req, res) => {
  const { trabajo_id, estado, cliente_id } = req.query as Record<string, string>;
  const datos = await svc.listarFacturas({
    trabajo_id,
    estado: estado as svc.EstadoFactura,
    cliente_id,
  });
  res.json(datos);
}));

// Detalle
router.get('/:id', asyncHandler(async (req, res) => {
  const datos = await svc.obtenerFactura(req.params.id);
  if (!datos) return res.status(404).json({ error: 'Factura no encontrada' });
  res.json(datos);
}));

// Crear
router.post('/', asyncHandler(async (req, res) => {
  const { trabajo_id, fecha, notas, presupuesto_origen_id, lineas } = req.body;
  if (!trabajo_id) return res.status(400).json({ error: 'trabajo_id es obligatorio' });
  const datos = await svc.crearFactura({
    trabajo_id, fecha, notas, presupuesto_origen_id, lineas,
  });
  res.status(201).json(datos);
}));

// Guardar líneas
router.put('/:id/lineas', asyncHandler(async (req, res) => {
  const lineas = parsear(lineasSchema, req.body?.lineas);
  await svc.guardarLineas(req.params.id, lineas as any);
  const datos = await svc.obtenerFactura(req.params.id);
  res.json(datos);
}));

// Añadir líneas de albarán a la factura borrador del trabajo (crea borrador si no hay)
// body: { trabajo_id, albaran_linea_ids }
router.post('/desde-albaran', asyncHandler(async (req, res) => {
  const { trabajo_id, albaran_linea_ids } = req.body;
  if (!trabajo_id) return res.status(400).json({ error: 'trabajo_id es obligatorio' });
  if (!Array.isArray(albaran_linea_ids) || albaran_linea_ids.length === 0) {
    return res.status(400).json({ error: 'albaran_linea_ids debe ser un array no vacío' });
  }
  try {
    const resultado = await svc.agregarLineasDesdeAlbaran(trabajo_id, albaran_linea_ids);
    res.json(resultado);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message ?? 'No se pudieron añadir las líneas' });
  }
}));

// Autoguardado
router.post('/:id/borrador', asyncHandler(async (req, res) => {
  await svc.guardarBorrador(req.params.id, req.body);
  res.json({ ok: true });
}));

// Cerrar factura (con verificaciones)
router.post('/:id/cerrar', asyncHandler(async (req, res) => {
  const resultado = await svc.cerrarFactura(req.params.id);

  if (!resultado.ok) {
    return res.status(422).json({ error: (resultado as any).error });
  }

  // Si hay aviso pero no es bloqueante, lo incluimos en la respuesta
  res.json(resultado);
}));

// Cambiar estado (entregada, pendiente_pago, pagada, borrador para reabrir)
router.post('/:id/estado', asyncHandler(async (req, res) => {
  const { estado } = req.body;
  if (!estado) return res.status(400).json({ error: 'estado es obligatorio' });
  const datos = await svc.cambiarEstado(req.params.id, estado);
  res.json(datos);
}));

// Generar PDF y versión
router.post('/:id/pdf', asyncHandler(async (req, res) => {
  const factura = await svc.obtenerFactura(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

  const pdfPath = await generarPdf(factura, 'factura');
  const version = await svc.guardarVersion(req.params.id, pdfPath);

  res.json({ ok: true, pdf_path: pdfPath, version });
}));

// Servir PDF
router.get('/:id/pdf/latest', asyncHandler(async (req, res) => {
  const factura = await svc.obtenerFactura(req.params.id);
  if (!factura || !factura.versiones.length) {
    return res.status(404).json({ error: 'Sin PDF disponible' });
  }
  const ultima = factura.versiones[0] as { pdf_path: string };
  res.sendFile(path.join(PDFS_DIR, path.basename(ultima.pdf_path)));
}));

// Enviar por email
router.post('/:id/enviar', asyncHandler(async (req, res) => {
  const { email_destino } = req.body;
  const factura = await svc.obtenerFactura(req.params.id);
  if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

  const dest = email_destino || (factura as Record<string, unknown>).cliente_email;
  if (!dest) return res.status(400).json({ error: 'No hay email de destino' });

  await enviarFactura(factura as any, dest as string);
  await svc.cambiarEstado(req.params.id, 'entregada');

  res.json({ ok: true });
}));

// Eliminar
router.delete('/:id', asyncHandler(async (req, res) => {
  await svc.eliminarFactura(req.params.id);
  res.json({ ok: true });
}));

export default router;