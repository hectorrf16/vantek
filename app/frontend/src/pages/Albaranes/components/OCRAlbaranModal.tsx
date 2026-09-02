/**
 * ──────────────────────────────────────────────────────────────────────────────
 * OCRAlbaranModal.tsx — Client-side OCR scan of a delivery note
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Modal that takes an image (click or drag-and-drop), runs Tesseract in the
 *   browser, heuristically parses provider/date/number/lines, and shows the
 *   extracted fields with confidence indicators for manual review/editing.
 *   On confirm it returns a ResultadoOCR to the parent. Also exports the
 *   LineaOCR and ResultadoOCR types.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @hooks/useTesseract → singleton OCR worker (estado + reconocer)
 *     · @ui/Modal → dialog shell
 *   Backend:
 *     · none — OCR is 100% client-side; assets served locally from public/
 *   Used by:
 *     · NuevoAlbaranModal (creation only; nested "Escanear OCR")
 *
 * PROPS
 *   · onConfirmar: (resultado: ResultadoOCR) => void → returns parsed/edited data
 *   · onCerrar: () => void → dismiss the modal
 *
 * INPUTS / OUTPUTS
 *   Input:  an image file + the user's manual corrections
 *   Output: onConfirmar with the final ResultadoOCR (provider, date, number, lines)
 *
 * NOTES
 *   · Confidence thresholds: 70 for critical fields (prices, references,
 *     numbers), 40 for descriptive text; below threshold shows a ⚠ marker.
 *   · The heuristic parser is basic by design — the user always reviews before
 *     confirming.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useState, useRef } from 'react';
import { useTesseract } from '@hooks/useTesseract';
import Modal from '@ui/Modal';

// ─── Umbrales de confianza ────────────────────────────────────────────────────
const UMBRAL_CRITICO = 70;   // precios, referencias, números
const UMBRAL_TEXTO   = 40;   // descripciones, nombres

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface LineaOCR {
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  _conf_descripcion: number;
  _conf_cantidad: number;
  _conf_precio: number;
}

export interface ResultadoOCR {
  proveedor: string;
  fecha: string;
  numero_albaran: string;
  lineas: LineaOCR[];
  _conf_proveedor: number;
  _conf_fecha: number;
  _conf_numero: number;
}

interface Props {
  onConfirmar: (resultado: ResultadoOCR) => void;
  onCerrar: () => void;
}

// ─── Parser básico del texto OCR ──────────────────────────────────────────────

function parsearTextoAlbaran(texto: string, confianzaGlobal: number): ResultadoOCR {
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);

  // Extracción heurística básica — el usuario siempre revisa
  const proveedor = lineas[0] ?? '';
  const fechaMatch = texto.match(/\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/);
  const fecha = fechaMatch ? fechaMatch[1] : '';
  const numMatch = texto.match(/(?:albarán|albaran|nº|no\.?|num\.?)\s*[:.]?\s*([A-Z0-9\-/]+)/i);
  const numero_albaran = numMatch ? numMatch[1] : '';

  // Líneas con precio: detectar patrón "descripción ... cantidad ... precio"
  const lineasDetectadas: LineaOCR[] = [];
  const precioRegex = /(\d+[.,]\d{2})/g;

  for (const l of lineas) {
    const precios = [...l.matchAll(precioRegex)].map(m => parseFloat(m[1].replace(',', '.')));
    if (precios.length >= 1) {
      const precio = precios[precios.length - 1];
      const cantMatch = l.match(/^\s*(\d+(?:[.,]\d+)?)\s+/);
      const cantidad = cantMatch ? parseFloat(cantMatch[1].replace(',', '.')) : 1;
      const descripcion = l.replace(precioRegex, '').replace(/^\d+[.,]?\d*\s*/, '').trim();
      if (descripcion.length > 2) {
        lineasDetectadas.push({
          descripcion,
          cantidad,
          precio_unitario: precio,
          _conf_descripcion: confianzaGlobal > UMBRAL_TEXTO ? confianzaGlobal : UMBRAL_TEXTO - 5,
          _conf_cantidad: confianzaGlobal > UMBRAL_CRITICO ? confianzaGlobal : UMBRAL_CRITICO - 10,
          _conf_precio: confianzaGlobal > UMBRAL_CRITICO ? confianzaGlobal : UMBRAL_CRITICO - 10,
        });
      }
    }
  }

  return {
    proveedor,
    fecha,
    numero_albaran,
    lineas: lineasDetectadas,
    _conf_proveedor: confianzaGlobal > UMBRAL_TEXTO ? confianzaGlobal : UMBRAL_TEXTO - 5,
    _conf_fecha: confianzaGlobal > UMBRAL_CRITICO ? confianzaGlobal : UMBRAL_CRITICO - 5,
    _conf_numero: confianzaGlobal > UMBRAL_CRITICO ? confianzaGlobal : UMBRAL_CRITICO - 10,
  };
}

