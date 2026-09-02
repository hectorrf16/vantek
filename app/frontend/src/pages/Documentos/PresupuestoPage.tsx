/**
 * ──────────────────────────────────────────────────────────────────────────────
 * PresupuestoPage.tsx — Quote (presupuesto) editor page
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Loads a single quote by id and renders its editor using the same shared,
 *   controlled DocumentoEditor (line state owned here in the parent). Handles
 *   autosave (every 3 min while in borrador), explicit save, PDF download,
 *   email send/resend, reopen, delete, and conversion of an accepted quote
 *   into a new invoice.
 *
 * ROUTE
 *   /presupuestos/:id
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @store/presupuestos.store → load/save/state/pdf/send/delete actions
 *     · DocumentoEditor → controlled line editor (no albarán; manual items)
 *     · BarraAcciones → action toolbar (incl. onConvertirFactura when aceptado)
 *     · PanelHistorial → version history modal
 *     · @utils/api → direct PDF blob fetch and POST /facturas on conversion
 *   Backend (via store unless noted):
 *     · GET    /api/presupuestos/:id → load detail
 *     · PUT    /api/presupuestos/:id/lineas → save lines
 *     · POST   /api/presupuestos/:id/borrador → autosave draft
 *     · POST   /api/presupuestos/:id/estado → enviado / aceptado / borrador
 *     · POST   /api/presupuestos/:id/pdf → generate PDF version
 *     · GET    /api/presupuestos/:id/pdf/latest → download (direct api call)
 *     · POST   /api/presupuestos/:id/enviar → email the quote
 *     · DELETE /api/presupuestos/:id → delete
 *     · POST   /api/facturas → create invoice from accepted quote (conversion)
 *   Used by:
 *     · Route /presupuestos/:id in App.tsx (from lists/cliente ficha)
 *
 * INPUTS / OUTPUTS
 *   Input:  url param :id; user edits lines and triggers toolbar actions
 *   Output: rendered editor UI, persisted lines/state, generated PDFs,
 *           navigation to the new invoice on conversion
 *
 * NOTES
 *   · Quotes carry NO IVA in the total (DocumentoEditor only adds IVA for
 *     facturas); lines are manual estimates, never sourced from albaranes.
 *   · 'Cerrar' just requires ≥1 line and moves the quote to 'enviado'.
 *   · Converting to factura marks the quote 'aceptado' first if needed.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePresupuestosStore, LineaPresupuesto } from '@store/presupuestos.store';
import Spinner from '@ui/Spinner';
import Modal from '@ui/Modal';
import DocumentoEditor, { LineaEditor, genKey } from '@pages/Documentos/components/DocumentoEditor';
import BarraAcciones from '@pages/Documentos/components/BarraAcciones';
import PanelHistorial from '@pages/Documentos/components/PanelHistorial';
import api from '@utils/api';

const AUTOSAVE_MS = 3 * 60 * 1000;

function presupuestoLineaToEditor(l: LineaPresupuesto): LineaEditor {
  return {
    _key: genKey(),
    descripcion: l.descripcion,
    detalle: l.detalle ?? null,
    cantidad: l.cantidad,
    unidad: l.unidad ?? '',
    precio_unitario: l.precio_unitario,
    coste_unitario: l.coste_unitario ?? null,
    margen_porcentaje: l.margen_porcentaje ?? null,
    tipo: l.tipo ?? 'concepto',
    es_libre: true,
    albaran_linea_id: null,
  };
}

export default function PresupuestoPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { actual, loading, error, cargarPresupuesto, guardarLineas,
          guardarBorrador, cambiarEstado, generarPdf, enviar, eliminar } = usePresupuestosStore();

  const [lineas, setLineas] = useState<LineaEditor[]>([]);

  const [guardando, setGuardando] = useState(false);
  const [showHistorial, setShowHistorial] = useState(false);
  const [showEnviar, setShowEnviar] = useState(false);
  const [emailDestino, setEmailDestino] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [showConvertir, setShowConvertir] = useState(false);
  const [convirtiendoFactura, setConvirtiendoFactura] = useState(false);
  const [errorCierre, setErrorCierre] = useState<string | null>(null);

  const autosaveTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (id) cargarPresupuesto(id);
    return () => { if (autosaveTimer.current) clearInterval(autosaveTimer.current); };
  }, [id]);

  useEffect(() => {
    if (!actual) return;
    setLineas(actual.lineas.map(presupuestoLineaToEditor));
    setEmailDestino(actual.cliente_email ?? '');
  }, [actual?.id]);

  // Se leen las líneas VIVAS desde la ref: el intervalo capturaba las del render
  // en que se montó el efecto, así que el borrador se autoguardaba siempre con
  // las líneas originales y nunca con las ediciones del usuario.
  const lineasRef = useRef(lineas);
  useEffect(() => { lineasRef.current = lineas; });   // sin deps: cada render

  useEffect(() => {
    if (!actual || !id || actual.estado !== 'borrador') return;
    autosaveTimer.current = setInterval(() => {
      guardarBorrador(id, { lineas: lineasRef.current });
    }, AUTOSAVE_MS);
    return () => { if (autosaveTimer.current) clearInterval(autosaveTimer.current); };
  }, [actual?.id, actual?.estado]);

  const handleGuardar = useCallback(async () => {
    if (!id || !actual) return;
    setGuardando(true);
    try {
      const lineasBack = lineas.map(l => ({
        descripcion: l.descripcion,
        detalle: l.detalle ?? null,
        cantidad: l.cantidad,
        unidad: l.unidad || null,
        precio_unitario: l.precio_unitario,
        coste_unitario: l.coste_unitario,
        margen_porcentaje: l.margen_porcentaje,
        tipo: l.tipo,
        es_libre: l.es_libre,
      }));
      await guardarLineas(id, lineasBack);
      await generarPdf(id);
    } finally {
      setGuardando(false);
    }
  }, [id, lineas, guardarLineas, generarPdf]);

  const handleCerrar = useCallback(async () => {
    if (!id) return;
    if (lineas.length === 0) {
      setErrorCierre('El presupuesto debe tener al menos una línea antes de cerrarse.');
      return;
    }
    await handleGuardar();
    await cambiarEstado(id, 'enviado');
  }, [id, lineas, handleGuardar, cambiarEstado]);

  const handlePdf = useCallback(async () => {
    if (!id) return;
    await generarPdf(id);
    // Descarga directa del PDF (sin abrir otra pestaña)
    const res = await api.get(`/presupuestos/${id}/pdf/latest`, { responseType: 'blob' });
    const url = window.URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    const nombreCliente = (actual?.cliente_nombre ?? id ?? '').replace(/\s+/g, '_');
    a.download = `Presupuesto_${nombreCliente}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }, [id, generarPdf, actual?.cliente_nombre]);

  const handleReabrir = useCallback(async () => {
    if (!id) return;
    await cambiarEstado(id, 'borrador');
  }, [id, cambiarEstado]);

  const handleEnviar = useCallback(async () => {
    if (!id || !emailDestino) return;
    setEnviando(true);
    try {
      await enviar(id, emailDestino);
      await cargarPresupuesto(id);
      setShowEnviar(false);
    } finally {
      setEnviando(false);
    }
  }, [id, emailDestino, enviar, cargarPresupuesto]);

  async function handleEliminar() {
    if (!actual) return;
    try {
      await eliminar(actual.id);
      navigate(-1);
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message ?? 'Error al eliminar presupuesto');
    }
  }

  // Convertir presupuesto aceptado a factura
  async function handleConvertirFactura() {
    if (!actual) return;
    setConvirtiendoFactura(true);
    try {
      // Marcar como aceptado si aún no lo está
      if (actual.estado !== 'aceptado') {
        await cambiarEstado(actual.id, 'aceptado');
      }
      // Crear factura importando líneas del presupuesto
      const res = await api.post('/facturas', {
        trabajo_id: actual.trabajo_id,
        presupuesto_origen_id: actual.id,
      });
      const nuevaId = res.data.data?.id ?? res.data.id;
      setShowConvertir(false);
      navigate(`/facturas/${nuevaId}`);
    } catch (e: any) {
      alert(e.response?.data?.error ?? e.message ?? 'Error creando factura');
    } finally {
      setConvirtiendoFactura(false);
    }
  }

  if (loading && !actual) return <Spinner label="Cargando presupuesto…" />;
  if (error) return <div className="page-error">{error}</div>;
  if (!actual) return null;

  const readonly = actual.estado !== 'borrador';

  return (
    <div className="page">

      <div className="page-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
        <div className="breadcrumb">
          <button className="btn-link" onClick={() => navigate(-1)}>← Volver</button>
          <span>{actual.cliente_nombre}</span>
          <span>›</span>
          <span>{actual.agrupador_label}</span>
          <span>›</span>
          <span>{actual.trabajo_nombre}</span>
          <span>›</span>
          <span>Presupuesto {actual.numero ?? 'Borrador'}</span>
        </div>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <BarraAcciones
          tipo="presupuesto"
          estado={actual.estado}
          numero={actual.numero}
          guardando={guardando}
          onGuardar={handleGuardar}
          onCerrar={handleCerrar}
          onPdf={handlePdf}
          onEnviar={() => setShowEnviar(true)}
          onHistorial={() => setShowHistorial(true)}
          onReabrir={handleReabrir}
          onEliminar={handleEliminar}
          onConvertirFactura={actual.estado === 'aceptado' ? () => setShowConvertir(true) : undefined}
        />

        <div className="card">
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div className="form-label">Cliente</div>
                <div style={{ fontWeight: 600 }}>{actual.cliente_nombre}</div>
              </div>
              <div>
                <div className="form-label">Dirección / Obra</div>
                <div style={{ color: 'var(--text-2)' }}>{actual.agrupador_label}</div>
              </div>
              <div>
                <div className="form-label">Fecha</div>
                <div>{actual.fecha}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <DocumentoEditor
            tipo="presupuesto"
            lineas={lineas}
            onChange={setLineas}
            iva_porcentaje={actual.iva_porcentaje}
            readonly={readonly}
          />
        </div>
      </div>

      {errorCierre && (
        <Modal title="No se puede cerrar" size="sm" onClose={() => setErrorCierre(null)}
          footer={<button className="btn btn-primary" onClick={() => setErrorCierre(null)}>Entendido</button>}
        >
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>{errorCierre}</p>
        </Modal>
      )}

      {showEnviar && (() => {
        const yaEnviado = actual.estado === 'enviado';
        return (
          <Modal
            title={yaEnviado ? 'Reenviar presupuesto' : 'Enviar presupuesto por email'}
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
                  {enviando ? <><span className="spinner" /> Enviando…</> : yaEnviado ? 'Reenviar' : 'Enviar'}
                </button>
              </>
            }
          >
            {yaEnviado && (
              <p style={{ color: 'var(--text-2)', fontSize: 13, marginBottom: 12 }}>
                Ya has enviado este email al cliente, ¿deseas reenviárselo?
              </p>
            )}
            <div className="form-group">
              <label className="form-label">Email de destino</label>
              <input
                className="input"
                type="email"
                value={emailDestino}
                onChange={e => setEmailDestino(e.target.value)}
                placeholder="cliente@ejemplo.com"
              />
              {!actual.cliente_email && (
                <span className="form-error">
                  El cliente no tiene email en su ficha. Escríbelo aquí para enviarlo.
                </span>
              )}
            </div>
          </Modal>
        );
      })()}

      {showConvertir && (
        <Modal title="Crear factura desde este presupuesto" size="sm" onClose={() => setShowConvertir(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setShowConvertir(false)} disabled={convirtiendoFactura}>
                Cancelar
              </button>
              <button className="btn btn-primary" onClick={handleConvertirFactura} disabled={convirtiendoFactura}>
                {convirtiendoFactura ? 'Creando…' : 'Crear factura'}
              </button>
            </>
          }
        >
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
            Se creará una nueva factura para <strong>{actual.trabajo_nombre}</strong> importando
            las líneas de este presupuesto.
            {actual.estado !== 'aceptado' && (
              <span style={{ display: 'block', marginTop: 8, color: 'var(--yellow)', fontSize: 12 }}>
                El presupuesto pasará a estado «Aceptado» automáticamente.
              </span>
            )}
          </p>
        </Modal>
      )}

      {showHistorial && (
        <PanelHistorial
          versiones={actual.versiones}
          documentoId={actual.id}
          tipo="presupuesto"
          onClose={() => setShowHistorial(false)}
        />
      )}
    </div>
  );
}