/**
 * ──────────────────────────────────────────────────────────────────────────────
 * pdf.service.ts — Generación de PDF de facturas y presupuestos con Puppeteer
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Renders the single HTML/CSS template (factura or presupuesto) with a
 *   small in-house template engine (no dependencies) and converts it to PDF
 *   with Puppeteer. Resolves logo, template (inline/external/bundled) and
 *   launches the bundled Chromium or the system Edge with fallback.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · puppeteer → renders the HTML to PDF
 *     · path, fs → templates, logo and PDF writing
 *     · @utils/config (getAppConfig, getProfileConfig, AppConfig) → empresa, footer, template
 *     · @utils/paths (APP_ROOT, PDFS_DIR) → external template paths and output
 *   Used by:
 *     · routes/facturas.router.ts and routes/presupuestos.router.ts → POST /:id/pdf
 *
 * EXPORTS
 *   · generarPdf(doc, tipo) → (relative) path of the generated PDF
 *
 * INPUTS / OUTPUTS
 *   Input:  DocumentoParaPdf (header + lines + totals) and tipo 'factura'|'presupuesto'
 *   Output: PDF file in PDFS_DIR; returns its relative path
 *
 * NOTES
 *   · The template carries a FACTURA/PRESUPUESTO watermark and PAGADA stamp depending on state.
 *   · IVA is only shown on facturas; the internal margen NEVER appears in the PDF.
 *   · Templates live in the repo-root `templates/` folder and are copied to
 *     <APP_ROOT>/templates at build/package time.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { getAppConfig, getProfileConfig, AppConfig } from '@utils/config';
import { APP_ROOT, CONFIG_DIR, PDFS_DIR } from '@utils/paths';

// ─── Tipos mínimos que necesita el template ───────────────────────────────────

interface DocumentoParaPdf {
  id: string;
  numero?: string | null;
  fecha: string;
  estado: string;
  notas?: string | null;
  iva_porcentaje: number;
  cliente_nombre?: string;
  cliente_empresa?: string;
  cliente_dni_cif?: string;
  cliente_direccion?: string;
  agrupador_label?: string;
  lineas: {
    descripcion: string;
    detalle?: string | null;
    cantidad: number;
    unidad?: string | null;
    precio_unitario: number;
  }[];
  totales: {
    subtotal: number;
    iva?: number;
    iva_porcentaje?: number;
    total: number;
  };
  anticipo_total?: number;
  anticipo_aplicado?: number;
  restante?: number;
}

type TipoDocumento = 'factura' | 'presupuesto';

// ─── Directorio de salida ─────────────────────────────────────────────────────

function dirPdfs(): string {
  const dir = PDFS_DIR;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Borra del disco el PDF de una versión purgada. Al podar versiones solo se
 * borraban las filas de la BD, así que data/pdfs crecía sin límite.
 * Acepta valores antiguos con ruta relativa: se queda con el nombre de fichero.
 */
export function eliminarPdf(pdfPath: string | null | undefined): void {
  if (!pdfPath) return;
  try {
    fs.unlinkSync(path.join(PDFS_DIR, path.basename(pdfPath.replace(/\\/g, '/'))));
  } catch {
    /* ya no existe o está en uso: no es un fallo de negocio */
  }
}

// ─── Formateo ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MESES_ES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

// Formatea una fecha tipo "2025-01-22" como "22 de Enero 2025".
function fmtFecha(fecha?: string | null): string {
  if (!fecha) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha);
  if (!m) return fecha;
  const dia = parseInt(m[3], 10);
  const mes = MESES_ES[parseInt(m[2], 10) - 1] ?? '';
  return `${dia} de ${mes} ${m[1]}`;
}

