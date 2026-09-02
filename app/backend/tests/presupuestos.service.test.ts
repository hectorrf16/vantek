/**
 * ──────────────────────────────────────────────────────────────────────────────
 * presupuestos.service.test.ts — Totales, líneas transaccionales y borrado
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { limpiarBd, db, crearCliente, crearAgrupador, crearTrabajo } from './helpers/db';
import {
  crearPresupuesto, obtenerPresupuesto, guardarLineas, eliminarPresupuesto,
  cambiarEstado,
} from '@services/presupuestos.service';
import { crearFactura } from '@services/facturas.service';

beforeEach(() => limpiarBd());

function nuevoTrabajo(): string {
  return crearTrabajo(crearAgrupador(crearCliente()));
}

const LINEA = {
  descripcion: 'Partida', detalle: null, cantidad: 2, unidad: 'ud',
  precio_unitario: 10.005, coste_unitario: null, margen_porcentaje: null,
  tipo: 'concepto' as const,
};

describe('crearPresupuesto', () => {
  it('creates a borrador with no IVA in the total', async () => {
    const p = await crearPresupuesto({ trabajo_id: nuevoTrabajo(), lineas: [LINEA] });
    expect(p!.estado).toBe('borrador');
    // 2 × 10,005 → línea redondeada a 20,01; los presupuestos no llevan IVA.
    expect(p!.totales.total).toBe(p!.totales.subtotal);
    expect(p!.totales.total).toBe(20.01);
  });
});

describe('guardarLineas', () => {
  it('replaces the lines atomically', async () => {
    const p = await crearPresupuesto({ trabajo_id: nuevoTrabajo(), lineas: [LINEA] });
    await guardarLineas(p!.id, [{ ...LINEA, descripcion: 'Otra', precio_unitario: 5 }]);
    const actualizado = await obtenerPresupuesto(p!.id);
    expect(actualizado!.lineas).toHaveLength(1);
    expect(actualizado!.lineas[0].descripcion).toBe('Otra');
  });

  it('keeps the existing lines when an insert fails mid-way', async () => {
    const p = await crearPresupuesto({ trabajo_id: nuevoTrabajo(), lineas: [LINEA] });
    // descripcion es NOT NULL: la segunda inserción revienta la transacción.
    await expect(
      guardarLineas(p!.id, [
        { ...LINEA, descripcion: 'Válida' },
        { ...LINEA, descripcion: null as unknown as string },
      ])
    ).rejects.toThrow();

    const tras = await obtenerPresupuesto(p!.id);
    expect(tras!.lineas).toHaveLength(1);
    expect(tras!.lineas[0].descripcion).toBe('Partida');
  });
});

describe('eliminarPresupuesto', () => {
  it('deletes the presupuesto and its lines', async () => {
    const p = await crearPresupuesto({ trabajo_id: nuevoTrabajo(), lineas: [LINEA] });
    await eliminarPresupuesto(p!.id);
    expect(await obtenerPresupuesto(p!.id)).toBeNull();
    const n = (db().prepare('SELECT COUNT(*) AS n FROM presupuesto_lineas').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('refuses (409) when a factura was generated from it', async () => {
    const trabajoId = nuevoTrabajo();
    const p = await crearPresupuesto({ trabajo_id: trabajoId, lineas: [LINEA] });
    await crearFactura({ trabajo_id: trabajoId, presupuesto_origen_id: p!.id });

    await expect(eliminarPresupuesto(p!.id)).rejects.toMatchObject({ statusCode: 409 });
    // Y no ha destruido nada por el camino.
    expect((await obtenerPresupuesto(p!.id))!.lineas).toHaveLength(1);
  });
});

describe('cambiarEstado', () => {
  it('does not drag an aceptado presupuesto back to enviado', async () => {
    const p = await crearPresupuesto({ trabajo_id: nuevoTrabajo(), lineas: [LINEA] });
    await cambiarEstado(p!.id, 'aceptado');
    const tras = await cambiarEstado(p!.id, 'enviado');
    expect(tras!.estado).toBe('aceptado');
  });
});
