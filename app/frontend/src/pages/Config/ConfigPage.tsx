/**
 * ──────────────────────────────────────────────────────────────────────────────
 * ConfigPage.tsx — Global app configuration editor
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Loads the full app.config.json, keeps it in local state, and saves the
 *   complete object back via PUT (the backend writes it without validating).
 *   Has sections for empresa, documentos, templates PDF, dashboard, email/SMTP
 *   and sistema. Normalizes legacy configs (e.g. numeracion_facturas →
 *   numeracion_factura, missing email plantillas) on load. Also hosts the
 *   year-rollover dialog that resets the invoice counter at the start of a new year.
 *
 * ROUTE
 *   /configuracion
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @utils/api → GET/PUT /config/app
 *     · @ui/Spinner → loading indicator
 *     · ../../config/tokens → available PDF/email template tokens
 *   Backend:
 *     · GET /api/config/app → load configuration
 *     · PUT /api/config/app → persist full config object (no server validation)
 *   Used by:
 *     · Route /configuracion in App.tsx (inside Layout)
 *
 * INPUTS / OUTPUTS
 *   Input:  field edits across sections; year-rollover confirmation
 *   Output: persisted app.config.json; transient ok/error messages
 *
 * NOTES
 *   · The frontend is responsible for sending a complete, coherent config object.
 *   · The year-rollover dialog lives here: it fires when numeracion_factura.anio
 *     is older than the current year, sending contador 0 + current year on confirm.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, Fragment } from 'react';
import api from '@utils/api';
import Spinner from '@ui/Spinner';
import Modal from '@ui/Modal';
import { TOKENS_EMAIL, TOKENS_PDF, BLOQUES_PDF } from '../../config/tokens';

// ─── tipos locales ────────────────────────────────────────────────────────────

interface AppConfig {
  empresa: {
    nombre: string;
    cif: string;
    direccion: string;
    telefono: string;
    email: string;
    logo?: string;
    mano_obra_precio_hora: number;
    mano_obra_unidad: string;
  };
  documentos: {
    iva_porcentaje: number;
    margen_defecto: number;
    max_versiones: number;
    numeracion_factura: { contador: number; anio: number };
    footer_factura: string;
    footer_presupuesto: string;
    template_html?: string;
    template_path?: string;
  };
  dashboard: {
    grafico_tipo: string;
    dias_presupuesto_antiguo: number;
    dias_factura_sin_cobrar?: number;
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
  sistema: {
    email_errores: string;
    actualizacion: {
      hora_inicio: string;
      hora_fin: string;
      inactividad_minutos: number;
    };
  };
}

// ─── hook para cargar y guardar config ───────────────────────────────────────

// Normaliza configuraciones antiguas: la clave de numeración pasó de
// `numeracion_facturas` (plural) a `numeracion_factura` (singular). Algunas
// instalaciones tienen el fichero antiguo; lo migramos al vuelo para que la
// sección Documentos no falle y se guarde ya con la clave correcta.
function normalizarConfig(raw: any): AppConfig {
  const doc = raw?.documentos ?? {};
  if (!doc.numeracion_factura && doc.numeracion_facturas) {
    doc.numeracion_factura = doc.numeracion_facturas;
    delete doc.numeracion_facturas;
  }
  if (!doc.numeracion_factura) {
    doc.numeracion_factura = { contador: 0, anio: new Date().getFullYear() };
  }
  // Garantiza las plantillas de email para instalaciones antiguas.
  raw.email = raw.email ?? {};
  raw.email.smtp = raw.email.smtp ?? {};
  if (!raw.email.plantillas) {
    raw.email.plantillas = {
      factura: {
        asunto: 'Factura {{numero}} — {{empresa}}',
        cuerpo: 'Estimado/a {{cliente}},\n\nAdjuntamos la factura {{numero}}.\n\nUn saludo,\n{{empresa}}',
      },
      presupuesto: {
        asunto: 'Presupuesto — {{obra}}',
        cuerpo: 'Estimado/a {{cliente}},\n\nAdjuntamos el presupuesto solicitado para {{obra}}.\n\nUn saludo,\n{{empresa}}',
      },
    };
  }
  // Garantiza la sección de actualización (forma anidada) para configs antiguas.
  raw.sistema = raw.sistema ?? {};
  if (!raw.sistema.actualizacion) {
    raw.sistema.actualizacion = {
      hora_inicio: raw.sistema.ventana_inicio ?? '03:00',
      hora_fin: raw.sistema.ventana_fin ?? '05:00',
      inactividad_minutos: raw.sistema.minutos_inactividad ?? 15,
    };
  }
  // Limpia las claves planas heredadas (la forma canónica es sistema.actualizacion).
  delete raw.sistema.ventana_inicio;
  delete raw.sistema.ventana_fin;
  delete raw.sistema.minutos_inactividad;
  return raw as AppConfig;
}

function useAppConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: 'ok' | 'error'; texto: string } | null>(null);

  useEffect(() => {
    // Sin .catch, cualquier fallo dejaba la página girando para siempre.
    api.get<AppConfig>('/config/app')
      .then(r => setConfig(normalizarConfig(r.data)))
      .catch(() => setMensaje({ tipo: 'error', texto: 'No se pudo cargar la configuración' }))
      .finally(() => setCargando(false));
  }, []);

  async function guardar(nuevo: AppConfig) {
    setGuardando(true);
    setMensaje(null);
    try {
      await api.put('/config/app', nuevo);
      setConfig(nuevo);
      setMensaje({ tipo: 'ok', texto: 'Configuración guardada correctamente' });
    } catch {
      setMensaje({ tipo: 'error', texto: 'Error al guardar la configuración' });
    } finally {
      setGuardando(false);
      setTimeout(() => setMensaje(null), 3000);
    }
  }

  return { config, setConfig, cargando, guardando, guardar, mensaje };
}

// ─── componentes de campo ─────────────────────────────────────────────────────

function Campo({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function Input({
  value, onChange, type = 'text', placeholder, disabled,
}: {
  value: string | number; onChange: (v: string) => void;
  type?: string; placeholder?: string; disabled?: boolean;
}) {
  return (
    <input
      className="input"
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
    />
  );
}

function Textarea({ value, onChange, rows = 3 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      className="input"
      rows={rows}
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ resize: 'vertical', fontFamily: 'inherit' }}
    />
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>;
}

// ─── botón de prueba de conexión SMTP ─────────────────────────────────────────

function BotonProbarEmail({ smtp }: { smtp: AppConfig['email']['smtp'] }) {
  const [estado, setEstado] = useState<'idle' | 'probando'>('idle');
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  async function probar() {
    setEstado('probando');
    setResultado(null);
    try {
      await api.post('/config/email/test', { smtp });
      setResultado({ ok: true, texto: 'Conexión correcta. El servidor aceptó las credenciales.' });
    } catch (err: any) {
      const texto = err?.response?.data?.error ?? 'No se pudo conectar con el servidor SMTP.';
      setResultado({ ok: false, texto });
    } finally {
      setEstado('idle');
    }
  }

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={probar}
        disabled={estado === 'probando' || !smtp.host}
      >
        {estado === 'probando' ? 'Probando…' : 'Probar conexión'}
      </button>
      {resultado && (
        <div style={{
          fontSize: 12, marginTop: 8,
          color: resultado.ok ? 'var(--green)' : 'var(--red)',
        }}>
          {resultado.ok ? '✓ ' : '✗ '}{resultado.texto}
        </div>
      )}
    </div>
  );
}

// ─── panel de informe de errores al técnico ───────────────────────────────────

function fechaISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function PanelErrores({ emailDestino }: { emailDestino: string }) {
  const hoy = new Date();
  const hace7 = new Date();
  hace7.setDate(hoy.getDate() - 7);

  const [desde, setDesde] = useState(fechaISO(hace7));
  const [hasta, setHasta] = useState(fechaISO(hoy));
  const [total, setTotal] = useState<number | null>(null);
  const [estado, setEstado] = useState<'idle' | 'consultando' | 'enviando'>('idle');
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  async function consultar() {
    setEstado('consultando');
    setResultado(null);
    try {
      const r = await api.get<{ total: number }>('/config/errores', { params: { desde, hasta } });
      setTotal(r.data.total);
    } catch {
      setResultado({ ok: false, texto: 'No se pudo consultar los errores.' });
    } finally {
      setEstado('idle');
    }
  }

  async function enviar() {
    setEstado('enviando');
    setResultado(null);
    try {
      const r = await api.post<{ enviados: number }>('/config/errores/enviar', { desde, hasta });
      setResultado({ ok: true, texto: `Informe enviado (${r.data.enviados} error(es)). Los errores enviados se han borrado.` });
      setTotal(0);
    } catch (err: any) {
      setResultado({ ok: false, texto: err?.response?.data?.error ?? 'No se pudo enviar el informe.' });
    } finally {
      setEstado('idle');
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
        Envía los errores registrados del rango seleccionado al email de notificaciones
        {emailDestino ? <> (<code>{emailDestino}</code>)</> : ' configurado arriba'}. Tras un envío
        correcto, esos errores se eliminan.
      </div>
      <Grid2>
        <Campo label="Desde">
          <Input value={desde} type="date" onChange={setDesde} />
        </Campo>
        <Campo label="Hasta">
          <Input value={hasta} type="date" onChange={setHasta} />
        </Campo>
      </Grid2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <button type="button" className="btn btn-ghost" onClick={consultar} disabled={estado !== 'idle'}>
          {estado === 'consultando' ? 'Consultando…' : 'Consultar'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={enviar}
          disabled={estado !== 'idle' || !emailDestino || total === 0}
        >
          {estado === 'enviando' ? 'Enviando…' : 'Enviar informe'}
        </button>
        {total !== null && (
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {total} error(es) en el rango
          </span>
        )}
      </div>
      {!emailDestino && (
        <div style={{ fontSize: 12, color: 'var(--orange, #c80)', marginTop: 8 }}>
          Configura el «Email para notificaciones de error» de arriba para poder enviar.
        </div>
      )}
      {resultado && (
        <div style={{ fontSize: 12, marginTop: 8, color: resultado.ok ? 'var(--green)' : 'var(--red)' }}>
          {resultado.ok ? '✓ ' : '✗ '}{resultado.texto}
        </div>
      )}
    </div>
  );
}

// ─── panel de contraseña de acceso ───────────────────────────────────────────
// Mientras no haya contraseña, la API responde a cualquiera que llegue por la
// red local. Al establecerla, todos los endpoints exigen sesión.

function PanelAcceso() {
  const [configurado, setConfigurado] = useState<boolean | null>(null);
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [estado, setEstado] = useState<'idle' | 'enviando'>('idle');
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  useEffect(() => {
    api.get('/auth/estado')
      .then(r => setConfigurado(Boolean(r.data.configurado)))
      .catch(() => setConfigurado(false));
  }, []);

  async function guardar() {
    setEstado('enviando');
    setResultado(null);
    try {
      await api.post('/auth/password', { nueva, actual: actual || undefined });
      setConfigurado(true);
      setActual('');
      setNueva('');
      setResultado({ ok: true, texto: 'Contraseña guardada. La app pedirá acceso al entrar.' });
    } catch (err) {
      setResultado({ ok: false, texto: (err as Error).message });
    } finally {
      setEstado('idle');
    }
  }

  async function quitar() {
    setEstado('enviando');
    setResultado(null);
    try {
      await api.delete('/auth/password', { data: { actual } });
      setConfigurado(false);
      setActual('');
      setResultado({ ok: true, texto: 'Acceso sin contraseña restablecido.' });
    } catch (err) {
      setResultado({ ok: false, texto: (err as Error).message });
    } finally {
      setEstado('idle');
    }
  }

  if (configurado === null) return null;

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
        {configurado
          ? 'La aplicación pide contraseña al abrirla. Cambia la contraseña o desactiva el acceso protegido.'
          : 'Ahora mismo cualquier equipo de la red local puede abrir la aplicación y usar la API. Establece una contraseña para exigir acceso.'}
      </div>
      <div className="form-grid-2">
        {configurado && (
          <Campo label="Contraseña actual">
            <Input type="password" value={actual} onChange={setActual} />
          </Campo>
        )}
        <Campo label={configurado ? 'Contraseña nueva' : 'Contraseña'} hint="Mínimo 6 caracteres">
          <Input type="password" value={nueva} onChange={setNueva} />
        </Campo>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={guardar}
          disabled={estado === 'enviando' || nueva.length < 6 || (configurado && !actual)}
        >
          {configurado ? 'Cambiar contraseña' : 'Activar acceso protegido'}
        </button>
        {configurado && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={quitar}
            disabled={estado === 'enviando' || !actual}
          >
            Desactivar
          </button>
        )}
      </div>
      {resultado && (
        <div style={{ fontSize: 12, marginTop: 8, color: resultado.ok ? 'var(--green)' : 'var(--red)' }}>
          {resultado.ok ? '✓ ' : '✗ '}{resultado.texto}
        </div>
      )}
    </div>
  );
}

// ─── panel de borrado total de datos (fresh start) ───────────────────────────

function PanelReset() {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('');
  const [estado, setEstado] = useState<'idle' | 'borrando'>('idle');
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null);

  function cerrar() {
    setAbierto(false);
    setTexto('');
  }

  async function borrar() {
    setEstado('borrando');
    try {
      await api.post('/config/reset-datos', { confirmar: 'BORRAR' });
      setResultado({ ok: true, texto: 'Todos los datos se han borrado. La configuración se ha conservado.' });
      cerrar();
    } catch (err: any) {
      setResultado({ ok: false, texto: (err as Error)?.message ?? 'No se pudieron borrar los datos.' });
    } finally {
      setEstado('idle');
    }
  }

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
        Elimina <strong>todos</strong> los clientes, direcciones, obras, albaranes, presupuestos,
        facturas, seguimientos y PDFs generados, dejando la base de datos vacía como recién instalada.
        La configuración (empresa, email, plantillas…) se conserva. Esta acción no se puede deshacer.
      </div>
      <button type="button" className="btn btn-danger" onClick={() => { setResultado(null); setAbierto(true); }}>
        Borrar todos los datos
      </button>
      {resultado && (
        <div style={{ fontSize: 12, marginTop: 8, color: resultado.ok ? 'var(--green)' : 'var(--red)' }}>
          {resultado.ok ? '✓ ' : '✗ '}{resultado.texto}
        </div>
      )}

      {abierto && (
        <Modal
          title="Borrar todos los datos"
          size="sm"
          onClose={cerrar}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={cerrar} disabled={estado === 'borrando'}>
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={borrar}
                disabled={texto !== 'BORRAR' || estado === 'borrando'}
              >
                {estado === 'borrando' ? <><span className="spinner" /> Borrando…</> : 'Borrar definitivamente'}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Se eliminarán de forma permanente todos los clientes, albaranes, presupuestos,
            facturas y seguimientos, junto con sus PDFs. La configuración se conserva.
            <br /><br />
            Escribe <code>BORRAR</code> para confirmar:
          </div>
          <input
            className="input"
            style={{ marginTop: 10 }}
            value={texto}
            onChange={e => setTexto(e.target.value)}
            placeholder="BORRAR"
            autoFocus
          />
        </Modal>
      )}
    </div>
  );
}

// ─── carga de logo (se guarda como data URI base64) ───────────────────────────

function LogoUpload({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [error, setError] = useState<string | null>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    if (!file.type.startsWith('image/')) {
      setError('El archivo debe ser una imagen (PNG, JPG, SVG…)');
      return;
    }
    if (file.size > 1024 * 1024) {
      setError('La imagen es demasiado grande (máximo 1 MB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.onerror = () => setError('No se pudo leer la imagen');
    reader.readAsDataURL(file);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{
          width: 160, height: 80, flexShrink: 0,
          border: '1px dashed var(--border)', borderRadius: 'var(--radius)',
          background: 'var(--bg-3)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          {value
            ? <img src={value} alt="logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Sin logo</span>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label className="btn btn-primary" style={{ cursor: 'pointer', margin: 0 }}>
            {value ? 'Cambiar logo' : 'Subir logo'}
            <input type="file" accept="image/*" onChange={onFile} style={{ display: 'none' }} />
          </label>
          {value && (
            <button type="button" className="btn btn-ghost" onClick={() => onChange('')}>
              Quitar logo
            </button>
          )}
        </div>
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

// ─── sección wrapper ──────────────────────────────────────────────────────────

function Seccion({ titulo, desc, children }: { titulo: string; desc?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>{titulo}</h2>
        {desc && <p style={{ fontSize: 12, color: 'var(--text-2)' }}>{desc}</p>}
      </div>
      <div className="card-section" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {children}
      </div>
    </div>
  );
}

// ─── sección de templates PDF ─────────────────────────────────────────────────

// Variables disponibles en la plantilla. Deben coincidir con el contexto que
// construye el backend en pdf.service.ts (construirContexto).
const VARIABLES_TEMPLATE = TOKENS_PDF;

const BLOQUES_TEMPLATE = BLOQUES_PDF;

function ReferenciaVariables() {
  const [abierto, setAbierto] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setAbierto(a => !a)}
        style={{
          width: '100%', textAlign: 'left', background: 'var(--bg-3)', border: 'none',
          padding: '10px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
          color: 'var(--text-2)', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span>Variables disponibles en la plantilla</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{abierto ? '▲ ocultar' : '▼ mostrar'}</span>
      </button>
      {abierto && (
        <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 6 }}>Valores</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 }}>
              {VARIABLES_TEMPLATE.map(v => (
                <Fragment key={v.token}>
                  <code style={{ fontFamily: 'monospace', color: 'var(--accent)', whiteSpace: 'nowrap' }}>{v.token}</code>
                  <span style={{ color: 'var(--text-2)' }}>{v.desc}</span>
                </Fragment>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 6 }}>Bloques (condiciones y listas)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: 12 }}>
              {BLOQUES_TEMPLATE.map(v => (
                <Fragment key={v.token}>
                  <code style={{ fontFamily: 'monospace', color: 'var(--accent)', whiteSpace: 'nowrap' }}>{v.token}</code>
                  <span style={{ color: 'var(--text-2)' }}>{v.desc}</span>
                </Fragment>
              ))}
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Usa <code style={{ fontFamily: 'monospace' }}>{'{{ variable }}'}</code> para texto seguro y{' '}
            <code style={{ fontFamily: 'monospace' }}>{'{{{ variable }}}'}</code> para HTML sin escapar (logo y estilos).
          </div>
        </div>
      )}
    </div>
  );
}

function TemplatesSection({
  config, set,
}: {
  config: AppConfig;
  set: (path: string[], value: unknown) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [nombreFichero, setNombreFichero] = useState<string | null>(null);

  const html = config.documentos.template_html ?? '';
  const usandoPersonalizada = html.trim().length > 0;

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    const esHtml = /\.html?$/i.test(file.name) || file.type === 'text/html';
    if (!esHtml) {
      setError('El archivo debe ser un .html');
      return;
    }
    if (file.size > 512 * 1024) {
      setError('El archivo es demasiado grande (máximo 512 KB)');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      set(['documentos', 'template_html'], String(reader.result));
      setNombreFichero(file.name);
    };
    reader.onerror = () => setError('No se pudo leer el archivo');
    reader.readAsText(file);
  }

  function restaurarDefault() {
    set(['documentos', 'template_html'], '');
    setNombreFichero(null);
    setError(null);
  }

  return (
    <Seccion titulo="Templates PDF" desc="Personaliza el diseño de facturas y presupuestos generados">
      <div style={{
        padding: '10px 14px', borderRadius: 'var(--radius)',
        background: usandoPersonalizada ? 'var(--accent-dim)' : 'var(--bg-3)',
        border: '1px solid var(--border)', fontSize: 12,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: usandoPersonalizada ? 'var(--accent)' : 'var(--text-3)',
        }} />
        {usandoPersonalizada
          ? <span>Usando una plantilla <strong>personalizada</strong>{nombreFichero ? ` (${nombreFichero})` : ''}.</span>
          : <span>Usando la plantilla <strong>incluida</strong> por defecto.</span>}
      </div>

      <Campo
        label="Cargar plantilla HTML"
        hint="Sube el fichero .html que te hayan proporcionado. Sustituye a la plantilla incluida."
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <label className="btn btn-primary" style={{ cursor: 'pointer', margin: 0 }}>
            Subir fichero HTML
            <input type="file" accept=".html,.htm,text/html" onChange={onFile} style={{ display: 'none' }} />
          </label>
          {usandoPersonalizada && (
            <button type="button" className="btn btn-ghost" onClick={restaurarDefault}>
              Restaurar plantilla por defecto
            </button>
          )}
        </div>
        {error && <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>{error}</div>}
      </Campo>

      <Campo label="Contenido de la plantilla" hint="Puedes pegar o editar el HTML directamente. Déjalo vacío para usar la plantilla incluida.">
        <textarea
          className="input"
          rows={18}
          value={html}
          onChange={e => { set(['documentos', 'template_html'], e.target.value); setNombreFichero(null); }}
          style={{ fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          placeholder="Vacío → se usa la plantilla incluida por defecto"
        />
      </Campo>

      <ReferenciaVariables />

      <Campo
        label="Ruta a plantilla externa (avanzado, opcional)"
        hint="Alternativa a lo anterior: ruta a un fichero .html en disco. Solo se usa si el contenido de arriba está vacío. Relativa a la carpeta raíz del proyecto."
      >
        <Input
          value={config.documentos.template_path ?? ''}
          placeholder="ej. config/mi_template.html"
          onChange={v => set(['documentos', 'template_path'], v || undefined)}
        />
      </Campo>
    </Seccion>
  );
}

// ─── tabs de navegación lateral ───────────────────────────────────────────────

const TABS = [
  { id: 'empresa', label: 'Empresa' },
  { id: 'documentos', label: 'Documentos' },
  { id: 'templates', label: 'Templates PDF' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'email', label: 'Email / SMTP' },
  { id: 'sistema', label: 'Sistema' },
] as const;

type TabId = typeof TABS[number]['id'];

// ─── diálogo de inicio de año ─────────────────────────────────────────────────

function DialogoAnioNuevo({
  anioDoc, anioActual, onConfirmar, onPosponer,
}: {
  anioDoc: number; anioActual: number;
  onConfirmar: () => void; onPosponer: () => void;
}) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}>
      <div className="card" style={{ maxWidth: 420, width: '100%', margin: 20 }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>🎉</div>
        <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Nuevo año {anioActual}</h2>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20, lineHeight: 1.6 }}>
          Las facturas estaban numeradas con el año {anioDoc}.
          ¿Quieres reiniciar la numeración desde <strong>0001</strong> para {anioActual}?
          <br /><br />
          Si tienes facturas pendientes del año anterior, puedes posponer esta acción.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onPosponer}>Posponer</button>
          <button className="btn btn-primary" onClick={onConfirmar}>Reiniciar numeración</button>
        </div>
      </div>
    </div>
  );
}

// ─── página principal ─────────────────────────────────────────────────────────

export default function ConfigPage() {
  const { config, setConfig, cargando, guardando, guardar, mensaje } = useAppConfig();
  const [tab, setTab] = useState<TabId>('empresa');

  // Diálogo de inicio de año
  const anioActual = new Date().getFullYear();
  const anioDoc = config?.documentos?.numeracion_factura?.anio ?? anioActual;
  const [mostrarDialogoAnio, setMostrarDialogoAnio] = useState(false);

  useEffect(() => {
    // Depende del AÑO, no del objeto config: con [config] cualquier tecleo
    // volvía a abrir el diálogo después de haberlo pospuesto.
    if (anioDoc < anioActual) setMostrarDialogoAnio(true);
  }, [anioDoc, anioActual]);

  function confirmarNuevoAnio() {
    if (!config) return;
    const nuevo = {
      ...config,
      documentos: {
        ...config.documentos,
        numeracion_factura: { contador: 0, anio: anioActual },
      },
    };
    setConfig(nuevo);
    guardar(nuevo);
    setMostrarDialogoAnio(false);
  }

  function set(path: string[], value: any) {
    if (!config) return;
    // Copia superficial por nivel de la ruta editada. El clonado profundo se
    // ejecutaba en CADA tecla, incluidos los 512 KB de template_html.
    const nuevo: any = { ...config };
    let obj = nuevo;
    for (let i = 0; i < path.length - 1; i++) {
      obj[path[i]] = { ...obj[path[i]] };
      obj = obj[path[i]];
    }
    obj[path[path.length - 1]] = value;
    setConfig(nuevo);
  }

  // parseFloat/parseInt devuelven NaN al vaciar el campo, y NaN se serializa
  // como null en el PUT (el backend lo guarda sin validar).
  const num = (v: string, entero = false) => {
    const n = entero ? parseInt(v, 10) : parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };

  function onGuardar() {
    if (config) guardar(config);
  }

  if (cargando) return <Spinner label="Cargando configuración…" />;
  if (!config) return <div style={{ padding: 32, color: 'var(--red)' }}>Error cargando la configuración</div>;

  return (
    <>
      {mostrarDialogoAnio && (
        <DialogoAnioNuevo
          anioDoc={anioDoc}
          anioActual={anioActual}
          onConfirmar={confirmarNuevoAnio}
          onPosponer={() => setMostrarDialogoAnio(false)}
        />
      )}

      <div className="config-layout" style={{ display: 'flex', height: '100%' }}>

        {/* ── nav lateral ─────────────────────────────── */}
        <nav className="config-nav" style={{
          width: 180, flexShrink: 0,
          borderRight: '1px solid var(--border)',
          padding: '24px 0',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0 16px', marginBottom: 8 }}>
            Configuración
          </div>
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                background: tab === t.id ? 'var(--accent-dim)' : 'transparent',
                border: 'none', borderLeft: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`,
                padding: '8px 16px', textAlign: 'left', cursor: 'pointer',
                fontSize: 13, color: tab === t.id ? 'var(--accent)' : 'var(--text-2)',
                fontWeight: tab === t.id ? 600 : 400,
                transition: 'all 150ms',
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* ── contenido ────────────────────────────────────────────────── */}
        <div className="config-content" style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
          <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 24 }}>

            {/* EMPRESA */}
            {tab === 'empresa' && (
              <Seccion titulo="Datos de empresa" desc="Aparecen en la cabecera de facturas y presupuestos">
                <Campo label="Logo" hint="Aparece en la cabecera de los PDF. PNG, JPG o SVG (máximo 1 MB).">
                  <LogoUpload value={config.empresa.logo} onChange={v => set(['empresa', 'logo'], v)} />
                </Campo>
                <Campo label="Nombre o razón social *">
                  <Input value={config.empresa.nombre} onChange={v => set(['empresa', 'nombre'], v)} />
                </Campo>
                <Grid2>
                  <Campo label="CIF / NIF *">
                    <Input value={config.empresa.cif} onChange={v => set(['empresa', 'cif'], v)} />
                  </Campo>
                  <Campo label="Teléfono">
                    <Input value={config.empresa.telefono} onChange={v => set(['empresa', 'telefono'], v)} />
                  </Campo>
                </Grid2>
                <Campo label="Dirección fiscal">
                  <Input value={config.empresa.direccion} onChange={v => set(['empresa', 'direccion'], v)} />
                </Campo>
                <Campo label="Email de empresa">
                  <Input value={config.empresa.email} type="email" onChange={v => set(['empresa', 'email'], v)} />
                </Campo>
                <Grid2>
                  <Campo label="Precio mano de obra (€/h)">
                    <Input value={config.empresa.mano_obra_precio_hora} type="number" onChange={v => set(['empresa', 'mano_obra_precio_hora'], num(v))} />
                  </Campo>
                  <Campo label="Unidad mano de obra">
                    <Input value={config.empresa.mano_obra_unidad} placeholder="h" onChange={v => set(['empresa', 'mano_obra_unidad'], v)} />
                  </Campo>
                </Grid2>
              </Seccion>
            )}

            {/* DOCUMENTOS */}
            {tab === 'documentos' && (
              <Seccion titulo="Documentos" desc="Parámetros de facturas y presupuestos">
                <Grid2>
                  <Campo label="IVA por defecto (%)" hint="Se aplica al subtotal de las facturas">
                    <Input value={config.documentos.iva_porcentaje} type="number" onChange={v => set(['documentos', 'iva_porcentaje'], num(v))} />
                  </Campo>
                  <Campo label="Margen por defecto (%)" hint="Porcentaje que se aplica al coste del material">
                    <Input value={config.documentos.margen_defecto} type="number" onChange={v => set(['documentos', 'margen_defecto'], num(v))} />
                  </Campo>
                </Grid2>
                <Campo label="Versiones máximas por documento" hint="Al superar el límite se elimina la más antigua">
                  <Input value={config.documentos.max_versiones} type="number" onChange={v => set(['documentos', 'max_versiones'], num(v, true))} />
                </Campo>
                <div style={{ padding: '12px 14px', background: 'var(--bg-3)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>NUMERACIÓN DE FACTURAS</div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <span style={{ fontSize: 13 }}>
                      Próxima factura: <strong>{String(config.documentos.numeracion_factura.contador + 1).padStart(4, '0')}</strong> · Año <strong>{config.documentos.numeracion_factura.anio}</strong>
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    La numeración se gestiona automáticamente. Al inicio de año nuevo se te preguntará si reiniciar.
                  </div>
                </div>
                <Campo label="Pie de factura">
                  <Textarea value={config.documentos.footer_factura} onChange={v => set(['documentos', 'footer_factura'], v)} />
                </Campo>
                <Campo label="Pie de presupuesto">
                  <Textarea value={config.documentos.footer_presupuesto} onChange={v => set(['documentos', 'footer_presupuesto'], v)} />
                </Campo>
              </Seccion>
            )}

            {/* TEMPLATES */}
            {tab === 'templates' && (
              <TemplatesSection config={config} set={set} />
            )}

            {/* DASHBOARD */}
            {tab === 'dashboard' && (
              <Seccion titulo="Dashboard" desc="Parámetros del panel de control">
                <Campo label="Días para considerar presupuesto antiguo" hint="Presupuestos enviados sin respuesta desde hace más de X días aparecerán como urgentes">
                  <Input
                    value={config.dashboard.dias_presupuesto_antiguo}
                    type="number"
                    onChange={v => set(['dashboard', 'dias_presupuesto_antiguo'], num(v, true))}
                  />
                </Campo>
                <Campo label="Días para considerar factura sin cobrar" hint="Facturas en pendiente de pago desde hace más de X días aparecerán en rojo">
                  <Input
                    value={config.dashboard.dias_factura_sin_cobrar ?? 30}
                    type="number"
                    onChange={v => set(['dashboard', 'dias_factura_sin_cobrar'], num(v, true))}
                  />
                </Campo>
                <Campo label="Tipo de gráfico económico" hint="Cambia la visualización del resumen económico">
                  <select
                    className="select"
                    value={config.dashboard.grafico_tipo}
                    onChange={e => set(['dashboard', 'grafico_tipo'], e.target.value)}
                  >
                    <option value="barras_lineas">Barras + línea de proyección</option>
                    <option value="barras">Solo barras</option>
                    <option value="lineas">Solo líneas</option>
                  </select>
                </Campo>
              </Seccion>
            )}

            {/* EMAIL */}
            {tab === 'email' && (
              <Seccion titulo="Email / SMTP" desc="Configuración del servidor de correo para envío de facturas y notificaciones">
                <Campo label="Servidor SMTP">
                  <Input value={config.email.smtp.host} placeholder="smtp.gmail.com" onChange={v => set(['email', 'smtp', 'host'], v)} />
                </Campo>
                <Grid2>
                  <Campo label="Puerto">
                    <Input value={config.email.smtp.port} type="number" onChange={v => set(['email', 'smtp', 'port'], num(v, true))} />
                  </Campo>
                  <Campo label="Seguridad">
                    <select
                      className="select"
                      value={config.email.smtp.secure ? 'ssl' : 'tls'}
                      onChange={e => set(['email', 'smtp', 'secure'], e.target.value === 'ssl')}
                    >
                      <option value="tls">STARTTLS (puerto 587)</option>
                      <option value="ssl">SSL/TLS (puerto 465)</option>
                    </select>
                  </Campo>
                </Grid2>
                <Grid2>
                  <Campo label="Usuario">
                    <Input value={config.email.smtp.user} placeholder="tu@email.com" onChange={v => set(['email', 'smtp', 'user'], v)} />
                  </Campo>
                  <Campo label="Contraseña">
                    <Input value={config.email.smtp.pass} type="password" onChange={v => set(['email', 'smtp', 'pass'], v)} />
                  </Campo>
                </Grid2>
                <Campo label="Dirección de envío (From)">
                  <Input value={config.email.smtp.from} placeholder="Reformas García <info@reformas.com>" onChange={v => set(['email', 'smtp', 'from'], v)} />
                </Campo>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.5 }}>
                  Gmail y Apple (iCloud) exigen una <strong>contraseña de aplicación</strong>, no la
                  contraseña normal de la cuenta. Gmail: servidor <code>smtp.gmail.com</code>, puerto
                  587 (STARTTLS) o 465 (SSL/TLS). iCloud: <code>smtp.mail.me.com</code>, puerto 587
                  (STARTTLS). Guarda los cambios y pulsa «Probar conexión» para validar.
                </div>
                <BotonProbarEmail smtp={config.email.smtp} />

                <div style={{ borderTop: '1px solid var(--border)', margin: '20px 0 4px' }} />
                <h4 style={{ margin: '0 0 4px', fontSize: 14 }}>Plantillas de email</h4>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 12, lineHeight: 1.5 }}>
                  Texto del email que acompaña a facturas y presupuestos. Tokens disponibles:{' '}
                  {TOKENS_EMAIL.map((t, i) => (
                    <Fragment key={t.token}>
                      {i > 0 && ', '}
                      <code>{t.token}</code>
                    </Fragment>
                  ))}
                  . Los presupuestos no llevan número: usa <code>{'{{obra}}'}</code>.
                </div>
                <Campo label="Asunto — Factura">
                  <Input value={config.email.plantillas.factura.asunto} onChange={v => set(['email', 'plantillas', 'factura', 'asunto'], v)} />
                </Campo>
                <Campo label="Cuerpo — Factura">
                  <Textarea rows={5} value={config.email.plantillas.factura.cuerpo} onChange={v => set(['email', 'plantillas', 'factura', 'cuerpo'], v)} />
                </Campo>
                <Campo label="Asunto — Presupuesto">
                  <Input value={config.email.plantillas.presupuesto.asunto} onChange={v => set(['email', 'plantillas', 'presupuesto', 'asunto'], v)} />
                </Campo>
                <Campo label="Cuerpo — Presupuesto">
                  <Textarea rows={5} value={config.email.plantillas.presupuesto.cuerpo} onChange={v => set(['email', 'plantillas', 'presupuesto', 'cuerpo'], v)} />
                </Campo>
              </Seccion>
            )}

            {/* SISTEMA */}
            {tab === 'sistema' && (
              <Seccion titulo="Sistema" desc="Parámetros del servicio y actualizaciones automáticas">
                <div style={{ paddingBottom: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Acceso a la aplicación</div>
                  <PanelAcceso />
                </div>

                <Campo label="Email para notificaciones de error" hint="El launcher enviará aquí los errores críticos">
                  <Input value={config.sistema.email_errores} type="email" onChange={v => set(['sistema', 'email_errores'], v)} />
                </Campo>
                <Grid2>
                  <Campo label="Ventana actualización — inicio" hint="Hora en formato HH:MM">
                    <Input value={config.sistema.actualizacion.hora_inicio} placeholder="03:00" onChange={v => set(['sistema', 'actualizacion', 'hora_inicio'], v)} />
                  </Campo>
                  <Campo label="Ventana actualización — fin" hint="Hora en formato HH:MM">
                    <Input value={config.sistema.actualizacion.hora_fin} placeholder="05:00" onChange={v => set(['sistema', 'actualizacion', 'hora_fin'], v)} />
                  </Campo>
                </Grid2>
                <Campo label="Minutos de inactividad para actualizar" hint="Solo aplica actualizaciones si el usuario lleva X minutos sin actividad">
                  <Input value={config.sistema.actualizacion.inactividad_minutos} type="number" onChange={v => set(['sistema', 'actualizacion', 'inactividad_minutos'], num(v, true))} />
                </Campo>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Informe de errores al técnico</div>
                  <PanelErrores emailDestino={config.sistema.email_errores} />
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Actualización manual</div>
                  <UpdatePanel />
                </div>

                <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 4 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, color: 'var(--red)' }}>Zona peligrosa — Reiniciar datos</div>
                  <PanelReset />
                </div>
              </Seccion>
            )}

            {/* ── botón guardar ────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 8 }}>
              <button className="btn btn-primary" onClick={onGuardar} disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar cambios'}
              </button>
              {mensaje && (
                <span style={{ fontSize: 13, color: mensaje.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>
                  {mensaje.texto}
                </span>
              )}
            </div>

          </div>
        </div>
      </div>
    </>
  );
}

// ─── panel de actualización manual ───────────────────────────────────────────

function UpdatePanel() {
  const [estado, setEstado] = useState<'idle' | 'comprobando' | 'hay_update' | 'sin_update' | 'descargando' | 'listo'>('idle');
  const [version, setVersion] = useState<string | null>(null);

  async function comprobar() {
    setEstado('comprobando');
    try {
      const { data } = await api.get<{ hay_update: boolean; version?: string }>('/status/update');
      if (data.hay_update) {
        setVersion(data.version ?? null);
        setEstado('hay_update');
      } else {
        setEstado('sin_update');
      }
    } catch {
      setEstado('idle');
    }
  }

  async function aplicar(ahora: boolean) {
    setEstado('descargando');
    try {
      await api.post('/status/update/apply', { reiniciar_ahora: ahora });
      setEstado('listo');
    } catch {
      setEstado('hay_update');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {estado === 'idle' && (
        <button className="btn btn-ghost" onClick={comprobar}>Comprobar actualizaciones</button>
      )}
      {estado === 'comprobando' && (
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Comprobando…</span>
      )}
      {estado === 'sin_update' && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 13, color: 'var(--green)' }}>✓ Tienes la versión más reciente</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setEstado('idle')}>
            Volver a comprobar
          </button>
        </div>
      )}
      {estado === 'hay_update' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 13, color: 'var(--accent)' }}>
            Nueva versión disponible: <strong>{version}</strong>
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => aplicar(false)}>
              Descargar y aplicar al reiniciar
            </button>
            <button className="btn btn-primary" onClick={() => aplicar(true)}>
              Descargar y reiniciar ahora
            </button>
          </div>
        </div>
      )}
      {estado === 'descargando' && (
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Descargando actualización…</span>
      )}
      {estado === 'listo' && (
        <span style={{ fontSize: 13, color: 'var(--green)' }}>✓ Actualización aplicada. El sistema se reiniciará cuando sea posible.</span>
      )}
    </div>
  );
}