/**
 * ──────────────────────────────────────────────────────────────────────────────
 * presupuestos.router.ts — Quotes (presupuestos) REST router
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Express router mounted at /api/presupuestos. Handles quote lifecycle: list,
 *   detail, create, header/line saving, autosave, state changes, PDF
 *   generation/serving and email send (auto-generating a PDF when needed).
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @services/presupuestos.service (* as svc, guardarVersion) → all logic
 *     · @services/pdf.service (generarPdf) → render PDF with Puppeteer
 *     · @services/email.service (enviarPresupuesto) → email the quote
 *     · @utils/paths (PDFS_DIR) → resolve stored PDF files
 *   Used by:
 *     · index.ts → app.use('/api/presupuestos', router)
 *
 * ENDPOINTS
 *   · GET    /              → list (?trabajo_id/estado/cliente_id)
 *   · GET    /:id           → detail (404 if missing)
 *   · POST   /              → create (trabajo_id required)
 *   · PUT    /:id           → update header (notas, fecha)
 *   · PUT    /:id/lineas     → save lines
 *   · POST   /:id/borrador   → autosave draft
 *   · POST   /:id/estado     → change state (syncs linked seguimiento)
 *   · POST   /:id/pdf        → generate PDF + store version
 *   · GET    /:id/pdf/latest → serve latest PDF (404 if none)
 *   · POST   /:id/enviar     → email quote then set estado=enviado
 *   · DELETE /:id           → delete quote
 *
 * INPUTS / OUTPUTS
 *   Input:  HTTP req params/query/body
 *   Output: JSON presupuesto data / { ok } / file (PDF) / { error }
 *
 * NOTES
 *   · Presupuestos carry no IVA in the total and use the same editor/template
 *     as facturas (watermark differs).
 *   · default export = the configured Router.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import path from 'path';
import { asyncHandler } from '@middleware/errorHandler';
import * as svc from '@services/presupuestos.service';
import { generarPdf } from '@services/pdf.service';
import { guardarVersion } from '@services/presupuestos.service';
import { enviarPresupuesto } from '@services/email.service';
import { PDFS_DIR } from '@utils/paths';
import { lineasSchema, parsear } from '@utils/validacion';

const router = Router();

// Listado
router.get('/', asyncHandler(async (req, res) => {
  const { trabajo_id, estado, cliente_id } = req.query as Record<string, string>;
  const datos = await svc.listarPresupuestos({ trabajo_id, estado: estado as svc.EstadoPresupuesto, cliente_id });
  res.json(datos);
}));

// Detalle
router.get('/:id', asyncHandler(async (req, res) => {
  const datos = await svc.obtenerPresupuesto(req.params.id);
  if (!datos) return res.status(404).json({ error: 'Presupuesto no encontrado' });
  res.json(datos);
}));

// Crear
router.post('/', asyncHandler(async (req, res) => {
  const { trabajo_id, fecha, notas, lineas } = req.body;
  if (!trabajo_id) return res.status(400).json({ error: 'trabajo_id es obligatorio' });
  const datos = await svc.crearPresupuesto({ trabajo_id, fecha, notas, lineas });
  res.status(201).json(datos);
}));

// Actualizar cabecera
router.put('/:id', asyncHandler(async (req, res) => {
  const { notas, fecha } = req.body;
  const datos = await svc.actualizarPresupuesto(req.params.id, { notas, fecha });
  res.json(datos);
}));

// Guardar líneas (save explícito)
router.put('/:id/lineas', asyncHandler(async (req, res) => {
  const lineas = parsear(lineasSchema, req.body?.lineas);
  await svc.guardarLineas(req.params.id, lineas as any);
  const datos = await svc.obtenerPresupuesto(req.params.id);
  res.json(datos);
}));

// Autoguardado de borrador
router.post('/:id/borrador', asyncHandler(async (req, res) => {
  await svc.guardarBorrador(req.params.id, req.body);
  res.json({ ok: true });
}));

// Cambiar estado
router.post('/:id/estado', asyncHandler(async (req, res) => {
  const { estado } = req.body;
  if (!estado) return res.status(400).json({ error: 'estado es obligatorio' });
  const datos = await svc.cambiarEstado(req.params.id, estado);
  res.json(datos);
}));

// Generar PDF y guardar versión
router.post('/:id/pdf', asyncHandler(async (req, res) => {
  const presupuesto = await svc.obtenerPresupuesto(req.params.id);
  if (!presupuesto) return res.status(404).json({ error: 'Presupuesto no encontrado' });

  const pdfPath = await generarPdf(presupuesto, 'presupuesto');
  const version = await guardarVersion(req.params.id, pdfPath);

  res.json({ ok: true, pdf_path: pdfPath, version });
}));

// Servir PDF por path relativo
router.get('/:id/pdf/latest', asyncHandler(async (req, res) => {
  const presupuesto = await svc.obtenerPresupuesto(req.params.id);
  if (!presupuesto || !presupuesto.versiones.length) {
    return res.status(404).json({ error: 'Sin PDF disponible' });
  }
  const ultima = presupuesto.versiones[0] as { pdf_path: string };
  res.sendFile(path.join(PDFS_DIR, path.basename(ultima.pdf_path)));
}));

// Enviar por email
router.post('/:id/enviar', asyncHandler(async (req, res) => {
  const { email_destino } = req.body;
  let presupuesto = await svc.obtenerPresupuesto(req.params.id);
  if (!presupuesto) return res.status(404).json({ error: 'Presupuesto no encontrado' });

  const dest = email_destino || (presupuesto as Record<string, unknown>).cliente_email;
  if (!dest) {
    return res.status(400).json({
      error: 'El cliente no tiene email. Añade un email en su ficha o indícalo manualmente.',
    });
  }

  // Asegurar que existe un PDF para adjuntar; generarlo si no hay versiones.
  if (!presupuesto.versiones.length) {
    const pdfPath = await generarPdf(presupuesto, 'presupuesto');
    await guardarVersion(req.params.id, pdfPath);
    presupuesto = await svc.obtenerPresupuesto(req.params.id);
  }

  await enviarPresupuesto(presupuesto as any, dest as string);
  await svc.cambiarEstado(req.params.id, 'enviado');

  res.json({ ok: true });
}));

// Eliminar
router.delete('/:id', asyncHandler(async (req, res) => {
  await svc.eliminarPresupuesto(req.params.id);
  res.json({ ok: true });
}));

export default router;