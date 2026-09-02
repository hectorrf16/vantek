/**
 * ──────────────────────────────────────────────────────────────────────────────
 * dashboard.service.ts — Pendientes de acción y resumen económico del dashboard
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Computes the two dashboard blocks: the list of pending actions
 *   (unconverted/old presupuestos, undelivered facturas and unpaid facturas)
 *   and the financial summary (real collected vs projection) grouped by
 *   month, quarter or year.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @db/connection (getDb) → aggregate queries over facturas/presupuestos
 *     · @utils/config (getAppConfig) → thresholds (days) and chart type
 *   Used by:
 *     · routes/dashboard.router.ts → GET /api/dashboard?agrupacion=...
 *
 * EXPORTS
 *   · getDashboard(agrupacion='mes') → { pendientes, resumen, grafico_tipo }
 *   · (types) PendienteAccion, PuntoGrafico, ResumenEconomico, DashboardData
 *
 * INPUTS / OUTPUTS
 *   Input:  time grouping; state of facturas/presupuestos in the DB
 *   Output: read-only DashboardData object (no side effects)
 *
 * NOTES
 *   · factura_sin_cobrar uses julianday('now') - julianday(updated_at) > diasSinCobrar.
 *   · 'projection' = facturas in cerrada/entregada/pendiente_pago/pagada; 'pagado'
 *     only counts the pagadas.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getDb } from '@db/connection';
import { getAppConfig } from '@utils/config';

export interface PendienteAccion {
  tipo: 'presupuesto_sin_convertir' | 'presupuesto_antiguo' | 'factura_sin_entregar' | 'factura_sin_cobrar';
  id: string;
  numero?: string;
  cliente: string;
  agrupador: string;
  importe: number;
  fecha: string;
  dias_espera?: number;
  dias_sin_cobrar?: number;
}

export interface PuntoGrafico {
  periodo: string;       // "2025-01", "2025-T1", "2025"
  label: string;         // "Ene 25", "T1 2025", "2025"
  pagado: number;        // solo facturas pagadas
  proyeccion: number;    // todas menos borrador
}

export interface ResumenEconomico {
  agrupacion: 'mes' | 'trimestre' | 'anio';
  total_pagado: number;
  total_proyeccion: number;
  puntos: PuntoGrafico[];
}

export interface DashboardData {
  pendientes: PendienteAccion[];
  resumen: ResumenEconomico;
  grafico_tipo: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function labelMes(periodo: string): string {
  const [anio, mes] = periodo.split('-');
  const nombres = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  return `${nombres[parseInt(mes) - 1]} ${anio.slice(2)}`;
}

function labelTrimestre(periodo: string): string {
  const [anio, t] = periodo.split('-');
  return `${t} ${anio}`;
}

function periodoMes(fecha: string): string {
  return fecha.slice(0, 7); // "2025-01"
}

function periodoTrimestre(fecha: string): string {
  const mes = parseInt(fecha.slice(5, 7));
  const anio = fecha.slice(0, 4);
  const t = Math.ceil(mes / 3);
  return `${anio}-T${t}`;
}

function periodoAnio(fecha: string): string {
  return fecha.slice(0, 4);
}

// ─── pendientes ─────────────────────────────────────────────────────────────

async function getPendientes(): Promise<PendienteAccion[]> {
  const db = getDb();
  const pendientes: PendienteAccion[] = []
  const hoy = new Date();
  const config = getAppConfig();
  const diasAntiguo = config.dashboard?.dias_presupuesto_antiguo ?? 30;
  // Antes se leía config.dashboard.dashboard.… (clave duplicada), así que el
  // valor configurado se ignoraba siempre y quedaba fijo en 30 días.
  const diasSinCobrar = config.dashboard?.dias_factura_sin_cobrar ?? 30;

  // 1. Presupuestos enviados sin convertir a aceptado (todos los "enviados")
  const presupuestosEnviados = db.prepare(`
  SELECT p.id, p.updated_at as fecha,
         COALESCE((
           SELECT SUM(pl.precio_unitario * pl.cantidad)
           FROM presupuesto_lineas pl
           WHERE pl.presupuesto_id = p.id
         ), 0) as importe,
         c.nombre as cliente,
         a.label as agrupador
  FROM presupuestos p
  JOIN trabajos t ON p.trabajo_id = t.id
  JOIN agrupadores a ON t.agrupador_id = a.id
  JOIN clientes c ON a.cliente_id = c.id
  WHERE p.estado = 'enviado'
  ORDER BY p.updated_at ASC
`).all() as any[];

  for (const p of presupuestosEnviados) {
    const fechaDoc = new Date(p.fecha);
    const dias = Math.floor((hoy.getTime() - fechaDoc.getTime()) / (1000 * 60 * 60 * 24));
    const esAntiguo = dias >= diasAntiguo;

    pendientes.push({
      tipo: esAntiguo ? 'presupuesto_antiguo' : 'presupuesto_sin_convertir',
      id: p.id,
      cliente: p.cliente,
      agrupador: p.agrupador,
      importe: p.importe,
      fecha: p.fecha,
      dias_espera: dias,
    });
  }

  // 2. Facturas cerradas sin entregar (estado = 'cerrada')
  const facturasCerradas = db.prepare(`
  SELECT f.id, f.numero, f.updated_at as fecha,
         COALESCE((
           SELECT SUM(fl.precio_unitario * fl.cantidad)
           FROM factura_lineas fl
           WHERE fl.factura_id = f.id
         ), 0) as importe,
         c.nombre as cliente,
         a.label as agrupador
  FROM facturas f
  JOIN trabajos t ON f.trabajo_id = t.id
  JOIN agrupadores a ON t.agrupador_id = a.id
  JOIN clientes c ON a.cliente_id = c.id
  WHERE f.estado = 'cerrada'
  ORDER BY f.updated_at ASC
`).all() as any[];

  for (const f of facturasCerradas) {
    pendientes.push({
      tipo: 'factura_sin_entregar',
      id: f.id,
      numero: f.numero,
      cliente: f.cliente,
      agrupador: f.agrupador,
      importe: f.importe,
      fecha: f.fecha,
    });
  }

  const facturasSinCobrar = db.prepare(`
  SELECT f.id, f.updated_at, f.numero,
    t.nombre AS trabajo_nombre,
    a.label  AS agrupador_label,
    c.nombre AS cliente_nombre,
    (SELECT SUM(precio_unitario * cantidad) FROM factura_lineas WHERE factura_id = f.id) AS importe
  FROM facturas f
  JOIN trabajos t    ON f.trabajo_id   = t.id
  JOIN agrupadores a ON t.agrupador_id = a.id
  JOIN clientes c    ON a.cliente_id   = c.id
  WHERE f.estado = 'pendiente_pago'
    AND julianday('now') - julianday(f.updated_at) > ?
`).all(diasSinCobrar) as any[];

  for (const f of facturasSinCobrar) {
    const fechaDoc = new Date(f.updated_at);
    const dias = Math.floor((hoy.getTime() - fechaDoc.getTime()) / (1000 * 60 * 60 * 24));

    pendientes.push({
      tipo: 'factura_sin_cobrar',
      id: f.id,
      numero: f.numero,
      cliente: f.cliente_nombre,
      agrupador: f.agrupador_label,
      importe: f.importe,
      fecha: f.updated_at,
      dias_espera: dias,
    });
  }

  return pendientes;
}

// ─── resumen económico ───────────────────────────────────────────────────────

async function getResumen(agrupacion: 'mes' | 'trimestre' | 'anio'): Promise<ResumenEconomico> {
  const db = getDb();

  // Estados que cuentan como "proyección" (todo menos borrador)
  const estadosProyeccion = ['cerrada', 'entregada', 'pendiente_pago', 'pagada'];
  const placeholders = estadosProyeccion.map(() => '?').join(',');

  // La facturación se ancla a la fecha del documento (fecha_cierre si existe,
  // si no la fecha de la factura). Con updated_at, cualquier cambio de estado o
  // reenvío posterior movía el ingreso al periodo actual.
  const facturas = db.prepare(`
  SELECT f.estado, COALESCE(f.fecha_cierre, f.fecha, f.updated_at) as fecha,
         COALESCE((
           SELECT SUM(fl.precio_unitario * fl.cantidad)
           FROM factura_lineas fl
           WHERE fl.factura_id = f.id
         ), 0) as total
  FROM facturas f
  WHERE f.estado IN (${placeholders})
  ORDER BY fecha ASC
`).all(...estadosProyeccion) as any[];

  // Agrupa por periodo
  const mapPagado: Record<string, number> = {};
  const mapProyeccion: Record<string, number> = {};

  for (const f of facturas) {
    let periodo: string;
    if (agrupacion === 'mes') periodo = periodoMes(f.fecha);
    else if (agrupacion === 'trimestre') periodo = periodoTrimestre(f.fecha);
    else periodo = periodoAnio(f.fecha);

    mapProyeccion[periodo] = (mapProyeccion[periodo] || 0) + f.total;
    if (f.estado === 'pagada') {
      mapPagado[periodo] = (mapPagado[periodo] || 0) + f.total;
    }
  }

  // Construir puntos ordenados
  const periodosSet = new Set([...Object.keys(mapPagado), ...Object.keys(mapProyeccion)]);
  const periodos = Array.from(periodosSet).sort();

  const puntos: PuntoGrafico[] = periodos.map(p => {
    let label: string;
    if (agrupacion === 'mes') label = labelMes(p);
    else if (agrupacion === 'trimestre') label = labelTrimestre(p);
    else label = p;

    return {
      periodo: p,
      label,
      pagado: mapPagado[p] || 0,
      proyeccion: mapProyeccion[p] || 0,
    };
  });

  const total_pagado = puntos.reduce((s, p) => s + p.pagado, 0);
  const total_proyeccion = puntos.reduce((s, p) => s + p.proyeccion, 0);

  return { agrupacion, total_pagado, total_proyeccion, puntos };
}

// ─── entry point ─────────────────────────────────────────────────────────────

export async function getDashboard(
  agrupacion: 'mes' | 'trimestre' | 'anio' = 'mes'
): Promise<DashboardData> {
  const config = getAppConfig();
  const grafico_tipo = (config as any).dashboard?.grafico_tipo ?? 'barras_lineas';

  const [pendientes, resumen] = await Promise.all([
    getPendientes(),
    getResumen(agrupacion),
  ]);

  return { pendientes, resumen, grafico_tipo };
}