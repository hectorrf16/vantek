/**
 * ──────────────────────────────────────────────────────────────────────────────
 * LoginPage.tsx — Pantalla de acceso
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Asks for the access password when one has been configured in
 *   Configuración → Sistema. Until then the app never renders this screen.
 *
 * RELATIONSHIPS
 *   Imports: react, @utils/api
 *   Used by: App.tsx → shown instead of the router while there is no session
 *
 * PROPS
 *   · onAcceso() → called after a successful login so App re-checks the session
 *
 * ROUTE
 *   None: it replaces the whole tree, it is not a route.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useState } from 'react';
import api from '@utils/api';

export default function LoginPage({ onAcceso }: { onAcceso: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function entrar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setError(null);
    try {
      await api.post('/auth/login', { password });
      onAcceso();
    } catch (err) {
      setError((err as Error).message || 'No se pudo iniciar sesión');
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="loading-page">
      <form
        onSubmit={entrar}
        className="card"
        style={{ display: 'flex', flexDirection: 'column', gap: 12, width: 300, padding: 24 }}
      >
        <h2 style={{ margin: 0, fontSize: 18 }}>Vantek</h2>
        <label htmlFor="login-password" style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Contraseña de acceso
        </label>
        <input
          id="login-password"
          className="input"
          type="password"
          autoFocus
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        {error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{error}</span>}
        <button className="btn btn-primary" type="submit" disabled={enviando || !password}>
          {enviando ? <><span className="spinner" /> Entrando…</> : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
