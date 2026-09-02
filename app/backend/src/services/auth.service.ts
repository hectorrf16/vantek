/**
 * ──────────────────────────────────────────────────────────────────────────────
 * auth.service.ts — Contraseña de acceso y sesiones
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Gives the previously unused `usuarios` table a purpose: it stores a single
 *   admin password (scrypt hash) that gates the whole API. Sessions are
 *   stateless HMAC tokens carried in an HttpOnly cookie, so no session store
 *   and no extra dependency is needed.
 *
 * RELATIONSHIPS
 *   Imports: node:crypto, node:fs, uuid, @db/connection, @utils/paths (DATA_DIR)
 *   Used by:
 *     · middleware/auth.ts → validates the cookie on every /api request
 *     · routes/auth.router.ts → login, logout, status and password change
 *
 * EXPORTS
 *   · authConfigurado() → is a password set?
 *   · establecerPassword(nueva, actual?) / verificarPassword(password)
 *   · crearToken() / verificarToken(token) / COOKIE_SESION
 *
 * NOTES
 *   · While no password is set the API stays open (the app has always worked
 *     that way on a LAN). The Configuración → Sistema panel lets the user turn
 *     it on, and from then on every endpoint requires a session.
 *   · The HMAC secret lives in data/.session-secret, NOT in app.config.json:
 *     PUT /api/config/app rewrites that file wholesale and would wipe it.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@db/connection';
import { DATA_DIR } from '@utils/paths';

export const COOKIE_SESION = 'vantek_sesion';

const DURACION_SESION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const SECRETO_PATH = path.join(DATA_DIR, '.session-secret');

interface UsuarioRow {
  id: string;
  email: string;
  password_hash: string;
}

function secreto(): string {
  try {
    if (fs.existsSync(SECRETO_PATH)) return fs.readFileSync(SECRETO_PATH, 'utf-8').trim();
  } catch { /* se regenera */ }
  const nuevo = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETO_PATH, nuevo, { mode: 0o600 });
  return nuevo;
}

function hashear(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function usuario(): UsuarioRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, email, password_hash FROM usuarios
       WHERE activo = 1 AND rol = 'admin'
       ORDER BY created_at ASC LIMIT 1`
    )
    .get() as UsuarioRow | undefined;
}

export function authConfigurado(): boolean {
  return Boolean(usuario());
}

export function verificarPassword(password: string): boolean {
  const u = usuario();
  if (!u) return false;

  const [salt, esperado] = u.password_hash.split(':');
  if (!salt || !esperado) return false;

  const calculado = hashear(password, salt);
  // timingSafeEqual exige longitudes iguales; los hex de scrypt siempre lo son.
  return (
    calculado.length === esperado.length &&
    crypto.timingSafeEqual(Buffer.from(calculado, 'hex'), Buffer.from(esperado, 'hex'))
  );
}

/**
 * Establece o cambia la contraseña. Si ya existe una, exige la actual: de otro
 * modo cualquiera podría reemplazarla y quedarse con el acceso.
 */
export function establecerPassword(nueva: string, actual?: string): void {
  if (!nueva || nueva.length < 6) {
    const e = new Error('La contraseña debe tener al menos 6 caracteres') as Error & { statusCode?: number };
    e.statusCode = 400;
    throw e;
  }

  const db = getDb();
  const existente = usuario();

  if (existente && !verificarPassword(actual ?? '')) {
    const e = new Error('La contraseña actual no es correcta') as Error & { statusCode?: number };
    e.statusCode = 401;
    throw e;
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = `${salt}:${hashear(nueva, salt)}`;

  if (existente) {
    db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hash, existente.id);
  } else {
    db.prepare(
      `INSERT INTO usuarios (id, nombre, email, password_hash, rol, activo)
       VALUES (?, 'Administrador', 'admin@vantek.local', ?, 'admin', 1)`
    ).run(uuidv4(), hash);
  }
}

/** Desactiva el acceso por contraseña (vuelve al modo abierto en LAN). */
export function quitarPassword(actual: string): void {
  if (!verificarPassword(actual)) {
    const e = new Error('La contraseña actual no es correcta') as Error & { statusCode?: number };
    e.statusCode = 401;
    throw e;
  }
  getDb().prepare('DELETE FROM usuarios').run();
}

export function crearToken(): string {
  const u = usuario();
  if (!u) return '';
  const expira = Date.now() + DURACION_SESION_MS;
  const cuerpo = `${u.id}.${expira}`;
  const firma = crypto.createHmac('sha256', secreto()).update(cuerpo).digest('hex');
  return `${cuerpo}.${firma}`;
}

export function verificarToken(token: string | undefined): boolean {
  if (!token) return false;
  const partes = token.split('.');
  if (partes.length !== 3) return false;

  const [id, expira, firma] = partes;
  const esperada = crypto
    .createHmac('sha256', secreto())
    .update(`${id}.${expira}`)
    .digest('hex');
  if (firma.length !== esperada.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(firma, 'hex'), Buffer.from(esperada, 'hex'))) return false;

  if (Number(expira) < Date.now()) return false;
  return usuario()?.id === id;
}

export const DURACION_SESION_SEGUNDOS = DURACION_SESION_MS / 1000;
