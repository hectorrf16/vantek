/**
 * ──────────────────────────────────────────────────────────────────────────────
 * migrate.ts — Migraciones versionadas del esquema SQLite
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Defines the list of SQL migrations (table creation and schema changes)
 *   and applies them in order, each one exactly once, recording the executed
 *   version in the _migraciones control table. It is idempotent.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @db/connection (getDb) → SQLite handle on which it runs the DDL
 *   Used by:
 *     · index.ts (backend startup) → runs runMigrations() on start
 *
 * EXPORTS
 *   · runMigrations() → applies the pending migrations (returns nothing)
 *
 * INPUTS / OUTPUTS
 *   Input:  current version read from _migraciones
 *   Output: updated schema + new rows in _migraciones (side effects)
 *
 * NOTES
 *   · To add a schema change: new {version, sql} entry with a version greater
 *     than all existing ones; never edit migrations already applied.
 *   · SQLite does not allow an in-place ALTER of a CHECK: widening a CHECK
 *     requires rebuilding the table in a new migration.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getDb } from '@db/connection';
import { backupDb } from '@db/backup';

const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS usuarios (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        rol TEXT NOT NULL CHECK(rol IN ('admin', 'usuario')),
        activo INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS clientes (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        empresa TEXT,
        dni_cif TEXT,
        telefono TEXT,
        email TEXT,
        notas TEXT,
        activo INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agrupadores (
        id TEXT PRIMARY KEY,
        cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        descripcion TEXT,
        activo INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS trabajos (
        id TEXT PRIMARY KEY,
        agrupador_id TEXT NOT NULL REFERENCES agrupadores(id) ON DELETE CASCADE,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        margen_porcentaje REAL NOT NULL DEFAULT 20,
        estado TEXT NOT NULL DEFAULT 'activo' CHECK(estado IN ('activo','completado','cancelado')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS proveedores (
        id TEXT PRIMARY KEY,
        nombre TEXT NOT NULL,
        telefono TEXT,
        email TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS albaranes (
        id TEXT PRIMARY KEY,
        proveedor_id TEXT REFERENCES proveedores(id),
        proveedor_nombre TEXT,
        numero TEXT,
        fecha TEXT NOT NULL,
        imagen_path TEXT,
        ocr_procesado INTEGER NOT NULL DEFAULT 0,
        notas TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS albaran_lineas (
        id TEXT PRIMARY KEY,
        albaran_id TEXT NOT NULL REFERENCES albaranes(id) ON DELETE CASCADE,
        descripcion TEXT NOT NULL,
        cantidad REAL NOT NULL DEFAULT 1,
        precio_unitario REAL NOT NULL DEFAULT 0,
        unidad TEXT,
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS albaran_linea_trabajo (
        id TEXT PRIMARY KEY,
        albaran_linea_id TEXT NOT NULL REFERENCES albaran_lineas(id) ON DELETE CASCADE,
        trabajo_id TEXT NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
        UNIQUE(albaran_linea_id, trabajo_id)
      );

      CREATE TABLE IF NOT EXISTS presupuestos (
        id TEXT PRIMARY KEY,
        trabajo_id TEXT NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
        numero TEXT,
        estado TEXT NOT NULL DEFAULT 'borrador'
          CHECK(estado IN ('borrador','enviado','aceptado','rechazado','caducado')),
        notas TEXT,
        borrador_data TEXT,
        borrador_updated_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS presupuesto_lineas (
        id TEXT PRIMARY KEY,
        presupuesto_id TEXT NOT NULL REFERENCES presupuestos(id) ON DELETE CASCADE,
        descripcion TEXT NOT NULL,
        cantidad REAL NOT NULL DEFAULT 1,
        precio_unitario REAL NOT NULL DEFAULT 0,
        coste_unitario REAL,
        margen_porcentaje REAL,
        unidad TEXT,
        tipo TEXT NOT NULL DEFAULT 'manual' CHECK(tipo IN ('material','manual','concepto')),
        es_libre INTEGER NOT NULL DEFAULT 0,
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS presupuesto_versiones (
        id TEXT PRIMARY KEY,
        presupuesto_id TEXT NOT NULL REFERENCES presupuestos(id) ON DELETE CASCADE,
        numero_version INTEGER NOT NULL,
        datos TEXT NOT NULL,
        pdf_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS facturas (
        id TEXT PRIMARY KEY,
        trabajo_id TEXT NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
        presupuesto_id TEXT REFERENCES presupuestos(id),
        numero TEXT,
        estado TEXT NOT NULL DEFAULT 'borrador'
          CHECK(estado IN ('borrador','cerrada','entregada','pendiente_pago','pagada')),
        notas TEXT,
        borrador_data TEXT,
        borrador_updated_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS factura_lineas (
        id TEXT PRIMARY KEY,
        factura_id TEXT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
        albaran_linea_id TEXT REFERENCES albaran_lineas(id),
        descripcion TEXT NOT NULL,
        cantidad REAL NOT NULL DEFAULT 1,
        precio_unitario REAL NOT NULL DEFAULT 0,
        coste_unitario REAL,
        margen_porcentaje REAL,
        unidad TEXT,
        tipo TEXT NOT NULL DEFAULT 'material' CHECK(tipo IN ('material','manual','concepto')),
        es_libre INTEGER NOT NULL DEFAULT 0,
        orden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS factura_versiones (
        id TEXT PRIMARY KEY,
        factura_id TEXT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
        numero_version INTEGER NOT NULL,
        datos TEXT NOT NULL,
        pdf_path TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS seguimiento (
        id TEXT PRIMARY KEY,
        cliente_id TEXT REFERENCES clientes(id),
        nombre TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        dni_cif TEXT,
        accion_peticion TEXT,
        estado TEXT NOT NULL DEFAULT 'nuevo' CHECK(estado IN (
          'nuevo','contactado','visita_agendada','pendiente_presupuesto',
          'a_la_espera','en_curso','pendiente_facturar','entregada','pagada'
        )),
        trabajo_id TEXT REFERENCES trabajos(id),
        notas TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS _migraciones (
        version INTEGER PRIMARY KEY,
        ejecutada_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `
  }
  ,
  {
    version: 2,
    sql: `
      ALTER TABLE presupuestos ADD COLUMN fecha TEXT NOT NULL DEFAULT (date('now'));
      ALTER TABLE presupuestos ADD COLUMN iva_porcentaje REAL NOT NULL DEFAULT 21;

      ALTER TABLE facturas ADD COLUMN fecha TEXT NOT NULL DEFAULT (date('now'));
      ALTER TABLE facturas ADD COLUMN fecha_cierre TEXT;
      ALTER TABLE facturas ADD COLUMN iva_porcentaje REAL NOT NULL DEFAULT 21;
      ALTER TABLE facturas ADD COLUMN presupuesto_origen_id TEXT REFERENCES presupuestos(id);
    `
  },
  {
    version: 3,
    sql: `
      ALTER TABLE seguimiento ADD COLUMN fecha_visita TEXT;
      ALTER TABLE seguimiento ADD COLUMN matricula TEXT;
      ALTER TABLE seguimiento ADD COLUMN marca_modelo TEXT;
      ALTER TABLE seguimiento ADD COLUMN fecha_entrada TEXT;
      ALTER TABLE seguimiento ADD COLUMN fecha_salida_estimada TEXT;
      ALTER TABLE seguimiento ADD COLUMN descripcion_problema TEXT;
      ALTER TABLE seguimiento ADD COLUMN firma_entrada TEXT;
      ALTER TABLE seguimiento ADD COLUMN firma_salida TEXT;
    `
  },
  {
    version: 4,
    sql: `
      -- Reconciliar trabajo.estado con el estado de su seguimiento vinculado.
      UPDATE trabajos SET estado = 'completado', updated_at = datetime('now')
      WHERE estado != 'completado' AND id IN (
        SELECT trabajo_id FROM seguimiento
        WHERE trabajo_id IS NOT NULL AND estado IN ('entregada', 'pagada')
      );

      UPDATE trabajos SET estado = 'cancelado', updated_at = datetime('now')
      WHERE estado != 'cancelado' AND id IN (
        SELECT trabajo_id FROM seguimiento
        WHERE trabajo_id IS NOT NULL AND estado = 'cancelado'
      );
    `
  },
  {
    version: 5,
    sql: `
      -- Ampliar el CHECK de seguimiento.estado para incluir 'cancelado' y 'completado'.
      -- SQLite no permite modificar un CHECK in-place: se reconstruye la tabla.
      PRAGMA foreign_keys=OFF;

      CREATE TABLE seguimiento_new (
        id TEXT PRIMARY KEY,
        cliente_id TEXT REFERENCES clientes(id),
        nombre TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        dni_cif TEXT,
        accion_peticion TEXT,
        estado TEXT NOT NULL DEFAULT 'nuevo' CHECK(estado IN (
          'nuevo','contactado','visita_agendada','pendiente_presupuesto',
          'a_la_espera','en_curso','pendiente_facturar','entregada','pagada',
          'completado','cancelado'
        )),
        trabajo_id TEXT REFERENCES trabajos(id),
        notas TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        fecha_visita TEXT,
        matricula TEXT,
        marca_modelo TEXT,
        fecha_entrada TEXT,
        fecha_salida_estimada TEXT,
        descripcion_problema TEXT,
        firma_entrada TEXT,
        firma_salida TEXT
      );

      INSERT INTO seguimiento_new (
        id, cliente_id, nombre, telefono, direccion, dni_cif, accion_peticion,
        estado, trabajo_id, notas, created_at, updated_at,
        fecha_visita, matricula, marca_modelo, fecha_entrada, fecha_salida_estimada,
        descripcion_problema, firma_entrada, firma_salida
      )
      SELECT
        id, cliente_id, nombre, telefono, direccion, dni_cif, accion_peticion,
        estado, trabajo_id, notas, created_at, updated_at,
        fecha_visita, matricula, marca_modelo, fecha_entrada, fecha_salida_estimada,
        descripcion_problema, firma_entrada, firma_salida
      FROM seguimiento;

      DROP TABLE seguimiento;
      ALTER TABLE seguimiento_new RENAME TO seguimiento;

      PRAGMA foreign_keys=ON;
    `
  },
  {
    version: 6,
    sql: `
      -- Registro de errores del servidor para enviarlos al técnico bajo demanda.
      CREATE TABLE IF NOT EXISTS errores (
        id TEXT PRIMARY KEY,
        mensaje TEXT NOT NULL,
        stack TEXT,
        ruta TEXT,
        metodo TEXT,
        status INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_errores_created_at ON errores(created_at);
    `
  },
  {
    version: 7,
    sql: `
      -- Año del contador de numeración de facturas (reinicio anual de la serie).
      -- Lo usa siguienteNumeroFactura/cerrarFactura para numerar por año.
      ALTER TABLE facturas ADD COLUMN anio_numero INTEGER;
    `
  },
  {
    version: 8,
    sql: `
      -- Incidencias del cliente: registro de cancelaciones de obras ya iniciadas.
      -- Cuando se cancela un seguimiento cuya obra ya estaba en curso, el motivo
      -- se adjunta aquí para marcar al cliente como "cliente difícil" y poder
      -- decidir si se acepta un futuro trabajo suyo.
      CREATE TABLE IF NOT EXISTS cliente_incidencias (
        id TEXT PRIMARY KEY,
        cliente_id TEXT NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        seguimiento_id TEXT,
        trabajo_id TEXT,
        trabajo_nombre TEXT,
        estado_cancelacion TEXT NOT NULL,
        motivo TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_cliente_incidencias_cliente
        ON cliente_incidencias(cliente_id);
    `
  },
  {
    version: 9,
    sql: `
      -- Anticipos / pagos por obra: el cliente entrega dinero por adelantado
      -- (a veces un único pago, a veces varios pagos parciales a lo largo del
      -- trabajo). Cada pago se guarda en euros ya resueltos (importe); si se
      -- introdujo como porcentaje se conserva tipo/valor/base para mostrarlo.
      -- El restante de la factura = total con IVA - SUMA(importe).
      CREATE TABLE IF NOT EXISTS obra_pagos (
        id TEXT PRIMARY KEY,
        trabajo_id TEXT NOT NULL REFERENCES trabajos(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL DEFAULT 'fijo' CHECK(tipo IN ('fijo','porcentaje')),
        valor REAL NOT NULL DEFAULT 0,
        importe REAL NOT NULL DEFAULT 0,
        base REAL,
        nota TEXT,
        fecha TEXT NOT NULL DEFAULT (date('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_obra_pagos_trabajo ON obra_pagos(trabajo_id);

      -- Detalle ampliado por línea de documento (descripción larga opcional que
      -- el usuario rellena cuando quiere; se muestra bajo la descripción corta).
      ALTER TABLE presupuesto_lineas ADD COLUMN detalle TEXT;
      ALTER TABLE factura_lineas ADD COLUMN detalle TEXT;
    `
  },
  {
    version: 10,
    sql: `
      -- La serie de facturas es correlativa y ÚNICA por ley. Antes solo lo
      -- garantizaba el código (y no lo hacía: numeraba con COUNT(*)). Este
      -- índice parcial impide a nivel de BD que se emitan dos facturas con el
      -- mismo número dentro del mismo año; los borradores (numero NULL) quedan
      -- fuera del índice.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_factura_serie
        ON facturas(anio_numero, numero) WHERE numero IS NOT NULL;
    `
  }
];

export function runMigrations(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migraciones (
      version INTEGER PRIMARY KEY,
      ejecutada_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const row = db.prepare('SELECT MAX(version) as version FROM _migraciones').get() as { version: number | null };
  const currentVersion = row.version ?? 0;
  const pending = migrations.filter(m => m.version > currentVersion);

  if (pending.length === 0) {
    console.log('[DB] Schema actualizado, no hay migraciones pendientes.');
    return;
  }

  // Copia previa: si una migración deja el esquema inservible, el usuario tiene
  // de dónde recuperar sin perder facturas.
  if (currentVersion > 0) backupDb(`pre-migracion-v${currentVersion}`);

  for (const migration of pending) {
    console.log(`[DB] Ejecutando migración v${migration.version}...`);

    // PRAGMA foreign_keys es un no-op dentro de una transacción, así que las
    // migraciones que lo usan (reconstrucción de tabla) lo aplican fuera.
    const tocaFks = /PRAGMA\s+foreign_keys/i.test(migration.sql);
    const sql = migration.sql.replace(/PRAGMA\s+foreign_keys\s*=\s*\w+\s*;/gi, '');

    if (tocaFks) db.pragma('foreign_keys = OFF');
    try {
      // Migración + registro de versión en la MISMA transacción: un fallo a
      // mitad revierte todo y deja la BD utilizable (antes quedaba a medias y
      // el reintento del siguiente arranque fallaba para siempre).
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migraciones (version) VALUES (?)').run(migration.version);
      })();
    } finally {
      if (tocaFks) db.pragma('foreign_keys = ON');
    }

    console.log(`[DB] Migración v${migration.version} completada.`);
  }
}