// Escapa texto para insertarlo de forma segura en el HTML del template.
function esc(valor: unknown): string {
  if (valor === null || valor === undefined) return '';
  return String(valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Rutas de fichero permitidas ─────────────────────────────────────────────
// El logo y la plantilla externa salen de la configuración, que se escribe por
// API. Sin confinar la ruta, cualquiera podía apuntar a un fichero cualquiera
// del disco (la propia config con la contraseña SMTP, la BD…) y volcarlo en el
// PDF generado. Se admiten solo rutas dentro de config/ o templates/.
function rutaPermitida(valor: string): string | null {
  const bases = [
    path.resolve(CONFIG_DIR),
    path.resolve(APP_ROOT, 'templates'),
  ];
  const abs = path.isAbsolute(valor)
    ? path.resolve(valor)
    : path.resolve(CONFIG_DIR, valor);
  const permitida = bases.some(b => abs === b || abs.startsWith(b + path.sep));
  return permitida && fs.existsSync(abs) ? abs : null;
}

// ─── Logo ─────────────────────────────────────────────────────────────────────

// Devuelve un src usable en <img> para el logo de la empresa. Acepta un data URI
// (lo más habitual, subido desde Configuración) o una ruta de fichero dentro de
// config/, que se lee y se convierte a data URI. Cadena vacía si no hay logo.
function logoSrc(valor?: string | null): string {
  if (!valor) return '';
  const v = valor.trim();
  if (!v) return '';
  if (v.startsWith('data:')) return v;
  try {
    const ruta = rutaPermitida(v);
    if (!ruta) return '';
    const buf = fs.readFileSync(ruta);
    const ext = path.extname(ruta).toLowerCase();
    const mime =
      ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.webp' ? 'image/webp'
      : '';
    if (!mime) return '';   // solo imágenes
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

// ─── Carga de plantillas ──────────────────────────────────────────────────────

// Las plantillas (.html/.css) viven en una única carpeta `templates/` en la raíz
// del repo y se copian a la raíz de instalación en el build/empaquetado
// (Dockerfile, release Windows). En runtime están en <APP_ROOT>/templates. Para
// dev (tsx, cwd = app/backend) se cae a la carpeta raíz del repo. Una sola copia
// de cada plantilla, sin duplicar entre src y dist.
function resolverTemplatesDir(): string {
  const candidatos = [
    path.join(APP_ROOT, 'templates'),
    path.join(__dirname, '..', '..', '..', '..', 'templates'),
  ];
  for (const dir of candidatos) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidatos[0];
}

const TEMPLATES_DIR = resolverTemplatesDir();

function leerCss(): string {
  try {
    return fs.readFileSync(path.join(TEMPLATES_DIR, 'documento.css'), 'utf-8');
  } catch {
    return '';
  }
}

// Devuelve el HTML de la plantilla a usar. Precedencia:
//   1. documentos.template_html  — plantilla en línea editada desde Configuración
//   2. documentos.template_path  — fichero HTML externo apuntado por el usuario
//   3. plantilla incluida (documento.html)
function cargarPlantilla(): string {
  const docs = getAppConfig().documentos ?? {};

  if (docs.template_html && docs.template_html.trim()) {
    return docs.template_html;
  }

  if (docs.template_path && docs.template_path.trim()) {
    try {
      const ruta = rutaPermitida(docs.template_path);
      if (ruta) return fs.readFileSync(ruta, 'utf-8');
    } catch {
      /* cae a la plantilla incluida */
    }
  }

  return fs.readFileSync(path.join(TEMPLATES_DIR, 'documento.html'), 'utf-8');
}

// ─── Motor de plantillas ──────────────────────────────────────────────────────
// Mini-motor sin dependencias. Soporta:
//   {{clave}}        valor escapado
//   {{{clave}}}      valor sin escapar (logo, CSS…)
//   {{#if clave}}…{{else}}…{{/if}}
//   {{#each lista}}…{{/each}}   (las claves del elemento quedan accesibles dentro)
// Los bloques pueden anidarse.
// Catálogo central de tokens (para la ayuda de la UI): app/frontend/src/config/tokens.ts

type Contexto = Record<string, unknown>;

function lookup(ctx: Contexto, clave: string): unknown {
  return clave
    .split('.')
    .reduce<unknown>((o, k) => (o == null ? undefined : (o as Contexto)[k]), ctx);
}

function esTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

// Sustituye las interpolaciones de un fragmento que ya no contiene bloques.
function interpolar(tpl: string, ctx: Contexto): string {
  return tpl
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_m, k: string) => {
      const v = lookup(ctx, k);
      return v == null ? '' : String(v);
    })
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k: string) => esc(lookup(ctx, k)));
}

