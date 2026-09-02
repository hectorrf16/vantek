/**
 * ──────────────────────────────────────────────────────────────────────────────
 * NuevoAlbaranModal.tsx — Create / edit a supplier delivery note (albarán)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Modal form to create a new albarán (POST) or edit an existing one (PUT)
 *   when albaranInicial is provided. Manages header fields (fecha, proveedor,
 *   numero) and an editable lines table. Hosts the "Escanear OCR" button that
 *   opens OCRAlbaranModal and feeds its ResultadoOCR into the form before save.
 *   Also exports the AlbaranInicial type.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @utils/api → create/update the albarán
 *     · @ui/Modal → dialog shell
 *     · ./OCRAlbaranModal → nested client-side OCR (creation flow)
 *   Backend:
 *     · POST /api/albaranes → create (optionally assigned to trabajoId)
 *     · PUT  /api/albaranes/:id → edit header + lines (edit mode)
 *   Used by:
 *     · AlbaranesPage (create), AlbaranFichaPage (edit via albaranInicial)
 *
 * PROPS
 *   · trabajoId?: string → if set, the new albarán is auto-assigned to it
 *   · albaranInicial?: AlbaranInicial → if set, the modal opens in edit (PUT) mode
 *   · onClose: () => void → dismiss the modal
 *   · onCreado?: (albaranId: string) => void → callback after creation
 *   · onActualizado?: () => void → callback after an edit
 *
 * INPUTS / OUTPUTS
 *   Input:  header/line fields, optional OCR result, optional albaranInicial
 *   Output: persisted albarán; onCreado / onActualizado callbacks; navigation
 *
 * NOTES
 *   · OCR is creation-only and lives inside this modal; the ficha has no scan.
 *   · Line precio_unitario is supplier coste; dates are normalized to yyyy-mm-dd.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from '@ui/Modal';
import api from '@utils/api';
import OCRAlbaranModal, { type ResultadoOCR } from './OCRAlbaranModal';

interface LineaNueva {
  _key: string;
  id?: string;              // presente solo en líneas ya existentes (modo edición)
  descripcion: string;
  cantidad: string;
  unidad: string;
  precio_unitario: string; // coste en albaranes
}

/** Datos de un albarán existente para abrir el modal en modo edición */
export interface AlbaranInicial {
  id: string;
  numero?: string;
  fecha: string;
  proveedor_nombre?: string;
  notas?: string;
  lineas: { id: string; descripcion: string; cantidad: number; precio_unitario: number; unidad?: string }[];
}

interface NuevoAlbaranModalProps {
  /** Si se pasa, el albarán se asigna automáticamente a ese trabajo al crear */
  trabajoId?: string;
  /** Si se pasa, el modal abre en modo edición (PUT) en lugar de creación */
  albaranInicial?: AlbaranInicial;
  onClose: () => void;
  /** Callback opcional si el padre quiere reaccionar sin navegar (creación) */
  onCreado?: (albaranId: string) => void;
  /** Callback opcional tras editar un albarán existente */
  onActualizado?: () => void;
}

function nuevaLinea(): LineaNueva {
  return {
    _key: Math.random().toString(36).slice(2),
    descripcion: '',
    cantidad: '1',
    unidad: 'ud',
    precio_unitario: '',
  };
}

