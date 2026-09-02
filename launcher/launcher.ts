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
const nodeCrypto = require('crypto');
const { spawn, execSync } = require('child_process');

// ─── Rutas ────────────────────────────────────────────────────────────────────

const ROOT                   = path.resolve(__dirname, '..');
const CONFIG_PATH            = path.join(ROOT, 'config', 'app.config.json');
const CONFIG_TEMPLATE_PATH   = path.join(ROOT, 'config', 'app.config.template.json');
const PROFILE_PATH           = path.join(ROOT, 'config', 'profile.config.json');
const PROFILE_TEMPLATE_PATH  = path.join(ROOT, 'config', 'profile.config.template.json');
const VERSION_PATH           = path.join(ROOT, 'version.json');
const LOG_PATH               = path.join(ROOT, 'logs', 'launcher.log');
const UPDATE_DIR             = path.join(ROOT, 'data', 'update');
const TMP_ZIP                = path.join(UPDATE_DIR, 'update.zip');
const STAGING_DIR            = path.join(UPDATE_DIR, 'staging');
const BACKUP_DIR             = path.join(UPDATE_DIR, 'backup');
const UPDATE_STATE           = path.join(ROOT, 'data', 'update-state.json');

// Tamaño máximo de launcher.log antes de rotar a launcher.log.1 (servicio
// desatendido durante meses: sin rotación el fichero crece sin límite).
const LOG_MAX_BYTES = 5 * 1024 * 1024;
// Timeouts de red de la descarga: sin ellos una transferencia colgada deja la
// fase en 'descargando' para siempre y el scheduler no vuelve a actuar.
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_IDLE_MS    = 30_000;

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

const state: UpdateState = {
  phase: 'idle',
  version_disponible: null,
  version_actual: '0.0.0',
  apply_requested: false,
  reiniciar_ahora: false,
  ultimo_check: null,
  error: null,
};

// Última release consultada en GitHub. Vive en memoria (no en UpdateState) para
// no serializar el JSON entero de la API dentro de update-state.json.
let ultimaRelease: any = null;

// Proceso del backend supervisado por el launcher.
let servidor: any = null;
let pararServidor = false;
let reintentosServidor = 0;
const BACKOFF_MS = [1000, 2000, 5000, 15000, 30000, 60000];

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const stat = fs.existsSync(LOG_PATH) ? fs.statSync(LOG_PATH) : null;
    if (stat && stat.size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    }
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch { /* continúa */ }
}

