/**
 * ──────────────────────────────────────────────────────────────────────────────
 * auth.ts — Middleware de sesión para la API
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Blocks every API request that has no valid session cookie once an access
 *   password has been configured. Until then the API stays open, which is how
 *   the app has always behaved on a LAN.
 *
 * RELATIONSHIPS
 *   Imports: express types, @services/auth.service
 *   Used by: index.ts → app.use('/api', requireAuth) and the /pdfs static mount
 *
 * EXPORTS
 *   · leerCookie(req, nombre) → value of a cookie without extra dependencies
 *   · requireAuth → 401 for unauthenticated requests
 *
 * NOTES
 *   · Public paths: /auth/*, /status and /setup/status (needed to render the
 *     login screen and the first-run wizard).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Request, Response, NextFunction } from 'express';
import { COOKIE_SESION, authConfigurado, verificarToken } from '@services/auth.service';

const RUTAS_PUBLICAS = [/^\/auth(\/|$)/, /^\/status$/, /^\/setup\/status$/];

export function leerCookie(req: Request, nombre: string): string | undefined {
  const cabecera = req.headers.cookie;
  if (!cabecera) return undefined;
  for (const trozo of cabecera.split(';')) {
    const idx = trozo.indexOf('=');
    if (idx === -1) continue;
    if (trozo.slice(0, idx).trim() === nombre) {
      return decodeURIComponent(trozo.slice(idx + 1).trim());
    }
  }
  return undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!authConfigurado()) return next();
  if (RUTAS_PUBLICAS.some(r => r.test(req.path))) return next();
  if (verificarToken(leerCookie(req, COOKIE_SESION))) return next();
  return res.status(401).json({ error: 'Sesión no iniciada' });
}
