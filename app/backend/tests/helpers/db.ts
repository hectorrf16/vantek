/**
 * ──────────────────────────────────────────────────────────────────────────────
 * db.ts — Test helpers over the shared SQLite handle
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Exposes the same singleton DB used by the services (so writes are visible to
 *   the code under test), a limpiarBd() that truncates every business table
 *   between tests, and small seed helpers to create clientes/agrupadores/
 *   trabajos/albaranes/seguimiento fixtures.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @db/connection (getDb) → the same handle the services use
 *     · uuid (v4) → fixture ids
 *   Used by:
 *     · the test suites → reset state + arrange fixtures
 *
 * NOTES
 *   · limpiarBd deletes child→parent so foreign keys never block.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import type BetterSqlite3 from 'better-sqlite3';
import { getDb } from '@db/connection';
import { v4 as uuidv4 } from 'uuid';

const TABLAS = [
  'factura_versiones', 'factura_lineas', 'facturas',
  'presupuesto_versiones', 'presupuesto_lineas', 'presupuestos',
  'albaran_linea_trabajo', 'albaran_lineas', 'albaranes',
  'obra_pagos',
  'seguimiento', 'trabajos', 'agrupadores', 'clientes', 'proveedores',
  'errores',
];

export function limpiarBd(): void {
  const db = getDb();
  for (const t of TABLAS) db.prepare(`DELETE FROM ${t}`).run();
}

export function db(): BetterSqlite3.Database {
  return getDb();
}

export function crearCliente(over: Partial<{ nombre: string; dni_cif: string; telefono: string }> = {}): string {
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO clientes (id, nombre, dni_cif, telefono, activo, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(id, over.nombre ?? 'Cliente Test', over.dni_cif ?? null, over.telefono ?? null);
  return id;
}

export function crearAgrupador(clienteId: string, label = 'Calle Falsa 123'): string {
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO agrupadores (id, cliente_id, label, activo, created_at, updated_at)
    VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(id, clienteId, label);
  return id;
}

export function crearTrabajo(agrupadorId: string, over: Partial<{ nombre: string; margen: number }> = {}): string {
  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO trabajos (id, agrupador_id, nombre, margen_porcentaje, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, agrupadorId, over.nombre ?? 'Obra Test', over.margen ?? 20);
  return id;
}

export function crearAlbaranConLinea(over: Partial<{ descripcion: string; precio: number; cantidad: number }> = {}): { albaranId: string; lineaId: string } {
  const albaranId = uuidv4();
  const lineaId = uuidv4();
  const d = getDb();
  d.prepare(`
    INSERT INTO albaranes (id, proveedor_nombre, numero, fecha, created_at, updated_at)
    VALUES (?, 'Proveedor Test', 'A-1', date('now'), datetime('now'), datetime('now'))
  `).run(albaranId);
  d.prepare(`
    INSERT INTO albaran_lineas (id, albaran_id, descripcion, cantidad, precio_unitario, orden)
    VALUES (?, ?, ?, ?, ?, 0)
  `).run(lineaId, albaranId, over.descripcion ?? 'Material', over.cantidad ?? 1, over.precio ?? 100);
  return { albaranId, lineaId };
}

export function asignarLineaATrabajo(lineaId: string, trabajoId: string): void {
  getDb().prepare(`
    INSERT INTO albaran_linea_trabajo (id, albaran_linea_id, trabajo_id) VALUES (?, ?, ?)
  `).run(uuidv4(), lineaId, trabajoId);
}
