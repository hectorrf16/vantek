/**
 * ──────────────────────────────────────────────────────────────────────────────
 * auth.service.test.ts — Contraseña de acceso y tokens de sesión
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './helpers/db';
import {
  authConfigurado, establecerPassword, verificarPassword,
  crearToken, verificarToken, quitarPassword,
} from '@services/auth.service';

beforeEach(() => { db().prepare('DELETE FROM usuarios').run(); });

describe('auth', () => {
  it('starts unconfigured (open LAN mode)', () => {
    expect(authConfigurado()).toBe(false);
    expect(verificarToken(undefined)).toBe(false);
  });

  it('sets a password and validates it', () => {
    establecerPassword('secreto123');
    expect(authConfigurado()).toBe(true);
    expect(verificarPassword('secreto123')).toBe(true);
    expect(verificarPassword('otra')).toBe(false);
  });

  it('rejects short passwords', () => {
    expect(() => establecerPassword('123')).toThrow(/6 caracteres/);
  });

  it('requires the current password to change it', () => {
    establecerPassword('secreto123');
    expect(() => establecerPassword('nuevo1234', 'incorrecta')).toThrow(/actual/i);
    establecerPassword('nuevo1234', 'secreto123');
    expect(verificarPassword('nuevo1234')).toBe(true);
  });

  it('issues a token that only validates while the password exists', () => {
    establecerPassword('secreto123');
    const token = crearToken();
    expect(verificarToken(token)).toBe(true);

    const [id, expira, firma] = token.split('.');
    const firmaAlterada = firma.slice(0, -1) + (firma.endsWith('a') ? 'b' : 'a');
    expect(verificarToken(`${id}.${expira}.${firmaAlterada}`)).toBe(false);
    expect(verificarToken(`${id}.${Date.now() - 1000}.${firma}`)).toBe(false);

    quitarPassword('secreto123');
    expect(authConfigurado()).toBe(false);
    expect(verificarToken(token)).toBe(false);
  });
});
