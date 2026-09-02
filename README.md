# Vantek

Sistema local de gestión de facturas, presupuestos y obras.

## Estructura

```
vantek/
├── app/
│   ├── backend/     Express + TypeScript + SQLite
│   └── frontend/    Vite + React + TypeScript
├── launcher/        Arranque automático y actualizaciones (Windows)
├── config/          Configuración del perfil y la app
├── data/            Base de datos SQLite (generada automáticamente)
├── logs/            Logs del servicio
├── node/            Node.js portable (lo aporta install.ps1)
├── tools/           NSSM (lo aporta install.ps1)
├── puppeteer/       Chromium incluido (generado en build/install)
└── version.json     Versión actual
```

## Requisitos (desarrollo)

- Node.js 24+
- npm 11+

## Desarrollo

```bash
npm install
npm run dev
```

## Compilar para producción

```bash
npm run build
```

## Instalación en producción (Windows)

El despliegue Windows es totalmente autónomo: no instala nada de forma global en
el equipo. Node.js portable y NSSM viajan dentro de la propia carpeta de Vantek,
de modo que nada externo puede romper la aplicación.

### Primera instalación (la realiza el técnico)

1. Abrir la página del [último release](https://github.com/HeRoDaRu/vantek/releases/latest)
   y descargar `Vantek-<version>.zip`.
2. Extraer el ZIP en una carpeta temporal. `install.ps1` viene incluido dentro.
3. Abrir **PowerShell como Administrador** en esa carpeta y ejecutar:

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install.ps1
   ```

   El script descarga el último release (`Vantek-<version>.zip`) desde GitHub, lo
   extrae en `C:\Vantek` (configurable con `-InstallDir`), descarga Node.js 24
   portable en `node\`, NSSM en `tools\nssm.exe` y registra el servicio de
   Windows **VANTEK**.

4. Abrir la aplicación en `http://localhost:3000`. La primera vez, la propia
   aplicación muestra el asistente de configuración.

### Arranque manual (sin servicio)

Para pruebas puede ejecutarse `start.bat`, que lanza el mismo runtime que el
servicio pero en primer plano.

### Generación de releases (CI)

Al publicar un tag `vX.Y.Z`, el workflow `.github/workflows/release.yml`
(GitHub Actions sobre `windows-latest`) compila frontend, backend y launcher,
incluye el Chromium de Puppeteer y el instalador `install.ps1`, y publica el
asset `Vantek-<version>.zip`.

### Motor de PDF (Chromium)

La generación de PDF usa por defecto el Chromium incluido. Puede cambiarse a
Microsoft Edge del sistema con `sistema.chromium_modo: "edge"` en
`config/app.config.json`. Si el motor elegido falla, se reintenta con el otro
automáticamente.

## Perfiles disponibles

El perfil de negocio se configura en `config/profile.config.json`.

| Perfil | agrupador | trabajo |
|--------|-----------|---------|
| reformas | Dirección | Obra |
| taller | Matrícula | Reparación |

## Actualización de la app

Las actualizaciones son automáticas: el launcher descarga el mismo
`Vantek-<version>.zip` de cada nueva release de GitHub y lo aplica en la ventana
horaria configurada. `node\` y `tools\` no viajan en las actualizaciones, por lo
que sobreviven a cada update. También pueden aplicarse manualmente desde
Configuración > Sistema.
