/**
 * ──────────────────────────────────────────────────────────────────────────────
 * App.tsx — Root component, setup gating and route table
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Bootstraps the SPA: queries /api/setup/status to decide whether the app needs
 *   first-time setup, loads the business profile/config, and renders the router.
 *   While loading shows a spinner; on connection failure shows an error screen.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · @store/config.store → load() business profile + app config
 *     · @components/Layout/Layout → shell (sidebar + <Outlet/>) for app routes
 *     · @pages/* → page components mounted per route
 *     · @ui/Spinner → loading indicator
 *   Used by:
 *     · src/main.tsx (rendered once the splash screen reports ready)
 *
 * ROUTES
 *   When setup is required:
 *     · *                        → SetupPage (catch-all first-run wizard)
 *   Otherwise, nested under Layout ("/"):
 *     · /                        → <Navigate> redirect to /dashboard
 *     · /dashboard               → DashboardPage
 *     · /clientes                → ClientesPage
 *     · /clientes/:id            → ClienteFichaPage
 *     · /albaranes               → AlbaranesPage
 *     · /albaranes/:id           → AlbaranFichaPage
 *     · /facturas                → FacturasListPage
 *     · /facturas/:id            → FacturaPage
 *     · /presupuestos            → PresupuestosListPage
 *     · /presupuestos/:id        → PresupuestoPage
 *     · /seguimiento             → SeguimientoPage
 *     · /seguimiento/:id         → SeguimientoFichaPage
 *     · /configuracion           → ConfigPage
 *
 * INPUTS / OUTPUTS
 *   Input:  none (top-level component)
 *   Output: BrowserRouter tree with the routes above, or loading/error screens
 *
 * NOTES
 *   · configState gates rendering: 'loading' | 'setup' | 'ready' | 'error'.
 *   · Config is loaded before any app route renders so modules/terminology exist.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useConfigStore } from '@store/config.store';
import Layout from '@components/Layout/Layout';
import ClientesPage from '@pages/Clientes/ClientesPage';
import ClienteFichaPage from '@pages/Clientes/ClienteFichaPage';
import AlbaranesPage from '@pages/Albaranes/AlbaranesPage';
import AlbaranFichaPage from '@pages/Albaranes/AlbaranFichaPage';
import SetupPage from '@pages/Setup/SetupPage';
import FacturasListPage from '@pages/Documentos/FacturasListPage';
import PresupuestosListPage from '@pages/Documentos/PresupuestosListPage';
import FacturaPage from '@pages/Documentos/FacturaPage';
import PresupuestoPage from '@pages/Documentos/PresupuestoPage';
import DashboardPage from '@pages/Dashboard/DashboardPage';
import ConfigPage from '@pages/Config/ConfigPage';
import SeguimientoPage from '@pages/Seguimiento/SeguimientoPage';
import SeguimientoFichaPage from '@pages/Seguimiento/SeguimientoFichaPage';
import LoginPage from '@pages/Login/LoginPage';
import { onSesionCaducada } from '@utils/api';
import Spinner from '@ui/Spinner';

export default function App() {
  const { load } = useConfigStore();
  const [configState, setConfigState] = useState<'loading' | 'setup' | 'ready' | 'error'>('loading');
  const [autenticado, setAutenticado] = useState(true);

  useEffect(() => {
    // El interceptor de axios avisa cuando el backend responde 401.
    onSesionCaducada(() => setAutenticado(false));
  }, []);

  const init = useCallback(async () => {
    try {
      const sesion = await fetch('/api/auth/estado').then(r => r.json());
      if (!sesion.autenticado) {
        setAutenticado(false);
        setConfigState('ready');
        return;
      }
      setAutenticado(true);

      const res = await fetch('/api/setup/status');
      const data = await res.json();
      if (data.necesita_setup) {
        setConfigState('setup');
        return;
      }
      await load();
      setConfigState('ready');
    } catch {
      setConfigState('error');
    }
  }, [load]);

  useEffect(() => { init(); }, [init]);

  if (configState === 'loading') {
    return (
      <div className="loading-page">
        <Spinner size="lg" />
      </div>
    );
  }

  if (configState === 'error') {
    return (
      <div className="loading-page" style={{ flexDirection: 'column', gap: 8 }}>
        <span style={{ color: 'var(--red)' }}>No se pudo conectar con el servidor</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          Asegúrate de que el servicio está en ejecución
        </span>
      </div>
    );
  }

  if (!autenticado) {
    return <LoginPage onAcceso={() => { setConfigState('loading'); init(); }} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        {configState === 'setup' ? (
          <Route path="*" element={<SetupPage />} />
        ) : (
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="clientes" element={<ClientesPage />} />
            <Route path="clientes/:id" element={<ClienteFichaPage />} />
            <Route path="albaranes" element={<AlbaranesPage />} />
            <Route path="albaranes/:id" element={<AlbaranFichaPage />} />
            <Route path="facturas" element={<FacturasListPage />} />
            <Route path="facturas/:id" element={<FacturaPage />} />
            <Route path="presupuestos" element={<PresupuestosListPage />} />
            <Route path="presupuestos/:id" element={<PresupuestoPage />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="configuracion" element={<ConfigPage />} />
            <Route path="seguimiento" element={<SeguimientoPage />} />
            <Route path="seguimiento/:id" element={<SeguimientoFichaPage />} />
          </Route>
        )}
      </Routes>
    </BrowserRouter>
  );
}