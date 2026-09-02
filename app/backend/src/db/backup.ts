/**
 * ──────────────────────────────────────────────────────────────────────────────
 * backup.ts — Copias de seguridad de la base de datos
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Creates consistent snapshots of vantek.db with `VACUUM INTO`, which is
 *   WAL-safe (a plain file copy of a live WAL database can be corrupt), and
 *   keeps only the newest N copies under data/backups.
 *
 * RELATIONSHIPS
 *   Imports: @db/connection (getDb), @utils/paths (DATA_DIR)
 *   Used by:
 *     · db/migrate.ts → snapshot before applying pending migrations
 *     · services/reset.service.ts → snapshot before wiping all business data
 *     · index.ts → daily scheduled backup
 *
 * EXPORTS
 *   · backupDb(motivo) → absolute path of the created file, or null on failure
 *   · BACKUPS_DIR
 *
 * NOTES
 *   · Never throws: a failed backup must not stop the app from booting.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { getDb } from '@db/connection';
import { DATA_DIR } from '@utils/paths';

export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

const MAX_COPIAS = 10;

function sello(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function backupDb(motivo = 'manual'): string | null {
  try {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const destino = path.join(BACKUPS_DIR, `vantek-${sello()}-${motivo}.db`);

    // VACUUM INTO escribe un fichero coherente aunque haya WAL activo.
    getDb().prepare('VACUUM INTO ?').run(destino);
    console.log(`[BACKUP] Copia creada: ${destino}`);

    rotar();
    return destino;
  } catch (err) {
    console.error('[BACKUP] No se pudo crear la copia de seguridad:', err);
    return null;
  }
}

function rotar(): void {
  const copias = fs
    .readdirSync(BACKUPS_DIR)
    .filter(n => n.startsWith('vantek-') && n.endsWith('.db'))
    .sort();
  const sobran = copias.slice(0, Math.max(0, copias.length - MAX_COPIAS));
  for (const nombre of sobran) {
    try { fs.unlinkSync(path.join(BACKUPS_DIR, nombre)); } catch { /* ignorar */ }
  }
}