// Escritura atómica: escribe en un temporal del mismo directorio y renombra.
// Un fallo o corte a mitad no deja nunca el fichero destino truncado.
function writeFileAtomic(destino: string, contenido: string): void {
  const tmp = `${destino}.tmp`;
  fs.writeFileSync(tmp, contenido);
  fs.renameSync(tmp, destino);
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
    writeFileAtomic(UPDATE_STATE, JSON.stringify(state, null, 2));
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

// Un email por tipo de fallo y día: el scheduler reintenta cada 60 s dentro de
// la ventana, y sin este freno un día sin red genera decenas de correos idénticos.
const emailsEnviados = new Map<string, string>();

async function sendErrorEmail(subject: string, body: string): Promise<void> {
  const config = getConfig();
  const destino = config?.sistema?.email_errores;
  if (!destino) return;

  const hoy = new Date().toISOString().slice(0, 10);
  if (emailsEnviados.get(subject) === hoy) return;
  emailsEnviados.set(subject, hoy);

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

function downloadFile(url: string, dest: string, saltos = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (saltos > 5) return reject(new Error('Demasiadas redirecciones'));
    if (!String(url).startsWith('https://')) {
      return reject(new Error(`Descarga rechazada: la URL no es HTTPS (${url})`));
    }

    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Vantek-Launcher' } },
      (res: any) => {
        // Seguir redirecciones (GitHub Assets redirigen a S3)
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return downloadFile(res.headers.location, dest, saltos + 1)
            .then(resolve)
            .catch(reject);
        }
        // Sin esta comprobación, un cuerpo 403 de rate-limit se guardaba como
        // update.zip y se trataba como una descarga válida.
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} al descargar la actualización`));
        }

        const esperado = Number(res.headers['content-length'] ?? 0);
        let recibido = 0;
        const file = fs.createWriteStream(dest);

        res.on('data', (c: any) => { recibido += c.length; });
        res.pipe(file);

        file.on('error', (err: any) => {
          req.destroy();
          fs.unlink(dest, () => { });
          reject(err);
        });
        file.on('finish', () => {
          file.close(() => {
            if (esperado && recibido !== esperado) {
              fs.unlink(dest, () => { });
              return reject(new Error(
                `Descarga incompleta: ${recibido} de ${esperado} bytes`
              ));
            }
            resolve();
          });
        });
      }
    );

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('Timeout al conectar con el servidor de descargas'));
    });
    req.on('socket', (socket: any) => {
      socket.setTimeout(DOWNLOAD_IDLE_MS, () => {
        req.destroy(new Error('La descarga se quedó sin datos (timeout de inactividad)'));
      });
    });
    req.on('error', (err: any) => {
      fs.unlink(dest, () => { });
      reject(err);
    });
  });
}

// ─── Verificación de integridad del ZIP ────────────────────────────────────────
// La release publica SHA256SUMS.txt junto al zip. Sin esta comprobación el
// launcher aplica cualquier ZIP que le llegue — código que se ejecuta como
// servicio de Windows.

function descargarTexto(url: string, saltos = 0): Promise<string | null> {
  return new Promise((resolve) => {
    if (saltos > 5 || !String(url).startsWith('https://')) return resolve(null);
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'Vantek-Launcher' } },
      (res: any) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return descargarTexto(res.headers.location, saltos + 1).then(resolve);
        }
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let data = '';
        res.on('data', (c: any) => (data += c));
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

async function verificarHash(release: any, zipPath: string, nombreAsset: string): Promise<void> {
  const sums = (release.assets || []).find(
    (a: any) => typeof a.name === 'string' && a.name.toUpperCase().startsWith('SHA256SUMS')
  );
  if (!sums) {
    throw new Error(
      'La release no publica SHA256SUMS.txt: no se puede verificar la integridad del ZIP.'
    );
  }

  const texto = await descargarTexto(sums.browser_download_url);
  if (!texto) throw new Error('No se pudo descargar SHA256SUMS.txt');

  const linea = texto
    .split(/\r?\n/)
    .find((l: string) => l.includes(nombreAsset));
  const esperado = linea?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!esperado || !/^[0-9a-f]{64}$/.test(esperado)) {
    throw new Error(`SHA256SUMS.txt no contiene el hash de ${nombreAsset}`);
  }

  const real = nodeCrypto
    .createHash('sha256')
    .update(fs.readFileSync(zipPath))
    .digest('hex');
  if (real !== esperado) {
    throw new Error(`El hash del ZIP no coincide (esperado ${esperado}, obtenido ${real})`);
  }
}

// ─── Extracción con PowerShell (Expand-Archive) ───────────────────────────────
// Sin adm-zip. Expand-Archive está disponible en Windows 10+ y Windows Server 2016+.

function extractZip(zipPath: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Las comillas simples se duplican: una ruta de instalación con apóstrofo
    // (C:\Users\O'Neill\…) cerraba la cadena de PowerShell y rompía la extracción.
    const q = (p: string) => p.replace(/'/g, "''");
    // -Force sobreescribe ficheros existentes
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(destPath)}' -Force`,
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
    // http, NO https: la URL es http://localhost. https.get lanza
    // ERR_INVALID_PROTOCOL de forma síncrona y la promesa acababa rechazando
    // siempre — la protección de borrador sucio nunca llegó a funcionar.
    const req = http.get(
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

  // La release se guarda en memoria, NO en el estado: serializar el JSON
  // completo de GitHub en update-state.json lo hincha y lo expone al frontend.
  ultimaRelease = release;
}

async function downloadUpdate(): Promise<boolean> {
  const release = ultimaRelease;
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
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    await downloadFile(asset.browser_download_url, TMP_ZIP);
    log('Descarga completada. Verificando integridad...');
    await verificarHash(release, TMP_ZIP, asset.name);
    log('Hash SHA256 verificado.');
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

// Directorios que NUNCA se sobreescriben al aplicar una actualización: los
// aporta el instalador una sola vez (node/, tools/) o contienen datos vivos.
const NO_SOBREESCRIBIR = new Set(['node', 'tools', 'data', 'logs', 'config']);

function limpiarDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function applyUpdate(): Promise<void> {
  const latestVersion = state.version_disponible;
  if (!latestVersion || !fs.existsSync(TMP_ZIP)) {
    log('No hay ZIP listo para aplicar.');
    return;
  }

  state.phase = 'aplicando';
  writeState();

  const intercambiado: string[] = [];

  try {
    // 1) Extraer a staging. Si el ZIP está corrupto, fallamos aquí y la
    //    instalación en marcha ni se toca.
    log('Extrayendo actualización en staging...');
    limpiarDir(STAGING_DIR);
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    await extractZip(TMP_ZIP, STAGING_DIR);

    const entradas = fs
      .readdirSync(STAGING_DIR)
      .filter((n: string) => !NO_SOBREESCRIBIR.has(n));
    if (entradas.length === 0) {
      throw new Error('El ZIP de actualización no contiene ficheros aplicables');
    }

    // 2) Parar el servidor ANTES de tocar el árbol: en Windows los módulos
    //    nativos cargados (better_sqlite3.node) quedan bloqueados y la copia
    //    fallaba a mitad, dejando versiones mezcladas.
    await stopServer();

    // 3) Apartar la versión actual (backup para rollback) y copiar la nueva.
    limpiarDir(BACKUP_DIR);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });

    for (const nombre of entradas) {
      const actual = path.join(ROOT, nombre);
      if (fs.existsSync(actual)) {
        fs.renameSync(actual, path.join(BACKUP_DIR, nombre));
      }
      fs.cpSync(path.join(STAGING_DIR, nombre), actual, { recursive: true });
      intercambiado.push(nombre);
    }

    writeFileAtomic(VERSION_PATH, JSON.stringify({ version: latestVersion }, null, 2));
    limpiarDir(STAGING_DIR);
    limpiarDir(BACKUP_DIR);
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
    log(`Error al aplicar la actualización: ${err}`);

    // Rollback: devolver lo apartado en el backup a su sitio.
    for (const nombre of intercambiado) {
      try {
        const destino = path.join(ROOT, nombre);
        const respaldo = path.join(BACKUP_DIR, nombre);
        if (fs.existsSync(respaldo)) {
          limpiarDir(destino);
          fs.renameSync(respaldo, destino);
        }
      } catch (errRollback) {
        log(`ROLLBACK FALLIDO en "${nombre}": ${errRollback}`);
      }
    }
    if (intercambiado.length) log('Rollback completado: se mantiene la versión anterior.');

    limpiarDir(STAGING_DIR);
    limpiarDir(BACKUP_DIR);
    if (fs.existsSync(TMP_ZIP)) { try { fs.unlinkSync(TMP_ZIP); } catch { /* ignorar */ } }

    state.phase = 'hay_update'; // revertir a estado anterior
    state.error = `Error al aplicar: ${err}`;
    writeState();
    await sendErrorEmail(
      'Error al aplicar actualización',
      `No se pudo aplicar la actualización a v${latestVersion}.\n\nError: ${err}\n\nSe continuará con la versión actual.`
    );

    // El servidor se paró para el intercambio: hay que volver a levantarlo.
    if (!servidor) startServer();
  }
}

// ─── Ventana horaria ──────────────────────────────────────────────────────────

function dentroDeVentana(): boolean {
  const config = getConfig();
  const inicio = config?.sistema?.actualizacion?.hora_inicio ?? '03:00';
  const fin    = config?.sistema?.actualizacion?.hora_fin    ?? '05:00';

  const ahora = new Date();
  const hhmm  = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  const ahoraMin = ahora.getHours() * 60 + ahora.getMinutes();
  const desde = hhmm(inicio);
  const hasta = hhmm(fin);

  // Ventana que cruza medianoche (p. ej. 23:00–02:00).
  if (desde > hasta) return ahoraMin >= desde || ahoraMin < hasta;
  return ahoraMin >= desde && ahoraMin < hasta;
}

// Best-effort: bajo servicio NSSM el launcher corre en la Sesión 0, donde
// GetLastInputInfo no ve el input del usuario interactivo. El gate real de
// seguridad es "borrador limpio + ventana horaria"; esto solo añade margen
// cuando el launcher se ejecuta en primer plano (start.bat).
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
    try {
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
        if (await hasDirtyDraft()) {
          log('Borrador sucio detectado. Reintentando en el siguiente ciclo.');
          return;
        }
        const ok = await downloadUpdate();
        if (!ok) return;
      }

      if (state.phase === 'listo_para_aplicar') {
        if (await hasDirtyDraft()) {
          log('Borrador sucio antes de aplicar. Reintentando en el siguiente ciclo.');
          return;
        }
        await applyUpdate();
        // applyUpdate llama process.exit(0) si tiene éxito → NSSM reinicia
      }
    } catch (err) {
      // Un rechazo sin capturar aquí tumbaría el proceso (Node ≥15).
      log(`Error en el ciclo del scheduler: ${err}`);
      state.phase = 'idle';
      state.error = String(err);
      writeState();
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
    try {
      const disco = readState();

      if (!disco.apply_requested) return;
      // El scheduler puede estar ya descargando/aplicando: no duplicar el trabajo.
      if (['checking', 'descargando', 'aplicando'].includes(state.phase)) return;

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
        if (await hasDirtyDraft()) {
          log('Hay borrador sucio. No se puede reiniciar ahora. La actualización se aplicará en el siguiente arranque.');
          state.error = 'Hay un borrador sin guardar. Guarda el documento y vuelve a intentarlo.';
          writeState();
          return;
        }
        await applyUpdate();
      } else {
        log('Actualización descargada. Se aplicará en el siguiente arranque del servicio.');
      }
    } catch (err) {
      log(`Error atendiendo la solicitud de apply: ${err}`);
      state.error = String(err);
      writeState();
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
  pararServidor = false;

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
  servidor = server;

  server.on('error', (err: Error) => {
    log(`Error del proceso servidor: ${err.message}`);
  });

  server.on('exit', (code: number) => {
    servidor = null;
    log(`El servidor terminó con código ${code}`);
    if (pararServidor) return;   // parada intencionada (actualización en curso)

    // NSSM supervisa AL LAUNCHER, no al backend: si el hijo muere y nadie lo
    // relanza, el servicio figura "en ejecución" con la app caída.
    const espera = BACKOFF_MS[Math.min(reintentosServidor, BACKOFF_MS.length - 1)];
    reintentosServidor++;
    log(`Terminación inesperada. Reintentando en ${espera / 1000} s...`);
    setTimeout(() => { if (!servidor && !pararServidor) startServer(); }, espera);
  });

  // Si aguanta un minuto, el arranque se considera bueno y se resetea el backoff.
  setTimeout(() => { if (servidor === server) reintentosServidor = 0; }, 60_000);
}