/** Convierte una fecha dd/mm/aaaa o dd-mm-aaaa al formato yyyy-mm-dd del input date */
function normalizarFecha(s: string): string {
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    const [, d, mes, a] = m;
    const anio = a.length === 2 ? `20${a}` : a;
    return `${anio}-${mes.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return '';
}

export default function NuevoAlbaranModal({ trabajoId, albaranInicial, onClose, onCreado, onActualizado }: NuevoAlbaranModalProps) {
  const navigate = useNavigate();
  const esEdicion = !!albaranInicial;

  const [fecha, setFecha] = useState(() =>
    albaranInicial ? normalizarFecha(albaranInicial.fecha) : new Date().toISOString().slice(0, 10));
  const [proveedor, setProveedor] = useState(albaranInicial?.proveedor_nombre ?? '');
  const [numero, setNumero] = useState(albaranInicial?.numero ?? '');
  const [lineas, setLineas] = useState<LineaNueva[]>(() =>
    albaranInicial && albaranInicial.lineas.length > 0
      ? albaranInicial.lineas.map(l => ({
          _key: Math.random().toString(36).slice(2),
          id: l.id,
          descripcion: l.descripcion,
          cantidad: String(l.cantidad),
          unidad: l.unidad ?? 'ud',
          precio_unitario: String(l.precio_unitario),
        }))
      : [nuevaLinea()]);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [ocrAbierto, setOcrAbierto] = useState(false);


  // ─── Gestión de líneas ───────────────────────────────────────────────────

  const actualizarLinea = useCallback((key: string, campo: Partial<Omit<LineaNueva, '_key'>>) => {
    setLineas(prev => prev.map(l => l._key === key ? { ...l, ...campo } : l));
  }, []);

  const añadirLinea = useCallback(() => {
    setLineas(prev => [...prev, nuevaLinea()]);
  }, []);

  const eliminarLinea = useCallback((key: string) => {
    setLineas(prev => prev.filter(l => l._key !== key));
  }, []);

  // ─── Importar resultado del OCR al formulario ─────────────────────────────

  const aplicarOCR = useCallback((r: ResultadoOCR) => {
    if (r.proveedor) setProveedor(r.proveedor);
    if (r.numero_albaran) setNumero(r.numero_albaran);
    const f = normalizarFecha(r.fecha);
    if (f) setFecha(f);
    if (r.lineas.length > 0) {
      setLineas(r.lineas.map(l => ({
        _key: Math.random().toString(36).slice(2),
        descripcion: l.descripcion,
        cantidad: String(l.cantidad || 1),
        unidad: 'ud',
        precio_unitario: String(l.precio_unitario || ''),
      })));
    }
    setOcrAbierto(false);
  }, []);

  // ─── Validación ──────────────────────────────────────────────────────────


  const valido = fecha.trim() !== '' &&
    lineas.length > 0 &&
    lineas.every(l => l.descripcion.trim() !== '' && Number(l.cantidad) > 0);

  // ─── Crear albarán ───────────────────────────────────────────────────────

  const handleCrear = useCallback(async () => {
    if (!valido) return;
    setGuardando(true);
    setError('');

    try {
      const lineasBody = lineas.map(l => ({
        descripcion: l.descripcion.trim(),
        cantidad: Number(l.cantidad),
        unidad: l.unidad.trim() || null,
        precio_unitario: Number(l.precio_unitario) || 0,
      }));

      // ── Modo edición: PUT ──
      if (esEdicion && albaranInicial) {
        await api.put(`/albaranes/${albaranInicial.id}`, {
          fecha,
          proveedor_nombre: proveedor.trim() || undefined,
          numero: numero.trim() || undefined,
          lineas: lineas.map((l) => ({
            id: l.id, // conserva el id de líneas existentes; undefined en nuevas
            descripcion: l.descripcion.trim(),
            cantidad: Number(l.cantidad),
            unidad: l.unidad.trim() || null,
            precio_unitario: Number(l.precio_unitario) || 0,
          })),
        });
        onClose();
        onActualizado?.();
        return;
      }

      // ── Modo creación: POST ──
      const body: Record<string, unknown> = {
        fecha,
        proveedor_nombre: proveedor.trim() || undefined,
        numero: numero.trim() || undefined,
        lineas: lineasBody,
      };

      // Si viene de FacturaPage, asignar directamente al trabajo
      if (trabajoId) {
        body.trabajo_id = trabajoId;
      }

      const res = await api.post('/albaranes', body);
      const albaranId: string = res.data.data?.id ?? res.data.id;

      onClose();

      if (onCreado) {
        onCreado(albaranId);
      } else {
        navigate(`/albaranes/${albaranId}`);
      }
    } catch (e: any) {
      setError(e.response?.data?.error ?? e.message ?? 'Error al guardar el albarán');
    } finally {
      setGuardando(false);
    }
  }, [valido, esEdicion, albaranInicial, fecha, proveedor, numero, lineas, trabajoId, onClose, onCreado, onActualizado, navigate]);


  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <Modal
      title={esEdicion ? 'Editar albarán' : 'Nuevo albarán'}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={guardando}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCrear}
            disabled={!valido || guardando}
          >
            {guardando
              ? (esEdicion ? 'Guardando…' : 'Creando…')
              : (esEdicion ? 'Guardar cambios' : 'Crear albarán')}
          </button>
        </>
      }
    >
      {/* Importar desde OCR (solo en creación) */}
      {!esEdicion && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setOcrAbierto(true)} title="Escanear albarán con OCR">
            <svg viewBox="0 0 24 24" style={{ width: 14, height: 14, marginRight: 6, stroke: 'currentColor', fill: 'none', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
            Escanear OCR
          </button>
        </div>
      )}

      {/* Cabecera del albarán */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
        <div className="form-group">
          <label className="form-label">
            Fecha <span style={{ color: 'var(--accent)' }}>*</span>
          </label>
          <input
            className="input"
            type="date"
            value={fecha}
            onChange={e => setFecha(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Proveedor</label>
          <input
            className="input"
            value={proveedor}
            onChange={e => setProveedor(e.target.value)}
            placeholder="ej. Leroy Merlin"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Nº albarán</label>
          <input
            className="input"
            value={numero}
            onChange={e => setNumero(e.target.value)}
            placeholder="ej. ALB-2024-001"
          />
        </div>
      </div>

      {trabajoId && (
        <div style={{
          marginBottom: 16,
          padding: '8px 12px',
          background: 'var(--accent-dim)',
          border: '1px solid var(--accent)',
          borderRadius: 'var(--radius)',
          fontSize: 12,
          color: 'var(--accent-h)',
        }}>
          Este albarán se asignará automáticamente al trabajo actual al crearlo.
        </div>
      )}

      {/* Tabla de líneas */}
      <div style={{ marginBottom: 8 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 80px 60px 100px 32px',
          gap: 6,
          padding: '0 0 6px',
          borderBottom: '1px solid var(--border)',
          marginBottom: 6,
        }}>
          <span className="form-label">Descripción *</span>
          <span className="form-label">Cant. *</span>
          <span className="form-label">Ud.</span>
          <span className="form-label">Coste unit. (€)</span>
          <span />
        </div>

        {lineas.map((l, idx) => (
          <div
            key={l._key}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 80px 60px 100px 32px',
              gap: 6,
              marginBottom: 6,
              alignItems: 'center',
            }}
          >
            <input
              className="input input-sm"
              value={l.descripcion}
              onChange={e => actualizarLinea(l._key, { descripcion: e.target.value })}
              placeholder={`Línea ${idx + 1}`}
              autoFocus={idx === lineas.length - 1 && idx > 0}
            />
            <input
              className="input input-sm"
              type="number"
              min="0.01"
              step="0.01"
              value={l.cantidad}
              onChange={e => actualizarLinea(l._key, { cantidad: e.target.value })}
            />
            <input
              className="input input-sm"
              value={l.unidad}
              onChange={e => actualizarLinea(l._key, { unidad: e.target.value })}
              placeholder="ud"
            />
            <input
              className="input input-sm"
              type="number"
              min="0"
              step="0.01"
              value={l.precio_unitario}
              onChange={e => actualizarLinea(l._key, { precio_unitario: e.target.value })}
              placeholder="0.00"
            />
            <button
              className="btn-icon btn-icon-danger"
              title="Eliminar línea"
              onClick={() => eliminarLinea(l._key)}
              disabled={lineas.length === 1}
              style={{ flexShrink: 0 }}
            >
              ✕
            </button>
          </div>
        ))}

        <button
          className="btn btn-ghost btn-sm"
          onClick={añadirLinea}
          style={{ marginTop: 4 }}
        >
          + Añadir línea
        </button>
      </div>

      {error && (
        <div style={{
          marginTop: 12,
          padding: '8px 12px',
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid var(--red)',
          borderRadius: 'var(--radius)',
          fontSize: 12,
          color: 'var(--red)',
        }}>
          {error}
        </div>
      )}

      {/* Modal OCR anidado (importar datos antes de crear) */}
      {ocrAbierto && (
        <OCRAlbaranModal
          onConfirmar={aplicarOCR}
          onCerrar={() => setOcrAbierto(false)}
        />
      )}
    </Modal>
  );
}
