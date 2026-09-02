/**
 * ──────────────────────────────────────────────────────────────────────────────
 * config.ts — Profile/app config loader, cache, migrate & translator
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Reads profile.config.json and app.config.json from CONFIG_DIR with in-memory
 *   caching, exposes getters/setters/reloaders, deep-merges missing keys from the
 *   app config template on boot (migrateConfig), and provides t() to translate
 *   profile entity keys (never literal strings in code).
 *
 * RELATIONSHIPS
 *   Imports:
 *     · fs, path → read/write the JSON config files
 *     · @utils/paths (CONFIG_DIR) → locate config files
 *   Used by:
 *     · index.ts → migrateConfig() on startup
 *     · config.router.ts → get/reload app & profile config
 *     · services (email, dashboard, etc.) → getAppConfig/getProfileConfig
 *
 * EXPORTS
 *   · ProfileConfig, AppConfig → config type shapes
 *   · getProfileConfig / getAppConfig → cached readers
 *   · saveAppConfig → write app config + update cache
 *   · reloadAppConfig / reloadProfileConfig → invalidate caches
 *   · migrateConfig → add new template keys without overwriting values
 *   · t(key) → translate a dotted profile key (falls back to the key)
 *
 * INPUTS / OUTPUTS
 *   Input:  JSON config files on disk
 *   Output: parsed config objects / translated strings
 *
 * NOTES
 *   · migrateConfig never overwrites existing values and never throws (a failure
 *     must not block server startup).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { APP_ROOT, CONFIG_DIR } from '@utils/paths';

const PROFILE_PATH = path.join(CONFIG_DIR, 'profile.config.json');
const APP_PATH = path.join(CONFIG_DIR, 'app.config.json');

export interface ProfileConfig {
  perfil: string;
  version: string;
  entidades: {
    cliente: string;
    clientes: string;
    agrupador: string;
    agrupadores: string;
    trabajo: string;
    trabajos: string;
  };
  menu: Record<string, string>;
  documentos: Record<string, string>;
  modulos: {
    albaranes: boolean;
    seguimiento: boolean;
    matriculas: boolean;
  };
  seguimiento: {
    tipo: 'reformas' | 'taller';
    label: string;
    // Lista ordenada de estados del flujo aplicables a este perfil. Define qué
    // estados aparecen como filtros y por qué transiciones avanza la ficha de
    // seguimiento. Si falta (instalaciones previas), getProfileConfig la rellena
    // según modulos.matriculas.
    estados?: string[];
  };
  footer: {
    factura: string;
    presupuesto: string;
  };
}

export interface AppConfig {
  puerto?: number;
  empresa: {
    nombre: string;
    cif: string;
    direccion: string;
    telefono: string;
    email: string;
    logo: string;
    mano_obra_precio_hora: number;
    mano_obra_unidad: string;
  };
  documentos: {
    iva_porcentaje: number;
    margen_defecto: number;
    max_versiones: number;
    numeracion_factura: {
      contador: number;
      anio: number;
    };
    footer_factura: string;
    footer_presupuesto: string;
    template_html?: string;
    template_path?: string;
  };
  dashboard: {
    grafico_tipo: string;
    dias_presupuesto_antiguo: number;
    dias_factura_sin_cobrar: number;
  };
  sistema: {
    email_errores: string;
    chromium_modo?: 'bundled' | 'edge';
    actualizacion: {
      hora_inicio: string;
      hora_fin: string;
      inactividad_minutos: number;
    };
  };
  email: {
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
      from: string;
    };
    plantillas: {
      factura: { asunto: string; cuerpo: string };
      presupuesto: { asunto: string; cuerpo: string };
    };
  };
}

let profileCache: ProfileConfig | null = null;
let appCache: AppConfig | null = null;

// Orden canónico de estados de seguimiento por estructura. Es la fuente de
// verdad para rellenar seguimiento.estados en instalaciones previas a que el
// campo existiera (el setup ya lo escribe en el perfil para instalaciones
// nuevas). Taller salta los estados de contacto/visita.
const ESTADOS_SEGUIMIENTO_REFORMAS = [
  'nuevo', 'contactado', 'visita_agendada', 'pendiente_presupuesto',
  'a_la_espera', 'en_curso', 'pendiente_facturar', 'entregada',
  'pagada', 'completado',
];
const ESTADOS_SEGUIMIENTO_TALLER = [
  'nuevo', 'pendiente_presupuesto', 'a_la_espera', 'en_curso',
  'pendiente_facturar', 'entregada', 'pagada', 'completado',
];

export function getProfileConfig(): ProfileConfig {
  if (!profileCache) {
    const cfg: ProfileConfig = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf-8'));
    // Backfill para perfiles guardados antes de que seguimiento.estados existiera.
    if (cfg.seguimiento && !cfg.seguimiento.estados?.length) {
      cfg.seguimiento.estados = cfg.modulos?.matriculas
        ? ESTADOS_SEGUIMIENTO_TALLER
        : ESTADOS_SEGUIMIENTO_REFORMAS;
    }
    profileCache = cfg;
  }
  return profileCache!;
}

export function getAppConfig(): AppConfig {
  if (!appCache) {
    appCache = leerConfigConRespaldo();
  }
  return appCache!;
}

// app.config.json guarda las credenciales SMTP y los datos de empresa. Si el
// fichero quedó corrupto (corte a mitad de escritura antes de que fuera
// atómica), se recupera de la última copia buena en lugar de tumbar la app.
function leerConfigConRespaldo(): AppConfig {
  try {
    return JSON.parse(fs.readFileSync(APP_PATH, 'utf-8'));
  } catch (err) {
    const bak = `${APP_PATH}.bak`;
    if (fs.existsSync(bak)) {
      console.error('[Config] app.config.json ilegible, recuperando de .bak:', err);
      const recuperado = JSON.parse(fs.readFileSync(bak, 'utf-8'));
      escribirAtomico(APP_PATH, JSON.stringify(recuperado, null, 2));
      return recuperado;
    }
    throw err;
  }
}

// Escritura atómica: fichero temporal + rename. Un fallo o disco lleno a mitad
// dejaba antes app.config.json truncado y la app inutilizable.
function escribirAtomico(destino: string, contenido: string): void {
  const tmp = `${destino}.tmp`;
  fs.writeFileSync(tmp, contenido, 'utf-8');
  fs.renameSync(tmp, destino);
}

export function saveAppConfig(config: AppConfig): void {
  const serializado = JSON.stringify(config, null, 2);
  if (fs.existsSync(APP_PATH)) {
    try { fs.copyFileSync(APP_PATH, `${APP_PATH}.bak`); } catch { /* opcional */ }
  }
  escribirAtomico(APP_PATH, serializado);
  appCache = config;
}