// Localiza el cierre del bloque abierto en `desde`, respetando anidamiento.
function finBloque(s: string, desde: number): { inner: string; fin: number } {
  const re = /\{\{#(?:if|each)\s+[\w.]+\s*\}\}|\{\{\/(?:if|each)\}\}/g;
  re.lastIndex = desde;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[0].startsWith('{{#')) depth++;
    else depth--;
    if (depth === 0) return { inner: s.slice(desde, m.index), fin: re.lastIndex };
  }
  return { inner: s.slice(desde), fin: s.length };
}

// Separa el cuerpo de un {{#if}} en sus ramas por el {{else}} de nivel superior.
function partirElse(inner: string): [string, string] {
  const re = /\{\{#(?:if|each)\s+[\w.]+\s*\}\}|\{\{\/(?:if|each)\}\}|\{\{else\}\}/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner)) !== null) {
    if (m[0] === '{{else}}') {
      if (depth === 0) return [inner.slice(0, m.index), inner.slice(re.lastIndex)];
    } else if (m[0].startsWith('{{#')) {
      depth++;
    } else {
      depth--;
    }
  }
  return [inner, ''];
}

function renderTemplate(tpl: string, ctx: Contexto): string {
  const apertura = /\{\{#(if|each)\s+([\w.]+)\s*\}\}/;
  let salida = '';
  let resto = tpl;
  let m: RegExpExecArray | null;

  while ((m = apertura.exec(resto)) !== null) {
    salida += interpolar(resto.slice(0, m.index), ctx);

    const tipo = m[1];
    const clave = m[2];
    const inicio = m.index + m[0].length;
    const { inner, fin } = finBloque(resto, inicio);
    const valor = lookup(ctx, clave);

    if (tipo === 'if') {
      const [siRama, noRama] = partirElse(inner);
      salida += esTruthy(valor) ? renderTemplate(siRama, ctx) : renderTemplate(noRama, ctx);
    } else if (Array.isArray(valor)) {
      for (const item of valor) {
        const hijo: Contexto =
          item !== null && typeof item === 'object'
            ? { ...ctx, ...(item as Contexto) }
            : { ...ctx };
        salida += renderTemplate(inner, hijo);
      }
    }

    resto = resto.slice(fin);
  }

  salida += interpolar(resto, ctx);
  return salida;
}

// ─── Construcción del contexto del documento ──────────────────────────────────

function construirContexto(doc: DocumentoParaPdf, tipo: TipoDocumento): Contexto {
  const appConfig = getAppConfig();
  const profileConfig = getProfileConfig();

  const empresa = appConfig.empresa ?? ({} as AppConfig['empresa']);
  const footerTexto =
    tipo === 'factura'
      ? (profileConfig.footer?.factura ?? '')
      : (profileConfig.footer?.presupuesto ?? '');

  const tituloDoc = tipo === 'factura' ? 'FACTURA' : 'PRESUPUESTO';
  const mostrarIva = tipo === 'factura';
  const ivaPct = doc.totales.iva_porcentaje ?? doc.iva_porcentaje ?? 0;
  const logo = logoSrc(empresa.logo);
  const esFactura = tipo === 'factura';

  return {
    STYLES: leerCss(),
    titulo_doc: tituloDoc,
    etiqueta_numero: esFactura ? 'Nº Factura:' : 'Nº Presupuesto:',
    // Factura: muestra siempre el número (o BORRADOR si aún no está cerrada),
    // ya que la numeración anual es la referencia del documento.
    // Presupuesto: solo si tiene número, en blanco en caso contrario.
    numero: doc.numero ?? (esFactura ? 'BORRADOR' : ''),
    mostrar_numero: esFactura ? true : Boolean(doc.numero),
    mostrar_sello: tipo === 'factura' && doc.estado === 'pagada',

    has_logo: Boolean(logo),
    logo,
    empresa_nombre: empresa.nombre ?? '',
    empresa_cif: empresa.cif ?? '',
    empresa_direccion: empresa.direccion ?? '',
    empresa_email: empresa.email ?? '',
    empresa_telefono: empresa.telefono ?? '',

    cliente_nombre: doc.cliente_empresa || doc.cliente_nombre || '',
    cliente_dni_cif: doc.cliente_dni_cif ?? '',
    cliente_direccion: doc.cliente_direccion ?? doc.agrupador_label ?? '',
    fecha: fmtFecha(doc.fecha),

    lineas: doc.lineas.map(l => ({
      descripcion: l.descripcion ?? '',
      detalle: l.detalle ?? '',
      tiene_detalle: Boolean(l.detalle && String(l.detalle).trim()),
      cantidad: fmt(l.cantidad),
      unidad: l.unidad ?? '',
      precio: `${fmt(l.precio_unitario)} €`,
      importe: `${fmt(l.cantidad * l.precio_unitario)} €`,
    })),

    mostrar_iva: mostrarIva,
    iva_pct: ivaPct,
    iva_importe: `${fmt(doc.totales.iva ?? 0)} €`,
    subtotal: `${fmt(doc.totales.subtotal)} €`,
    total: `${fmt(doc.totales.total)} €`,
    mostrar_nota_iva: tipo === 'presupuesto',

    // Anticipos entregados y restante a pagar (solo facturas con anticipos).
    // Solo el anticipo IMPUTADO a esta factura: el total de la obra se reparte
    // entre sus facturas para no descontarlo entero en todas.
    mostrar_anticipo: esFactura && (doc.anticipo_aplicado ?? doc.anticipo_total ?? 0) > 0,
    anticipo_total: `-${fmt(doc.anticipo_aplicado ?? doc.anticipo_total ?? 0)} €`,
    restante: `${fmt(doc.restante ?? doc.totales.total)} €`,

    notas: doc.notas ?? '',
    footer: footerTexto,
  };
}

function buildHtml(doc: DocumentoParaPdf, tipo: TipoDocumento): string {
  return renderTemplate(cargarPlantilla(), construirContexto(doc, tipo));
}

// ─── Lanzador de navegador (Chromium incluido o Edge del sistema) ─────────────

function encontrarEdge(): string | undefined {
  const candidatos = [
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const ruta of candidatos) {
    try {
      if (fs.existsSync(ruta)) return ruta;
    } catch {
      /* ignorar */
    }
  }
  return undefined;
}

async function lanzarNavegador() {
  // El sandbox de Chromium solo se desactiva en Linux/contenedor, donde el
  // proceso ya corre sin privilegios y el sandbox de espacios de nombres no
  // está disponible. En Windows se mantiene activo.
  const baseArgs =
    process.platform === 'linux' ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];

  const lanzarBundled = () =>
    puppeteer.launch({ headless: true, args: baseArgs });

  const lanzarEdge = () => {
    const edgePath = encontrarEdge();
    if (!edgePath) {
      throw new Error('No se encontró Microsoft Edge instalado en el sistema');
    }
    return puppeteer.launch({ headless: true, args: baseArgs, executablePath: edgePath });
  };

  const modo = getAppConfig().sistema?.chromium_modo === 'edge' ? 'edge' : 'bundled';
  const primario = modo === 'edge' ? lanzarEdge : lanzarBundled;
  const secundario = modo === 'edge' ? lanzarBundled : lanzarEdge;
  const nombrePrimario = modo === 'edge' ? 'Edge del sistema' : 'Chromium incluido';
  const nombreSecundario = modo === 'edge' ? 'Chromium incluido' : 'Edge del sistema';

  try {
    const browser = await primario();
    console.log(`[pdf] Generando PDF con ${nombrePrimario}`);
    return browser;
  } catch (err) {
    console.warn(
      `[pdf] Falló ${nombrePrimario} (${(err as Error).message}); probando ${nombreSecundario}`
    );
    const browser = await secundario();
    console.log(`[pdf] Generando PDF con ${nombreSecundario} (fallback)`);
    return browser;
  }
}

// ─── Generar PDF ──────────────────────────────────────────────────────────────

export async function generarPdf(
  doc: DocumentoParaPdf,
  tipo: TipoDocumento
): Promise<string> {
  const html = buildHtml(doc, tipo);
  const nombre = `${tipo}-${doc.id}-${Date.now()}.pdf`;
  const outputPath = path.join(dirPdfs(), nombre);

  const browser = await lanzarNavegador();

  try {
    const page = await browser.newPage();
    await page.setContent(html, {
      waitUntil: ["load", "domcontentloaded"]
    });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }

  // Se guarda SOLO el nombre del fichero: una ruta relativa al módulo compilado
  // cambiaba entre dev/producción y entre Windows y Docker (separadores
  // distintos), y la BD dejaba de ser portable entre despliegues.
  return nombre;
}