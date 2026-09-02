/**
 * ──────────────────────────────────────────────────────────────────────────────
 * FacturaPage.tsx — Invoice editor page (full document workspace)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Loads a single invoice by id and renders its full editor: header data,
 *   the controlled DocumentoEditor (line state lives HERE, in the parent),
 *   the BarraAcciones toolbar and modals (add-from-albarán, send email,
 *   history). Owns autosave (every 3 min while in borrador), explicit save,
 *   PDF download/print, sending, closing and deletion.
 *
 * ROUTE
 *   /facturas/:id
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @store/facturas.store → load/save/close/state/pdf/send/delete actions
 *     · @store/config.store → default margin for new albarán lines
 *     · DocumentoEditor → controlled line editor (receives lineas + onChange)
 *     · BarraAcciones → action toolbar (Guardar/Cerrar/PDF/Enviar/…)
 *     · PanelHistorial → version history modal
 *     · ModalAñadirAlbaran → pick albarán lines to import as material
 *     · @utils/api → direct blob fetch of the latest PDF
 *   Backend (via store unless noted):
 *     · GET    /api/facturas/:id → load detail
 *     · PUT    /api/facturas/:id/lineas → save lines
 *     · POST   /api/facturas/:id/borrador → autosave draft
 *     · POST   /api/facturas/:id/cerrar → close & assign number
 *     · POST   /api/facturas/:id/estado → reopen as borrador
 *     · POST   /api/facturas/:id/pdf → generate PDF version
 *     · GET    /api/facturas/:id/pdf/latest → download/print (direct api call)
 *     · POST   /api/facturas/:id/enviar → email the invoice
 *     · DELETE /api/facturas/:id → delete draft
 *   Used by:
 *     · Route /facturas/:id in App.tsx (navigated from lists/cliente ficha)
 *
 * INPUTS / OUTPUTS
 *   Input:  url param :id; user edits lines and triggers toolbar actions
 *   Output: rendered editor UI, persisted lines/state, generated PDFs,
 *           navigation back on delete
 *
 * NOTES
 *   · Editing is only allowed in 'borrador'; other states are readonly until
 *     reopened (which drops the assigned number).
 *   · Close requires ≥1 material line (blocks) and warns (no block) if there
 *     is no labour line; all this business logic lives in the frontend.
 *   · coste_unitario / margen_porcentaje are internal and never shown in PDF.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useFacturasStore, LineaFactura } from '@store/facturas.store';
import Spinner from '@ui/Spinner';
import Modal from '@ui/Modal';
import DocumentoEditor, { LineaEditor, genKey } from '@pages/Documentos/components/DocumentoEditor';
import BarraAcciones from '@pages/Documentos/components/BarraAcciones';
import PanelHistorial from '@pages/Documentos/components/PanelHistorial';
import ModalAñadirAlbaran from '@pages/Documentos/components/ModalAñadirAlbaran';
import { useConfigStore } from '@store/config.store';
import api from '@utils/api';

const AUTOSAVE_MS = 3 * 60 * 1000;



// Convierte una LineaFactura del backend al formato del editor
function facturaLineaToEditor(l: LineaFactura): LineaEditor {
  return {
    _key: genKey(),
    descripcion: l.descripcion,
    detalle: l.detalle ?? null,
    cantidad: l.cantidad,
    unidad: l.unidad ?? '',
    precio_unitario: l.precio_unitario,
    coste_unitario: l.coste_unitario ?? null,
    margen_porcentaje: l.margen_porcentaje ?? null,
    tipo: l.tipo,
    es_libre: l.es_libre,
    albaran_linea_id: l.albaran_linea_id ?? null,
  };
}

// Convierte LineaEditor al formato que espera el backend
function editorLineaToBack(l: LineaEditor): Omit<LineaFactura, 'id' | 'factura_id' | 'orden'> {
  return {
    descripcion: l.descripcion,
    detalle: l.detalle ?? null,
    cantidad: l.cantidad,
    unidad: l.unidad || null,
    precio_unitario: l.precio_unitario,
    coste_unitario: l.coste_unitario,
    margen_porcentaje: l.margen_porcentaje,
    tipo: l.tipo,
    es_libre: l.es_libre,
    albaran_linea_id: l.albaran_linea_id,
  };
}

export default function FacturaPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const appConfig = useConfigStore(state => state.appConfig);
  const {
    actual, loading, error,
    cargarFactura, guardarLineas, guardarBorrador,
    cerrarFactura, cambiarEstado, generarPdf, enviar, eliminar
  } = useFacturasStore();

  // ─── Estado controlado de líneas (Opción A) ─────────────────────────────────
  const [lineas, setLineas] = useState<LineaEditor[]>([]);

  const [guardando, setGuardando] = useState(false);
  const [showHistorial, setShowHistorial] = useState(false);
  const [showEnviar, setShowEnviar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [showModalAlbaran, setShowModalAlbaran] = useState(false);
  const [emailDestino, setEmailDestino] = useState('');
  const [errorCierre, setErrorCierre] = useState<string | null>(null);
  const [confirmSinMO, setConfirmSinMO] = useState(false);

  const autosaveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cargar factura al montar
  useEffect(() => {
    if (id) cargarFactura(id);
    return () => { if (autosaveTimer.current) clearInterval(autosaveTimer.current); };
  }, [id]);

  // Cuando llega la factura del store, inicializar el estado local de líneas
  useEffect(() => {
    if (!actual) return;
    setLineas(actual.lineas.map(facturaLineaToEditor));
    setEmailDestino(actual.cliente_email ?? '');
  }, [actual?.id]); // solo cuando cambia el documento, no en cada render

  // Arrancar autosave si está en borrador
  const lineasRef = useRef(lineas);
  useEffect(() => { lineasRef.current = lineas; });   // sin deps: cada render

  useEffect(() => {
    if (!actual || !id || actual.estado !== 'borrador') return;
    // Se leen las líneas VIVAS desde la ref: el intervalo capturaba las del
    // render en que se montó el efecto, así que el borrador se autoguardaba
    // siempre con las líneas originales y nunca con las ediciones del usuario.
    autosaveTimer.current = setInterval(() => {
      guardarBorrador(id, { lineas: lineasRef.current });
    }, AUTOSAVE_MS);
    return () => { if (autosaveTimer.current) clearInterval(autosaveTimer.current); };
  }, [actual?.id, actual?.estado]);

  // ─── Guardar explícito ──────────────────────────────────────────────────────

  const handleGuardar = useCallback(async () => {
    if (!id) return;
    setGuardando(true);
    try {
      await guardarLineas(id, lineas.map(editorLineaToBack));
      await generarPdf(id);
    } finally {
      setGuardando(false);
    }
  }, [id, lineas, guardarLineas, generarPdf]);

  // ─── Cerrar factura ─────────────────────────────────────────────────────────

  const handleCerrar = useCallback(async () => {
    if (!id) return;

    const tieneMaterial = lineas.some(l => l.tipo === 'material');
    if (!tieneMaterial) {
      setErrorCierre(
        'La factura debe tener al menos una línea de material. Añade un albarán primero.'
      );
      return;
    }

    const tieneManual = lineas.some(l => l.tipo === 'manual');
    if (!tieneManual) {
      setConfirmSinMO(true);
      return;
    }

    await ejecutarCierre();
  }, [id, lineas]);

  const ejecutarCierre = useCallback(async () => {
    if (!id) return;
    setConfirmSinMO(false);
    await handleGuardar();
    const resultado = await cerrarFactura(id);
    if (!resultado.ok) setErrorCierre(resultado.error ?? 'Error al cerrar la factura');
  }, [id, handleGuardar, cerrarFactura]);

  // ─── Añadir líneas desde el modal de albarán ────────────────────────────────

  const handleLineasAlbaran = useCallback(
    (nuevas: Omit<LineaEditor, '_key'>[]) => {
      setLineas(prev => [
        ...prev,
        ...nuevas.map(l => ({ ...l, _key: genKey() })),
      ]);
      setShowModalAlbaran(false);
    },
    []
  );

  // ─── PDF, imprimir, enviar, reabrir ─────────────────────────────────────────

  const handlePdf = useCallback(async () => {
    if (!id) return;
    await generarPdf(id);
    // Descarga directa del PDF (sin abrir otra pestaña)
    const res = await api.get(`/facturas/${id}/pdf/latest`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    const nombreCliente = (actual?.cliente_nombre ?? '').replace(/\s+/g, '_');
    const numero = actual?.numero ?? 'BORRADOR';
    a.download = `Factura_${numero}_${nombreCliente}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }, [id, generarPdf, actual?.cliente_nombre, actual?.numero]);

  const handleImprimir = useCallback(async () => {
    if (!id) return;
    await generarPdf(id);
    const w = window.open(`/api/facturas/${id}/pdf/latest`, '_blank');
    w?.addEventListener('load', () => w.print());
  }, [id, generarPdf]);

  const handleEnviar = useCallback(async () => {
    if (!id || !emailDestino) return;
    setEnviando(true);
    try {
      await enviar(id, emailDestino);
      setShowEnviar(false);
    } finally {
      setEnviando(false);
    }
  }, [id, emailDestino, enviar]);

  const handleReabrir = useCallback(async () => {
    if (!id) return;
    await cambiarEstado(id, 'borrador');
  }, [id, cambiarEstado]);

  async function handleEliminar() {
    if (!actual) return;
    await eliminar(actual.id);   // el interceptor de axios ya avisa del error
    navigate(-1);
  }
  // ─── Render ─────────────────────────────────────────────────────────────────

  if (loading && !actual) return <Spinner label="Cargando factura…" />;
  if (error) return <div className="page-error">{error}</div>;
  if (!actual) return null;

  const readonly = actual.estado !== 'borrador';

  // IDs de líneas de albarán ya presentes, para que el modal las marque como usadas
  const lineasYaUsadas = lineas
    .map(l => l.albaran_linea_id)
    .filter((id): id is string => id !== null);

  return (
    <div className="page">

      <div className="page-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        {/* Breadcrumb */}
        <div className="breadcrumb">
          <button className="btn-link" onClick={() => navigate(-1)}>← Volver</button>
          <span>{actual.cliente_nombre}</span>
          <span>›</span>
          <span>{actual.agrupador_label}</span>
          <span>›</span>
          <span>{actual.trabajo_nombre}</span>
          <span>›</span>
          <span>Factura {actual.numero ?? 'Borrador'}</span>
        </div>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Barra de acciones */}
        <BarraAcciones
          tipo="factura"
          estado={actual.estado}
          numero={actual.numero}
          guardando={guardando}
          onGuardar={handleGuardar}
          onCerrar={handleCerrar}
          onPdf={handlePdf}
          onEnviar={() => setShowEnviar(true)}
          onImprimir={handleImprimir}
          onAlbaranes={() => navigate(`/albaranes?trabajo_id=${actual.trabajo_id}`)}
          onHistorial={() => setShowHistorial(true)}
          onReabrir={handleReabrir}
          onEliminar={handleEliminar}
        />

        {/* Cabecera del documento */}
        <div className="card">
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div className="form-label">Cliente</div>
                <div style={{ fontWeight: 600 }}>{actual.cliente_nombre}</div>
                {actual.cliente_empresa && (
                  <div style={{ color: 'var(--text-2)' }}>{actual.cliente_empresa}</div>
                )}
                {actual.cliente_dni_cif && (
                  <div style={{ color: 'var(--text-2)' }}>{actual.cliente_dni_cif}</div>
                )}
              </div>
              <div>
                <div className="form-label">Dirección del trabajo</div>
                <div style={{ color: 'var(--text-2)' }}>{actual.agrupador_label}</div>
              </div>
              <div>
                <div className="form-label">Fecha</div>
                <div>{actual.fecha}</div>
              </div>
              {actual.fecha_cierre && (
                <div>
                  <div className="form-label">Fecha de cierre</div>
                  <div>{actual.fecha_cierre.slice(0, 10)}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Editor controlado */}
        <div className="card">
          <DocumentoEditor
            tipo="factura"
            lineas={lineas}
            onChange={setLineas}
            iva_porcentaje={actual.iva_porcentaje}
            readonly={readonly}
            onAbrirAlbaran={readonly ? undefined : () => setShowModalAlbaran(true)}
            anticipoTotal={actual.anticipo_aplicado ?? actual.anticipo_total}
          />
        </div>
      </div>

      {/* ── Modales ── */}

      {showModalAlbaran && (
        <ModalAñadirAlbaran
          trabajoId={actual.trabajo_id}
          margenTrabajo={
            actual.trabajo_margen ?? appConfig?.documentos.margen_defecto ?? 20
          }
          lineasYaUsadas={lineasYaUsadas}
          onConfirm={handleLineasAlbaran}
          onClose={() => setShowModalAlbaran(false)}
        />
      )}

      {errorCierre && (
        <Modal
          title="No se puede cerrar"
          size="sm"
          onClose={() => setErrorCierre(null)}
          footer={
            <button className="btn btn-primary" onClick={() => setErrorCierre(null)}>
              Entendido
            </button>
          }
        >
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>{errorCierre}</p>
        </Modal>
      )}

      {confirmSinMO && (
        <Modal
          title="Sin mano de obra"
          size="sm"
          onClose={() => setConfirmSinMO(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setConfirmSinMO(false)}>
                Cancelar, voy a añadirla
              </button>
              <button className="btn btn-primary" onClick={ejecutarCierre}>
                Cerrar sin mano de obra
              </button>
            </>
          }
        >
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
            Esta factura no tiene ninguna línea de mano de obra.
            ¿Seguro que quieres cerrarla así?
          </p>
        </Modal>
      )}

      {showEnviar && (
        <Modal
          title="Enviar factura por email"
          size="sm"
          onClose={() => setShowEnviar(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setShowEnviar(false)} disabled={enviando}>
                Cancelar
              </button>
              <button
                className="btn btn-primary"
                disabled={!emailDestino || enviando}
                onClick={handleEnviar}
              >
                {enviando ? <><span className="spinner" /> Enviando…</> : 'Enviar'}
              </button>
            </>
          }
        >
          <div className="form-group">
            <label className="form-label">Email de destino</label>
            <input
              className="input"
              type="email"
              value={emailDestino}
              onChange={e => setEmailDestino(e.target.value)}
              placeholder="cliente@ejemplo.com"
            />
          </div>
        </Modal>
      )}

      {showHistorial && (
        <PanelHistorial
          versiones={actual.versiones}
          documentoId={actual.id}
          tipo="factura"
          onClose={() => setShowHistorial(false)}
        />
      )}
    </div>
  );
}