export function reloadAppConfig(): void {
  appCache = null;
}

export function reloadProfileConfig(): void {
  profileCache = null;
}

// ─── Migrate de configuración ─────────────────────────────────────────────────
// Compara el template con el config real y añade las claves que falten.
// Nunca sobreescribe valores existentes. Se ejecuta en cada arranque.

function mergeDeep(template: any, actual: any): { resultado: any; cambios: number } {
  let cambios = 0;
  const resultado = { ...actual };

  for (const key of Object.keys(template)) {
    if (!(key in resultado)) {
      // Clave nueva en el template que no existe en el config real
      resultado[key] = template[key];
      cambios++;
    } else if (
      typeof template[key] === 'object' &&
      template[key] !== null &&
      !Array.isArray(template[key]) &&
      typeof resultado[key] === 'object' &&
      resultado[key] !== null
    ) {
      // Ambos son objetos — recursión
      const sub = mergeDeep(template[key], resultado[key]);
      resultado[key] = sub.resultado;
      cambios += sub.cambios;
    }
    // Si el tipo difiere o es un valor primitivo existente, no tocamos nada
  }

  return { resultado, cambios };
}

export function migrateConfig(): void {
  // En Windows el template viaja dentro de config/; en Docker el entrypoint
  // solo siembra los config reales y las plantillas viven en config-default/.
  // Sin este segundo candidato, las claves nuevas NUNCA se añadían en Linux.
  const candidatos = [
    path.join(CONFIG_DIR, 'app.config.template.json'),
    path.join(APP_ROOT, 'config-default', 'app.config.template.json'),
  ];
  const templatePath = candidatos.find(p => fs.existsSync(p));

  if (!templatePath || !fs.existsSync(APP_PATH)) {
    // Sin template o sin config real no hay nada que migrar
    return;
  }

  try {
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
    const actual   = JSON.parse(fs.readFileSync(APP_PATH, 'utf-8'));

    const { resultado, cambios } = mergeDeep(template, actual);

    if (cambios > 0) {
      escribirAtomico(APP_PATH, JSON.stringify(resultado, null, 2));
      appCache = null; // invalidar caché
      console.log(`[Config] Migrate: ${cambios} clave(s) nueva(s) añadida(s) al app.config.json`);
    }
  } catch (err) {
    console.error('[Config] Error en migrate de configuración:', err);
    // No lanzamos — un fallo en migrate no debe impedir arrancar el servidor
  }
}

// Función de traducción — nunca texto literal en el código
export function t(key: string): string {
  const config = getProfileConfig();
  const parts = key.split('.');
  let val: unknown = config;
  for (const p of parts) {
    if (val && typeof val === 'object') {
      val = (val as Record<string, unknown>)[p];
    } else return key;
  }
  return typeof val === 'string' ? val : key;
}

