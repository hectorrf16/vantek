/**
 * ──────────────────────────────────────────────────────────────────────────────
 * DocumentoEditor.tsx — Shared CONTROLLED line editor for invoices/quotes
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Renders the editable line table and totals for a document. It is a
 *   CONTROLLED component: the lineas array lives in the parent page
 *   (FacturaPage / PresupuestoPage) and every change is pushed up via
 *   onChange. Supports inline edit, reorder, delete, an "add manual item"
 *   modal and an optional "add from albarán" hook. Recomputes precio_unitario
 *   from coste × (1 + margen/100) and the subtotal/IVA/total.
 *   Also exports the LineaEditor type, genKey() and fmt() helpers.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @store/config.store → default margin for the manual-item modal
 *     · @ui/Modal → dialog for the manual item form
 *   Backend:
 *     · none — purely UI; persistence is the parent's responsibility
 *   Used by:
 *     · FacturaPage, PresupuestoPage; ModalAñadirAlbaran/FacturaPage reuse the
 *       exported LineaEditor / genKey
 *
 * PROPS
 *   · tipo: 'factura' | 'presupuesto' → IVA only added for facturas
 *   · lineas: LineaEditor[] → the controlled line state from the parent
 *   · onChange: (lineas: LineaEditor[]) => void → emits every mutation upward
 *   · iva_porcentaje: number → IVA rate applied to the subtotal (facturas)
 *   · readonly: boolean → hides edit controls when not in borrador
 *   · onAbrirAlbaran?: () => void → opens the add-from-albarán modal (facturas)
 *
 * INPUTS / OUTPUTS
 *   Input:  controlled lineas + user edits
 *   Output: onChange with the next lineas array; rendered table + totals
 *
 * NOTES
 *   · coste_unitario and margen_porcentaje are internal-only and never appear
 *     in the PDF; editing either recomputes precio_unitario automatically.
 *   · Unit defaults by tipo: manual → 'h', material/concepto → 'ud'.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useState, useCallback } from 'react';
import { useConfigStore } from '@store/config.store';
import { redondear, totalesDocumento } from '@utils/dinero';
import Modal from '@ui/Modal';

export type LineaEditor = {
  _key: string;
  descripcion: string;
  detalle?: string | null;
  cantidad: number;
  unidad: string;
  precio_unitario: number;
  coste_unitario: number | null;
  margen_porcentaje: number | null;
  tipo: 'material' | 'manual' | 'concepto';
  es_libre: boolean;
  albaran_linea_id: string | null;
};

export function genKey() {
  return Math.random().toString(36).slice(2);
}

export function fmt(n: number) {
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Unidad fija según tipo: mano de obra → h, resto → ud
function unidadPorTipo(tipo: 'material' | 'manual' | 'concepto'): string {
  return tipo === 'manual' ? 'h' : 'ud';
}

type TipoDocumento = 'factura' | 'presupuesto';

interface DocumentoEditorProps {
  tipo: TipoDocumento;
  lineas: LineaEditor[];
  onChange: (lineas: LineaEditor[]) => void;
  iva_porcentaje: number;
  readonly: boolean;
  onAbrirAlbaran?: () => void;
  anticipoTotal?: number;
}

// ─── Modal ítem manual ────────────────────────────────────────────────────────

interface ModalItemManualProps {
  margenDefecto: number;
  onConfirm: (linea: Omit<LineaEditor, '_key'>) => void;
  onClose: () => void;
}

function ModalItemManual({ margenDefecto, onConfirm, onClose }: ModalItemManualProps) {
  const [descripcion, setDescripcion] = useState('');
  const [detalle, setDetalle] = useState('');
  const [cantidad, setCantidad] = useState('1');
  const [coste, setCoste] = useState('');
  const [margen, setMargen] = useState(String(margenDefecto));
  const [tipo, setTipo] = useState<'manual' | 'concepto'>('manual');

  const precio = coste ? Number(coste) * (1 + Number(margen) / 100) : 0;
  const unidad = unidadPorTipo(tipo);

  function handleConfirm() {
    if (!descripcion.trim()) return;
    onConfirm({
      descripcion,
      detalle: detalle.trim() || null,
      cantidad: Number(cantidad) || 1,
      unidad,
      precio_unitario: redondear(precio),
      coste_unitario: coste ? Number(coste) : null,
      margen_porcentaje: coste ? Number(margen) : null,
      tipo,
      es_libre: true,
      albaran_linea_id: null,
    });
  }

  return (
    <Modal
      title="Añadir ítem manual"
      size="md"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancelar</button>
          <button
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={!descripcion.trim()}
          >
            Añadir
          </button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label">Tipo</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['manual', 'concepto'] as const).map(t => (
            <button
              key={t}
              className={`btn ${tipo === t ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setTipo(t)}
            >
              {t === 'manual' ? 'Mano de obra' : 'Concepto libre'}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group" style={{ marginTop: 12 }}>
        <label className="form-label">
          Descripción <span style={{ color: 'var(--accent)' }}>*</span>
        </label>
        <input
          className="input"
          value={descripcion}
          onChange={e => setDescripcion(e.target.value)}
          placeholder={tipo === 'manual' ? 'ej. Mano de obra pintura' : 'ej. Gestión de residuos'}
          autoFocus
        />
      </div>

      <div className="form-group" style={{ marginTop: 12 }}>
        <label className="form-label">
          Detalle
          <span style={{ marginLeft: 6, color: 'var(--text-3)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            (opcional, se muestra bajo la descripción en el PDF)
          </span>
        </label>
        <textarea
          className="input"
          value={detalle}
          onChange={e => setDetalle(e.target.value)}
          rows={2}
          style={{ resize: 'vertical' }}
          placeholder="Descripción ampliada del trabajo o notas para el cliente"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        <div className="form-group">
          <label className="form-label">
            Cantidad
            <span style={{ marginLeft: 6, color: 'var(--text-3)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
              ({unidad})
            </span>
          </label>
          <input
            className="input"
            type="number"
            min="0.01"
            step="0.01"
            value={cantidad}
            onChange={e => setCantidad(e.target.value)}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Coste unitario (€)</label>
          <input
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={coste}
            onChange={e => setCoste(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Margen (%)</label>
          <input
            className="input"
            type="number"
            min="0"
            step="1"
            value={margen}
            onChange={e => setMargen(e.target.value)}
          />
        </div>
      </div>

      {coste && (
        <div style={{
          marginTop: 12, padding: '8px 12px',
          background: 'var(--bg-3)', borderRadius: 'var(--radius)',
          fontSize: 13, color: 'var(--text-2)',
        }}>
          Precio final al cliente:{' '}
          <strong style={{ color: 'var(--text)' }}>{fmt(precio)} €</strong>
        </div>
      )}
    </Modal>
  );
}

// ─── Componente principal ─────────────────────────────────────────────────────

export default function DocumentoEditor({
  tipo,
  lineas,
  onChange,
  iva_porcentaje,
  readonly,
  onAbrirAlbaran,
  anticipoTotal,
}: DocumentoEditorProps) {
  const { appConfig } = useConfigStore();
  const margenDefecto = appConfig?.documentos?.margen_defecto ?? 0;

  const [showModalManual, setShowModalManual] = useState(false);
  const [editando, setEditando] = useState<string | null>(null);

  const actualizarLinea = useCallback((key: string, campo: Partial<LineaEditor>) => {
    onChange(lineas.map(l => {
      if (l._key !== key) return l;
      const updated = { ...l, ...campo };
      if ('coste_unitario' in campo || 'margen_porcentaje' in campo) {
        const coste = updated.coste_unitario ?? 0;
        const margen = updated.margen_porcentaje ?? 0;
        updated.precio_unitario = redondear(coste * (1 + margen / 100));
      }
      return updated;
    }));
  }, [lineas, onChange]);

  const eliminarLinea = useCallback((key: string) => {
    onChange(lineas.filter(l => l._key !== key));
    if (editando === key) setEditando(null);
  }, [lineas, onChange, editando]);

  const moverLinea = useCallback((key: string, dir: 'up' | 'down') => {
    const idx = lineas.findIndex(l => l._key === key);
    if (idx < 0) return;
    const next = [...lineas];
    const target = dir === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  }, [lineas, onChange]);

  const añadirManual = useCallback((linea: Omit<LineaEditor, '_key'>) => {
    const unidad = linea.unidad || unidadPorTipo(linea.tipo as any);
    onChange([...lineas, { ...linea, unidad, _key: genKey() }]);
    setShowModalManual(false);
  }, [lineas, onChange]);

  // ─── Totales ────────────────────────────────────────────────────────────────

  const totales = totalesDocumento(lineas, tipo === 'factura' ? iva_porcentaje : 0);
  const subtotal = totales.subtotal;
  const iva = totales.iva;
  const total = totales.total;

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="doc-editor">

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th>Descripción</th>
              <th style={{ width: 90 }}>Cant.</th>
              <th style={{ width: 100 }}>Coste u.</th>
              <th style={{ width: 80 }}>Margen %</th>
              <th style={{ width: 110 }}>P. unitario</th>
              <th style={{ width: 110 }}>Total línea</th>
              {!readonly && <th style={{ width: 88 }} />}
            </tr>
          </thead>
          <tbody>
            {lineas.length === 0 && (
              <tr>
                <td
                  colSpan={readonly ? 6 : 7}
                  style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}
                >
                  Sin líneas. Añade ítems con los botones de abajo.
                </td>
              </tr>
            )}

            {lineas.map((l, idx) => {
              const enEdicion = editando === l._key && !readonly;
              return (
                <tr
                  key={l._key}
                  style={{ cursor: readonly ? 'default' : 'pointer' }}
                  onClick={() => !readonly && setEditando(l._key)}
                >
                  {/* Descripción */}
                  <td>
                    {enEdicion ? (
                      <>
                        <input
                          className="input input-sm"
                          value={l.descripcion}
                          autoFocus
                          onChange={e => actualizarLinea(l._key, { descripcion: e.target.value })}
                          onClick={e => e.stopPropagation()}
                        />
                        <textarea
                          className="input input-sm"
                          value={l.detalle ?? ''}
                          rows={2}
                          placeholder="Detalle / descripción ampliada (opcional)"
                          style={{ marginTop: 4, resize: 'vertical', width: '100%' }}
                          onChange={e => actualizarLinea(l._key, { detalle: e.target.value || null })}
                          onClick={e => e.stopPropagation()}
                        />
                      </>
                    ) : (
                      <span>{l.descripcion}</span>
                    )}
                    <span
                      style={{
                        marginLeft: 6, fontSize: 10,
                        color: 'var(--text-3)',
                        background: 'var(--bg-3)',
                        padding: '1px 5px', borderRadius: 99,
                      }}
                    >
                      {l.tipo === 'material' ? 'mat.' : l.tipo === 'manual' ? 'm.o.' : 'conc.'}
                    </span>
                    {!enEdicion && l.detalle && l.detalle.trim() && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2, whiteSpace: 'pre-wrap' }}>
                        {l.detalle}
                      </div>
                    )}
                  </td>

                  {/* Cantidad con unidad fija */}
                  <td>
                    {enEdicion ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          className="input input-sm"
                          type="number" min="0.01" step="0.01"
                          value={l.cantidad}
                          style={{ width: 60 }}
                          onChange={e => actualizarLinea(l._key, { cantidad: Number(e.target.value) })}
                          onClick={e => e.stopPropagation()}
                        />
                        <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                          {l.unidad || unidadPorTipo(l.tipo)}
                        </span>
                      </div>
                    ) : (
                      <span>
                        {fmt(l.cantidad)}{' '}
                        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{l.unidad || unidadPorTipo(l.tipo)}</span>
                      </span>
                    )}
                  </td>

                  {/* Coste — interno, nunca en PDF */}
                  <td style={{ color: 'var(--text-3)' }}>
                    {enEdicion ? (
                      <input
                        className="input input-sm"
                        type="number" min="0" step="0.01"
                        value={l.coste_unitario ?? ''}
                        onChange={e => actualizarLinea(l._key, {
                          // Con `Number(v) || null` un 0 legítimo se convertía en
                          // null y no podía introducirse un coste cero.
                          coste_unitario: e.target.value === '' ? null : Number(e.target.value),
                        })}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : l.coste_unitario != null ? `${fmt(l.coste_unitario)} €` : '—'}
                  </td>

                  {/* Margen — interno, nunca en PDF */}
                  <td style={{ color: 'var(--text-3)' }}>
                    {enEdicion ? (
                      <input
                        className="input input-sm"
                        type="number" min="0" step="1"
                        value={l.margen_porcentaje ?? ''}
                        onChange={e => actualizarLinea(l._key, {
                          margen_porcentaje: e.target.value === '' ? null : Number(e.target.value),
                        })}
                        onClick={e => e.stopPropagation()}
                      />
                    ) : l.margen_porcentaje != null ? `${l.margen_porcentaje}%` : '—'}
                  </td>

                  {/* Precio final al cliente */}
                  <td style={{ fontWeight: 500 }}>{fmt(l.precio_unitario)} €</td>

                  {/* Total línea */}
                  <td style={{ fontWeight: 600 }}>
                    {fmt(l.precio_unitario * l.cantidad)} €
                  </td>

                  {/* Acciones */}
                  {!readonly && (
                    <td
                      style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                      onClick={e => e.stopPropagation()}
                    >
                      <button
                        className="btn-icon"
                        title="Subir"
                        disabled={idx === 0}
                        onClick={() => moverLinea(l._key, 'up')}
                      >▲</button>
                      <button
                        className="btn-icon"
                        title="Bajar"
                        disabled={idx === lineas.length - 1}
                        onClick={() => moverLinea(l._key, 'down')}
                      >▼</button>
                      <button
                        className="btn-icon btn-icon-danger"
                        title="Eliminar"
                        onClick={() => eliminarLinea(l._key)}
                      >✕</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Botones de añadir */}
      {!readonly && (
        <div style={{ display: 'flex', gap: 8, padding: '8px 16px' }}>
          {onAbrirAlbaran && (
            <button className="btn btn-ghost btn-sm" onClick={onAbrirAlbaran}>
              + Desde albarán
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setShowModalManual(true)}>
            + Ítem manual
          </button>
        </div>
      )}

      {/* Totales */}
      <div className="doc-totales">
        <div className="totales-row">
          <span>Subtotal</span>
          <span>{fmt(subtotal)} €</span>
        </div>
        {tipo === 'factura' && (
          <div className="totales-row">
            <span>IVA ({iva_porcentaje}%)</span>
            <span>{fmt(iva)} €</span>
          </div>
        )}
        <div className="totales-row totales-total">
          <span>TOTAL</span>
          <span>{fmt(total)} €</span>
        </div>
        {tipo === 'factura' && (anticipoTotal ?? 0) > 0 && (
          <>
            <div className="totales-row" style={{ color: '#1f7a3d' }}>
              <span>Anticipos entregados</span>
              <span>-{fmt(anticipoTotal ?? 0)} €</span>
            </div>
            <div className="totales-row totales-total">
              <span>RESTANTE A PAGAR</span>
              <span>{fmt(total - (anticipoTotal ?? 0))} €</span>
            </div>
          </>
        )}
      </div>

      {showModalManual && (
        <ModalItemManual
          margenDefecto={margenDefecto}
          onConfirm={añadirManual}
          onClose={() => setShowModalManual(false)}
        />
      )}
    </div>
  );
}