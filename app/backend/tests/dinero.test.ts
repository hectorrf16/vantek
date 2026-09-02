/**
 * ──────────────────────────────────────────────────────────────────────────────
 * dinero.test.ts — Política de redondeo monetario
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from 'vitest';
import { redondear, totalesDocumento } from '@utils/dinero';

describe('redondear', () => {
  it('rounds half-cents up (toFixed rounded them down)', () => {
    expect(redondear(8.575)).toBe(8.58);
    expect(redondear(1.005)).toBe(1.01);
    expect(Number((8.575).toFixed(2))).toBe(8.57); // comportamiento antiguo
  });

  it('is stable for values already in cents', () => {
    expect(redondear(12.34)).toBe(12.34);
    expect(redondear(0)).toBe(0);
  });

  it('does not produce NaN', () => {
    expect(redondear(Number.NaN)).toBe(0);
  });
});

describe('totalesDocumento', () => {
  it('guarantees base + IVA === total', () => {
    const { subtotal, iva, total } = totalesDocumento(
      [{ precio_unitario: 0.05, cantidad: 1.5 }],
      21
    );
    expect(subtotal + iva).toBeCloseTo(total, 10);
  });

  it('rounds each line before summing', () => {
    const { subtotal } = totalesDocumento(
      [
        { precio_unitario: 0.005, cantidad: 1 },
        { precio_unitario: 0.005, cantidad: 1 },
      ],
      0
    );
    expect(subtotal).toBe(0.02); // 0,01 + 0,01, no 0,01
  });
});
