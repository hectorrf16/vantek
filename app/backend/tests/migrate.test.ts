/**
 * ──────────────────────────────────────────────────────────────────────────────
 * migrate.test.ts — Schema migrations reach v10 and are idempotent
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from 'vitest';
import { db } from './helpers/db';
import { runMigrations } from '@db/migrate';

describe('runMigrations', () => {
  it('applied all migrations up to v10 during setup', () => {
    const max = (db().prepare('SELECT MAX(version) AS v FROM _migraciones').get() as { v: number }).v;
    expect(max).toBe(10);
  });

  it('is idempotent — running again applies nothing and does not throw', () => {
    const antes = (db().prepare('SELECT COUNT(*) AS n FROM _migraciones').get() as { n: number }).n;
    expect(() => runMigrations()).not.toThrow();
    const despues = (db().prepare('SELECT COUNT(*) AS n FROM _migraciones').get() as { n: number }).n;
    expect(despues).toBe(antes);
  });

  it('created the facturas.anio_numero column (v7)', () => {
    const cols = (db().prepare(`PRAGMA table_info(facturas)`).all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('anio_numero');
  });

  it('created the cliente_incidencias table (v8)', () => {
    const tabla = db()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cliente_incidencias'`)
      .get() as { name: string } | undefined;
    expect(tabla?.name).toBe('cliente_incidencias');
  });

  it('created the obra_pagos table and line detalle columns (v9)', () => {
    const tabla = db()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'obra_pagos'`)
      .get() as { name: string } | undefined;
    expect(tabla?.name).toBe('obra_pagos');

    const fCols = (db().prepare(`PRAGMA table_info(factura_lineas)`).all() as { name: string }[]).map(c => c.name);
    const pCols = (db().prepare(`PRAGMA table_info(presupuesto_lineas)`).all() as { name: string }[]).map(c => c.name);
    expect(fCols).toContain('detalle');
    expect(pCols).toContain('detalle');
  });

  it('enforces a unique invoice series at DB level (v10)', () => {
    const idx = db()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_factura_serie'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('ux_factura_serie');
  });
});
