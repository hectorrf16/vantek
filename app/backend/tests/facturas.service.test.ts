/**
 * ──────────────────────────────────────────────────────────────────────────────
 * facturas.service.test.ts — Numbering, albarán→factura transfer & transitions
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  limpiarBd, db, crearCliente, crearAgrupador, crearTrabajo,
  crearAlbaranConLinea, asignarLineaATrabajo,
} from './helpers/db';
import {
  crearFactura, cerrarFactura, cambiarEstado, agregarLineasDesdeAlbaran,
  guardarLineas, eliminarFactura, obtenerFactura,
} from '@services/facturas.service';

beforeEach(() => limpiarBd());

function nuevoTrabajo(margen = 20): string {
  return crearTrabajo(crearAgrupador(crearCliente()), { margen });
}

/** Factura en borrador con una línea: cerrarFactura rechaza las vacías. */
async function facturaConLinea(trabajoId = nuevoTrabajo(), precio = 100) {
  const f = await crearFactura({
    trabajo_id: trabajoId,
    lineas: [{
      descripcion: 'Servicio', detalle: null, cantidad: 1, unidad: 'ud',
      precio_unitario: precio, coste_unitario: null, margen_porcentaje: null,
      tipo: 'concepto', es_libre: true, albaran_linea_id: null,
    }],
  });
  return f!;
}

describe('crearFactura', () => {
  it('creates a borrador factura with the default IVA', async () => {
    const trabajoId = nuevoTrabajo();
    const factura = await crearFactura({ trabajo_id: trabajoId });
    expect(factura!.estado).toBe('borrador');
    expect(factura!.numero).toBeNull();
    expect(factura!.iva_porcentaje).toBe(21);
  });
});

describe('cerrarFactura — annual numbering', () => {
  it('assigns padded sequential numbers and rejects re-close', async () => {
    const f1 = await facturaConLinea();
    const f2 = await facturaConLinea();

    const r1 = await cerrarFactura(f1.id);
    const r2 = await cerrarFactura(f2.id);

    expect(r1.ok).toBe(true);
    expect(r1.factura!.numero).toBe('0001');
    expect(r1.factura!.estado).toBe('cerrada');
    expect(r2.factura!.numero).toBe('0002');

    const reclose = await cerrarFactura(f1.id);
    expect(reclose.ok).toBe(false);
  });

  it('does not reuse a number after deleting a closed factura', async () => {
    // Reproductor del bug de numeración por COUNT(*): al desaparecer una
    // factura de la serie, el siguiente cierre reemitía un número ya usado.
    const f1 = await facturaConLinea();
    const f2 = await facturaConLinea();
    await cerrarFactura(f1.id);   // 0001
    await cerrarFactura(f2.id);   // 0002

    await cambiarEstado(f1.id, 'borrador');   // libera el 0001
    await eliminarFactura(f1.id);

    const f3 = await facturaConLinea();
    const r3 = await cerrarFactura(f3.id);
    expect(r3.factura!.numero).toBe('0003');
  });

  it('rejects closing an empty factura', async () => {
    const f = await crearFactura({ trabajo_id: nuevoTrabajo() });
    const r = await cerrarFactura(f!.id);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/líneas/i);
  });

  it('takes the series year from the factura date, not from the clock', async () => {
    const f = await crearFactura({
      trabajo_id: nuevoTrabajo(),
      fecha: '2020-12-31',
      lineas: [{
        descripcion: 'Servicio', detalle: null, cantidad: 1, unidad: 'ud',
        precio_unitario: 50, coste_unitario: null, margen_porcentaje: null,
        tipo: 'concepto', es_libre: true, albaran_linea_id: null,
      }],
    });
    const r = await cerrarFactura(f!.id);
    expect(r.factura!.anio_numero).toBe(2020);
  });
});

describe('facturas emitidas — inmutabilidad', () => {
  it('rejects editing the lines of a closed factura', async () => {
    const f = await facturaConLinea();
    await cerrarFactura(f.id);
    await expect(guardarLineas(f.id, [])).rejects.toThrow(/emitida/i);
  });

  it('rejects deleting a closed factura', async () => {
    const f = await facturaConLinea();
    await cerrarFactura(f.id);
    await expect(eliminarFactura(f.id)).rejects.toThrow(/emitida/i);
  });
});

