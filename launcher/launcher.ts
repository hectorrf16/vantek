/**
 * ──────────────────────────────────────────────────────────────────────────────
 * launcher.ts — Windows-only process launcher with self-updating from GitHub
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Boots the Vantek Express server and supervises auto-updates on Windows.
 *   On start (and on a scheduler) it checks GitHub Releases for a newer version,
 *   downloads and extracts the release ZIP, and applies it during the configured
 *   maintenance window only when the machine is idle and no document draft is dirty.
 *
 * RELATIONSHIPS
 *   Used by / Calls:
 *     · install-service.bat (NSSM) / start.bat → launch launcher.js as the service or foreground
 *     · GitHub Releases API → fetch latest version metadata and the release ZIP
 *     · PowerShell (Expand-Archive, GetLastInputInfo) → unzip updates, detect inactivity
 *     · Backend GET /api/status/draft → decide whether it is safe to restart
 *     · Frontend (Config update panel) → manual apply requests via data/update-state.json
 *
 * INPUTS / OUTPUTS
 *   Input:  config/app.config.json (update window, idle minutes), version.json,
 *           frontend requests written to data/update-state.json
 *   Output: data/update-state.json (phase/state), logs/launcher.log, logs/update.zip,
 *           extracted app files, restarted server process, error notification emails
 *
 * NOTES
 *   · Windows-only. Has no role in the Linux/Docker deployment.
 *   · Zero external dependencies: pure Node + PowerShell + setInterval/fs.watchFile.
 *   · Communicates with the backend purely through data/update-state.json on disk.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Vantek Launcher — Fase 4
 *
 * Responsabilidades:
 * 1. Al arrancar: comprobar y aplicar actualización si hay versión nueva y no hay borrador sucio
 * 2. Arrancar el servidor Express
 * 3. Scheduler: comprobar actualizaciones dentro de la ventana horaria y con inactividad suficiente
 * 4. Comunicación con el frontend via data/update-state.json
 * 5. En caso de error: notificar por email y continuar con la versión actual
 *
 * Principios:
 * - Sin dependencias externas. Todo via Node nativo + PowerShell
 * - Expand-Archive (PowerShell) en lugar de adm-zip
 * - GetLastInputInfo (PowerShell + user32.dll) para detectar inactividad
 * - setInterval nativo para el scheduler
 * - fs.watchFile para detectar solicitudes de apply desde el frontend
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

// ─── Rutas ────────────────────────────────────────────────────────────────────

const ROOT                   = path.resolve(__dirname, '..');
const CONFIG_PATH            = path.join(ROOT, 'config', 'app.config.json');
const CONFIG_TEMPLATE_PATH   = path.join(ROOT, 'config', 'app.config.template.json');
const PROFILE_PATH           = path.join(ROOT, 'config', 'profile.config.json');
const PROFILE_TEMPLATE_PATH  = path.join(ROOT, 'config', 'profile.config.template.json');
const VERSION_PATH           = path.join(ROOT, 'version.json');
const LOG_PATH               = path.join(ROOT, 'logs', 'launcher.log');
const TMP_ZIP                = path.join(ROOT, 'logs', 'update.zip');
const UPDATE_STATE           = path.join(ROOT, 'data', 'update-state.json');

// ─── GitHub ───────────────────────────────────────────────────────────────────

const GITHUB_OWNER = 'HeRoDaRu';
const GITHUB_REPO  = 'vantek';
const GITHUB_API   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

// ─── Estado interno del launcher ─────────────────────────────────────────────

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'hay_update'
  | 'sin_update'
  | 'descargando'
  | 'listo_para_aplicar'   // descargado, esperando reinicio
  | 'aplicando';           // en proceso de reinicio

interface UpdateState {
  phase: UpdatePhase;
  version_disponible: string | null;
  version_actual: string;
  apply_requested: boolean;      // frontend pide apply
  reiniciar_ahora: boolean;      // frontend pide reinicio inmediato
  ultimo_check: string | null;   // ISO timestamp
  error: string | null;
}

let state: UpdateState = {
  phase: 'idle',
  version_disponible: null,
  version_actual: '0.0.0',
  apply_requested: false,
  reiniciar_ahora: false,
  ultimo_check: null,
  error: null,
};

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* continúa */ }
}

// ─── Configuración ────────────────────────────────────────────────────────────

