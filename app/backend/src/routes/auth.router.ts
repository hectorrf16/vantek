/**
 * ──────────────────────────────────────────────────────────────────────────────
 * auth.router.ts — Endpoints de acceso (login, logout, contraseña)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Exposes the session lifecycle so the SPA can show a login screen and the
 *   Configuración → Sistema panel can enable, change or disable the password.
 *
 * RELATIONSHIPS
 *   Imports: express, @middleware/errorHandler (asyncHandler),
 *            @middleware/auth (leerCookie), @services/auth.service
 *   Used by: index.ts → app.use('/api/auth', authRouter)
 *
 * ENDPOINTS
 *   · GET  /estado           → { configurado, autenticado }
 *   · POST /login            → { password } → sets the session cookie
 *   · POST /logout           → clears the cookie
 *   · POST /password         → { nueva, actual? } sets or changes the password
 *   · DELETE /password       → { actual } disables password access
 *
 * NOTES
 *   · The cookie is HttpOnly + SameSite=Lax; it is never readable from JS.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { asyncHandler } from '@middleware/errorHandler';
import { leerCookie } from '@middleware/auth';
import {
  COOKIE_SESION,
  DURACION_SESION_SEGUNDOS,
  authConfigurado,
  crearToken,
  establecerPassword,
  quitarPassword,
  verificarPassword,
  verificarToken,
} from '@services/auth.service';

const router = Router();

function opcionesCookie(seguro: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: seguro,
    maxAge: DURACION_SESION_SEGUNDOS * 1000,
  };
}

router.get('/estado', asyncHandler(async (req, res) => {
  const configurado = authConfigurado();
  res.json({
    configurado,
    autenticado: !configurado || verificarToken(leerCookie(req, COOKIE_SESION)),
  });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const password = String(req.body?.password ?? '');
  if (!authConfigurado()) {
    res.json({ ok: true, configurado: false });
    return;
  }
  if (!verificarPassword(password)) {
    res.status(401).json({ error: 'Contraseña incorrecta' });
    return;
  }
  res.cookie(COOKIE_SESION, crearToken(), opcionesCookie(req.secure));
  res.json({ ok: true });
}));

router.post('/logout', asyncHandler(async (_req, res) => {
  res.clearCookie(COOKIE_SESION, { path: '/' });
  res.json({ ok: true });
}));

router.post('/password', asyncHandler(async (req, res) => {
  const nueva = String(req.body?.nueva ?? '');
  const actual = req.body?.actual != null ? String(req.body.actual) : undefined;
  establecerPassword(nueva, actual);
  // Tras establecerla, dejamos la sesión iniciada para no expulsar al usuario.
  res.cookie(COOKIE_SESION, crearToken(), opcionesCookie(req.secure));
  res.json({ ok: true });
}));

router.delete('/password', asyncHandler(async (req, res) => {
  quitarPassword(String(req.body?.actual ?? ''));
  res.clearCookie(COOKIE_SESION, { path: '/' });
  res.json({ ok: true });
}));

export default router;