describe('totales — redondeo a céntimos', () => {
  it('keeps base + IVA exactly equal to the total', async () => {
    const f = await crearFactura({
      trabajo_id: nuevoTrabajo(),
      lineas: [{
        descripcion: 'Fraccionado', detalle: null, cantidad: 1.5, unidad: 'ud',
        precio_unitario: 0.05, coste_unitario: null, margen_porcentaje: null,
        tipo: 'concepto', es_libre: true, albaran_linea_id: null,
      }],
    });
    const { totales } = (await obtenerFactura(f!.id))!;
    expect(totales.subtotal + totales.iva).toBeCloseTo(totales.total, 10);
    expect(totales.total).toBe(Math.round(totales.total * 100) / 100);
  });
});

describe('anticipos — reparto entre facturas de la obra', () => {
  it('does not deduct the same anticipo on every factura', async () => {
    const trabajoId = nuevoTrabajo();
    db().prepare(
      `INSERT INTO obra_pagos (id, trabajo_id, tipo, valor, importe)
       VALUES ('p1', ?, 'fijo', 100, 100)`
    ).run(trabajoId);

    const f1 = await facturaConLinea(trabajoId, 60);   // total 72,60 con IVA
    const f2 = await facturaConLinea(trabajoId, 60);

    const d1 = (await obtenerFactura(f1.id))!;
    const d2 = (await obtenerFactura(f2.id))!;

    // La primera consume 72,60 del anticipo; a la segunda le quedan 27,40.
    expect(d1.anticipo_aplicado).toBeCloseTo(d1.totales.total, 2);
    expect(d1.anticipo_aplicado + d2.anticipo_aplicado).toBeCloseTo(100, 2);
    expect(d2.restante).toBeCloseTo(d2.totales.total - d2.anticipo_aplicado, 2);
  });
});

describe('agregarLineasDesdeAlbaran', () => {
  it('applies the trabajo margen to the coste and dedups by albaran_linea_id', async () => {
    const trabajoId = nuevoTrabajo(20);
    const { lineaId } = crearAlbaranConLinea({ precio: 100, cantidad: 2 });
    asignarLineaATrabajo(lineaId, trabajoId);

    const r1 = await agregarLineasDesdeAlbaran(trabajoId, [lineaId]);
    expect(r1.agregadas).toBe(1);

    const linea = db().prepare(
      `SELECT precio_unitario, coste_unitario, margen_porcentaje, tipo
       FROM factura_lineas WHERE factura_id = ?`
    ).get(r1.factura_id) as { precio_unitario: number; coste_unitario: number; margen_porcentaje: number; tipo: string };
    expect(linea.coste_unitario).toBe(100);
    expect(linea.precio_unitario).toBe(120); // 100 * (1 + 20/100)
    expect(linea.tipo).toBe('material');

    // Segunda pasada de la misma línea → omitida, no duplica.
    const r2 = await agregarLineasDesdeAlbaran(trabajoId, [lineaId]);
    expect(r2.agregadas).toBe(0);
    expect(r2.omitidas).toBe(1);
  });

  it('ignores lines not assigned to the trabajo', async () => {
    const trabajoId = nuevoTrabajo();
    const { lineaId } = crearAlbaranConLinea(); // not assigned
    const r = await agregarLineasDesdeAlbaran(trabajoId, [lineaId]);
    expect(r.agregadas).toBe(0);
    expect(r.omitidas).toBe(1);
  });
});

describe('cambiarEstado — transition guard', () => {
  it('reopening to borrador clears the number', async () => {
    const f = await facturaConLinea();
    await cerrarFactura(f.id);
    const reabierta = await cambiarEstado(f.id, 'borrador');
    expect(reabierta!.estado).toBe('borrador');
    expect(reabierta!.numero).toBeNull();
    expect(reabierta!.anio_numero).toBeNull();
  });

  it('does not move a pagada factura backward to entregada (no error)', async () => {
    const f = await facturaConLinea();
    await cerrarFactura(f.id);
    await cambiarEstado(f.id, 'pagada');

    const result = await cambiarEstado(f.id, 'entregada');
    expect(result!.estado).toBe('pagada');
  });
});