function getConfig(): any {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

function getCurrentVersion(): string {
  try { return JSON.parse(fs.readFileSync(VERSION_PATH, 'utf-8')).version; }
  catch { return '0.0.0'; }
}

// ─── Comparación semántica de versiones ───────────────────────────────────────
// Devuelve true SOLO si `latest` es estrictamente mayor que `current`.
// Evita el falso positivo de actualización cuando la versión instalada es más
// reciente que la última release (p. ej. instalada 1.5.5 vs release 1.5.2).
// Compara los componentes numéricos major.minor.patch; ignora sufijos (-test, -rc…).

function parseVersion(v: string): number[] {
  const core = String(v).replace(/^v/, '').split('-')[0];
  return core.split('.').map((n) => {
    const parsed = parseInt(n, 10);
    return isNaN(parsed) ? 0 : parsed;
  });
}

function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na > nb) return true;
    if (na < nb) return false;
  }
  return false; // iguales → no hay actualización
}

// Selecciona el módulo correcto (http/https) según el protocolo de la URL.
// Los redirects de GitHub Assets pueden usar cualquiera de los dos.
function httpModule(url: string): any {
  return String(url).startsWith('http://') ? http : https;
}

// ─── Inicialización de ficheros de configuración ─────────────────────────────
// Se ejecuta una sola vez, en el primer arranque, cuando los ficheros no existen.
// En actualizaciones posteriores nunca sobreescribe los ficheros reales.

function inicializarConfiguracion(): void {
  // Asegurar que existe la carpeta config
  const configDir = path.join(ROOT, 'config');
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  // app.config.json — con año dinámico
  if (!fs.existsSync(CONFIG_PATH)) {
    if (fs.existsSync(CONFIG_TEMPLATE_PATH)) {
      const template = JSON.parse(fs.readFileSync(CONFIG_TEMPLATE_PATH, 'utf-8'));
      template.documentos.numeracion_factura.anio = new Date().getFullYear();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2));
      log('app.config.json creado desde plantilla.');
    } else {
      log('ADVERTENCIA: No se encontró app.config.template.json. El servidor puede no arrancar correctamente.');
    }
  }

  // profile.config.json — copia directa del template
  if (!fs.existsSync(PROFILE_PATH)) {
    if (fs.existsSync(PROFILE_TEMPLATE_PATH)) {
      fs.copyFileSync(PROFILE_TEMPLATE_PATH, PROFILE_PATH);
      log('profile.config.json creado desde plantilla.');
    } else {
      log('ADVERTENCIA: No se encontró profile.config.template.json. El servidor puede no arrancar correctamente.');
    }
  }
}

// ─── update-state.json ───────────────────────────────────────────────────────
// Canal de comunicación unidireccional launcher → backend → frontend
// El launcher escribe. El backend lo lee en GET /api/status/update.
// El frontend escribe apply_requested via POST /api/status/update/apply (que el backend proxea).

function writeState(): void {
  try {
    const dataDir = path.join(ROOT, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(UPDATE_STATE, JSON.stringify(state, null, 2));
  } catch (err) {
    log(`No se pudo escribir update-state.json: ${err}`);
  }
}

function readState(): UpdateState {
  try {
    const raw = JSON.parse(fs.readFileSync(UPDATE_STATE, 'utf-8'));
    return { ...state, ...raw };
  } catch {
    return state;
  }
}

// ─── Email de error ───────────────────────────────────────────────────────────

async function sendErrorEmail(subject: string, body: string): Promise<void> {
  const config = getConfig();
  const destino = config?.sistema?.email_errores;
  if (!destino) return;

  const smtpConfig = config?.email?.smtp;
  if (!smtpConfig?.host) {
    log('Email de error no enviado: SMTP no configurado.');
    return;
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port || 587,
      secure: smtpConfig.secure || false,
      auth: { user: smtpConfig.user, pass: smtpConfig.pass },
    });
    await transporter.sendMail({
      from: smtpConfig.from || smtpConfig.user,
      to: destino,
      subject: `[Vantek] ${subject}`,
      text: body,
    });
    log(`Email de error enviado a ${destino}`);
  } catch (err) {
    log(`No se pudo enviar email de error: ${err}`);
  }
}

// ─── GitHub Release ───────────────────────────────────────────────────────────

