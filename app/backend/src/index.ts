/**
 * ──────────────────────────────────────────────────────────────────────────────
 * index.ts — Express server entry point & API bootstrap
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Builds the Express app: global middleware (helmet, cors, compression, JSON,
 *   request logger), serves static frontend/PDFs, mounts every /api router, and
 *   exposes status + update endpoints. On start() it runs config + DB migrations
 *   and listens on PORT (default 3000).
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @db/migrate (runMigrations) → bring the SQLite schema up to date on boot
 *     · @utils/config (migrateConfig) → merge new keys into app.config.json
 *     · @middleware/errorHandler → notFound + central error handlers
 *     · @routes/* → clientes, albaranes, setup, presupuestos, facturas,
 *       dashboard, config, seguimiento routers
 *     · @services/facturas.service (hayBorradorSucio) → /api/status/draft
 *     · @utils/paths (APP_ROOT, PDFS_DIR) → resolve static/PDF/update paths
 *   Used by:
 *     · launcher / Docker entrypoint → started as the backend process
 *
 * ENDPOINTS        (mounts + locally defined routes)
 *   · use /api/config, /api/setup, /api/clientes, /api/albaranes,
 *     /api/presupuestos, /api/facturas, /api/dashboard, /api/seguimiento
 *   · GET  /api/status → { ok, version }
 *   · GET  /api/status/draft → { sucio } (launcher checks for dirty draft)
 *   · GET  /api/status/update → update state read from data/update-state.json
 *   · POST /api/status/update/apply → flags launcher to apply an update
 *   · GET  * (production) → SPA fallback to frontend index.html
 *
 * INPUTS / OUTPUTS
 *   Input:  HTTP requests; env (PORT, NODE_ENV, VANTEK_ROOT)
 *   Output: running HTTP server; default export = the Express app
 *
 * NOTES
 *   · SPA fallback and express.static only active when NODE_ENV=production; in
 *     Docker nginx serves the frontend so those never fire behind the proxy.
 *   · /api/status/update[/apply] are placeholders backed by update-state.json,
 *     functional only with the Windows launcher (no-op under Docker).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import fs from 'fs';
import asyncHandler from 'express-async-handler';
import { runMigrations } from '@db/migrate';
import { backupDb } from '@db/backup';
import { getDb, closeDb } from '@db/connection';
import { migrateConfig } from '@utils/config';
import { errorHandler, notFoundHandler } from '@middleware/errorHandler';
import { requireAuth } from '@middleware/auth';
import authRouter from '@routes/auth.router';
import clientesRouter from '@routes/clientes.router';
import albanesRouter from '@routes/albaranes.router';
import setupRouter from '@routes/setup.router';
import presupuestosRouter from '@routes/presupuestos.router';
import facturasRouter from '@routes/facturas.router';
import { hayBorradorSucio } from '@services/facturas.service';
import { podarErrores } from '@services/errores.service';
import dashboardRouter from '@routes/dashboard.router';
import configRouter from '@routes/config.router';
import seguimientoRouter from './routes/seguimiento.router';
import pagosRouter from './routes/pagos.router';
import { APP_ROOT, PDFS_DIR } from '@utils/paths';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(
  helmet({
    // CSP restrictiva: el SPA solo carga recursos propios. 'unsafe-inline' en
    // estilos es necesario porque la UI usa style={{…}} en línea.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'"],   // tesseract.js (WASM)
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);
app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── HTTP request logger ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? '\x1b[31m'  // rojo
                : res.statusCode >= 400 ? '\x1b[33m'  // amarillo
                : res.statusCode >= 300 ? '\x1b[36m'  // cyan
                : '\x1b[32m';                          // verde
    console.log(`${color}${res.statusCode}\x1b[0m ${req.method} ${req.path} \x1b[90m${ms}ms\x1b[0m`);
  });
  next();
});

// ─── Estáticos (producción) ───────────────────────────────────────────────────
// En Windows/Node portable, Express sirve el frontend compilado por Vite
// (app/frontend/dist). En Docker la imagen lo deja en <APP_ROOT>/public y el
// servidor habitual es nginx; se resuelve por candidatos para que el fallback
// de Express funcione en ambos despliegues.
const FRONTEND_DIST =
  [
    path.join(APP_ROOT, 'app', 'frontend', 'dist'),
    path.join(APP_ROOT, 'public'),
  ].find(p => fs.existsSync(path.join(p, 'index.html'))) ??
  path.join(APP_ROOT, 'app', 'frontend', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(FRONTEND_DIST));
}
app.use('/pdfs', requireAuth, express.static(PDFS_DIR));

// ─── Acceso ────────────────────────────────────────────────────────────────
// Mientras no haya contraseña configurada, requireAuth deja pasar todo (modo
// LAN de siempre). En cuanto se configura desde Configuración → Sistema, cada
// endpoint — incluido el borrado total de datos — exige sesión.
app.use('/api/auth', authRouter);
app.use('/api', requireAuth);

// ─── Config endpoints ─────────────────────────────────────────────────────────
app.use('/api/config', configRouter);

// ─── Status (usado por el launcher para verificar borrador sucio) ─────────────
app.get('/api/status', (_req, res) => {
  res.json({ ok: true, version: process.env.npm_package_version || '0.1.0' });
});

app.get('/api/status/draft', asyncHandler(async (_req, res) => {
  const sucio = await hayBorradorSucio();
  res.json({ sucio });
}));

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/setup', setupRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/albaranes', albanesRouter);
app.use('/api/presupuestos', presupuestosRouter);
app.use('/api/facturas', facturasRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/seguimiento', seguimientoRouter);
app.use('/api/trabajos/:trabajoId/pagos', pagosRouter);

// ─── placeholders de actualización ────────────────────────────────────────────
const UPDATE_STATE_PATH = path.join(APP_ROOT, 'data', 'update-state.json');
 
function readUpdateState(): any {
  try {
    return JSON.parse(fs.readFileSync(UPDATE_STATE_PATH, 'utf-8'));
  } catch {
    return { phase: 'idle', version_disponible: null, version_actual: null, error: null };
  }
}
 
function writeUpdateState(partial: object): void {
  const current = readUpdateState();
  const tmp = `${UPDATE_STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...current, ...partial }, null, 2));
  fs.renameSync(tmp, UPDATE_STATE_PATH);
}
 
// GET /api/status/update
// Devuelve el estado actual de actualización para el panel de ConfigPage.
app.get('/api/status/update', (_req, res) => {
  const s = readUpdateState();
  res.json({
    phase: s.phase ?? 'idle',
    hay_update: !!s.version_disponible,
    version_disponible: s.version_disponible ?? null,
    version_actual: s.version_actual ?? null,
    ultimo_check: s.ultimo_check ?? null,
    error: s.error ?? null,
  });
});
 
// POST /api/status/update/apply
// El frontend pide al launcher que descargue y/o aplique la actualización.
// El launcher monitoriza update-state.json con fs.watchFile y reacciona al flag.
app.post('/api/status/update/apply', (req, res) => {
  const reiniciar_ahora = req.body?.reiniciar_ahora === true;
  writeUpdateState({ apply_requested: true, reiniciar_ahora });
  res.json({ ok: true, reiniciar_ahora });
});

// ─── SPA fallback (producción) ────────────────────────────────────────────────
// Debe ir tras TODAS las rutas /api para no interceptarlas. En Windows/Node
// portable sirve el index.html del frontend compilado; en Docker nunca se
// alcanza porque nginx atiende las rutas no-/api.
if (process.env.NODE_ENV === 'production') {
  app.get('/*splat', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
}

// ─── Error handlers (siempre al final) ───────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ─── Arranque ─────────────────────────────────────────────────────────────────
const UN_DIA_MS = 24 * 60 * 60 * 1000;

function start() {
  try {
    console.log('[Vantek] Iniciando...');
    migrateConfig();
    runMigrations();
    console.log('[Vantek] Base de datos lista.');

    // Copia de seguridad diaria (y una al arrancar): vantek.db es el único
    // almacén de todas las facturas y no había ningún respaldo automático.
    backupDb('arranque');
    podarErrores();
    const backupTimer = setInterval(() => {
      backupDb('diario');
      podarErrores();
    }, UN_DIA_MS);
    backupTimer.unref();

    const server = app.listen(PORT, () => {
      console.log(`[Vantek] Servidor en http://localhost:${PORT}`);
    });

    // Apagado ordenado. En Docker el proceso es PID 1 y `docker stop` acababa
    // siempre en SIGKILL con el WAL abierto; aquí cerramos y hacemos
    // checkpoint para que la copia del fichero .db esté siempre al día.
    let cerrando = false;
    const apagar = (senal: string) => {
      if (cerrando) return;
      cerrando = true;
      console.log(`[Vantek] ${senal} recibido, cerrando...`);
      server.close(() => {
        try {
          getDb().pragma('wal_checkpoint(TRUNCATE)');
          closeDb();
        } catch (err) {
          console.error('[Vantek] Error cerrando la base de datos:', err);
        }
        process.exit(0);
      });
      // Red de seguridad si alguna conexión se queda abierta.
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', () => apagar('SIGTERM'));
    process.on('SIGINT', () => apagar('SIGINT'));
  } catch (err) {
    console.error('[Vantek] Error al iniciar:', err);
    process.exit(1);
  }
}

start();
export default app;