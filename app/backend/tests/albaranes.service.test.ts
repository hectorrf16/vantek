/**
 * ──────────────────────────────────────────────────────────────────────────────
 * albaranes.service.test.ts — Estado calculado y asignaciones por línea
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import {
  limpiarBd, db, crearCliente, crearAgrupador, crearTrabajo, asignarLineaATrabajo,
} from './helpers/db';
import { albanesService as albaranesService } from '@services/albaranes.service';

beforeEach(() => limpiarBd());

function albaranConLineas(n: number): { albaranId: string; lineaIds: string[] } {
  const albaranId = uuidv4();
  const d = db();
  d.prepare(`
    INSERT INTO albaranes (id, proveedor_nombre, numero, fecha, created_at, updated_at)
    VALUES (?, 'Proveedor Test', 'A-1', date('now'), datetime('now'), datetime('now'))
  `).run(albaranId);

  const lineaIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = uuidv4();
    d.prepare(`
      INSERT INTO albaran_lineas (id, albaran_id, descripcion, cantidad, precio_unitario, orden)
      VALUES (?, ?, ?, 1, 10, ?)
    `).run(id, albaranId, `Línea ${i}`, i);
    lineaIds.push(id);
  }
  return { albaranId, lineaIds };
}

describe('findAll — estado calculado', () => {
  it('reports parcial for a partially assigned albarán, with a single row', () => {
    const trabajoId = crearTrabajo(crearAgrupador(crearCliente()));
    const { lineaIds } = albaranConLineas(3);
    asignarLineaATrabajo(lineaIds[0], trabajoId);

    const filas = albaranesService.findAll() as { id: string; estado: string }[];
    expect(filas).toHaveLength(1);          // antes salía duplicado
    expect(filas[0].estado).toBe('parcial'); // antes era inalcanzable
  });

  it('reports sin_asignar and asignado at the extremes', () => {
    const trabajoId = crearTrabajo(crearAgrupador(crearCliente()));
    const { lineaIds } = albaranConLineas(2);
    expect((albaranesService.findAll() as any[])[0].estado).toBe('sin_asignar');

    lineaIds.forEach(id => asignarLineaATrabajo(id, trabajoId));
    expect((albaranesService.findAll() as any[])[0].estado).toBe('asignado');
  });
});

describe('findById — asignaciones por línea', () => {
  it('keeps id↔nombre paired when the trabajo name contains a comma', () => {
    const trabajoId = crearTrabajo(crearAgrupador(crearCliente()), {
      nombre: 'Reforma cocina, 2ª fase',
    });
    const { albaranId, lineaIds } = albaranConLineas(1);
    asignarLineaATrabajo(lineaIds[0], trabajoId);

    const albaran = albaranesService.findById(albaranId)!;
    const asignados = albaran.lineas![0].trabajos_asignados!;
    expect(asignados).toHaveLength(1);
    expect(asignados[0].trabajo_id).toBe(trabajoId);
    expect(asignados[0].trabajo_nombre).toBe('Reforma cocina, 2ª fase');
  });
});