// Parada ordenada del backend: SIGTERM y, si no responde en 10 s, SIGKILL.
function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    const proc = servidor;
    if (!proc) return resolve();

    pararServidor = true;
    log('Deteniendo el servidor antes de aplicar la actualización...');

    const forzar = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* ya terminado */ }
    }, 10_000);

    proc.once('exit', () => {
      clearTimeout(forzar);
      servidor = null;
      resolve();
    });

    try { proc.kill('SIGTERM'); }
    catch { clearTimeout(forzar); servidor = null; resolve(); }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Asegurar directorios necesarios
  for (const dir of ['logs', 'data', 'config', UPDATE_DIR].map(d =>
    path.isAbsolute(d) ? d : path.join(ROOT, d)
  )) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Inicializar ficheros de configuración desde plantillas si no existen
  inicializarConfiguracion();

  log('=== Vantek Launcher iniciado ===');
  log(`Versión actual: ${getCurrentVersion()}`);

  state.version_actual = getCurrentVersion();
  writeState();

  // Un fallo comprobando actualizaciones NUNCA debe impedir que la app arranque.
  try {
    await checkAndUpdateAlArrancar();
  } catch (err) {
    log(`Error comprobando actualizaciones al arrancar: ${err}`);
    state.phase = 'idle';
    state.error = String(err);
    writeState();
  }
  startServer();
  iniciarScheduler();
  iniciarWatcherApply();
}

main().catch((err) => {
  console.error('Error fatal en el launcher:', err);
  process.exit(1);
});