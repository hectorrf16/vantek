/**
 * ──────────────────────────────────────────────────────────────────────────────
 * useTesseract.ts — Singleton Tesseract.js OCR worker + React hook
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Provides a single shared Tesseract.js worker (Spanish model) for the whole
 *   app, plus a React hook to run OCR on an image with progress/error state.
 *   The worker is preloaded at splash time to remove first-scan latency, with
 *   an on-demand fallback if it was not preloaded.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · react (useEffect/useRef/useState) → hook state & cleanup
 *     · tesseract.js (createWorker, Worker) → OCR engine
 *   Used by:
 *     · SplashScreen → calls preinicializarTesseract() at startup
 *     · OCRAlbaranModal (inside NuevoAlbaranModal) → useTesseract() to scan
 *
 * EXPORTS
 *   · preinicializarTesseract() → creates the singleton worker once (idempotent)
 *   · getTesseractWorker() → returns the current worker or null
 *   · useTesseract() → { estado, reconocer(imagen), resetear } hook
 *   · OcrResultado / OcrEstado → result and state types
 *
 * INPUTS / OUTPUTS
 *   Input:  image File/Blob to recognise
 *   Output: OcrResultado { texto, confianza } or null (aborted/error)
 *
 * NOTES
 *   · Worker assets are served locally (/tesseract-worker/*, /tessdata) so OCR
 *     works offline; these assets are provisioned at build/install, not versioned.
 *   · Logger is silenced in the preload path; abortRef cancels in-flight work on
 *     unmount or reset.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState } from 'react';
import { createWorker, Worker } from 'tesseract.js';

// ─── Singleton del worker ─────────────────────────────────────────────────────
// Se crea una única instancia compartida por toda la app

let workerSingleton: Worker | null = null;
let workerPromise: Promise<Worker> | null = null;

export async function preinicializarTesseract(): Promise<void> {
  if (workerSingleton || workerPromise) return;
  // Si la creación falla, hay que soltar la promesa: al quedarse cacheada
  // rechazada, la guarda de arriba impedía reintentar y el OCR quedaba roto
  // hasta recargar la página.
  const promesa = createWorker('spa', 1, {
    workerPath: '/tesseract-worker/worker.min.js',
    langPath: '/tessdata',
    corePath: '/tesseract-worker/tesseract-core.wasm.js',
    logger: () => {}, // silenciar logs en producción
  });
  workerPromise = promesa;
  try {
    workerSingleton = await promesa;
  } catch (err) {
    workerPromise = null;
    throw err;
  }
}

export function getTesseractWorker(): Worker | null {
  return workerSingleton;
}

// ─── Hook para usar OCR en un componente ──────────────────────────────────────

export interface OcrResultado {
  texto: string;
  confianza: number; // 0-100
}

export interface OcrEstado {
  procesando: boolean;
  progreso: number; // 0-1
  error: string | null;
}

export function useTesseract() {
  const [estado, setEstado] = useState<OcrEstado>({ procesando: false, progreso: 0, error: null });
  const abortRef = useRef(false);

  useEffect(() => {
    return () => { abortRef.current = true; };
  }, []);

  async function reconocer(imagen: File | Blob): Promise<OcrResultado | null> {
    setEstado({ procesando: true, progreso: 0, error: null });
    abortRef.current = false;

    try {
      let worker = workerSingleton;

      // Si el worker todavía no está listo, esperar
      if (!worker && workerPromise) {
        try {
          worker = await workerPromise;
        } catch {
          workerPromise = null;   // permite el fallback on-demand de abajo
        }
      }

      // Fallback: crear worker on-demand si el splash no lo precargó
      if (!worker) {
        setEstado(s => ({ ...s, progreso: 0.1 }));
        workerPromise = createWorker('spa', 1, {
          workerPath: '/tesseract-worker/worker.min.js',
          langPath: '/tessdata',
          corePath: '/tesseract-worker/tesseract-core.wasm.js',
          logger: (m: any) => {
            if (m.status === 'recognizing text') {
              setEstado(s => ({ ...s, progreso: 0.3 + m.progress * 0.7 }));
            }
          },
        });
        worker = await workerPromise;
        workerSingleton = worker;
      }

      if (abortRef.current) return null;
      setEstado(s => ({ ...s, progreso: 0.3 }));

      const { data } = await worker.recognize(imagen);

      if (abortRef.current) return null;
      setEstado({ procesando: false, progreso: 1, error: null });

      return { texto: data.text, confianza: data.confidence };
    } catch (e: any) {
      if (!abortRef.current) {
        setEstado({ procesando: false, progreso: 0, error: e.message ?? 'Error en OCR' });
      }
      return null;
    }
  }

  function resetear() {
    abortRef.current = true;
    setEstado({ procesando: false, progreso: 0, error: null });
  }

  return { estado, reconocer, resetear };
}