function fetchLatestRelease(): Promise<any> {
  return new Promise((resolve) => {
    const req = https.get(
      GITHUB_API,
      { headers: { 'User-Agent': 'Vantek-Launcher' } },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    httpModule(url)
      .get(url, { headers: { 'User-Agent': 'Vantek-Launcher' } }, (res: any) => {
        // Seguir redirecciones (GitHub Assets redirigen a S3)
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      })
      .on('error', (err: any) => {
        fs.unlink(dest, () => { });
        reject(err);
      });
  });
}

// ─── Extracción con PowerShell (Expand-Archive) ───────────────────────────────
// Sin adm-zip. Expand-Archive está disponible en Windows 10+ y Windows Server 2016+.

function extractZip(zipPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // -Force sobreescribe ficheros existentes
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destPath}' -Force`,
    ]);

    let stderr = '';
    ps.stderr.on('data', (d: any) => (stderr += d.toString()));

    ps.on('close', (code: number) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Expand-Archive falló (código ${code}): ${stderr}`));
      }
    });

    ps.on('error', (err: Error) => reject(err));
  });
}

// ─── Detección de inactividad ─────────────────────────────────────────────────
// Usa GetLastInputInfo de user32.dll via PowerShell inline.
// Devuelve segundos desde el último input de ratón o teclado.
// Si falla (ej. entorno sin UI), devuelve Infinity para no bloquear actualizaciones.

function getIdleSeconds(): number {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdleTime {
  [DllImport("user32.dll")]
  static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [StructLayout(LayoutKind.Sequential)]
  struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  public static uint GetIdleMs() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(info);
    if (!GetLastInputInfo(ref info)) return 0;
    return (uint)Environment.TickCount - info.dwTime;
  }
}
"@
[IdleTime]::GetIdleMs()
`.trim();

  try {
    // -EncodedCommand (Base64 UTF-16LE) para pasar el script tal cual: preserva
    // saltos de línea y comillas, de modo que el terminador de here-string ("@ al
    // inicio de línea) se reconoce. Con -Command "..." las comillas escapadas
    // rompían el here-string → ParserError "Falta la cadena en el terminador".
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const output = execSync(
      `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 5000, windowsHide: true }
    ).toString().trim();

    const ms = parseInt(output, 10);
    return isNaN(ms) ? Infinity : Math.floor(ms / 1000);
  } catch {
    // Si PowerShell no está disponible o el entorno no tiene UI, asumimos inactividad total
    return Infinity;
  }
}

// ─── Verificar borrador sucio ─────────────────────────────────────────────────

async function hasDirtyDraft(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.get(
      'http://localhost:3000/api/status/draft',
      { headers: { 'User-Agent': 'Vantek-Launcher' } },
      (res: any) => {
        let data = '';
        res.on('data', (c: any) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data).sucio === true); }
          catch { resolve(false); }
        });
      }
    );
    req.on('error', () => resolve(false)); // sin servidor = sin borrador
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
  });
}

// ─── Lógica de actualización ──────────────────────────────────────────────────

async function checkForUpdate(): Promise<void> {
  state.phase = 'checking';
  state.ultimo_check = new Date().toISOString();
  state.error = null;
  writeState();

  log('Comprobando actualizaciones en GitHub...');
  const release = await fetchLatestRelease();

  if (!release || !release.tag_name) {
    log('No se pudo conectar con GitHub.');
    state.phase = 'idle';
    state.error = 'No se pudo conectar con GitHub';
    writeState();
    await sendErrorEmail(
      'Error de actualización',
      'No se pudo conectar con GitHub para comprobar actualizaciones.'
    );
    return;
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  const currentVersion = getCurrentVersion();
  state.version_actual = currentVersion;

  if (!isNewerVersion(latestVersion, currentVersion)) {
    log(`Sin actualizaciones. Versión actual: v${currentVersion} (última release: v${latestVersion})`);
    state.phase = 'sin_update';
    state.version_disponible = null;
    writeState();
    return;
  }

  log(`Nueva versión disponible: v${latestVersion} (actual: v${currentVersion})`);
  state.phase = 'hay_update';
  state.version_disponible = latestVersion;
  writeState();

  // Guardar la release para no repetir la llamada a GitHub si ya la tenemos
  (state as any)._release = release;
}

async function downloadUpdate(): Promise<boolean> {
  const release = (state as any)._release;
  if (!release) return false;

  const asset = (release.assets || []).find((a: any) => typeof a.name === 'string' && a.name.startsWith('Vantek-') && a.name.endsWith('.zip'));
  if (!asset) {
    log('Asset Vantek-*.zip no encontrado en la release.');
    state.error = 'Asset no encontrado en GitHub Release';
    writeState();
    return false;
  }

  state.phase = 'descargando';
  writeState();
  log('Descargando actualización...');

  try {
    await downloadFile(asset.browser_download_url, TMP_ZIP);
    log('Descarga completada.');
    state.phase = 'listo_para_aplicar';
    writeState();
    return true;
  } catch (err) {
    log(`Error en la descarga: ${err}`);
    state.phase = 'hay_update';
    state.error = `Error en la descarga: ${err}`;
    writeState();
    if (fs.existsSync(TMP_ZIP)) { try { fs.unlinkSync(TMP_ZIP); } catch { /* ignorar */ } }
    await sendErrorEmail(
      'Error al descargar actualización',
      `No se pudo descargar la actualización a v${state.version_disponible}.\n\nError: ${err}`
    );
    return false;
  }
}

async function applyUpdate(): Promise<void> {
  const latestVersion = state.version_disponible;
  if (!latestVersion || !fs.existsSync(TMP_ZIP)) {
    log('No hay ZIP listo para aplicar.');
    return;
  }

  state.phase = 'aplicando';
  writeState();
  log('Extrayendo actualización con Expand-Archive...');

  try {
    await extractZip(TMP_ZIP, ROOT);
    fs.writeFileSync(VERSION_PATH, JSON.stringify({ version: latestVersion }, null, 2));
    if (fs.existsSync(TMP_ZIP)) fs.unlinkSync(TMP_ZIP);
    log(`Actualización a v${latestVersion} aplicada. Reiniciando...`);
    state.phase = 'idle';
    state.version_disponible = null;
    state.apply_requested = false;
    state.reiniciar_ahora = false;
    writeState();
    // NSSM detecta el exit y reinicia el proceso
    process.exit(0);
  } catch (err) {
    log(`Error al extraer la actualización: ${err}`);
    state.phase = 'hay_update'; // revertir a estado anterior
    state.error = `Error al extraer: ${err}`;
    writeState();
    if (fs.existsSync(TMP_ZIP)) { try { fs.unlinkSync(TMP_ZIP); } catch { /* ignorar */ } }
    await sendErrorEmail(
      'Error al aplicar actualización',
      `No se pudo extraer la actualización a v${latestVersion}.\n\nError: ${err}\n\nSe continuará con la versión actual.`
    );
  }
}

// ─── Ventana horaria ──────────────────────────────────────────────────────────

function dentroDeVentana(): boolean {
  const config = getConfig();
  const inicio = config?.sistema?.actualizacion?.hora_inicio ?? '15:00';
  const fin    = config?.sistema?.actualizacion?.hora_fin    ?? '16:00';

  const ahora = new Date();
  const hhmm  = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  return ahoraMin >= hhmm(inicio) && ahoraMin < hhmm(fin);
}

function inactividadSuficiente(): boolean {
  const config = getConfig();
  const umbralMin = config?.sistema?.actualizacion?.inactividad_minutos ?? 15;
  const idleSecs  = getIdleSeconds();
  return idleSecs >= umbralMin * 60;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
// Comprueba cada minuto si hay que buscar/aplicar actualización.
// Solo actúa si: estamos en la ventana horaria Y hay inactividad suficiente.

let schedulerActivo = false;

function iniciarScheduler(): void {
  if (schedulerActivo) return;
  schedulerActivo = true;

  log('Scheduler de actualizaciones iniciado (comprobación cada 60 s).');

  setInterval(async () => {
    // No hacer nada si ya estamos en medio de un proceso
    if (['checking', 'descargando', 'aplicando'].includes(state.phase)) return;

    const enVentana = dentroDeVentana();
    const inactivo  = inactividadSuficiente();

    if (!enVentana || !inactivo) return;

    log('Dentro de la ventana horaria y usuario inactivo. Comprobando actualizaciones...');

    if (state.phase === 'idle' || state.phase === 'sin_update') {
      await checkForUpdate();
    }

    if (state.phase === 'hay_update') {
      const dirty = await hasDirtyDraft();
      if (dirty) {
        log('Borrador sucio detectado. Reintentando en el siguiente ciclo.');
        return;
      }
      const ok = await downloadUpdate();
      if (!ok) return;
    }

    if (state.phase === 'listo_para_aplicar') {
      const dirty = await hasDirtyDraft();
      if (dirty) {
        log('Borrador sucio antes de aplicar. Reintentando en el siguiente ciclo.');
        return;
      }
      await applyUpdate();
      // applyUpdate llama process.exit(0) si tiene éxito → NSSM reinicia
    }
  }, 60_000); // cada minuto
}

// ─── Watcher de solicitudes del frontend ─────────────────────────────────────
// El backend escribe en update-state.json cuando el frontend llama a
// POST /api/status/update/apply. El launcher detecta el cambio y actúa.

function iniciarWatcherApply(): void {
  // Crear el fichero si no existe para que watchFile no falle
  if (!fs.existsSync(UPDATE_STATE)) writeState();

  fs.watchFile(UPDATE_STATE, { interval: 1000 }, async () => {
    const disco = readState();

    if (!disco.apply_requested) return;

    // Limpiar el flag inmediatamente para no procesar dos veces
    state.apply_requested = false;
    state.reiniciar_ahora = disco.reiniciar_ahora;
    writeState();

    log(`Solicitud de apply recibida. reiniciar_ahora=${disco.reiniciar_ahora}`);

    if (state.phase === 'idle' || state.phase === 'sin_update') {
      await checkForUpdate();
    }

    if (state.phase !== 'hay_update' && state.phase !== 'listo_para_aplicar') {
      log('No hay actualización disponible para aplicar.');
      return;
    }

    if (state.phase === 'hay_update') {
      const ok = await downloadUpdate();
      if (!ok) return;
    }

    if (disco.reiniciar_ahora) {
      const dirty = await hasDirtyDraft();
      if (dirty) {
        log('Hay borrador sucio. No se puede reiniciar ahora. La actualización se aplicará en el siguiente arranque.');
        state.error = 'Hay un borrador sin guardar. Guarda el documento y vuelve a intentarlo.';
        writeState();
        return;
      }
      await applyUpdate();
    } else {
      log('Actualización descargada. Se aplicará en el siguiente arranque del servicio.');
    }
  });

  log('Watcher de solicitudes de actualización activo.');
}

// ─── Comprobación al arrancar ─────────────────────────────────────────────────

async function checkAndUpdateAlArrancar(): Promise<void> {
  state.version_actual = getCurrentVersion();

  if (fs.existsSync(TMP_ZIP)) {
    log('ZIP de actualización encontrado. Verificando borrador antes de aplicar...');
    const dirty = await hasDirtyDraft();
    if (!dirty) {
      const disco = readState();
      if (disco.version_disponible) {
        state.version_disponible = disco.version_disponible;
        state.phase = 'listo_para_aplicar';
        await applyUpdate();
        return;
      }
    } else {
      log('Borrador sucio. ZIP pendiente no se puede aplicar ahora. Se reintentará.');
      state.phase = 'listo_para_aplicar';
      writeState();
      return;
    }
  }

  await checkForUpdate();

  if (state.phase === 'hay_update' && dentroDeVentana() && inactividadSuficiente()) {
    const dirty = await hasDirtyDraft();
    if (!dirty) {
      await downloadUpdate();
      if ((state.phase as UpdatePhase) === 'listo_para_aplicar') {
        await applyUpdate();
      }
    }
  }
}

// ─── Arrancar servidor ────────────────────────────────────────────────────────

function startServer(): void {
  const serverPath = path.join(ROOT, 'app', 'backend', 'dist', 'index.js');

  if (!fs.existsSync(serverPath)) {
    log('ERROR CRÍTICO: No se encontró app/backend/dist/index.js');
    log('El proyecto debe estar compilado antes de arrancar.');
    process.exit(1);
  }

  log('Arrancando servidor Vantek...');

  const server = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      VANTEK_ROOT: ROOT,
      // Chromium incluido (modo "bundled"): puppeteer descarga el navegador en
      // esta carpeta durante el build y aquí le indicamos dónde encontrarlo en
      // la instalación del cliente. El modo "edge" usa msedge.exe del sistema.
      PUPPETEER_CACHE_DIR: path.join(ROOT, 'puppeteer'),
    },
    cwd: ROOT,
    stdio: 'inherit',
  });

  server.on('error', (err: Error) => {
    log(`Error del proceso servidor: ${err.message}`);
  });

  server.on('exit', (code: number) => {
    log(`El servidor terminó con código ${code}`);
    if (code !== 0) {
      log('Terminación inesperada. NSSM reiniciará el proceso automáticamente.');
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Asegurar directorios necesarios
  for (const dir of ['logs', 'data', 'config'].map(d => path.join(ROOT, d))) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Inicializar ficheros de configuración desde plantillas si no existen
  inicializarConfiguracion();

  log('=== Vantek Launcher iniciado ===');
  log(`Versión actual: ${getCurrentVersion()}`);

  state.version_actual = getCurrentVersion();
  writeState();

  await checkAndUpdateAlArrancar();
  startServer();
  iniciarScheduler();
  iniciarWatcherApply();
}

main().catch((err) => {
  console.error('Error fatal en el launcher:', err);
  process.exit(1);
});