// ─── Indicador de confianza ───────────────────────────────────────────────────

function IndicadorConf({ conf, umbral }: { conf: number; umbral: number }) {
  const color = conf >= umbral ? 'var(--green)' : 'var(--orange)';
  return (
    <span style={{ fontSize: 10, color, marginLeft: 4, fontWeight: 600 }}>
      {conf >= umbral ? '✓' : `⚠ ${Math.round(conf)}%`}
    </span>
  );
}

// ─── Modal principal ──────────────────────────────────────────────────────────

export default function OCRAlbaranModal({ onConfirmar, onCerrar }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { estado: ocrEstado, reconocer } = useTesseract();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoOCR | null>(null);
  const [editado, setEditado] = useState<ResultadoOCR | null>(null);

  async function handleArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPreviewUrl(URL.createObjectURL(file));
    setResultado(null);
    setEditado(null);

    const r = await reconocer(file);
    if (!r) return;

    const parsed = parsearTextoAlbaran(r.texto, r.confianza);
    setResultado(parsed);
    setEditado(JSON.parse(JSON.stringify(parsed))); // copia editable
  }

  function setE(key: keyof ResultadoOCR) {
    return (v: string) => setEditado(ed => ed ? { ...ed, [key]: v } : ed);
  }

  function setLinea(i: number, key: keyof LineaOCR, v: string) {
    setEditado(ed => {
      if (!ed) return ed;
      const lineas = [...ed.lineas];
      lineas[i] = {
        ...lineas[i],
        [key]: key === 'descripcion' ? v : parseFloat(v) || 0,
      };
      return { ...ed, lineas };
    });
  }

  function añadirLinea() {
    setEditado(ed => ed ? {
      ...ed,
      lineas: [...ed.lineas, { descripcion: '', cantidad: 1, precio_unitario: 0, _conf_descripcion: 100, _conf_cantidad: 100, _conf_precio: 100 }],
    } : ed);
  }

  function eliminarLinea(i: number) {
    setEditado(ed => ed ? { ...ed, lineas: ed.lineas.filter((_, j) => j !== i) } : ed);
  }

  const listo = !!resultado && !ocrEstado.procesando;

  return (
    <Modal
      title="Escanear albarán con OCR"
      size="lg"
      onClose={onCerrar}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCerrar}>Cancelar</button>
          {listo && editado && (
            <button className="btn btn-primary" onClick={() => onConfirmar(editado)}>
              Usar estos datos
            </button>
          )}
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Zona de subida */}
        <div
          style={{
            border: '2px dashed var(--border-2)', borderRadius: 'var(--radius-lg)',
            padding: '24px', textAlign: 'center', cursor: 'pointer',
            background: 'var(--bg-3)', transition: 'all 150ms',
          }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file) {
              const dt = new DataTransfer();
              dt.items.add(file);
              if (fileRef.current) fileRef.current.files = dt.files;
              handleArchivo({ target: { files: dt.files } } as any);
            }
          }}
        >
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleArchivo} />
          {previewUrl ? (
            <img src={previewUrl} alt="Preview" style={{ maxHeight: 160, maxWidth: '100%', borderRadius: 'var(--radius)', objectFit: 'contain' }} />
          ) : (
            <>
              <div style={{ fontSize: 28, marginBottom: 8 }}>📷</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4 }}>
                Haz clic o arrastra una imagen del albarán
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>JPG, PNG, WEBP</div>
            </>
          )}
        </div>

        {/* Progreso OCR */}
        {ocrEstado.procesando && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>
              <span>Procesando imagen…</span>
              <span>{Math.round(ocrEstado.progreso * 100)}%</span>
            </div>
            <div style={{ height: 4, background: 'var(--bg-4)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${ocrEstado.progreso * 100}%`, background: 'var(--accent)', transition: 'width 300ms' }} />
            </div>
          </div>
        )}

        {ocrEstado.error && (
          <div style={{ padding: '10px 12px', background: 'var(--red-dim)', border: '1px solid var(--red)', borderRadius: 'var(--radius)', fontSize: 13, color: 'var(--red)' }}>
            {ocrEstado.error}
          </div>
        )}

        {/* Resultados editables */}
        {editado && (
          <>
            <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 12px', background: 'var(--bg-3)', borderRadius: 'var(--radius)', borderLeft: '3px solid var(--accent)' }}>
              Revisa los datos extraídos. Los campos con <span style={{ color: 'var(--orange)' }}>⚠</span> tienen baja confianza y pueden contener errores.
            </div>

            {/* Cabecera del albarán */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <div className="form-group">
                <label className="form-label">
                  Proveedor
                  <IndicadorConf conf={editado._conf_proveedor} umbral={UMBRAL_TEXTO} />
                </label>
                <input className="input" value={editado.proveedor} onChange={e => setE('proveedor')(e.target.value)} />
              </div>
              <div className="form-group">
                <label className="form-label">
                  Fecha
                  <IndicadorConf conf={editado._conf_fecha} umbral={UMBRAL_CRITICO} />
                </label>
                <input className="input" value={editado.fecha} onChange={e => setE('fecha')(e.target.value)} placeholder="dd/mm/aaaa" />
              </div>
              <div className="form-group">
                <label className="form-label">
                  Nº albarán
                  <IndicadorConf conf={editado._conf_numero} umbral={UMBRAL_CRITICO} />
                </label>
                <input className="input" value={editado.numero_albaran} onChange={e => setE('numero_albaran')(e.target.value)} />
              </div>
            </div>

            {/* Líneas */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Líneas ({editado.lineas.length})
                </span>
                <button className="btn btn-sm btn-ghost" onClick={añadirLinea}>+ Añadir línea</button>
              </div>

              {editado.lineas.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13, background: 'var(--bg-3)', borderRadius: 'var(--radius)' }}>
                  No se detectaron líneas. Añade manualmente.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {editado.lineas.map((l, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px 28px', gap: 6, alignItems: 'center' }}>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>
                          Descripción <IndicadorConf conf={l._conf_descripcion} umbral={UMBRAL_TEXTO} />
                        </div>
                        <input className="input-sm" value={l.descripcion} onChange={e => setLinea(i, 'descripcion', e.target.value)} />
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>
                          Cant. <IndicadorConf conf={l._conf_cantidad} umbral={UMBRAL_CRITICO} />
                        </div>
                        <input className="input-sm" type="number" min="0" step="0.01" value={l.cantidad} onChange={e => setLinea(i, 'cantidad', e.target.value)} />
                      </div>
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 2 }}>
                          Precio <IndicadorConf conf={l._conf_precio} umbral={UMBRAL_CRITICO} />
                        </div>
                        <input className="input-sm" type="number" min="0" step="0.01" value={l.precio_unitario} onChange={e => setLinea(i, 'precio_unitario', e.target.value)} />
                      </div>
                      <button className="btn-icon btn-icon-danger" onClick={() => eliminarLinea(i)} title="Eliminar línea">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}