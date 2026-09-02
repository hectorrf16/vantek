# Vantek — Auditoría técnica y plan de mejora

*Sistema local de gestión de facturas, presupuestos y obras · Backend Express/SQLite · Frontend React · Despliegue Windows (Node portable + NSSM) y Linux (Docker + nginx)*

- **21** — Hallazgos crítico/alto
- **78** — Hallazgos verificados
- **98** — Agentes de análisis
- **5** — Refutados y descartados

Preparado para David · 22/07/2026
Metodología: mapeo paralelo de subsistemas + búsqueda por dimensiones + **verificación adversarial** de cada hallazgo.
**Restricción respetada:** no se propone ningún cambio de arquitectura. La app depende de dos sistemas (Windows y Linux) y ambos se mantienen como ciudadanos de primera clase.

## Contenido

- 1 · Resumen ejecutivo
- 2 · Metodología y cómo leer este informe
- 3 · Mapa de la arquitectura descubierta
- 4 · Plan de remediación priorizado (Fases 0–7) con código
- 5 · Catálogo completo de hallazgos verificados
- 6 · Hallazgos refutados (verificados y descartados)

## 1 · Resumen ejecutivo

Los cimientos de Vantek son mejores que la media, pero la aplicación es más débil justo donde más importa: la legalidad de las facturas, la seguridad de los datos y el actualizador automático.

**Lo que está bien y conviene conservar.** TypeScript en modo `strict` en las cuatro configuraciones; sentencias preparadas en todo el acceso a SQL (la única sospecha de inyección fue refutada: SQLite admite `IN ()` vacío); WAL y `foreign_keys` activos; un CI real que comprueba tipos y ejecuta los tests de ambos *workspaces* antes de publicar; y compilación disciplinada de `better-sqlite3` para el ABI correcto en cada release. El diseño de doble plataforma es coherente: `VANTEK_ROOT` unifica la disposición de Windows-portable y de Docker.

**Los cuatro focos de riesgo.**

- **Legalidad de facturas.** La numeración se basa en `COUNT(*)`, no hay restricción `UNIQUE` sobre la serie, las facturas ya emitidas son libremente editables y borrables, y el año de la serie se toma del reloj al cerrar (no de la fecha de la factura). Todo ello incumple el requisito legal español de numeración correlativa y única.
- **Seguridad de los datos.** No existe ninguna copia de seguridad automática de `vantek.db` en ninguna de las dos plataformas, y las migraciones no son transaccionales (un fallo a mitad deja el esquema a medio aplicar e impide arrancar).
- **Seguridad (exposición en LAN).** Ningún endpoint tiene autenticación —incluidos «borrar todos los datos» y la escritura de configuración— mientras la app es alcanzable por red local. La contraseña SMTP se guarda en claro y se devuelve al navegador. El actualizador aplica un ZIP de GitHub sin verificar firma ni hash: combinado con la escritura de configuración sin auth y la lectura de ficheros arbitrarios del motor de PDF, es una cadena realista de ejecución remota de código.
- **Fiabilidad del actualizador.** El comprobador de «borrador sucio» del launcher está roto (llama a `https.get` sobre una URL `http://`), el ZIP se extrae sobre la instalación en marcha sin *staging* ni *rollback*, y la ventana de mantenimiento por defecto cae a media jornada laboral.

**Distribución de los 78 hallazgos verificados:** 2 críticos, 19 altos, 29 medios, 28 bajos. Los apartados 4 (plan con código) y 5 (catálogo exhaustivo) los desarrollan uno a uno.

## 2 · Metodología y cómo leer este informe

El análisis se ejecutó como una orquestación multiagente en tres fases:

- **Mapeo.** Cinco lectores en paralelo, uno por subsistema (núcleo del backend, integraciones, frontend, plataforma/despliegue y calidad), produjeron el inventario y las convenciones del apartado 3.
- **Búsqueda por dimensiones.** Siete buscadores especializados (correctitud financiera, correctitud general, seguridad, robustez multiplataforma, integridad de datos, mantenibilidad y dependencias) recorrieron el código en busca de defectos concretos con referencia a `fichero:línea`.
- **Verificación adversarial.** Cada hallazgo pasó por un verificador escéptico cuyo objetivo era *refutarlo* leyendo el código citado. Solo los que sobrevivieron aparecen como «verificados»; 5 fueron descartados y se documentan en el apartado 6.

En total: 98 agentes, ~2,4 millones de tokens de análisis por pasada. Yo he revisado personalmente el código de todos los hallazgos crítico/alto antes de redactar las soluciones del apartado 4.

> **Nota de honestidad.** Un hallazgo de los buscadores afirmaba que varias versiones de dependencias «no existen» (typescript 6.0.3, uuid 14, nodemailer 9, etc.). Lo **refuté consultando el registro npm**: todas existen a día de hoy. Era el límite de conocimiento de los agentes, no un problema real, y queda excluido del informe.

**Cómo leer cada ficha (apartado 5):** etiqueta de severidad (crítico/alto/medio/bajo), esfuerzo estimado (pequeño/medio/grande), dimensión, ubicación `fichero:línea`, evidencia + solución, y —cuando aplica— la nota del verificador que confirma por qué el hallazgo se sostiene.

## 3 · Mapa de la arquitectura descubierta

> Vantek es un monolito con dos rutas de despliegue. **Windows:** `install.ps1` aprovisiona Node portable + NSSM en `C:\Vantek`, registra el servicio «VANTEK» que ejecuta el *launcher*; éste lanza el backend Express compilado y se autoactualiza sondeando GitHub Releases. **Linux:** Dockerfile multietapa (backend con Chromium del sistema + nginx sirviendo el frontend), orquestado por docker-compose; las actualizaciones son reconstrucciones de imagen. El almacén único es SQLite en modo WAL. Los PDF se generan con Puppeteer (Chromium incluido, con *fallback* a Edge en Windows).

### 3.1 · Backend — núcleo (API, servicios, base de datos)

The Vantek backend is an Express 5 + TypeScript + better-sqlite3 monolith bootstrapped in app/backend/src/index.ts, which mounts 8 domain routers under /api, serves the built frontend and PDFs statically, and runs config + DB migrations synchronously at startup. Routers are thin (manual field-presence validation, asyncHandler wrapping) and delegate to per-domain service modules that execute prepared SQL directly against a singleton WAL-mode SQLite handle; there is no ORM, no auth, and no schema-validation layer despite zod being a dependency. The domain centers on a cliente → agrupador → trabajo hierarchy with presupuestos/facturas/albaranes documents, a seguimiento (lead/work-order) state machine that bidirectionally syncs with document states, Puppeteer-rendered PDFs via a small in-house template engine, and Nodemailer for sending documents and 5xx error reports.

**Inventario de módulos**

| | |
| --- | --- |
| app/backend/src/index.ts | Express bootstrap: middleware (helmet/cors/compression/json 10mb), request logger, static frontend+PDFs, router mounts, update-state placeholders, SPA fallback, start() runs migrateConfig()+runMigrations() then listens |
| app/backend/src/middleware/errorHandler.ts | asyncHandler wrapper, global errorHandler (400 for ZodError name, else logs to errores table and returns 500), notFoundHandler |
| app/backend/src/db/connection.ts | better-sqlite3 singleton getDb() with PRAGMA journal_mode=WAL, foreign_keys=ON, synchronous=NORMAL |
| app/backend/src/db/migrate.ts | inline versioned SQL migrations (v1–v9) applied in order and recorded in _migraciones; table rebuild pattern for CHECK widening (v5) |
| app/backend/src/routes/clientes.router.ts | nested REST for clientes/agrupadores/trabajos; { data } envelope; logical deletes |
| app/backend/src/routes/facturas.router.ts | invoice lifecycle: CRUD, lines, autosave, cerrar (annual number), estado, PDF generate/serve, email send |
| app/backend/src/routes/presupuestos.router.ts | quote lifecycle mirror of facturas (no IVA), auto-generates PDF before emailing |
| app/backend/src/routes/albaranes.router.ts | supplier delivery notes CRUD + line assignment/move/unassign to trabajos; 409 on lines used in facturas |
| app/backend/src/routes/seguimiento.router.ts | CRUD + POST /:id/estado state machine endpoint; maps service statusCode to HTTP |
| app/backend/src/routes/dashboard.router.ts | GET / with agrupacion=mes\|trimestre\|anio |
| app/backend/src/routes/config.router.ts | read/write app+profile config files verbatim (no validation by design), SMTP test, error log list/send/clear, reset-datos |
| app/backend/src/routes/setup.router.ts | first-run wizard: profile validation and config file creation |
| app/backend/src/routes/pagos.router.ts | advance payments ledger nested at /api/trabajos/:trabajoId/pagos (mergeParams) |
| app/backend/src/services/seguimiento.service.ts | largest service (738 lines): CRUD, cancelable/terminal state machine, auto-conversion to cliente+agrupador+trabajo with Levenshtein fuzzy dedup, bidirectional doc↔seguimiento sync (forward-only via ORDEN_SEGUIMIENTO ranks) |
| app/backend/src/services/facturas.service.ts | invoice logic: totals, count-based annual numbering, TRANSICIONES_FACTURA transition guard, albarán-line import with margin, PDF version snapshots with purge, dirty-draft detection for launcher |
| app/backend/src/services/presupuestos.service.ts | quote logic mirroring facturas; exportarLineasParaFactura feeds invoice creation |
| app/backend/src/services/albaranes.service.ts | albarán header+lines CRUD, computed estado (sin_asignar/parcial/asignado), line↔trabajo assignment, delete guarded by factura usage |
| app/backend/src/services/clientes.service.ts | cliente CRUD (logical delete), nested ficha with agrupadores/trabajos/incidencias, global search |
| app/backend/src/services/trabajos.service.ts | trabajo CRUD with context joins and per-trabajo albaranes |
| app/backend/src/services/agrupadores.service.ts | agrupador CRUD, logical delete only |
| app/backend/src/services/dashboard.service.ts | pending-action lists (unsold quotes, undelivered/uncollected invoices) and paid-vs-projection revenue grouped by period |
| app/backend/src/services/pdf.service.ts | in-house {{}}/{{#if}}/{{#each}} template engine, logo/template resolution, Puppeteer launch with bundled-Chromium↔Edge fallback, per-call browser lifecycle |
| app/backend/src/services/email.service.ts | Nodemailer transporter from config (STARTTLS forcing), factura/presupuesto send with latest-PDF attachment, error-report emails |
| app/backend/src/services/errores.service.ts | persist/list/count/delete 5xx errors by date range; registrarError never throws |
| app/backend/src/services/pagos.service.ts | obra advance payments; percentage resolved to euros at insert, rounded to cents |
| app/backend/src/services/setup.service.ts | profile presets (reformas/taller/otro) and app/profile config file generation preserving existing values |
| app/backend/src/services/reset.service.ts | transactional child→parent DELETE of all business tables + PDF file cleanup |
| app/backend/src/utils/config.ts | cached readers for profile/app config JSON, saveAppConfig, migrateConfig (deep-merge template keys on boot), t() key translator |
| app/backend/src/utils/paths.ts | APP_ROOT (VANTEK_ROOT env or cwd) and derived CONFIG_DIR/DATA_DIR/PDFS_DIR |
| app/backend/src/types/index.ts | all shared domain interfaces (entities, document lines, setup payloads, config mirrors) |

**Convenciones y patrones**

- Routing: one Express Router per domain mounted in index.ts:102-122; every handler wrapped in asyncHandler (middleware/errorHandler.ts:37-43) so rejections reach the global errorHandler; default export per router.
- Validation: entirely manual ad-hoc presence checks in routers (e.g. clientes.router.ts:77, facturas.router.ts:76, albaranes.router.ts:73-74); no zod schemas are used anywhere despite zod in package.json and a ZodError branch in errorHandler.ts:53.
- Error handling: three coexisting conventions — (a) throw Error with attached statusCode caught either in-router (seguimiento.router.ts:77-83) or intended for the global handler (pagos.service.ts:76-78); (b) result-enum returns ('no_existe'|'en_uso'|'ok' in albaranes.service.ts:309); (c) { ok, error } result objects (facturas.service.ts:431-437 → 422 in facturas.router.ts:115-124). Global handler logs 5xx to the errores table and can email them to a technician on demand (config.router.ts:112-137).
- DB layer: single synchronous better-sqlite3 connection (connection.ts:43-51, WAL + foreign_keys ON); all queries use prepared statements with ? binding, including dynamically built IN(...) placeholder lists (facturas.service.ts:369, clientes.service.ts:74); db.transaction() wraps multi-insert creates (facturas.service.ts:247, presupuestos.service.ts:207, albaranes.service.ts:177, reset.service.ts:64) but not all multi-statement mutations.
- Migrations: append-only array of { version, sql } executed via db.exec and recorded in _migraciones (migrate.ts:396-421); idempotent by max-version check; CHECK-constraint changes done by full table rebuild (migration v5, migrate.ts:266-318).
- Services are either module-namespace function exports (facturas, presupuestos, seguimiento, pagos, errores) or single object literals (clientesService, albanesService, trabajosService, agrupadoresService) — two coexisting styles.
- IDs are uuidv4 TEXT primary keys generated in app code; timestamps are TEXT, written either by SQLite datetime('now') or JS new Date().toISOString() depending on the service.
- Soft-delete convention (activo = 0) for clientes/agrupadores ('principle 5'), hard DELETE for documents (facturas/presupuestos/albaranes/seguimiento rows).
- State machines as data: allowed-transition maps (TRANSICIONES_FACTURA facturas.service.ts:459-465, TRANSICIONES_PRESUPUESTO presupuestos.service.ts:312-318) that silently no-op invalid transitions; seguimiento uses an ordinal rank table (ORDEN_SEGUIMIENTO seguimiento.service.ts:133-145) so document-driven sync can only advance the state; sync uses direct SQL only to avoid circular service imports (seguimiento.service.ts:371-412).
- Config as JSON files on disk (config/app.config.json, profile.config.json) with in-memory caches, boot-time template deep-merge migration (config.ts:216-239), and PUT endpoints that write the whole object verbatim by design (config.router.ts:68-87).
- PDF pipeline: dependency-free mini template engine with escaping ({{ }} escaped, {{{ }}} raw, nested if/each — pdf.service.ts:203-290); one Puppeteer browser launched and closed per document (pdf.service.ts:426-441) with bundled-Chromium/system-Edge fallback; PDFs versioned in *_versiones tables with JSON snapshot and purge beyond max_versiones.
- API response envelope is inconsistent: clientes/albaranes/pagos wrap in { data }, while facturas/presupuestos/seguimiento/dashboard return the raw object/array.

**Puntos de atención observados**

- Invoice numbering can produce duplicates: siguienteNumeroFactura is COUNT-based (facturas.service.ts:104-114) while reopening clears numero/anio_numero (facturas.service.ts:484-490) and eliminarFactura deletes closed invoices with no state guard (facturas.service.ts:553-558); e.g. close 0001+0002, reopen/delete 0001, next close gets a second '0002'. The configured counter documentos.numeracion_factura (config.ts:95-98) is never used, and there is no UNIQUE constraint on (anio_numero, numero) in migrate.ts.
- Bug: dashboard reads config.dashboard?.dashboard?.dias_factura_sin_cobrar — doubled 'dashboard' key (dashboard.service.ts:105) — so the configured dias_factura_sin_cobrar is always ignored in favor of the 30-day default; also the AppConfig type is bypassed via (config as any).
- Service errors with statusCode are turned into 500s: pagos.service.crearPago throws statusCode 404 (pagos.service.ts:76-78) but pagos.router does not catch it and errorHandler ignores err.statusCode (errorHandler.ts:46-65), so an unknown trabajo returns HTTP 500 and pollutes the errores log; only seguimiento.router manually maps statusCode (seguimiento.router.ts:81).
- Non-atomic multi-statement mutations: guardarLineas does DELETE-then-loop-INSERT without a transaction in both facturas.service.ts:288-307 and presupuestos.service.ts:266-288 (a mid-loop failure loses all document lines); eliminarFactura (facturas.service.ts:553-558), eliminarPresupuesto (presupuestos.service.ts:403-408), and seguimiento cambiarEstado's multi-table updates (_convertirACliente + estado update + _syncDocumentosDesdeEstado, seguimiento.service.ts:280-363) are also un-wrapped.
- Migrations are not transactional: db.exec(migration.sql) and the _migraciones INSERT are separate steps with no BEGIN/COMMIT (migrate.ts:415-419); a failure mid-way through a multi-statement migration (e.g. the v5 table rebuild, migrate.ts:266-318) leaves a half-applied schema that will re-run from the top on next boot.
- Mixed timestamp formats in the same columns: clientes/agrupadores/trabajos/albaranes services write ISO strings with 'T'/'Z' (clientes.service.ts:163, albaranes.service.ts:175, trabajosService.create:83) while seguimiento's auto-conversion and schema defaults use datetime('now') space-separated UTC (seguimiento.service.ts:513-515, migrate.ts:58); lexicographic ORDER BY created_at across formats is inconsistent ('T' sorts after ' '), and date arithmetic mixes local-time toISOString dates with UTC DB values.
- GROUP_CONCAT split-by-comma parsing breaks on names containing commas: albaranes.service.findById splits trabajo_ids/trabajo_nombres by ',' (albaranes.service.ts:113-130), so a trabajo named 'Reforma cocina, baño' misaligns the assigned-trabajos array; similarly findAll GROUP BY al.id, t.id (albaranes.service.ts:86-97) duplicates an albarán row per assigned trabajo and computes estado against the per-group count.
- Dashboard revenue is anchored to updated_at, not the invoice date: getResumen selects f.updated_at as fecha (dashboard.service.ts:215) so any later touch of an invoice (state change, resend) moves its revenue into the current period; fecha/fecha_cierre exist but are unused there. Also facturasSinCobrar populates dias_espera instead of the declared dias_sin_cobrar field (dashboard.service.ts:198 vs type at :46).
- No authentication or authorization anywhere: the usuarios table with password_hash and roles is created (migrate.ts:38-47) and typed (types/index.ts:62-69) but no login/middleware exists; every endpoint including POST /api/config/reset-datos (config.router.ts:140-146, wipes all business data) and PUT /api/config/app (writes SMTP credentials to disk verbatim, config.router.ts:68-76) is unauthenticated — acceptable for a LAN-local app only if the port is never exposed.
- Validation gaps in write paths: zod is a dependency (package.json:25) but unused — routers pass req.body fields straight to SQL (e.g. facturas guardarLineas trusts each line's shape, facturas.router.ts:84-90; trabajosService.update accepts arbitrary estado string, trabajos.service.ts:94-117 despite the CHECK constraint causing an opaque 500); PUT /api/config/app and /profile write any JSON object to the config files (config.router.ts:68-87), which getAppConfig then trusts.
- Partial-update semantics conflate 'not sent' and 'clear': seguimiento.actualizar uses data.x ?? seg.x (seguimiento.service.ts:246-260) and clientes/agrupadores/trabajos update use COALESCE(?, col) (clientes.service.ts:178-192), so no field (telefono, notas, fecha_visita, firma_salida…) can ever be reset to NULL through the API.
- Money is computed with unrounded floating point: calcularTotales sums REAL columns and derives IVA without rounding (facturas.service.ts:94-102), while other paths round to cents (facturas.service.ts:395, pagos.service.ts:42-44); totals shown/summed in SQL (listarFacturas facturas.service.ts:150-154) can differ by cents from the JS-side totals and from what the PDF displays after fmt().
- pdf_path is stored relative to the compiled service directory (path.relative(__dirname, ...), pdf.service.ts:443), which changes between dev (tsx) and production (dist) layouts; consumers defensively re-resolve by basename (email.service.ts:54, facturas.router.ts:152), but the persisted value itself is deployment-dependent data in factura_versiones/presupuesto_versiones.
- cerrarFactura numbers by wall-clock year (new Date().getFullYear(), facturas.service.ts:439) regardless of the invoice's fecha, so an invoice dated December closed in January gets the new year's series; combined with the count-based numbering above this makes the annual series fragile at year boundaries.
- Dead/placeholder infrastructure: ZodError branch in errorHandler.ts:53-55 can never fire, usuarios table is write-only schema, /api/status/update endpoints operate on a JSON flag file with no validation of update-state.json contents (index.ts:127-161), and GET /api/status reads npm_package_version which is absent under NSSM/portable Node launch (index.ts:106).

### 3.2 · Backend — integraciones (PDF, email, configuración)

The Vantek backend integration layer consists of three services anchored on a JSON-file config system. PDF generation (pdf.service.ts) renders a single shared HTML template through a dependency-free in-house Handlebars-like engine and prints it with Puppeteer, launching either the bundled Chromium or system Edge (Windows hardcoded paths) with automatic fallback between them; output goes straight to <APP_ROOT>/data/pdfs with no temp files, no queue, and one full browser launch per request. Email (email.service.ts) builds a Nodemailer SMTP transport per send from app.config.json, where SMTP credentials (including the password) are stored in plaintext and are also returned verbatim to the frontend by GET /api/config/app. Setup (setup.service.ts) writes profile.config.json and app.config.json from a wizard payload using hardcoded reformas/taller profiles, and config.ts provides cached readers/writers plus a startup deep-merge migration from config/app.config.template.json.

**Inventario de módulos**

| | |
| --- | --- |
| app/backend/src/services/pdf.service.ts | Renders factura/presupuesto HTML via in-house template engine (interpolation, {{#if}}/{{else}}, {{#each}}, nesting; lines 194-290) and converts to PDF with Puppeteer; resolves logo to data URI (119-139), template precedence inline-config > external file > bundled (173-192), browser launch with bundled-Chromium/Edge fallback (382-414), writes '<tipo>-<id>-<timestamp>.pdf' into PDFS_DIR (423-424) |
| app/backend/src/services/email.service.ts | Nodemailer SMTP layer: crearTransporter from config.email.smtp with secure/requireTLS logic (68-88), verificarSmtp for the 'test connection' button (105-108), enviarFactura/enviarPresupuesto with {{token}} subject/body templates and latest-version PDF attachment rebuilt from PDFS_DIR by basename (48-57), enviarErrores error report to technician (205-259) |
| app/backend/src/services/setup.service.ts | First-run wizard: checkSetupRequired (146-155), hardcoded reformas/taller profile presets (48-142), 'otro' profile built on reformas base (157-189), buildAppConfig preserving existing counters/SMTP (191-274), saveSetup writes both JSON configs and invalidates caches (276-287) |
| app/backend/src/utils/config.ts | Loads/caches profile.config.json and app.config.json from CONFIG_DIR; AppConfig type includes plaintext smtp.pass and numeracion_factura counter (79-132); saveAppConfig writes file + cache (172-175); migrateConfig deep-merges new template keys on boot without overwriting (216-239); t() key translator (242-252); seguimiento.estados backfill for old installs (151-163) |
| app/backend/src/utils/paths.ts | APP_ROOT = VANTEK_ROOT env or process.cwd(); derives CONFIG_DIR, DATA_DIR, PDFS_DIR (35-39) |
| config/app.config.template.json | App config template: puerto, empresa, documentos (IVA, margen, max_versiones, invoice numbering counter), dashboard, email.smtp (host/port/secure/user/pass/from) + email plantillas, sistema (email_errores, chromium_modo, update window) |
| config/profile.config.template.json | Business-profile template (reformas default): entity labels, menu labels, document labels, module toggles, seguimiento estados list, PDF footers |
| templates/documento.html | Shared Puppeteer PDF template for factura/presupuesto; watermark, PAGADA stamp, IVA row, anticipo/restante rows toggled by context flags; {{{STYLES}}} injected from CSS |
| templates/documento.css | Stylesheet inlined into the PDF template at render time via leerCss() (pdf.service.ts:161-167) |

**Convenciones y patrones**

- Config-as-JSON-files: all runtime settings (company, SMTP creds, invoice numbering counter, chromium mode) live in <APP_ROOT>/config/app.config.json with in-memory caching and explicit reload* invalidators (config.ts:134-183); schema evolution handled by startup deep-merge from app.config.template.json that adds missing keys but never overwrites (config.ts:216-239) and never throws to avoid blocking boot
- Browser selection is config-driven with mutual fallback: sistema.chromium_modo 'bundled'|'edge' picks the primary launcher, and any launch error falls back to the other (pdf.service.ts:396-413); Edge is discovered only at two hardcoded Windows Program Files paths (pdf.service.ts:367-380); both modes always pass --no-sandbox --disable-setuid-sandbox (pdf.service.ts:383)
- No temp files in PDF flow: HTML is set via page.setContent and page.pdf writes the final file directly into PDFS_DIR with a timestamped name (pdf.service.ts:423-437); browser closed in finally (439-441); no concurrency control — one full browser launch per request, no pool, queue, mutex, or timeout
- Two independent template engines: pdf.service.ts implements a nesting-aware {{}}/{{{ }}}/{{#if}}/{{#each}} engine with HTML escaping on double-stache (pdf.service.ts:104-290); email.service.ts uses a flat {{token}} replacer plus textoAHtml escaping for the HTML body (email.service.ts:113-124); token catalog centralized in app/frontend/src/config/tokens.ts per comments
- Defensive path handling for portability: stored pdf_path values are treated as untrusted/relative and re-anchored by basename onto PDFS_DIR before attaching (email.service.ts:46-57); APP_ROOT is env-overridable to unify Windows-portable and Docker layouts (paths.ts:35)
- Error handling style: swallow-and-fallback (empty string on missing CSS/logo, template fallback chain in cargarPlantilla, try/catch around fs probes); setup preserves prior config and counters when re-run (setup.service.ts:191-201); Spanish domain language throughout with t() translator so entity labels never appear as literals (config.ts:242-252)

**Puntos de atención observados**

- SMTP password stored in plaintext in config/app.config.json (AppConfig.email.smtp.pass — config.ts:118-126; template config/app.config.template.json:31-39, setup default setup.service.ts:231-239) AND returned verbatim to any client via GET /api/config/app (res.json(getAppConfig()) — app/backend/src/routes/config.router.ts:63-65). No redaction, no encryption, no OS keychain; anyone with LAN/browser access to the app can read the mail account password.
- Invoice numbering counter lives in the same mutable JSON config (documentos.numeracion_factura — config.ts:95-98) and saveAppConfig uses a non-atomic fs.writeFileSync with no lock or tmp-rename (config.ts:172-175); a crash mid-write corrupts app.config.json (losing SMTP config and the legal invoice counter), and a concurrent PUT /api/config/app full-object write can race counter increments.
- PDF generation has zero concurrency management: every request launches and tears down a full Chromium/Edge instance (pdf.service.ts:426-441) with no queue, semaphore, or timeout on launch/newPage/pdf — parallel requests multiply memory-heavy browsers and a hung browser stalls the HTTP request indefinitely.
- Sandbox disabled unconditionally ('--no-sandbox', '--disable-setuid-sandbox' — pdf.service.ts:383) while the rendered HTML is user-configurable: documentos.template_html/template_path load arbitrary HTML with unescaped {{{ }}} interpolation (pdf.service.ts:173-192, 217-223), and logoSrc reads any local file path from config and embeds it base64 (pdf.service.ts:119-139) — combined with the config API this allows local-file disclosure into generated PDFs.
- generarPdf returns path.relative(__dirname, outputPath) (pdf.service.ts:443) — a path relative to the compiled module location gets persisted as pdf_path, which is deployment-fragile; email.service.ts must work around it by rebasing on basename (email.service.ts:46-57, acknowledged in its own header note line 32).
- Old PDF files are never deleted from disk: version pruning only deletes DB rows (DELETE FROM factura_versiones — facturas.service.ts:544/556; presupuesto_versiones — presupuestos.service.ts:394/406; no unlink/rm anywhere in either service), and filenames are timestamped-unique (pdf.service.ts:423), so PDFS_DIR grows without bound.
- adjuntoPdf silently returns no attachment when the PDF file is missing (email.service.ts:55), so enviarFactura/enviarPresupuesto can email a client a bare message without the document and report success.
- checkSetupRequired does raw JSON.parse with no try/catch (setup.service.ts:151-152): a corrupted app.config.json or profile.config.json makes the setup-status check throw instead of returning true, while buildAppConfig handles the same corruption gracefully (setup.service.ts:194-200); getProfileConfig/getAppConfig similarly throw on corrupt JSON (config.ts:153, 167).
- Edge fallback is Windows-only hardcoded paths (pdf.service.ts:368-371); in the Docker/Linux deployment the fallback branch is guaranteed dead and only yields a confusing 'No se encontró Microsoft Edge' error if bundled Chromium fails.
- TEMPLATES_DIR is resolved once at module load (const at pdf.service.ts:159), so a templates folder created or moved after startup requires a process restart; likewise the seguimiento.estados backfill mutates only the in-memory cache and never persists (config.ts:154-159).
- enviarErrores interpolates empresa and error count into the HTML email body without escaping (email.service.ts:243-247) — a company name containing HTML markup breaks/injects into the report email (low severity, self-inflicted via own config).

### 3.3 · Frontend (React SPA)

The frontend is a Vite + React 19 SPA (TypeScript, react-router-dom v7) with Zustand v5 stores per domain and a single shared axios instance (baseURL /api, 15s timeout, global error-toast interceptor). Entry gates on a Tesseract-preloading splash (main.tsx), then App.tsx checks /api/setup/status to route to a first-run wizard or the Layout shell with 12 routes. Styling is almost entirely inline style objects over CSS-variable tokens; forms are hand-rolled controlled state with minimal ad-hoc validation, despite react-hook-form/zod being declared as dependencies but never imported. Significant business logic (invoice-close rules, seguimiento state machine, legacy-config migration) lives in page components rather than the backend or stores.

**Inventario de módulos**

| | |
| --- | --- |
| app/frontend/src/main.tsx | entry point; splash-gated mount of <App/> plus global <Toaster/> under StrictMode |
| app/frontend/src/App.tsx | root router; fetches /api/setup/status, loads config store, renders SetupPage catch-all or BrowserRouter route table under Layout |
| app/frontend/src/utils/api.ts | shared axios instance ('/api', 15s timeout) with response interceptor that toasts every error and normalizes rejections to Error(message) |
| app/frontend/src/utils/pagos.api.ts | thin REST helpers for the per-obra advance-payment ledger (no store) |
| app/frontend/src/store/clientes.store.ts | Zustand store for Cliente→Agrupador→Trabajo hierarchy; nested immutable updates on `selected` |
| app/frontend/src/store/facturas.store.ts | invoice list/detail lifecycle: lines, draft autosave, close, state, PDF, email, delete |
| app/frontend/src/store/presupuestos.store.ts | quote store, near-clone of facturas.store (same shape minus IVA/albaranes) |
| app/frontend/src/store/seguimiento.store.ts | lead/works-tracking store with cambiarEstado returning {ok,error} result objects |
| app/frontend/src/store/config.store.ts | business profile + app config loader (native fetch) and t() dot-path terminology translator |
| app/frontend/src/store/toast.store.ts | toast queue with 6s auto-dismiss and notificarError() imperative helper for non-React code |
| app/frontend/src/store/dashboard.store.ts | dashboard pendientes + economic summary data |
| app/frontend/src/components/Layout/Layout.tsx / Sidebar.tsx | app shell: mobile topbar, backdrop, collapsible NavLink rail gated by profile modules |
| app/frontend/src/components/UI/{Modal,Toaster,Badge,Spinner,SelectorTrabajoModal}.tsx | UI primitives; Modal has Escape/overlay close + 125ms exit animation; Badge maps ~22 estado strings to labels |
| app/frontend/src/pages/Config/ConfigPage.tsx (1089 LOC) | tabbed editor of the whole app.config.json (empresa/documentos/templates/dashboard/email/sistema) with legacy-config normalization, SMTP test, error-report, data-reset and year-rollover dialog; PUTs the full object with no server validation |
| app/frontend/src/pages/Seguimiento/SeguimientoFichaPage.tsx (814 LOC) | seguimiento detail + state machine derived from profile's ordered estados; chains post-transition modals (create presupuesto/factura, close trabajo); dual reformas/taller field sets |
| app/frontend/src/pages/Clientes/ClienteFichaPage.tsx (762 LOC) | client ficha with agrupador accordion, incidencias banner, and 5 decision dialogs for existing draft/closed/accepted/rejected documents |
| app/frontend/src/pages/Setup/SetupPage.tsx (722 LOC) | 3-step first-run wizard (profile pick + custom entity labels, company data, done); reloads window on finish |
| app/frontend/src/pages/Documentos/FacturaPage.tsx / PresupuestoPage.tsx | near-twin document editor pages owning controlled line state, 3-min autosave, close/PDF/print/send/reopen/delete |
| app/frontend/src/pages/Documentos/components/DocumentoEditor.tsx | shared controlled line table (inline edit, reorder, manual-item modal, coste×margen→precio recompute, totals/IVA/anticipos) |
| app/frontend/src/pages/Documentos/components/{BarraAcciones,PanelHistorial,ModalAñadirAlbaran}.tsx | document toolbar, PDF version history, albarán-line importer |
| app/frontend/src/pages/Documentos/{FacturasListPage,PresupuestosListPage}.tsx | filtered list tables (server estado/trabajo_id filters, client-side text search) |
| app/frontend/src/pages/Clientes/components/Modal/{ClienteModal,AgrupadorModal,TrabajoModal,PagosObra}.tsx | hand-rolled controlled form modals delegating persistence via onSubmit |
| app/frontend/src/pages/{Dashboard/DashboardPage,Seguimiento/SeguimientoPage,Albaranes/*}.tsx | dashboard (recharts), seguimiento list, albarán list/ficha + OCR modal (tesseract.js) |

**Convenciones y patrones**

- State: one Zustand vanilla-create store per domain; reads set {loading,error} inside the store, writes (create/update/delete) throw and are handled ad hoc by each page. Loading is a single shared boolean per store, so list-fetch and detail-fetch of the same store collide.
- HTTP: all calls go through the shared axios instance whose interceptor toasts EVERY failed request globally (utils/api.ts:42-52) and re-rejects a normalized Error; config.store.ts intentionally bypasses axios with native fetch for boot (config.store.ts:119-129).
- Error handling is a 4-way mix: global toast (interceptor), window.alert() in 14 places, inline error banners/state (errEstado, errorCierre, form-error spans), and result-object returns ({ok,error}) from cerrarFactura/cambiarEstado — the same failure often surfaces twice (toast + alert).
- Documents use a 'controlled editor' pattern: line state lives in FacturaPage/PresupuestoPage, DocumentoEditor is pure UI pushing changes up via onChange; drafts autosaved every 3 min via POST /borrador; explicit save also regenerates the PDF.
- Business rules live in the frontend: invoice close requires ≥1 material line and warns without mano de obra (FacturaPage.tsx:162-188 and header note lines 44-47); the seguimiento state machine transitions are derived client-side from the profile's ordered estados list (SeguimientoFichaPage.tsx:87-98); legacy config migration is done in the browser (ConfigPage.tsx:102-139).
- Forms: hand-rolled controlled useState objects with manual required-field checks only (ClienteModal.tsx:69, SetupPage.tsx:404-410); react-hook-form + zod + @hookform/resolvers are declared in package.json but never imported anywhere in src.
- Terminology/white-labeling via config.store t('entidades.x') dot-path resolver and modulos flags gating taller vs reformas fields (SeguimientoFichaPage.tsx:158-159).
- Styling: overwhelmingly inline style={{}} objects referencing CSS custom properties (var(--bg-2), var(--radius)); a handful of utility classes (.btn, .input, .card); hover effects sometimes done with onMouseEnter/Leave JS (ClienteFichaPage.tsx:462-463).
- API response envelope is inconsistent (clientes wraps {data}, facturas/presupuestos/seguimiento return raw), so callers defensively unwrap with `res.data.data ?? res.data` / `res.data.data?.id ?? res.data.id` in 6+ places (ClienteFichaPage.tsx:77,85,135; SeguimientoFichaPage.tsx:209,217).
- Modals: shared Modal primitive used in two styles — conditional mount ({show && <Modal/>}) and open prop — with per-modal document-level Escape listeners; confirmation-before-action modals are the standard flow idiom (5 decision dialogs in ClienteFichaPage, 4 post-action modals in SeguimientoFichaPage).
- Testing: only 3 small unit tests exist (Badge, config.store, toast.store); no page/integration tests.

**Puntos de atención observados**

- Autosave stale-closure bug: the 3-minute setInterval captures `lineas` from the render when the effect ran, but the effect deps are only [actual?.id, actual?.estado], so drafts are autosaved with the ORIGINAL lines, never the user's edits — FacturaPage.tsx:139-145 and identically PresupuestoPage.tsx:107-113.
- ConfigPage load has no error path: api.get('/config/app').then(...) with no .catch, so any failure leaves `cargando` true and the page spins forever — ConfigPage.tsx:148-153.
- Year-rollover dialog reopens after being postponed: the effect depends on [config], which changes on every keystroke, so any edit re-triggers setMostrarDialogoAnio(true) — ConfigPage.tsx:721-725.
- Numeric config fields store NaN: onChange={v => set([...], parseFloat(v))} with no NaN guard means clearing a field writes NaN (serialized as null in the PUT of the full config, which the backend saves without validating per header comment ConfigPage.tsx:24) — ConfigPage.tsx:827,841,844,848,882,907,981.
- SMTP password round-trips in plaintext to the browser and is kept in page state / re-PUT with the whole config — ConfigPage.tsx:925 (type='password' input fed from GET /config/app).
- Duplicate divergent AppConfig types: config.store.ts:51-102 (email.auth.{user,pass}, no dashboard/plantillas) vs ConfigPage.tsx:47-94 (email.smtp.{user,pass,from}, plantillas, dashboard) — two hand-maintained shapes for the same payload, one of them wrong; EstadoFactura/EstadoPresupuesto are also re-declared locally in ClienteFichaPage.tsx:64-65 instead of imported from the stores.
- Heavy duplication across big pages: fmt()/fmtFecha() re-implemented in 8+ files (FacturasListPage.tsx:44, PresupuestosListPage.tsx:44, DocumentoEditor.tsx:66, ModalAñadirAlbaran.tsx:73, DashboardPage.tsx:47-62, SeguimientoPage.tsx:70, SeguimientoFichaPage.tsx:114, PagosObra.tsx:36); FacturaPage/PresupuestoPage are ~80% copy-paste (autosave, PDF blob download, send-email modal, historial); facturas.store/presupuestos.store are near-identical; Campo/Input field wrappers re-invented per page (ConfigPage.tsx:175-213, SeguimientoFichaPage.tsx:121-137, SetupPage.tsx:199-236).
- 14 window.alert() calls for error feedback while a global toast for the same error already fires from the axios interceptor — double, inconsistent error UX (e.g. ClienteFichaPage.tsx:158,175,186,226,240; SeguimientoFichaPage.tsx:266,350; FacturasListPage.tsx:105).
- Deep-clone-per-keystroke: ConfigPage set() does JSON.parse(JSON.stringify(config)) on every input change, including when config.documentos.template_html holds up to 512KB of HTML — ConfigPage.tsx:741-748.
- Accessibility gaps: only 8 aria-* attributes in the whole app (Toaster, Modal close, Layout menu button); Modal has no role='dialog', aria-modal, or focus trap (Modal.tsx:71-88) and every open modal registers its own document Escape listener so stacked modals close together; clickable non-interactive divs without keyboard support: accordion headers (ClienteFichaPage.tsx:405), document rows (SeguimientoFichaPage.tsx:566-576,595-605), profile cards (SetupPage.tsx:156-172), table rows (FacturasListPage.tsx:209-212); most inputs lack htmlFor/id association (labels in ClienteModal, ConfigPage, SeguimientoFichaPage Campo).
- Silent error swallowing hides data problems: linked presupuestos/facturas/pagos fetches .catch(() => set…([]/0)) so a failing endpoint renders as 'no documents' (SeguimientoFichaPage.tsx:206-227, ClienteFichaPage.tsx:73-89); FacturaPage.handleEliminar only console.errors (FacturaPage.tsx:245-253).
- Dead dependencies: react-hook-form, zod, @hookform/resolvers, lucide-react and date-fns are in package.json but have zero imports under src (verified by grep) — bundle/maintenance dead weight and a sign the validation strategy was abandoned; form validation today is required-name-only with no email/phone/CIF format checks anywhere (ClienteModal.tsx:69, SetupPage.tsx:404-410).
- Invoice-close business rules enforced only client-side (frontend decides material/mano-de-obra requirements; backend only checks estado='borrador' per facturas.store.ts:39-40 header note) — any other client or race can close non-conforming invoices.
- FacturaPage.handleImprimir relies on window.open + load-event print for a PDF tab, which popup blockers and PDF viewers often break (FacturaPage.tsx:222-227); handleGuardar/ejecutarCierre chain can throw an unhandled rejection from button onClick since handleGuardar has try/finally without catch (FacturaPage.tsx:149-158,182-188).
- SeguimientoFichaPage renders form inputs from `form.nombre` etc. before the actual→form sync effect runs (initial {} means value=undefined→controlled/uncontrolled warning risk on first edit render) — SeguimientoFichaPage.tsx:163,185-203,448.

### 3.4 · Plataforma y despliegue (Windows + Docker)

Vantek ships two deployment paths. Windows: install.ps1 (run once as admin) provisions portable Node 24 + NSSM into C:\Vantek, registers a "VANTEK" service that runs launcher/launcher.js; the launcher spawns the compiled Express backend and self-updates by polling GitHub Releases (HeRoDaRu/vantek) for a Vantek-*.zip asset, downloading it to logs/update.zip, extracting it with PowerShell Expand-Archive directly over the install root, rewriting version.json, and calling process.exit(0) so NSSM restarts it — gated by a config maintenance window (default 15:00-16:00), >=15 min user idle (GetLastInputInfo via PowerShell), and a dirty-draft check against GET /api/status/draft, with frontend-triggered applies via data/update-state.json. Linux: a 6-stage Dockerfile builds backend (node:24-bookworm-slim + system Chromium, non-root via gosu) and nginx frontend containers wired by docker-compose with named volumes; no auto-update, updates are image rebuilds. CI (ci.yml, Ubuntu) type-checks and tests both workspaces and gates release.yml, which on a v* tag builds everything on windows-latest, force-compiles better-sqlite3 for Node 24 ABI 137, bundles Chromium, and publishes Vantek-<version>.zip. The updater performs no integrity, size, checksum, or signature verification of downloads, and has no staging directory, no backup, and no rollback.

**Inventario de módulos**

| | |
| --- | --- |
| launcher/launcher.ts | Windows-only supervisor: spawns backend (dist/index.js) with PUPPETEER_CACHE_DIR=<root>/puppeteer, checks GitHub Releases at boot + 60s scheduler + fs.watchFile on data/update-state.json, downloads/extracts updates and exits 0 for NSSM restart; emails errors via nodemailer |
| install.ps1 | one-time elevated Windows installer: reuses in-zip payload (robocopy, excluding node/ and tools/) or downloads latest release, provisions portable Node 24.x and NSSM 2.24 locally, then runs install-service.bat; zip-slip-guarded .NET ZipFile extraction with Expand-Archive fallback, retry/backoff downloads |
| start.bat | foreground manual start (node\node.exe launcher\launcher.js) without NSSM; creates data/logs/config dirs |
| launcher/install-service.bat | registers NSSM service VANTEK (AppDirectory=install root, AppRestartDelay 5000ms, 5MB rotating stdout/stderr logs, SERVICE_AUTO_START) and starts it |
| launcher/uninstall-service.bat | nssm stop + remove confirm; leaves files/node/tools in place |
| Dockerfile | multi-stage: deps (npm ci workspaces, PUPPETEER_SKIP_DOWNLOAD), frontend-build (Vite), backend-build (tsc), production-deps (npm ci --omit=dev), backend runtime (Debian chromium + gosu, PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium, entrypoint script), nginx stage serving frontend dist |
| docker-compose.yml | backend (expose 3000, healthcheck GET /api/status, restart unless-stopped) + frontend nginx (host 8080:80, depends_on healthy backend, pdfs volume ro); named volumes vantek-data/pdfs/config/logs on bridge network vantek-internal |
| nginx.conf | serves SPA with hashed-asset 1y immutable cache, /pdfs/ alias to the ro volume (no auth), /api/ proxy to backend:3000 with 120s timeouts and 20M body limit, SPA fallback to index.html |
| backend-entrypoint.sh | root entrypoint: mkdir data/pdfs logs config, first-boot seeds app.config.json (stamps current year into invoice numbering) and profile.config.json from templates without overwriting, chown -R node, exec gosu node "$@" |
| Makefile | Docker-wrapped dev workflow (node:24 container): install, build-sqlite (better-sqlite3 from source), test/test-list per workspace, deps-update targets calling scripts/update-deps.sh |
| .github/workflows/ci.yml | Ubuntu gate on PR->main, push->dev, workflow_call: npm ci, compile better-sqlite3 from source, tsc --noEmit both workspaces, npm test; concurrency keyed per workflow+ref |
| .github/workflows/release.yml | on v* tag (after CI gate passes via workflow_call): windows-latest build; deletes package-lock.json and npm install (npm/cli#4828 workaround), downloads Puppeteer Chromium into .puppeteer-cache, npm run build, npm prune --omit=dev, force-builds and smoke-tests better-sqlite3 (ABI 137), assembles release/ (app dist, node_modules, launcher.js, service bats, config+doc templates, version.json, start.bat, install.ps1, puppeteer/), 7z to Vantek-<v>.zip, publishes via softprops/action-gh-release |
| version.json | single source of installed version ({"version":"1.5.0"}); rewritten by release.yml at build and by launcher after each applied update |
| scripts/update-deps.sh | bulk dependency bumper (safe within-major or --majors via npm-check-updates), pins tesseract.js/typescript/vitest, regenerates the lockfile on Linux (hence the Windows release lock deletion) |
| config/app.config.template.json | defaults incl. sistema.actualizacion { hora_inicio 15:00, hora_fin 16:00, inactividad_minutos 15 } (lines 54-58) |

**Convenciones y patrones**

- Windows update flow: boot-time check (launcher.ts:625-658, applies any pending logs/update.zip before starting the server) + 60s scheduler gated on window/idle/phase (launcher.ts:535-569) + manual apply requests observed through data/update-state.json via fs.watchFile (launcher.ts:576-621); download picks the first release asset matching Vantek-*.zip (launcher.ts:431), streams to logs/update.zip following only 301/302 redirects (launcher.ts:269-287), extract = Expand-Archive -Force straight onto the install root (launcher.ts:292-315, 475), then version.json rewrite + process.exit(0) so NSSM restarts the service (launcher.ts:476-485)
- Restart-safety heuristics instead of transactions: dirty-draft HTTP probe fails open to 'no draft' (launcher.ts:378), idle detection via GetLastInputInfo through PowerShell -EncodedCommand fails open to Infinity/always-idle (launcher.ts:343-359), maintenance window compared as minutes-of-day (launcher.ts:501-514)
- Zero-dependency launcher principle: raw https/http modules, PowerShell for unzip and Win32 calls, setInterval scheduler, file-based IPC (launcher.ts:44-49); errors are logged to logs/launcher.log, surfaced in update-state.json, and emailed via SMTP config (launcher.ts:217-246); every failure path reverts phase and keeps running the current version
- Survivor-directory convention: node/ and tools/ are provisioned once by install.ps1 and never shipped in the update zip (release.yml packaging list; install.ps1 robocopy /XD node tools at :243), so Expand-Archive -Force only overwrites app payload
- Native-module ABI discipline: better-sqlite3 always compiled from source for Node 24/ABI 137 with explicit existence + load smoke tests before packaging (ci.yml:58-64, release.yml:123-152, 188-199, 224-229); install.ps1 resolves latest Node 24.x with pinned fallback and documents the major-version coupling (install.ps1:165-189)
- Docker path: config seeded idempotently on first boot from *-default templates, root->gosu node privilege drop (backend-entrypoint.sh:40-61), system Chromium instead of Puppeteer download (Dockerfile:61-72), nginx fronting API/SPA/PDFs with backend never exposed to the host (docker-compose.yml:19-20)
- CI/release gating: release.yml refuses to package unless ci.yml (types + both Vitest suites on Ubuntu) passes via workflow_call (release.yml:36-44); manual workflow_dispatch runs produce a 7-day artifact instead of a published release (release.yml:246-252)
- Defensive PowerShell installer style: $ErrorActionPreference=Stop, TLS 1.2 forced, retry-with-backoff downloads, zip-slip check in fast extraction, robocopy exit-code >=8 treated as failure (install.ps1:97-163, 243-244)

**Puntos de atención observados**

- No integrity/authenticity verification of updates anywhere: downloadFile writes whatever bytes arrive with no HTTP status check, no Content-Length/size comparison, no SHA256, and no signature (launcher.ts:269-287, 443-448); a 404/403-rate-limit body or truncated transfer is saved as logs/update.zip and treated as 'listo_para_aplicar'. install.ps1 likewise verifies nothing for the release, Node, or nssm.cc downloads (install.ps1:259, 275, 300) — nssm.cc is a notable unauthenticated-binary supply-chain point.
- Protocol bug makes hasDirtyDraft throw instead of resolve: it calls https.get on 'http://localhost:3000/api/status/draft' (launcher.ts:366-368), which raises ERR_INVALID_PROTOCOL synchronously inside the Promise executor, so every await hasDirtyDraft() rejects. In the scheduler (launcher.ts:551, 561) that is an unhandled rejection (process crash on modern Node); at boot (launcher.ts:630, 650) it propagates to main().catch -> exit(1) -> NSSM 5s restart loop while an update is available in the window. The dirty-draft guard effectively never works.
- In-place extraction over a running install with no staging, no backup, no rollback: extractZip targets ROOT while the spawned backend is still running (launcher.ts:475 vs startServer at :717), so locked files (e.g. the loaded better_sqlite3.node) can make Expand-Archive fail midway, leaving a mixed old/new tree; the catch only reverts the state enum and deletes the zip (launcher.ts:486-496). If a fully-applied new version fails to boot there is no health check or revert — version.json already claims the new version (launcher.ts:476) and isNewerVersion blocks reinstalling it, so the client stays broken until the next release.
- Idle gating is meaningless under the actual deployment: NSSM runs the launcher in Session 0 where GetLastInputInfo cannot see the interactive user's input, and any PowerShell failure returns Infinity 'to not block updates' (launcher.ts:320, 357-359). Combined with the default maintenance window of 15:00-16:00 — mid business hours (launcher.ts:503-504, config/app.config.template.json:55-56) — and the broken draft check above, the server can be killed via process.exit(0) mid-use, aborting in-flight requests (only drafts are ever checked, never active HTTP work).
- Partial-download / hang handling gaps: downloadFile has no request or socket timeout, so a stalled transfer pins phase='descargando' forever and the scheduler skips all future cycles (launcher.ts:537) until the service restarts; only 301/302 redirects are followed (launcher.ts:275) so a 307/308 response body would be saved as the zip; a truncated-but-cleanly-closed response resolves as success. Corrupt zips are only detected later when Expand-Archive fails — on the live directory.
- Update-state file IPC is racy and leaky: launcher and backend both write data/update-state.json with non-atomic fs.writeFileSync (launcher.ts:196-204) polled at 1s (launcher.ts:580), risking torn reads/lost apply_requested flags; the full GitHub release JSON is stashed on state as _release (launcher.ts:424) and serialized into update-state.json by every subsequent writeState, bloating the file and exposing it to whatever the backend serves. The scheduler and the watcher can also run download/apply concurrently — the watcher has no phase-in-progress guard (launcher.ts:576-618 vs :537).
- Error-email spam: every failed GitHub check sends an email (launcher.ts:399-403), and during the update window the scheduler re-checks every 60s from 'idle'/'sin_update' (launcher.ts:546-548); an offline day or unauthenticated API rate-limiting (60 req/h/IP, no token in fetchLatestRelease launcher.ts:250-267) can generate dozens of identical emails.
- Release builds are not the tree CI tested: release.yml deletes package-lock.json and runs a fresh npm install on Windows (release.yml:91-95, documented npm/cli#4828 workaround), so shipped dependency versions can drift from what ci.yml validated with npm ci — an unpinned supply-chain window at exactly the artifact that auto-installs on client machines.
- release.yml copies install.ps1 as the release README: Copy-Item 'install.ps1' "$rel\README.md" (release.yml:219) ships a PowerShell script body as README.md — either a mistake or a confusing hack.
- Unauthenticated PDF exposure on the Linux path: nginx serves every generated invoice/quote PDF at /pdfs/ with no auth (nginx.conf:23-29, ro volume mount docker-compose.yml:43); anyone on the LAN who can guess/enumerate filenames can read client invoices.
- Minor: maintenance windows crossing midnight are impossible (dentroDeVentana requires inicio<fin, launcher.ts:512-513); httpModule permits silent https->http downgrade if a redirect ever points to http:// (launcher.ts:155-157); zip paths are single-quote-interpolated into a PowerShell command (launcher.ts:299) — safe only while ROOT contains no quote; launcher's Expand-Archive path lacks the explicit zip-slip guard install.ps1 has (install.ps1:145-147); update.zip is stored under logs/ (launcher.ts:66); no disk-space check before download/extract; possible Puppeteer-vs-Debian-chromium version drift in Docker (Dockerfile:61-72).

### 3.5 · Calidad (tests, tipos, dependencias, CI)

Vantek's quality infrastructure is thin but not absent: CI (.github/workflows/ci.yml) genuinely type-checks both apps and runs backend+frontend vitest suites on PRs to main, pushes to dev, and as a release gate, and all four tsconfigs set strict:true. However, test coverage is narrow (4 of 14 backend services tested, zero route/HTTP tests, 3 small frontend test files, no coverage tooling), there is no linting or formatting configuration anywhere, and dependency hygiene is poor — the manifests and lockfile pin multiple versions that do not exist upstream (typescript 6.0.3, lucide-react 1.23.0, cors 2.8.6, uuid 14.0.1, nodemailer 9.0.3), making installs unreproducible against the real npm registry. Documentation drifts from reality on the Node version (README says 22, everything else uses 24) and the release asset name, and release.yml ships install.ps1 as the release's README.md.

**Inventario de módulos**

| | |
| --- | --- |
| app/backend/tests/facturas.service.test.ts | factura numbering, albarán→factura line transfer with margin, state-transition guards (100 lines) |
| app/backend/tests/seguimiento.service.test.ts | fuzzy client/agrupador dedup, cancellation rules, entregada PDF guard, forward-only doc sync (174 lines; broadest suite) |
| app/backend/tests/pagos.service.test.ts | advance-payment ledger: fixed/percentage payments, totals, delete, 404 on unknown obra |
| app/backend/tests/reset.service.test.ts | data wipe preserves usuarios and schema version (single test) |
| app/backend/tests/migrate.test.ts | migrations reach v9, idempotency, spot-checks of v7/v8/v9 schema objects |
| app/backend/tests/setup.ts | per-file throwaway VANTEK_ROOT temp dir, config seeding from templates, runs migrations before each test file |
| app/backend/tests/helpers/db.ts | fixture builders (crearCliente/crearAgrupador/crearTrabajo/crearAlbaranConLinea) and limpiarBd (91 lines) |
| app/frontend/src/store/config.store.test.ts | profile translator t() resolution/fallback |
| app/frontend/src/store/toast.store.test.ts | toast queue, auto-expiry with fake timers, dismissal |
| app/frontend/src/components/UI/Badge.test.tsx | estado→label/CSS-class mapping incl. all 11 seguimiento states |
| app/backend/vitest.config.ts | node env, pool:forks + isolate:true, manual aliases mirroring tsconfig paths, tests/**/*.test.ts |
| app/frontend/vitest.config.ts | jsdom env, React plugin, manual aliases, src/**/*.test.{ts,tsx}, setup registers jest-dom |
| app/backend/tsconfig.json | strict, CommonJS/node resolution, ignoreDeprecations '6.0', include limited to src/** |
| app/frontend/tsconfig.json | strict + noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch, bundler resolution, noEmit |
| launcher/tsconfig.json | strict, CommonJS, compiles single launcher.ts in place |
| package.json | npm workspaces root; engines node>=24; only devDep typescript ^6.0.3; test script chains both workspaces |
| app/backend/package.json | express 5/better-sqlite3/puppeteer/zod stack; vitest; no lint scripts, no engines |
| app/frontend/package.json | React 19/Vite 8/zustand/tesseract.js stack; vitest+RTL+jsdom; no lint scripts, no engines |
| .github/workflows/ci.yml | Node 24, npm ci, better-sqlite3 built from source, tsc --noEmit for both apps, npm test; triggers: PR→main, push→dev, workflow_call, dispatch |
| .github/workflows/release.yml | Windows packaging gated on ci.yml; builds, prunes dev deps, compiles/verifies better-sqlite3 native binary, zips Vantek-<version>.zip |
| README.md | dev/prod instructions; claims Node 22+ and asset name Vantek-release.zip (both stale) |
| install.ps1 | Windows installer; -NodeVersion default '24' (resolves latest 24.x) despite its own docstring saying Node 22 |

**Convenciones y patrones**

- Backend tests are service-level integration tests against a real SQLite DB: vitest pool:'forks' + isolate:true with a fresh mkdtemp VANTEK_ROOT and full migration run per test file (app/backend/vitest.config.ts:45-51, tests/setup.ts:35-56); shared fixture helpers in tests/helpers/db.ts
- Error handling convention surfaced in tests: services throw errors carrying statusCode (e.g. 404 asserted in tests/pagos.service.test.ts:53-60); Spanish domain language throughout (facturas/albaranes/seguimiento)
- TS path aliases (@db, @services, @utils, ...) defined in tsconfig paths and manually duplicated in both vitest.config.ts files with explicit 'MUST stay in sync' comments — convention is manual synchronization rather than vite-tsconfig-paths
- TS strictness: strict:true in all four tsconfigs; frontend additionally enables noUnusedLocals/noUnusedParameters/noFallthroughCasesInSwitch (app/frontend/tsconfig.json:16-18); backend/launcher use legacy CommonJS + moduleResolution 'node' kept alive via ignoreDeprecations '6.0'; skipLibCheck everywhere; no noUncheckedIndexedAccess anywhere
- CI is the only quality gate and does run tests: type-check (tsc --noEmit both apps) + npm test on PR→main, push→dev, and via workflow_call as a release gate (ci.yml jobs.test); release.yml refuses to package if tests fail (release.yml 'needs: test')
- Native-module discipline: better-sqlite3 is always compiled from source and its binding verified with explicit failure messages in both CI and release packaging (ci.yml 'Compilar better-sqlite3 desde fuente', release.yml verification steps)
- Heavy header-comment documentation convention: every config/test file opens with a WHAT IT DOES / RELATIONSHIPS / NOTES banner
- Frontend state managed with zustand stores tested by direct setState/getState manipulation (src/store/*.test.ts); component tests use React Testing Library + jest-dom
- No linting or formatting infrastructure at all: no ESLint/Prettier/Biome/editorconfig config files, no lint deps in any package.json, no lint script, no lint step in CI

**Puntos de atención observados**

- Fabricated/nonexistent dependency versions pinned in manifests AND lockfile — installs are unreproducible against the real npm registry: typescript ^6.0.3 in all three package.json files (root package.json:19, app/backend/package.json devDependencies, app/frontend/package.json devDependencies; stable TypeScript is 5.x), lucide-react ^1.23.0 (app/frontend/package.json; lucide-react has only ever published 0.x), cors ^2.8.6 (app/backend/package.json; latest published is 2.8.5), uuid ^14.0.1 + @types/uuid ^11.0.0 (app/backend/package.json; uuid tops out around 13.x and bundles its own types), nodemailer ^9.0.3 + @types/nodemailer ^8.0.1 (app/backend/package.json; real majors ~7.x / types 6.x). package-lock.json resolves these exact versions (typescript 6.0.3, lucide-react 1.23.0, cors 2.8.6, uuid 14.0.1, nodemailer 9.0.3), so the lock cannot have come from the public registry. Also inflated: puppeteer ^25.3.0, jsdom ^29.1.1, date-fns ^4.4.0, and GitHub Actions actions/checkout@v6 / setup-node@v6 / upload-artifact@v6 (ci.yml:44,48; release.yml)
- Node version documentation contradiction: root package.json engines says node >=24 (package.json:26-28) and CI/Dockerfile/installer default all use Node 24 (ci.yml:47-50, Dockerfile:7, install.ps1:92 default '24'), but README.md:24 says 'Node.js 22+', README.md:59 says the installer downloads 'Node.js 22 portable', and install.ps1's own docstring at install.ps1:46 says 'Descarga Node.js 22 portable' — contradicting its default one screen below. A dev on Node 22 satisfies README but violates engines and gets an ABI-mismatched better-sqlite3 expectation (ABI 137 = Node 24)
- Release packaging bug: release.yml:219 'Copy-Item install.ps1 "$rel\README.md"' ships the PowerShell installer's content as the release's README.md — almost certainly meant to copy the real README.md
- Zero HTTP/route-level tests: all 9 routers (app/backend/src/routes/albaranes|clientes|config|dashboard|facturas|pagos|presupuestos|seguimiento|setup.router.ts) are untested; no supertest anywhere in package-lock.json, so request validation, status codes, and the errorHandler middleware (app/backend/src/middleware/errorHandler.ts) have no automated coverage
- 10 of 14 backend services untested: presupuestos.service.ts (425 lines — the quote-side mirror of the tested facturas logic), pdf.service.ts (443 lines, Puppeteer/Chromium fallback logic), albaranes.service.ts (326), setup.service.ts (286), dashboard.service.ts (279), email.service.ts (259), clientes.service.ts (201), trabajos.service.ts (136), errores.service.ts (113), agrupadores.service.ts (92). The deployment-critical auto-update launcher (launcher/launcher.ts, ~433+ lines) also has no tests
- Frontend coverage is token: 3 test files total (config.store.test.ts, toast.store.test.ts, Badge.test.tsx); 6 other stores (clientes, dashboard, facturas, presupuestos, seguimiento stores in app/frontend/src/store/) and all 8 page areas (app/frontend/src/pages/Albaranes…Splash), including the tesseract.js OCR flow, are untested
- No linting or formatting at all: no ESLint/Prettier/Biome/.editorconfig config found anywhere in the repo (verified via find/grep across root, app/backend, app/frontend), no lint deps or scripts in any package.json, and ci.yml has no lint step — TS strict mode is the only static gate
- Backend tests are never type-checked: app/backend/tsconfig.json include is ["src/**/*"] (tsconfig.json:24) so tests/ is excluded; CI type-checks only via 'npx tsc --noEmit -p app/backend/tsconfig.json' (ci.yml:66) and vitest transpiles without checking, so type errors in test code go undetected (e.g. 'catch (e: any)' at tests/pagos.service.test.ts:57)
- No coverage measurement anywhere: neither vitest.config.ts defines coverage (grep 'coverage' returns 0 hits in both), no thresholds, no coverage step in ci.yml — coverage breadth cannot regress-fail
- README asset-name drift: README.md:49, :58, :76, :97 all reference a 'Vantek-release.zip' asset, but release.yml (header comment and zip step) produces 'Vantek-<version>.zip'; only install.ps1:251 and launcher.ts:433 use the tolerant 'Vantek-*.zip' pattern — a user following the README literally looks for a file that does not exist
- engines field only at root: app/backend/package.json and app/frontend/package.json have no engines, and there is no .nvmrc/.node-version, so nothing enforces Node 24 when a workspace is used standalone; README.md:25 also says 'npm 10+' while Node 24 ships npm 11
- Alias-drift risk by design: backend vitest aliases (app/backend/vitest.config.ts:36-43) and frontend aliases (app/frontend/vitest.config.ts:38-46) manually duplicate tsconfig/vite paths with only a comment ('Aliases MUST stay in sync') guarding against divergence
- release.yml deletes package-lock.json on Windows and runs bare npm install (release.yml 'Instalar dependencias' step) — a documented npm/cli#4828 workaround, but it means shipped releases are built from unpinned dependency resolution, weakening the CI job's 'npm ci' integrity guarantee it claims to inherit

## 4 · Plan de remediación priorizado

Ocho fases ordenadas por relación valor/riesgo. Las fases 0–2 son de esfuerzo bajo y cubren los dos riesgos existenciales (facturas ilegales/duplicadas y pérdida irrecuperable de datos). Las 3–4 cierran la exposición en LAN y hacen fiable el actualizador. Las 5–6 son correcciones agrupables en releases normales. La 7 es trabajo de fondo con interés compuesto.

**Fase 0 · Correcciones de emergencia (horas cada una)**

### 0.1 · El comprobador de borrador del launcher está roto `CRÍTICO`

`launcher/launcher.ts:366` — `https.get` sobre una URL `http://` lanza `ERR_INVALID_PROTOCOL` de forma síncrona dentro del ejecutor de la promesa. Resultado: `hasDirtyDraft()` rechaza siempre, la protección «no actualizar con un borrador sucio» nunca funciona y el rechazo puede tumbar el *scheduler*.

```ts
// ANTES — launcher.ts:366
const req = https.get('http://localhost:3000/api/status/draft', …)

// DESPUÉS — usar el módulo http (ya importado) y proteger la llamada
import http from 'http';
const req = http.get('http://localhost:3000/api/status/draft', { headers:{…} }, …);
// y en el scheduler, envolver el await para no propagar un rechazo:
const sucio = await hasDirtyDraft().catch(() => false);
```

### 0.2 · Escrituras multi-sentencia sin transacción `ALTO`

`facturas.service.ts:288` y `presupuestos.service.ts:266` — `guardarLineas` hace `DELETE` y luego un bucle de `INSERT` sin transacción: un fallo a mitad del bucle deja el documento sin ninguna línea.

```ts
// DESPUÉS — envolver todo el borrado+inserción en una transacción atómica
const guardar = db.transaction((lineas) => {
  db.prepare('DELETE FROM factura_lineas WHERE factura_id = ?').run(factura_id);
  const stmt = db.prepare(`INSERT INTO factura_lineas (…) VALUES (…)`);
  lineas.forEach((l, idx) => stmt.run(uuidv4(), factura_id, …, idx));
  db.prepare(`UPDATE facturas SET updated_at = datetime('now') WHERE id = ?`).run(factura_id);
});
guardar(lineas);  // better-sqlite3 hace BEGIN/COMMIT y ROLLBACK ante excepción
```

### 0.3 · Migraciones no transaccionales `ALTO`

`db/migrate.ts:415-419` — `db.exec(migration.sql)` y el `INSERT` en `_migraciones` son pasos separados. Un fallo a mitad de una migración multi-sentencia (p. ej. la reconstrucción de tabla de la v5) deja el esquema a medias y se reintenta desde el principio en el siguiente arranque, con el servicio caído.

```ts
// DESPUÉS — migrate.ts, cada migración en su propia transacción
for (const migration of pending) {
  const aplicar = db.transaction(() => {
    db.exec(migration.sql);
    db.prepare('INSERT INTO _migraciones (version) VALUES (?)').run(migration.version);
  });
  aplicar();  // o queda intacta y se puede corregir sin dejar el esquema a medias
}
```

### 0.4 · Escritura de configuración no atómica `MEDIO`

`utils/config.ts:174` y `config.router.ts:73` — `fs.writeFileSync` directo sobre `app.config.json`, que guarda las credenciales SMTP **y** el contador legal de facturas. Un fallo o disco lleno a mitad corrompe ambos.

```ts
// DESPUÉS — escribir a tmp y renombrar (rename es atómico en el mismo volumen)
const tmp = APP_PATH + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
fs.renameSync(tmp, APP_PATH);
```

### 0.5 · El proceso servidor no está supervisado `ALTO`

`launcher.ts:691` — si el backend hijo cae, NSSM solo ve el *launcher*: el servicio figura «en ejecución» mientras la app está muerta. El comentario dice «NSSM reiniciará» pero NSSM supervisa al launcher, no al hijo.

```ts
// DESPUÉS — reiniciar el hijo desde el launcher con backoff
server.on('exit', (code) => {
  log(`El servidor terminó con código ${code}`);
  if (!cerrandoPorActualizacion) {
    const espera = Math.min(30000, 1000 * ++reintentos);
    log(`Reiniciando el servidor en ${espera}ms (intento ${reintentos})`);
    setTimeout(startServer, espera);
  }
});
```

**0.6 ·** Además, corregir `release.yml:219`, que publica el contenido de `install.ps1` como el `README.md` de la release (casi seguro se pretendía copiar el README real).

**Fase 1 · Legalidad de facturas y correctitud del dinero**

### 1.1 · Numeración por `COUNT(*)` → duplicados `ALTO`

`facturas.service.ts:104` — `siguienteNumeroFactura` cuenta facturas no-borrador del año. Al reabrir se limpia el número (`:487`) y al borrar una cerrada no hay guardia (`:553`). Escenario verificado: cerrar 0001 y 0002, borrar/reabrir 0001, el siguiente cierre vuelve a emitir «0002».

```ts
// DESPUÉS — numerar por MAX del año, nunca por COUNT, y blindar con UNIQUE
const row = db.prepare(
  `SELECT MAX(numero) AS maxn FROM facturas WHERE anio_numero = ?`).get(anio);
const siguiente = (row.maxn ?? 0) + 1;

// migración nueva — la BD garantiza la unicidad de la serie
CREATE UNIQUE INDEX ux_factura_serie ON facturas(anio_numero, numero)
  WHERE numero IS NOT NULL;
```

### 1.2 · Facturas emitidas son editables y borrables `ALTO`

`facturas.service.ts:282,553` — `guardarLineas` y `eliminarFactura` no comprueban el estado. Una factura `cerrada`/`pagada` (con número legal asignado) puede modificarse o borrarse por API.

```ts
// DESPUÉS — guardia de inmutabilidad en el servidor
function exigirBorrador(id) {
  const { estado } = db.prepare('SELECT estado FROM facturas WHERE id=?').get(id) ?? {};
  if (estado !== 'borrador') { const e = new Error('Factura emitida: no editable'); e.statusCode = 409; throw e; }
}
// llamar exigirBorrador(id) al inicio de guardarLineas y eliminarFactura.
// Para correcciones, usar la reapertura (nuevo número al re-cerrar) o una factura rectificativa.
```

### 1.3 · Año de serie desde el reloj, no desde la fecha `ALTO`

`facturas.service.ts:439` — `const anio = new Date().getFullYear()` al cerrar. Una factura de diciembre cerrada en enero cae en la serie del año nuevo; además el número impreso no lleva el año, así que puede colisionar visualmente con el del año anterior.

```ts
// DESPUÉS — derivar el año de la fecha de la factura y mostrar el año en el número
const anio = new Date().getFullYear();
const anio = new Date(factura.fecha).getFullYear();
// y en la plantilla/serialización: mostrar `${anio_numero}-${numero}` (p. ej. 2026-0001)
```

### 1.4 · Anticipos deducidos por completo en cada factura `ALTO`

`facturas.service.ts:208-214` — `restante = total − SUM(obra_pagos del trabajo)`. Si un trabajo tiene varias facturas, el anticipo se resta entero en **todas**, infravalorando el restante.

```ts
// DESPUÉS — repartir el anticipo entre las facturas del trabajo (o marcar consumo).
// Opción mínima: deducir solo el anticipo aún no imputado a otras facturas.
const yaImputado = db.prepare(
  `SELECT COALESCE(SUM(anticipo_aplicado),0) AS s FROM facturas
   WHERE trabajo_id = ? AND id != ? AND estado != 'borrador'`).get(trabajo_id, id).s;
const anticipoDisponible = Math.max(0, anticipo_total - yaImputado);
const restante = totales.total - anticipoDisponible;
```

### 1.5 · Dinero en coma flotante sin redondeo `MEDIO`

`facturas.service.ts:94-102` — `calcularTotales` no redondea; base + IVA impresos pueden diferir del total impreso en 1 céntimo. Conviven dos métodos de redondeo (`toFixed` vs otro) y la misma operación se repite en frontend, dos servicios y SQL.

```ts
// DESPUÉS — una única util compartida (paquete de workspace) con redondeo explícito
const c = (n) => Math.round(n * 100) / 100;          // redondeo a céntimo
const subtotal = c(lineas.reduce((a,l)=>a + c(l.precio_unitario*l.cantidad), 0));
const iva = c(subtotal * (iva_porcentaje/100));
const total = c(subtotal + iva);                     // total = base + IVA por construcción
```

**1.6 ·** Mover al servidor las reglas de cierre (hoy en `FacturaPage.tsx`): impedir cerrar una factura vacía o de importe cero (`facturas.service.ts:431`).

**Fase 2 · Seguridad de los datos**

### 2.1 · Sin copia de seguridad de `vantek.db` `MEDIO` (impacto alto)

`db/connection.ts:38` — no hay backup automático en ninguna plataforma, y el único procedimiento documentado (`README-docker.md:59`) es una copia en caliente de la BD WAL, que puede salir corrupta. Usar la API de backup online de better-sqlite3 (segura con WAL).

```ts
// DESPUÉS — backup seguro y rotado; disparar a diario, antes de migrar,
// antes de que el launcher aplique un update y antes de reset-datos
export async function backupDb() {
  const dir = path.join(DATA_DIR, 'backups'); mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  await getDb().backup(path.join(dir, `vantek-${stamp}.db`));   // WAL-safe
  // rotar: conservar las N más recientes
}
```

### 2.2 · Sin apagado ordenado `MEDIO`

`index.ts:178` — `closeDb()` es código muerto, no hay manejadores de señal y el WAL no se checkpointea al parar. En Docker, Node corre como PID 1, así que `docker stop` siempre acaba en SIGKILL con el WAL abierto.

```ts
// DESPUÉS — index.ts: cierre ordenado
const server = app.listen(PORT, …);
for (const sig of ['SIGTERM','SIGINT']) process.on(sig, () => {
  server.close(() => { getDb().pragma('wal_checkpoint(TRUNCATE)'); closeDb(); process.exit(0); });
});
// docker-compose.yml: añadir `init: true` al servicio backend (sin cambiar la imagen)
```

**2.3 ·** Proteger `reset-datos` (`config.router.ts:140`) con backup previo automático y confirmación en servidor. **2.4 ·** Limpieza: acotar la tabla `errores`, rotar `launcher.log`, borrar PDFs huérfanos al purgar versiones (hoy solo se borran filas de BD; `data/pdfs/` crece sin límite).

**Fase 3 · Endurecimiento de seguridad (sin cambiar arquitectura)**

### 3.1 · Sin autenticación en la API `ALTO`

`index.ts:114` — ningún endpoint está protegido, incluidos «borrar todos los datos» y la escritura de config, mientras la app es alcanzable por LAN. El esquema ya tiene una tabla `usuarios` con `password_hash` sin usar. Basta una contraseña compartida con cookie de sesión, aplicada por un middleware Express.

```ts
// DESPUÉS — un único middleware protege todo /api (o al menos config/reset/pdfs)
app.use('/api', (req, res, next) => {
  if (req.path === '/setup/status' || req.session?.auth) return next();
  return res.status(401).json({ error: 'No autenticado' });
});
// En Docker: enrutar /pdfs por el backend (location interno en nginx) para que
// el mismo middleware cubra los PDFs, hoy servidos sin auth (nginx.conf:23).
```

### 3.2 · Contraseña SMTP en claro hacia el navegador `ALTO`

`config.router.ts:63` — `GET /api/config/app` devuelve `getAppConfig()` tal cual, incluida `email.smtp.pass`, sin auth. Redactarla en salida y tratarla como *write-only*.

```ts
// DESPUÉS — redactar en GET; conservar el valor guardado si el PUT trae el placeholder
const cfg = structuredClone(getAppConfig());
if (cfg.email?.smtp?.pass) cfg.email.smtp.pass = '__STORED__';
res.json(cfg);
// en PUT: si pass === '__STORED__', mantener la contraseña existente.
```

### 3.3 · Update sin verificación de integridad (RCE) `ALTO`

`launcher.ts:463` — se aplica un ZIP de GitHub sin comprobar hash ni firma. Combinado con 3.1 y 3.4, es una cadena realista de ejecución remota de código en los equipos Windows.

```ts
// DESPUÉS — release.yml emite SHA256SUMS junto al zip; el launcher lo verifica
const esperado = (await fetch(sumsUrl)).match(/^(\w{64})/)[1];
const real = crypto.createHash('sha256').update(fs.readFileSync(TMP_ZIP)).digest('hex');
if (real !== esperado) throw new Error('Hash del update no coincide — abortando');
// crypto es nativo → se respeta el principio de launcher sin dependencias.
```

### 3.4 · Lectura de fichero arbitrario en el motor de PDF `ALTO`

`pdf.service.ts:119-139` — `logoSrc` lee cualquier ruta de disco de la config y la incrusta en el PDF. Con la escritura de config sin auth, permite exfiltrar ficheros locales. Restringir a `CONFIG_DIR`.

```ts
// DESPUÉS — resolver y confinar bajo CONFIG_DIR; rechazar rutas que se escapen
const abs = path.resolve(CONFIG_DIR, v);
if (!abs.startsWith(path.resolve(CONFIG_DIR) + path.sep)) return '';
if (!fs.existsSync(abs)) return '';
// (los data: URI siguen permitidos, que es el caso habitual del logo subido)
```

**3.5 ·** Verificar/pin de las descargas de Node y NSSM en `install.ps1` (checksums). **3.6 ·** Puppeteer con `--no-sandbox` solo en el contenedor Docker; en Windows quitarlo (`pdf.service.ts:383`).

**Fase 4 · Robustez del actualizador (Windows)**

Rehacer la **secuencia**, no el diseño: **descargar → verificar hash → extraer a un directorio de *staging* → comprobar borrador sucio → parar el hijo servidor → respaldar árbol actual (+ BD) → intercambiar → reiniciar**, conservando el árbol anterior para un *rollback* de un intento si la nueva versión no arranca. Hoy el ZIP se extrae sobre la instalación en marcha (`launcher.ts:475`): módulos nativos bloqueados (`better_sqlite3.node`) pueden hacer fallar la extracción a mitad y dejar un árbol de versiones mezcladas sin vuelta atrás.

- **Timeouts y comprobación de estado HTTP** en `downloadFile` (`launcher.ts:269`): hoy un cuerpo 403 de *rate-limit* se guarda como `update.zip` y una descarga colgada fija `phase='descargando'` para siempre. Seguir también 307/308, no solo 301/302.
- **Ventana de mantenimiento por defecto** (`app.config.template.json`): cambiar de 15:00–16:00 (media jornada) a madrugada, y permitir ventanas que crucen medianoche. La detección de inactividad no funciona bajo servicio en Sesión 0, así que el gate real es el borrador + la ventana.
- **Anti-spam de emails** (uno por tipo de fallo y día) y dejar de serializar el JSON completo de la release en `update-state.json`.
- **Dejar de borrar `package-lock.json`** antes del build de release (`release.yml:91`): lo que se publica se construye con una resolución de dependencias que CI nunca probó. Resolver el issue npm/cli#4828 actualizando npm en el *runner*.

**Fase 5 · Barrido de bugs verificados (pequeños, agrupables)**

### 5.1 · Autosave guarda datos obsoletos `MEDIO`

`FacturaPage.tsx:139-145` y `PresupuestoPage.tsx:107` — el `setInterval` captura `lineas` del render en que se montó el efecto, pero las dependencias son solo `[actual?.id, actual?.estado]`: los borradores se autoguardan con las líneas **originales**, nunca con las ediciones del usuario. Esto además anula la protección de «borrador sucio» del launcher.

```ts
// DESPUÉS — leer las líneas vivas mediante una ref actualizada en cada render
const lineasRef = useRef(lineas);
useEffect(() => { lineasRef.current = lineas; });        // sin deps: cada render
useEffect(() => {
  if (!actual || !id || actual.estado !== 'borrador') return;
  autosaveTimer.current = setInterval(() => guardarBorrador(id, { lineas: lineasRef.current }), AUTOSAVE_MS);
  return () => { if (autosaveTimer.current) clearInterval(autosaveTimer.current); };
}, [actual?.id, actual?.estado]);
```

**Backend:** `GROUP BY` del listado de albaranes hace inalcanzable el estado «parcial» y duplica filas (`albaranes.service.ts:75`); el `GROUP_CONCAT` partido por comas descuadra nombres con comas (`:110`); el `errorHandler` ignora `err.statusCode`, así que 404 previstos se vuelven 500 y ensucian el log (`errorHandler.ts:46`); fechas de negocio derivadas de UTC se desplazan un día para usuarios españoles (`facturas.service.ts:238`); cerrar por `/cerrar` no sincroniza el seguimiento (`:431`); borrar un presupuesto con factura enlazada lanza un 500 de FK en vez de un 409 (`presupuestos.service.ts:403`); typo de config: `dias_factura_sin_cobrar` siempre vale 30 (`dashboard.service.ts:105`).

**Frontend:** `ConfigPage` sin `.catch` al cargar (spinner infinito); un preload de Tesseract fallido rompe el OCR de forma permanente (`useTesseract.ts:47`); la importación desde albarán usa el margen global en vez del del trabajo (`FacturaPage.tsx:353`); campos numéricos de config escriben `NaN`; el cero se convierte en null en el editor de líneas.

**Fase 6 · Higiene de plataforma y release**

Añadir un job Windows a la matriz de CI (el producto que se despliega en Windows solo se prueba en Ubuntu, `ci.yml:39`); añadir `.gitattributes` para que `backend-entrypoint.sh` sobreviva a checkouts en Windows (CRLF rompe la imagen Docker); guardar `pdf_path` solo como *basename* (hoy es dato dependiente de plataforma y disposición en la BD, `pdf.service.ts:443`); arreglar que `migrateConfig()` nunca se ejecuta en Docker (`config.ts:217`); reconciliar la identidad de versión (`version.json` 1.5.0 vs `package.json` 0.1.0) y la deriva del README (Node 22 vs 24, `Vantek-release.zip` vs `Vantek-<version>.zip`, y que `install.ps1` diga «abrir http://localhost» cuando Windows escucha en el 3000); revisar `.npmrc ignore-scripts=true`, que silenciosamente omite el aprovisionamiento de assets de OCR en dev local.

**Fase 7 · Mantenibilidad (continuo, en paralelo)**

- **Un paquete de workspace compartido** para los contratos de la API, las utilidades de dinero y las máquinas de estado. Hoy los tipos se mantienen a mano 2–3 veces y ya divergen (dos `AppConfig` distintos solo en el frontend); la máquina de estado de seguimiento existe duplicada. Es una librería de workspace, no un cambio de arquitectura, y es lo que hace que «una sola implementación del dinero» de la Fase 1 se sostenga.
- **Usar zod en el borde de las rutas.** Ya es dependencia y el `errorHandler` ya tiene una rama (muerta) para `ZodError`: el diseño lo pretendía. Unificar además las tres convenciones de manejo de errores en un middleware sensible a `statusCode`.
- **Deduplicar el par Factura/Presupuesto** (~80% de copia-pega en páginas, stores y envío de email) y extraer los `fmt()`/`fmtFecha()` reimplementados en 8+ ficheros; partir el `ConfigPage` de 1089 líneas; sustituir las 14 `window.alert` por el sistema de toast que ya se dispara.
- **Tooling y tests:** añadir ESLint + Prettier + un paso de lint en CI (hoy no hay ninguno); tipar los tests del backend (hoy excluidos del tsconfig); añadir tests de ruta con supertest y priorizar cobertura donde está el riesgo: numeración/cierre, redondeo del dinero, migraciones, el motor de plantillas de PDF y presupuestos (425 líneas sin test que reflejan la lógica ya testada de facturas). Eliminar o adoptar las dependencias declaradas sin uso.

## 5 · Catálogo completo de hallazgos verificados

78 hallazgos, agrupados por dimensión y ordenados por severidad. Cada uno incluye evidencia, la solución propuesta y la nota de verificación adversarial.

### 5.1 · Correctitud financiera (8: 0 crít · 5 alto · 2 medio · 1 bajo)

`ALTO` · `esfuerzo: medium` · `Correctitud financiera`

#### 1. Invoice numbers generated with COUNT(*) — duplicates and reuse of already-issued numbers

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:104`

**Evidencia y solución**

siguienteNumeroFactura (lines 104-114) computes the next number as COUNT(*) of non-borrador facturas for the year + 1. Any operation that removes a closed factura from that count causes the next cierre to re-issue an existing number: (a) reopening via cambiarEstado('borrador') clears numero/anio_numero (lines 484-490); (b) eliminarFactura deletes closed facturas with no estado guard (lines 553-558). Example: close 0001,0002,0003; reopen 0002; next close computes COUNT=2 -> assigns '0003', which already exists on another factura. The schema (migrate.ts, facturas table lines 160-172 and v7 anio_numero at line 341) has no UNIQUE(anio_numero, numero) index, so duplicates are silently persisted. Spanish law requires correlative, unique numbering; this produces both gaps and duplicates. Fix: derive the next number from MAX(CAST(numero AS INTEGER)) per anio (or a dedicated per-year sequence table), never from COUNT, and add a UNIQUE partial index on (anio_numero, numero) WHERE numero IS NOT NULL as a backstop.

> ℹ️ **Verificación adversarial:** Verified siguienteNumeroFactura uses COUNT(*) of non-borrador facturas (facturas.service.ts:104-114); reopening (allowed from all states via TRANSICIONES_FACTURA, nulls numero/anio_numero at lines 484-490) or unguarded eliminarFactura (lines 553-558, route DELETE /:id) shrinks the count so the next cierre reassigns an already-issued number, and migrate.ts has no UNIQUE index on (anio_numero, numero) to catch it. No compensating logic exists anywhere, and the fix is DB-local so it cannot conflict with the fixed architecture.

`ALTO` · `esfuerzo: medium` · `Correctitud financiera`

#### 2. Anticipos deducted in full on every factura of the same trabajo — 'restante' understated on multiple invoices

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:208`

**Evidencia y solución**

obtenerFactura computes anticipo_total = SUM(obra_pagos.importe) for the whole trabajo and restante = this factura's total - that sum (facturas.service.ts:208-214), and the PDF prints '-anticipo' and 'restante' as the amount due (pdf.service.ts:352-354). Nothing limits a trabajo to one factura: crearFactura is unrestricted and agregarLineasDesdeAlbaran creates a new borrador whenever the previous one was closed (facturas.service.ts:322-337). So after factura #1 already discounted the anticipo, factura #2 for the same trabajo discounts the exact same anticipo again — two legal documents each telling the client the advance covers them, understating the money owed. restante can also go negative and is printed as-is. Fix: allocate obra_pagos to a specific factura (or track applied amounts), or only deduct the unapplied remainder.

> ℹ️ **Verificación adversarial:** Confirmed in code: obtenerFactura (facturas.service.ts:208-214) subtracts the trabajo-wide SUM(obra_pagos.importe) from each individual factura's total; obra_pagos has no factura allocation column (migrate.ts:374-384); and agregarLineasDesdeAlbaran (facturas.service.ts:322-337) plus unrestricted crearFactura make multiple facturas per trabajo a designed flow, so every subsequent factura re-deducts the same anticipo and the PDF (pdf.service.ts:352-354) prints the understated/possibly negative restante verbatim.

`ALTO` · `esfuerzo: medium` · `Correctitud financiera`

#### 3. Issued (closed/paid) invoices are freely mutable and deletable through the API

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:282`

**Evidencia y solución**

guardarLineas (facturas.service.ts:282-308) and its route PUT /:id/lineas (facturas.router.ts:84-90) have no estado check: the lines — and therefore the legal amounts — of a factura in estado 'cerrada'/'entregada'/'pendiente_pago'/'pagada' can be replaced while it keeps its assigned numero. DELETE /:id (facturas.router.ts:171-174 -> eliminarFactura facturas.service.ts:553-558) deletes issued invoices without any guard. cambiarEstado additionally allows 'pagada' -> 'borrador' (TRANSICIONES_FACTURA line 464), wiping numero and fecha_cierre (lines 484-490). Only the frontend enforces readonly (FacturaPage.tsx:260 'const readonly = actual.estado !== borrador'), and the router header comment explicitly states 'Close business rules live in the frontend'. For a document with legal effect this must be enforced server-side: reject line edits and deletion for any factura with numero assigned, and gate reopening (Spanish practice requires a factura rectificativa instead of editing an issued one).

> ℹ️ **Verificación adversarial:** Confirmed in code: guardarLineas (service:282-308) and eliminarFactura (service:553-558) have zero estado/numero guards, PUT /:id/lineas and DELETE /:id pass through directly, TRANSICIONES_FACTURA:464 allows pagada->borrador wiping numero, and the router comment plus FacturaPage.tsx:260 confirm enforcement is frontend-only; additionally COUNT(*)-based numbering (service:104-114) means deleting an issued invoice causes duplicate numero assignment. Not critical because the app is a trusted local single-user deployment and the UI gates normal flows, but the server-side invariant for legally numbered invoices is genuinely absent.

`ALTO` · `esfuerzo: small` · `Correctitud financiera`

#### 4. guardarLineas does DELETE + INSERT loop without a transaction — partial failure destroys the document's amounts

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:288`

**Evidencia y solución**

In facturas.service.ts guardarLineas (lines 288-303) and presupuestos.service.ts guardarLineas (lines 266-283), all existing lines are deleted and then re-inserted one by one with no db.transaction wrapper (unlike crearFactura, which does use one). If any insert throws (e.g., NOT NULL violation on descripcion from a malformed payload) or the process dies mid-loop, the invoice/quote is left with zero or partial lines — silent loss of financial data on a document that may later be closed and issued. Fix: wrap delete+inserts in db.transaction, as crearFactura already does.

> ℹ️ **Verificación adversarial:** Confirmed both guardarLineas functions (facturas.service.ts:288, presupuestos.service.ts:266) do an auto-committed DELETE then untransacted per-row INSERTs, while sibling functions in the same files (crearFactura, crearPresupuesto, agregarLineasDesdeAlbaran) all use db.transaction; routers validate only Array.isArray, and the schema's NOT NULL/CHECK constraints on descripcion/cantidad/tipo make a mid-loop throw reachable, leaving the document with zero or partial lines.

`ALTO` · `esfuerzo: medium` · `Correctitud financiera`

#### 5. Series year taken from close-time clock, and printed numero carries no year — cross-year invoices share identical visible numbers

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:439`

**Evidencia y solución**

cerrarFactura uses new Date().getFullYear() (server local time at close) as the series year (facturas.service.ts:439-440), while the invoice date printed on the PDF is doc.fecha, a user-set field frozen at creation (facturas.service.ts:238). An invoice dated 31-12-2025 but closed on 02-01-2026 is numbered in the 2026 series, breaking correlativity relative to the expedition date. Worse, the PDF prints only doc.numero ('0001') with no year or series prefix (pdf.service.ts:317 'numero: doc.numero ?? ...'), so factura 0001/2025 and factura 0001/2026 are visually identical legal documents. Fix: render the number as e.g. `${anio_numero}-${numero}` (or store the full formatted number), and decide series year from the factura's fecha de expedicion, updating fecha at cierre if needed.

> ℹ️ **Verificación adversarial:** Verified in code: cerrarFactura uses new Date().getFullYear() for the series and never updates fecha; siguienteNumeroFactura returns only a zero-padded counter that resets per anio_numero; anio_numero is never passed to the PDF context and documento.html renders bare {{numero}}, so annual series produce visually identical invoice numbers across years and the series year can diverge from the printed expedition date.

`MEDIO` · `esfuerzo: small` · `Correctitud financiera`

#### 6. Backend allows closing (assigning a legal number to) an empty or zero-total factura

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:431`

**Evidencia y solución**

cerrarFactura only validates existence and estado === 'borrador' (facturas.service.ts:433-437); the route POST /:id/cerrar (facturas.router.ts:115-124) adds nothing. The header comment says close business rules live in the frontend (FacturaPage shows a 'No se puede cerrar' modal), so any direct API call, race with autosave, or future UI regression can consume a correlative series number on a factura with no lines or a 0,00 total — a numbered legal document that then forces a rectificativa or a gap. Fix: reject cierre server-side when the factura has no lines (and optionally when total <= 0).

> ℹ️ **Verificación adversarial:** Confirmed in code: cerrarFactura (facturas.service.ts:431-450) checks only existence and estado==='borrador', the router (routes/facturas.router.ts:115-124) adds nothing, and the router header explicitly documents that close business rules live only in the frontend (FacturaPage.tsx:165-171); since crearFactura allows zero-line drafts, one direct POST /:id/cerrar assigns a legal correlative number to an empty factura. Downgraded from the implied high: the autosave-race vector is not real (autosave writes borrador_data, not lines), the deployment is local single-user, and the count-based numbering plus the explicit reopen flow (which nulls numero) makes an accidental empty close recoverable without a permanent gap.

`MEDIO` · `esfuerzo: medium` · `Correctitud financiera`

#### 7. No rounding of money anywhere: printed base + printed IVA can disagree with printed total by 1 cent

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:94`

**Evidencia y solución**

calcularTotales (facturas.service.ts:94-102) returns raw floats: subtotal = sum(precio*cantidad), iva = subtotal*(pct/100), total = subtotal+iva, with no rounding to cents. The PDF then formats each figure independently (pdf.service.ts:341 per-line importe, 346-348 iva/subtotal/total via fmt -> toLocaleString 2 decimals). Verified example: one line 1,5 x 0,05 EUR -> subtotal 0.075 prints '0,08', IVA 21% 0.01575 prints '0,02', total 0.09075 prints '0,09'; the printed invoice shows 0,08 + 0,02 = 0,10 != 0,09. The same applies between the sum of printed line importes and the printed subtotal. The frontend duplicates the identical unrounded math (DocumentoEditor.tsx:297-299) and listarFacturas duplicates it in SQL (facturas.service.ts:150-154), so the defect is baked into every surface, including the legal PDF where the cuota de IVA must be arithmetically consistent with base and total. Fix: define one rounding policy (round subtotal to cents, compute IVA on the rounded base, round IVA to cents, total = rounded subtotal + rounded IVA — ideally in integer cents) and use it in service, SQL listing, PDF and frontend.

> ℹ️ **Verificación adversarial:** Confirmed in code: calcularTotales (facturas.service.ts:94-102), the SQL listing (150-154), the PDF (pdf.service.ts fmt at 85-87, used at 341/346-348) and the frontend (DocumentoEditor.tsx:297-299) all use unrounded float math with each figure formatted independently; the cited example (1.5 x 0.05, 21% IVA) reproduces exactly, printing 0,08 + 0,02 vs total 0,09 on the legal PDF. However, with the common case of integer quantities and 2-decimal prices the printed figures stay consistent, so the defect only manifests with fractional quantities yielding sub-cent amounts and is capped at ~1 cent, warranting medium not high.

`BAJO` · `esfuerzo: small` · `Correctitud financiera`

#### 8. Two different cent-rounding methods in use; toFixed(2) rounds half-cents down

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:395`

**Evidencia y solución**

Margin-derived unit prices use Number((coste * (1 + margen/100)).toFixed(2)) in the backend (facturas.service.ts:395) and frontend (DocumentoEditor.tsx:116 and :268), while pagos.service.ts uses Math.round((n + Number.EPSILON) * 100) / 100 (pagos.service.ts:42-44). toFixed is unreliable for money: verified (8.575).toFixed(2) === '8.57' and (1.005).toFixed(2) === '1.00' (binary float representation rounds half-cents down), whereas the EPSILON variant rounds them up. Result: prices computed from coste+margen can be one cent below the intended half-up rounding, and the app rounds the same conceptual quantity differently in different modules. Fix: extract a single shared redondear() (half-up on cents) and use it everywhere instead of toFixed.

> ℹ️ **Verificación adversarial:** Verified both rounding methods exist as cited (facturas.service.ts:395 and DocumentoEditor.tsx:116/268 use toFixed(2); pagos.service.ts:42-44 uses EPSILON half-up) and brute-force confirmed they diverge by one cent on ~65k realistic coste×margen combinations (e.g., 0.10 at 15% -> 0.11 vs 0.12). However, impact is capped at 1 cent per line with no cross-module mismatch (frontend and backend both use toFixed for margin prices, so they agree), and the EPSILON variant is itself not reliably half-up (redondear(8.575)=8.57), so this is a consistency/edge-case issue rather than a reconciliation-breaking bug.

### 5.2 · Seguridad (7: 0 crít · 4 alto · 2 medio · 1 bajo)

`ALTO` · `esfuerzo: large` · `Seguridad`

#### 9. No authentication on any API endpoint; app is LAN-reachable

`📍 /Users/david/TestPersonal/vantek/app/backend/src/index.ts:114`

**Evidencia y solución**

The Express app mounts every router (/api/clientes, /api/facturas, /api/presupuestos, /api/config, /api/setup, /api/dashboard, /api/seguimiento, /api/albaranes, /api/trabajos/:id/pagos) with zero authentication/authorization middleware. index.ts installs only helmet, cors, compression, json, urlencoded and a logger (lines 71-89); no auth guard exists anywhere in src (grep for auth/token/session finds only a `usuarios.password_hash` column in migrate.ts that is never used to protect routes). This is NOT localhost-only: docker-compose.yml:35-36 publishes the nginx frontend on host port 8080 (`"8080:80"`), nginx.conf:32-33 proxies /api/ to the backend, and nginx.conf:23-24 serves /pdfs/ directly. Any host on the LAN can read/modify all clients, invoices, quotes; overwrite config (PUT /api/config/app); wipe all business data + PDFs (POST /api/config/reset-datos with `{confirmar:'BORRAR'}`, config.router.ts:140); and trigger updates. Fix: add an auth layer (at minimum a shared secret / session login enforced by middleware before the /api routers, or bind the service to 127.0.0.1 and require an authenticated reverse proxy) — do not rely on 'binds locally' since the Docker deployment binds 0.0.0.0:8080.

> ℹ️ **Verificación adversarial:** Verified index.ts mounts every /api router with only helmet/cors/compression/json/logger and no auth middleware anywhere in src (grep confirms only an unused password_hash column); docker-compose.yml publishes 8080:80 on all interfaces and nginx.conf proxies /api/ to the backend with no auth_basic/allow-deny, while config.router.ts:140 lets any LAN client wipe all data with just {confirmar:'BORRAR'}. Rated high not critical because exploitation requires LAN adjacency, not internet exposure.

`ALTO` · `esfuerzo: medium` · `Seguridad`

#### 10. SMTP email credentials returned in plaintext by unauthenticated GET /api/config/app

`📍 /Users/david/TestPersonal/vantek/app/backend/src/routes/config.router.ts:63`

**Evidencia y solución**

GET /api/config/app returns `getAppConfig()` verbatim, and AppConfig.email.smtp includes `pass` (config.ts:118-120, app.config.template.json:31-39). The password is stored in plaintext on disk in config/app.config.json and is echoed in full by this endpoint. Because there is no auth (see finding above) and the endpoint is reachable via nginx on LAN port 8080, any LAN client can `curl http://<host>:8080/api/config/app` and read the mailbox SMTP username+password used to send invoices — a real credential-theft vector enabling mailbox takeover / outbound spoofing. The launcher also reads the same plaintext pass for error emails (launcher.ts:234). Fix: never return secrets from the read endpoint (strip/redact `email.smtp.pass`), require auth, and store the credential encrypted or in an OS credential store.

> ℹ️ **Verificación adversarial:** Verified config.router.ts:63-65 returns getAppConfig() verbatim (raw JSON.parse of app.config.json, no redaction), AppConfig.email.smtp.pass exists (config.ts:118-126, template:31-39), index.ts has zero auth middleware, and docker-compose/nginx expose /api on LAN port 8080 with no auth_basic — so any LAN client can curl the SMTP username+password. CORS/helmet do not block non-browser clients; downgraded from implied critical to high because exposure is adjacent-network only (LAN-local app, not internet-facing).

`ALTO` · `esfuerzo: medium` · `Seguridad`

#### 11. Unauthenticated arbitrary local file read via config-controlled logo/template path in PDF generation

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/pdf.service.ts:119`

**Evidencia y solución**

logoSrc() (pdf.service.ts:119-139) reads ANY file path taken from `empresa.logo` and base64-embeds its bytes into the generated PDF (mime falls back to application/octet-stream for non-images, so arbitrary binary/text is embedded). cargarPlantilla() (pdf.service.ts:180-189) likewise reads an arbitrary `documentos.template_path` file as the HTML template. Both values come straight from app.config.json, which is writable via the unauthenticated PUT /api/config/app (config.router.ts:68-76, no validation). Attack chain on the LAN: PUT config with `empresa.logo` = `C:\Vantek\config\app.config.json` (or the SQLite DB, or any system file) → POST /api/facturas/:id/pdf → GET the resulting PDF and decode the embedded base64 to exfiltrate the file. This turns the missing auth into full local-file disclosure (including the SMTP password file and DB). Fix: restrict logo/template paths to an allowlisted directory, reject absolute/`..` paths, and gate config writes behind auth.

> ℹ️ **Verificación adversarial:** Verified there is no auth anywhere: PUT /api/config/app (config.router.ts:68-76) writes attacker JSON verbatim, and both logoSrc (pdf.service.ts:124-135) and cargarPlantilla (pdf.service.ts:180-189) fs.readFileSync attacker-controlled paths with no allowlist/../absolute checks; the template_path vector actually renders arbitrary text-file contents into the retrievable PDF, confirming unauthenticated arbitrary local file read/disclosure. Downgraded to high because the app has zero auth by design (LAN attacker already reads all app data incl. the SMTP password via GET /api/config/app), the read escalates only to files outside the app, and the claim's logo base64 exfil mechanism does not actually work since page.pdf() renders images rather than embedding the data URI text.

`ALTO` · `esfuerzo: medium` · `Seguridad`

#### 12. Auto-update applies unsigned GitHub ZIP with no hash/signature verification (RCE)

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:463`

**Evidencia y solución**

applyUpdate() extracts the downloaded release ZIP directly over the install ROOT (extractZip → Expand-Archive, launcher.ts:475) and then runs the new code as the Windows service, with no integrity check whatsoever: downloadFile (launcher.ts:269-287) streams asset.browser_download_url to logs/update.zip and there is no SHA256/signature comparison anywhere, and release.yml publishes only `Vantek-*.zip` with no checksum or signature asset (release.yml:254-262). Worse, downloadFile follows redirects to `res.headers.location` via httpModule(), which explicitly permits plain `http://` (launcher.ts:155-157, 275-277), so a downgraded/MITM'd redirect can substitute the payload. A compromised GitHub release, a stolen release token, or a MITM on the download therefore yields arbitrary code execution as the service account (installed by NSSM, typically LocalSystem). Fix: pin and verify a signed hash of the release (e.g. publish and check a detached signature / SHA256 over HTTPS-only, reject non-https redirects) before extracting.

> ℹ️ **Verificación adversarial:** Verified in launcher.ts: downloadFile (269-287) fetches the release ZIP with no hash/signature check, applyUpdate (463-497) extracts it over the install root via Expand-Archive -Force and NSSM (default LocalSystem, install-service.bat sets no ObjectName) reruns the new code; release.yml publishes only Vantek-*.zip with no checksum/signature asset. The MITM/http-downgrade sub-claim is overstated since the redirect Location arrives over certificate-validated HTTPS, so the practical vector is a compromised GitHub release channel — real, but supply-chain-gated, hence high rather than critical.

`MEDIO` · `esfuerzo: medium` · `Seguridad`

#### 13. Puppeteer launched with --no-sandbox while rendering config-controlled HTML

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/pdf.service.ts:383`

**Evidencia y solución**

lanzarNavegador() always passes `['--no-sandbox','--disable-setuid-sandbox']` (pdf.service.ts:383) for both bundled Chromium and system Edge. The HTML rendered is built from templates that can be fully attacker-supplied via the unauthenticated config (`documentos.template_html` / `template_path`, pdf.service.ts:173-192). Disabling the Chromium sandbox removes the last containment layer around untrusted markup being parsed by the browser during PDF generation, so a Chromium renderer exploit or SSRF/file access from the page runs unconfined in the service process. Fix: run Chromium with its sandbox enabled (drop --no-sandbox; on Docker use a low-privilege user / seccomp instead of disabling the sandbox), and constrain template sources.

> ℹ️ **Verificación adversarial:** Verified pdf.service.ts:383 always passes --no-sandbox/--disable-setuid-sandbox while page.setContent renders JS-enabled HTML taken verbatim from documentos.template_html/template_path, which is writable via the fully unauthenticated PUT /api/config/app (config.router.ts:68) on a server bound to all interfaces — so the factual chain stands. However, impact is defense-in-depth only: the attacker already needs API reach that grants total data control, host code-exec additionally requires a Chromium renderer exploit, the SSRF/file-access claims are not consequences of the sandbox flag, and unconditionally dropping --no-sandbox would break the fixed Docker deployment (non-root user + distro chromium under default seccomp).

`MEDIO` · `esfuerzo: medium` · `Seguridad`

#### 14. install.ps1 downloads Node.js and NSSM with no checksum/signature verification

`📍 /Users/david/TestPersonal/vantek/install.ps1:296`

**Evidencia y solución**

The installer fetches the NSSM service-supervisor zip from `https://nssm.cc/release/nssm-2.24.zip` (install.ps1:298-308) and Node.js from nodejs.org (install.ps1:271-286) via Get-File, then copies nssm.exe and node.exe into the install tree and registers them as the VANTEK Windows service — with no SHA256/publisher-signature verification of either download. nssm.cc is a single third-party host (the script itself notes it returns transient 503s) with no published checksum pinned here; a compromised mirror or MITM (even with TLS, no cert pinning / no hash) yields an attacker-controlled nssm.exe running as the service supervisor (LocalSystem). Fix: pin and verify a known-good SHA256 for both nssm.exe and the Node archive (nodejs.org publishes SHASUMS256.txt) before use, and prefer Authenticode signature validation for node.exe/nssm.exe.

> ℹ️ **Verificación adversarial:** Confirmed in install.ps1: Get-File is plain Invoke-WebRequest (TLS 1.2 enforced but no hash/signature check anywhere in the repo), and install-service.bat registers the downloaded nssm.exe/node.exe as the auto-start VANTEK service under NSSM's default LocalSystem account. TLS cert validation blocks ordinary MITM (claim overstates that vector), but a compromise of nssm.cc — a single-maintainer host serving an unsigned 2014 binary — would go undetected, making this a real but low-likelihood, high-impact supply-chain gap; pinning a SHA256 for nssm-2.24.zip and Authenticode-checking node.exe fixes it without touching the fixed architecture.

`BAJO` · `esfuerzo: small` · `Seguridad`

#### 15. Content-Security-Policy disabled in helmet

`📍 /Users/david/TestPersonal/vantek/app/backend/src/index.ts:71`

**Evidencia y solución**

helmet is initialized with `{ contentSecurityPolicy: false }` (index.ts:71), so the SPA is served with no CSP. The PDF template engine does escape interpolated values via esc() (pdf.service.ts:105-112), so stored data injected into PDFs is largely neutralized, but the browser-facing app loses defense-in-depth against any reflected/stored XSS in the React UI (which renders client/quote/invoice text an unauthenticated LAN user can write). Given there is no auth, an attacker can freely seed malicious strings into stored records. Fix: enable a restrictive CSP (default-src 'self', no inline script) for the frontend responses.

> ℹ️ **Verificación adversarial:** Confirmed: index.ts:71 disables helmet's CSP and nginx.conf sets no CSP either, so the SPA is served without CSP on both Windows (Express static) and Docker (nginx). However, I found zero raw-HTML sinks in the frontend (no dangerouslySetInnerHTML; the one document.write print path escapes all values via escapeHtml at SeguimientoPage.tsx:75-81) and the app has no auth/sessions/cookies, so XSS would grant nothing beyond the open LAN API — this is a pure defense-in-depth hardening gap, not an exploitable issue, and the helmet-only fix would additionally need a matching nginx header to cover Docker.

### 5.3 · Integridad de datos y resiliencia (11: 1 crít · 4 alto · 4 medio · 2 bajo)

`CRÍTICO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 16. hasDirtyDraft() calls https.get on an http:// URL — launcher crash loop and dirty-draft protection never works

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:366`

**Evidencia y solución**

hasDirtyDraft() uses `https.get('http://localhost:3000/api/status/draft', ...)` (lines 364-381). Node's https.get throws ERR_INVALID_PROTOCOL synchronously for an http:// URL; the throw inside the Promise executor becomes a rejection that no caller handles. Consequences: (1) the safeguard that prevents applying an update while an invoice/quote draft is unsaved can never return true; (2) in the scheduler (lines 551, 561), the apply-watcher (line 607) and the startup check (line 630) the rejection is unhandled, which kills the Node process (unhandled rejections are fatal since Node 15). Worst case verified: once logs/update.zip exists, checkAndUpdateAlArrancar() hits hasDirtyDraft() at line 630 BEFORE startServer(), so the launcher crashes on every boot — NSSM restart loop, total outage until someone manually deletes update.zip. The file even defines httpModule() (line 155) to pick http vs https, but this call site doesn't use it. Fix: use http.get (or httpModule) and add try/catch around the awaits in the setInterval/watchFile callbacks.

> ℹ️ **Verificación adversarial:** Confirmed line 366 uses https.get on an http:// URL and reproduced the exact pattern in Node: the promise rejects with ERR_INVALID_PROTOCOL every call, so hasDirtyDraft never works and its rejections are uncaught at all five call sites (setInterval/watchFile callbacks crash via unhandled rejection; the startup path at line 630 propagates to main().catch which exits(1) before startServer). With logs/update.zip present — reachably created by the watcher path at lines 601-604 — the launcher exits on every boot before starting the server, producing the claimed NSSM crash loop until the zip is manually deleted.

`ALTO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 17. Migrations are not transactional; a mid-migration failure permanently bricks startup

`📍 /Users/david/TestPersonal/vantek/app/backend/src/db/migrate.ts:417`

**Evidencia y solución**

runMigrations() executes each migration with db.exec(migration.sql) and only inserts the version row afterwards (lines 415-419). db.exec autocommits each statement individually, so a failure or crash mid-script leaves a partially applied schema with no version recorded. Concrete failure modes verified in the SQL: migration v2 (lines 226-234) is six separate ALTER TABLE statements — if statement 3 fails (disk full, crash), the retry on next boot re-runs statement 1 and dies forever with 'duplicate column name'; migration v5 rebuilds seguimiento — a crash between DROP TABLE seguimiento (line 313) and RENAME (line 314) leaves no seguimiento table, and the retry dies on 'table seguimiento_new already exists'. index.ts start() (lines 187-190) catches this and process.exit(1), so NSSM/Docker restart-loops the service indefinitely with a half-migrated database and no pre-migration backup. Since migrations run automatically right after every auto-update, every update is a bricking opportunity. Improvement: wrap each migration in db.transaction() (moving PRAGMA foreign_keys toggles outside the transaction, since they are no-ops inside one), and copy the db file (or VACUUM INTO) before applying pending migrations.

> ℹ️ **Verificación adversarial:** Verified in migrate.ts lines 415-419 that each migration runs via better-sqlite3 db.exec (per-statement autocommit, no BEGIN/COMMIT in any migration SQL) with the version row inserted separately; v2/v3/v5/v7/v9 are non-idempotent on retry (bare ALTERs, CREATE TABLE seguimiento_new without IF NOT EXISTS), index.ts start() exits(1) on failure, NSSM (AppRestartDelay 5000) and docker-compose (restart: unless-stopped) both restart-loop, and a repo-wide grep confirms no pre-migration backup exists. The claim stands; only the trigger probability (crash/disk-full during the short migration window) keeps it below critical.

`ALTO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 18. reset-datos irreversibly wipes all business data with no pre-wipe snapshot and no auth

`📍 /Users/david/TestPersonal/vantek/app/backend/src/routes/config.router.ts:140`

**Evidencia y solución**

POST /api/config/reset-datos requires only the literal string body {confirmar:'BORRAR'} (config.router.ts:141) — there is no authentication anywhere in the API — and resetDatos() (reset.service.ts:64-70) deletes every business table and all generated PDFs. Because no backup mechanism exists (see backup finding), one HTTP request from anything on localhost/LAN destroys the complete invoice history unrecoverably. Improvement: take a timestamped safety copy first (VACUUM INTO DATA_DIR/backups/pre-reset-<ts>.db) inside resetDatos() before the DELETEs, so the wipe is reversible; the PDF deletion could similarly move files aside instead of unlinking.

> ℹ️ **Verificación adversarial:** Verified config.router.ts:140-146 gates the wipe only on the literal 'BORRAR' string, reset.service.ts:61-85 deletes all 16 business tables (including the versiones snapshots) plus all PDFs, the only middleware in the app is errorHandler (no auth on any route, server binds all interfaces and nginx/docker expose it on the LAN with no restriction), and a repo-wide grep confirms no backup/VACUUM mechanism exists — so the wipe is one unauthenticated LAN request away and unrecoverable. Severity tempered from critical to high because it is an intentional feature in a by-design trusted-LAN zero-auth app, and the proposed pre-reset VACUUM INTO fix is additive and platform-safe.

`ALTO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 19. Invoice numbering reuses numbers after reopening an invoice; no UNIQUE constraint on the series

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:104`

**Evidencia y solución**

siguienteNumeroFactura() derives the next number as COUNT(*)+1 of non-borrador invoices for the year (lines 104-114). cambiarEstado(id,'borrador') clears numero and anio_numero on reopen (lines 484-490), decrementing that count. Verified sequence: close invoices 0001-0003, reopen 0002, close a new invoice → COUNT=2 → it is issued number 0003, duplicating the existing 0003 — a fiscal-integrity violation for a Spanish invoice series. The schema has no UNIQUE constraint on (anio_numero, numero) (migrate.ts lines 160-172), so nothing detects the collision, and cerrarFactura's count-then-UPDATE spans awaits (lines 431-447) outside any transaction, allowing the same duplication under concurrent closes. Improvement: allocate with MAX(CAST(numero AS INTEGER))+1 per year inside a db.transaction(), and add a unique partial index `CREATE UNIQUE INDEX ... ON facturas(anio_numero, numero) WHERE numero IS NOT NULL` in a new migration.

> ℹ️ **Verificación adversarial:** Verified in facturas.service.ts: siguienteNumeroFactura is COUNT(*)+1 (lines 104-114), cambiarEstado to 'borrador' nulls numero/anio_numero from any state (lines 459-490) with no route guard, and migrate.ts defines no UNIQUE constraint or index on (anio_numero, numero) — so reopening a mid-series invoice deterministically causes the next close to reissue an existing number. cerrarFactura also runs count-then-UPDATE across awaits with no transaction (lines 431-450), though the reopen path alone reproduces the duplicate without concurrency.

`ALTO` · `esfuerzo: large` · `Integridad de datos y resiliencia`

#### 20. Auto-update extracts ZIP over the live install with the server running: no stop, no staging, no rollback

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:475`

**Evidencia y solución**

applyUpdate() runs `Expand-Archive -Force` directly onto ROOT (line 475) and is invoked from the scheduler (line 566) and the apply-watcher (line 614) while the spawned backend child is still running — startServer()'s child handle (line 673) is never retained or killed anywhere in the file. The release ZIP contains node_modules/ (per release.yml header), so the running server's loaded better_sqlite3.node and other files are locked on Windows: extraction fails midway, the catch block (lines 486-496) reverts the state flag but cannot revert the already-overwritten files, leaving a mixed-version install with no rollback and no re-extraction from a known-good copy. On the success path, process.exit(0) at line 485 exits the launcher without terminating the backend child; if NSSM restarts the launcher without reaping the orphan, the old server keeps port 3000 and the SQLite handle while the new spawn dies with EADDRINUSE. The db survives only because data/ is not in the ZIP — there is no explicit exclusion guard, so a packaging mistake would silently overwrite live data. Improvement: track and gracefully stop the child (then wal_checkpoint) before extraction, extract to a staging dir and swap, keep the previous tree for rollback, and assert the ZIP contains no data/ or config/*.json entries before applying.

> ℹ️ **Verificación adversarial:** Verified in launcher.ts: applyUpdate() (line 475) runs Expand-Archive -Force onto ROOT and is reached from the scheduler (566) and apply-watcher (614) after startServer() spawned the backend (673), whose handle is never killed; the catch (486-496) reverts only the state flag and deletes the ZIP, so a lock-induced mid-extraction failure (release.yml line 183 ships node_modules incl. the loaded better_sqlite3.node DLL) leaves a mixed-version tree with no rollback. The orphan/EADDRINUSE sub-claim is overstated (extraction fails before process.exit(0) while the child runs), and data/ is genuinely absent from the ZIP by construction, so no direct DB loss — hence high rather than critical.

`MEDIO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 21. Only documented backup procedure is a naive hot copy of the live WAL database

`📍 /Users/david/TestPersonal/vantek/README-docker.md:59`

**Evidencia y solución**

README-docker.md lines 56-61 tell the operator to `docker run ... tar czf` the vantek-data volume while the backend container keeps writing. connection.ts enables WAL (line 46), so a point-in-time tar of vantek.db + -wal + -shm taken mid-transaction can capture torn pages and produce an archive that fails integrity_check on restore — the operator only discovers this when the restore is needed. There is no equivalent guidance at all for the Windows deployment. Improvement: document/implement `sqlite3 vantek.db ".backup /backup/vantek.db"` or an app-level VACUUM INTO endpoint, or instruct stopping the backend container first; ties into the automated-backup finding.

> ℹ️ **Verificación adversarial:** README-docker.md:56-62 indeed documents a hot tar of the vantek-data volume as the only backup path, connection.ts:46 enables WAL, and project-wide grep confirms no safe backup mechanism (no .backup/VACUUM INTO/wal_checkpoint/backup endpoint) and zero Windows backup guidance; a non-atomic tar of db+wal under concurrent writes can silently produce a restore-time-corrupt archive. Live data is never at risk and writes are sporadic in this single-user app, so medium rather than high.

`MEDIO` · `esfuerzo: medium` · `Integridad de datos y resiliencia`

#### 22. No automated backup of vantek.db in either deployment

`📍 /Users/david/TestPersonal/vantek/app/backend/src/db/connection.ts:38`

**Evidencia y solución**

vantek.db (DATA_DIR/vantek.db) is the sole store for all invoice/quote data, and a repo-wide search for backup/respaldo/.bak/VACUUM/checkpoint confirms zero backup code. Windows: install.ps1, launcher/launcher.ts, start.bat and install-service.bat contain no backup step — not before auto-updates (launcher.ts applyUpdate, lines 463-497), not before migrations, not scheduled. Docker: docker-compose.yml defines volume vantek-data with no backup sidecar; the only mention in the whole repo is a manual command in README-docker.md:59-61. A single disk failure, botched migration, or accidental reset loses every invoice with no recovery path. Improvement: scheduled online backup using better-sqlite3's db.backup() or `VACUUM INTO` into DATA_DIR/backups with dated retention (e.g. daily, keep N), triggered from the backend on a timer plus forced before runMigrations() and before launcher applyUpdate(); ideally also copy to a second disk/volume.

> ℹ️ **Verificación adversarial:** Verified by repo-wide search and reading connection.ts, migrate.ts, launcher.ts applyUpdate (463-497), docker-compose.yml, and deploy scripts: vantek.db is the sole datastore and there is zero backup code anywhere — only a manual tar command in README-docker.md; the unattended auto-update pipeline (extract ZIP over ROOT, NSSM restart, auto-run migrations) takes no pre-update/pre-migration snapshot. The claim stands; severity is medium rather than critical because it is a missing safeguard requiring an external failure trigger, not an active defect, and the proposed fix is compatible with the fixed dual-platform architecture.

`MEDIO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 23. No graceful shutdown: closeDb() is dead code, no signal handlers, WAL never checkpointed on stop

`📍 /Users/david/TestPersonal/vantek/app/backend/src/index.ts:178`

**Evidencia y solución**

index.ts registers no SIGTERM/SIGINT handlers and never calls closeDb() (grep confirms connection.ts:53 is its only occurrence); the launcher never signals the child, NSSM tree-kills it on service stop, and in Docker the node process (PID 1 via `exec gosu node` in backend-entrypoint.sh:61) is SIGTERM-killed by docker stop without closing the db. SQLite's WAL recovery prevents corruption, but: (1) the WAL is never checkpointed/truncated on shutdown, so vantek.db alone is perpetually stale — any file-level copy that forgets -wal/-shm (including the README backup and any operator copying 'the db file') silently loses the most recent transactions; (2) with synchronous=NORMAL (connection.ts:48) a power failure can drop the last commits — acceptable, but undocumented. Improvement: handle SIGTERM/SIGINT to close the HTTP server, run PRAGMA wal_checkpoint(TRUNCATE), and db.close() before exit.

> ℹ️ **Verificación adversarial:** Verified in code: index.ts has no signal handlers, closeDb() at connection.ts:53 is never called anywhere, the launcher never signals its spawned child, and backend-entrypoint.sh execs node as PID 1 with no init, so no path ever closes the DB or checkpoints the WAL on stop. However, the documented Docker backup tars the whole /data dir (wal/shm included) and SQLite auto-checkpoint plus WAL recovery prevent corruption, so the realistic harm is limited to an operator copying vantek.db alone or power-loss dropping the last synchronous=NORMAL commits.

`MEDIO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 24. Non-atomic writes of app.config.json and state files: crash or disk-full mid-write corrupts them

`📍 /Users/david/TestPersonal/vantek/app/backend/src/utils/config.ts:174`

**Evidencia y solución**

saveAppConfig (config.ts:174) and migrateConfig (config.ts:231) rewrite app.config.json in place with fs.writeFileSync, which truncates then writes: a crash, power loss or ENOSPC mid-write leaves truncated/invalid JSON. getAppConfig (config.ts:167) has no try/catch or fallback, so a corrupt file makes every config-dependent request throw until manual repair — app.config.json holds company data, SMTP credentials and the invoice numbering block. Same pattern in index.ts writeUpdateState (line 137), launcher.ts writeState (line 200), version.json (launcher.ts:476) and the first-boot config render (launcher.ts:173, backend-entrypoint.sh:42-49). There is no disk-space check anywhere in the codebase. Improvement: write to a temp file in the same directory and fs.renameSync over the target (atomic on same filesystem); optionally keep a .bak of the last good config and fall back to it on parse failure.

> ℹ️ **Verificación adversarial:** Verified config.ts:174/231, config.router.ts:73/84, launcher.ts:173/200/476, index.ts:137 and backend-entrypoint.sh all use truncate-in-place writeFileSync with no temp+rename, and getAppConfig has no parse fallback or .bak, so a crash/ENOSPC mid-write of app.config.json bricks every config-dependent endpoint until manual repair. Severity is tempered because update-state readers already fall back to defaults on corruption and the live invoice counter is derived from SQLite (not config), so the critical file is written only on first boot, template migrations, and user config saves.

`BAJO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 25. errores table grows unbounded inside the business database

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/errores.service.ts:106`

**Evidencia y solución**

Every server error is inserted into the errores table in vantek.db (migration v6, migrate.ts:320-335), but rows are only deleted by borrarErrores() after a successful manual email send, and only within the sent date range (errores.service.ts:106-111). A recurring failure (e.g. SMTP misconfigured so the send-and-purge path itself never succeeds, or repeated Puppeteer errors) accumulates rows indefinitely, bloating the invoice database and its backups. Improvement: cap the table on insert (e.g. delete rows older than 90 days or beyond N thousand on startup/insert).

> ℹ️ **Verificación adversarial:** Verified: errorHandler.ts:57 inserts every 5xx (with full stack) into errores in vantek.db; the only delete is borrarErrores() at config.router.ts:135, gated behind a successful manual SMTP send (returns 400 before deleting on failure), and grep confirms no scheduled job, startup prune, or row cap exists anywhere in the backend. The claim stands, but growth is driven only by server errors in a local single-user app, so impact is gradual DB/backup bloat rather than data loss.

`BAJO` · `esfuerzo: small` · `Integridad de datos y resiliencia`

#### 26. Log rotation gaps: launcher.log unbounded, NSSM rotates only on restart, Docker logs uncapped

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:111`

**Evidencia y solución**

Three verified gaps for a service meant to run unattended for months: (1) launcher.ts log() appends to logs/launcher.log with no size cap or rotation (line 111), and the update ZIP is also downloaded into logs/ (TMP_ZIP, line 66). (2) install-service.bat sets AppRotateFiles=1 and AppRotateBytes=5MB but NOT AppRotateOnline=1, so NSSM only rotates service-stdout.log when the service restarts; the backend logs every HTTP request (index.ts:78-89), so between updates the file grows without bound. (3) docker-compose.yml defines no `logging:` options for either service, so the default json-file driver grows unbounded on the Linux host. Disk exhaustion from logs is exactly the ENOSPC scenario the config-write and update paths do not survive. Improvement: add `AppRotateOnline 1` to install-service.bat, size-check/rotate launcher.log in log(), and set logging.driver options (max-size/max-file) in docker-compose.yml.

> ℹ️ **Verificación adversarial:** All three cited gaps verified in code: launcher.ts:111 appends to launcher.log with no rotation (and TMP_ZIP lives in logs/), install-service.bat sets AppRotateFiles/AppRotateBytes but omits AppRotateOnline so NSSM rotates only on restart while the backend's stdio-inherited per-request logger feeds service-stdout.log, and docker-compose.yml has no logging options so the json-file driver is unbounded. Downgraded severity because growth rates for this single-user local app are small (KBs/day for the launcher, modest request volume, no continuous polling) and the Windows service restarts (rotating logs) on every applied update, making disk exhaustion a slow multi-month/year risk rather than an acute one.

### 5.4 · Correctitud general (17: 0 crít · 3 alto · 8 medio · 6 bajo)

`ALTO` · `esfuerzo: small` · `Correctitud general`

#### 27. Invoice number collision after reopening a closed factura (COUNT-based numbering)

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:104`

**Evidencia y solución**

siguienteNumeroFactura computes the next annual number as COUNT(*) of non-borrador facturas for the year + 1 (lines 104-114). cambiarEstado(id,'borrador') (lines 484-490) clears numero/anio_numero when a factura is reopened, shrinking that count. Sequence: close A->0001, close B->0002, reopen A (count for the year drops to 1), close C -> COUNT+1 = 0002, duplicating B's legal invoice number. Fix: derive the next number from MAX(CAST(numero AS INTEGER)) per anio_numero (or a persisted counter) instead of COUNT(*).

> ℹ️ **Verificación adversarial:** Confirmed in code: siguienteNumeroFactura uses COUNT(*)+1 of non-borrador facturas per year, cambiarEstado(id,'borrador') nulls numero/anio_numero (a transition explicitly allowed from all closed states and exposed via the router), and the facturas schema has no UNIQUE constraint on numero, so the reviewer's reopen-then-close sequence silently produces a duplicate legal invoice number; eliminarFactura hard-deletes and triggers the same collision.

`ALTO` · `esfuerzo: small` · `Correctitud general`

#### 28. guardarLineas performs DELETE-then-INSERT without a transaction (facturas and presupuestos)

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:282`

**Evidencia y solución**

guardarLineas first runs DELETE FROM factura_lineas (line 288), then inserts the new lines in a loop and updates updated_at - all as separate statements with no db.transaction(). If any insert fails (NOT NULL descripcion, CHECK on tipo, FK on albaran_linea_id from a malformed payload), the document's existing lines are already gone and the save is half-applied: permanent data loss for that factura. The identical pattern exists in presupuestos.service.ts:260-288, and eliminarFactura (facturas.service.ts:553-558) / eliminarPresupuesto (presupuestos.service.ts:403-408) also chain multiple deletes untransacted. Fix: wrap each of these in db.transaction() like crearFactura already does.

> ℹ️ **Verificación adversarial:** Verified guardarLineas in both facturas.service.ts:282 and presupuestos.service.ts:260 run DELETE-then-INSERT-then-UPDATE as separate better-sqlite3 autocommit statements with no db.transaction(), while the router only checks Array.isArray and the schema enforces NOT NULL descripcion, CHECK(tipo), and FK albaran_linea_id with foreign_keys=ON — so a failing insert mid-loop permanently destroys the document's existing lines. crearFactura already uses db.transaction(), confirming the fix is the established codebase pattern with no architectural impact.

`ALTO` · `esfuerzo: small` · `Correctitud general`

#### 29. Deleting a presupuesto referenced by a factura throws FK constraint -> 500

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/presupuestos.service.ts:403`

**Evidencia y solución**

eliminarPresupuesto deletes the presupuestos row, but facturas.presupuesto_origen_id REFERENCES presupuestos(id) with no ON DELETE action (migrate.ts:233; also facturas.presupuesto_id at migrate.ts:163) and foreign_keys=ON (connection.ts:47). Once a factura has been created from the presupuesto (facturas.service.ts crearFactura stores presupuesto_origen_id), DELETE /api/presupuestos/:id fails with SQLITE_CONSTRAINT and surfaces as an unhandled 500. The same DELETE FROM presupuestos in seguimiento.service.ts:685 (_limpiarObraAlCancelar) can hit it too. Fix: NULL out facturas.presupuesto_origen_id first (or return 409 with a clear message).

> ℹ️ **Verificación adversarial:** Confirmed in code: facturas.presupuesto_origen_id references presupuestos(id) with no ON DELETE action (migrate.ts:233), foreign_keys=ON (connection.ts:47), crearFactura stores the reference, and eliminarPresupuesto/DELETE route have no guard, so the delete throws SQLITE_CONSTRAINT and errorHandler returns 500 — reachable via the UI by reopening an aceptado presupuesto to borrador after converting it to a factura. Worse than claimed: the three DELETEs are not in a transaction, so presupuesto_lineas and presupuesto_versiones are permanently destroyed before the failing statement, leaving a corrupted empty presupuesto.

`MEDIO` · `esfuerzo: small` · `Correctitud general`

#### 30. Schema migrations are not run inside transactions - a mid-script failure bricks startup

`📍 /Users/david/TestPersonal/vantek/app/backend/src/db/migrate.ts:415`

**Evidencia y solución**

runMigrations executes each multi-statement migration with db.exec(migration.sql) and only then records the version (lines 415-420). better-sqlite3's exec is not atomic across statements: if a statement in the middle fails (e.g. the v5 seguimiento table rebuild, or an ALTER in v2/v3/v9), the schema is left half-applied and the version row is never inserted, so every subsequent boot re-runs the same migration and fails forever ('duplicate column name' / 'table already exists'), and index.ts start() exits with process.exit(1). Fix: wrap db.exec(sql) + the version INSERT in db.transaction() per migration (moving PRAGMA foreign_keys toggles outside the transaction for v5).

> ℹ️ **Verificación adversarial:** Verified migrate.ts:415-420 runs db.exec(multi-statement SQL) with no transaction and records the version afterward; v2/v3/v9 (ALTER ADD COLUMN) and v5 (CREATE TABLE seguimiento_new without IF NOT EXISTS) are non-idempotent, so a partial apply re-fails on every boot and index.ts:189 exits with code 1, with no backup/recovery mechanism anywhere in the repo. The claim stands; severity tempered to medium because it only triggers if a crash/error lands inside a migration window, though impact then is an unrecoverable boot loop for a non-technical user.

`MEDIO` · `esfuerzo: small` · `Correctitud general`

#### 31. findById pairs GROUP_CONCAT(trabajo_ids) with GROUP_CONCAT(nombres) split by comma - breaks with commas in names and unguaranteed ordering

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/albaranes.service.ts:110`

**Evidencia y solución**

Lines 110-131 build trabajos_asignados by splitting two independent GROUP_CONCAT columns on ',' and pairing by index. If a trabajo name contains a comma (free-text user field, e.g. 'Reforma cocina, 2a fase'), the name array misaligns and every subsequent line's trabajo_nombre is wrong; additionally SQLite does not guarantee both GROUP_CONCATs enumerate rows in the same order. Fix: fetch the assignments with a second query per albaran (as findByTrabajo does) or use json_group_array pairs.

> ℹ️ **Verificación adversarial:** Verified: findById (albaranes.service.ts:110-131) index-pairs two comma-split GROUP_CONCAT columns; trabajos.nombre is free-text with only a non-empty check (clientes.router.ts:139) so commas are allowed, and albaran_linea_trabajo permits multiple trabajos per line, so a comma in any nombre misaligns/truncates trabajo_nombre. Impact is limited to wrong display names (ids are UUIDs and split correctly, so no data corruption), though the mislabeled move-line selector in AlbaranFichaPage.tsx can mislead the user; the ordering half of the claim is only theoretical.

`MEDIO` · `esfuerzo: medium` · `Correctitud general`

#### 32. Albaran list: GROUP BY al.id, t.id makes estado 'parcial' unreachable and duplicates/misstates rows

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/albaranes.service.ts:75`

**Evidencia y solución**

findAll groups by (al.id, t.id). For an albaran whose lines are split between assigned and unassigned (or across trabajos), lines assigned to trabajo X land in group (al, X) and unassigned lines in group (al, NULL). Within each group lineas_count only counts that group's lines, so lineas_asignadas always equals lineas_count (estado 'asignado') or 0 (estado 'sin_asignar'); the 'parcial' state computed at lines 90-97 (and rendered by Badge in AlbaranesPage) can never occur, and a partially-assigned albaran appears twice - once as 'asignado' and once as 'sin_asignar' (AlbaranesPage.tsx:177-179 keys rows by id+trabajo_id). The estado=sin_asignar filter therefore wrongly includes partially assigned albaranes. Fix: compute lineas_count/lineas_asignadas per albaran (subqueries) instead of per (albaran, trabajo) group.

> ℹ️ **Verificación adversarial:** Reproduced the exact query in SQLite: a 3-line albaran with 1 line assigned yields two rows (count=2/asignadas=0 and count=1/asignadas=1), so 'parcial' is mathematically unreachable given UNIQUE(albaran_linea_id, trabajo_id), and the estado=sin_asignar filter includes partially assigned albaranes. Intent is proven by the AlbaranEstado type, the dead 'parcial' branch at lines 92-96, and the frontend's 'Parcial' filter option (which the backend silently ignores, returning everything).

`MEDIO` · `esfuerzo: medium` · `Correctitud general`

#### 33. Business dates derived from UTC (toISOString) shift to the previous day for Spanish users; mixed UTC/local comparisons

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:238`

**Evidencia y solución**

Document dates use new Date().toISOString().slice(0,10), which is the UTC date: a factura created at 00:30 local (Europe/Madrid, UTC+1/+2) gets yesterday's fecha. Same pattern in presupuestos.service.ts:204, pagos.service.ts:87, and frontend NuevoAlbaranModal.tsx:106 and PagosObra.tsx:54. Related inconsistencies: cerrarFactura uses the LOCAL year for anio/numero while fecha_cierre stores UTC datetime('now') (facturas.service.ts:439-447), so an invoice closed shortly after local midnight on Jan 1 can carry the new year's series with a Dec 31 fecha_cierre; dashboard.service.ts:127-128 and 187-188 parse SQLite UTC strings ('YYYY-MM-DD HH:MM:SS') with new Date() as LOCAL time, skewing dias_espera/dias_sin_cobrar around day boundaries. Fix: build dates from local components (or a shared 'hoyISO()' helper using local timezone) and parse DB timestamps as UTC.

> ℹ️ **Verificación adversarial:** Verified every cited line: backend defaults in facturas.service.ts:238, presupuestos.service.ts:204, pagos.service.ts:87 and frontend defaults in NuevoAlbaranModal.tsx:106/PagosObra.tsx:54 all derive business dates from toISOString() (UTC), shifting to the previous day for 1-2h after Madrid midnight; cerrarFactura mixes local getFullYear() with UTC datetime('now'), and dashboard.service.ts parses SQLite UTC strings as local time. Real correctness bug, but impact is limited to a narrow nightly window, dates are user-overridable in the UI, and dashboard skew is off-by-one on informational counters.

`MEDIO` · `esfuerzo: small` · `Correctitud general`

#### 34. Closing a factura via POST /:id/cerrar never syncs the seguimiento (pendiente_facturar step skipped)

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:431`

**Evidencia y solución**

syncSeguimientoDesdeDocumento explicitly maps factura 'cerrada' -> seguimiento 'pendiente_facturar' (seguimiento.service.ts:394), but that sync is only invoked from cambiarEstado (facturas.service.ts:496-501). cerrarFactura - the actual path used by the UI close button (facturas.router.ts:115-124) - updates estado='cerrada' directly at lines 442-447 without calling the sync, so the linked seguimiento/trabajo never advances to pendiente_facturar on close; the mapping is effectively dead code. Fix: call syncSeguimientoDesdeDocumento(factura.trabajo_id, 'factura', 'cerrada') at the end of cerrarFactura.

> ℹ️ **Verificación adversarial:** Verified cerrarFactura (facturas.service.ts:431-450) updates estado='cerrada' via direct SQL without calling syncSeguimientoDesdeDocumento, which is only invoked from cambiarEstado (line 500); the UI close button goes through POST /:id/cerrar (routes/facturas.router.ts:115) and the frontend never sends 'cerrada' via the /estado endpoint, so the 'cerrada'→'pendiente_facturar' mapping (seguimiento.service.ts:394) is unreachable in production. Impact is limited because the seguimiento catches up when the factura is later marked entregada/pagada (those go through cambiarEstado and the sync advances past the skipped step), and manual seguimiento moves remain possible.

`MEDIO` · `esfuerzo: small` · `Correctitud general`

#### 35. Failed Tesseract preload caches a rejected workerPromise, permanently breaking OCR until reload

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/hooks/useTesseract.ts:47`

**Evidencia y solución**

preinicializarTesseract sets the module-level workerPromise before awaiting it and never clears it on failure. If createWorker rejects (assets missing/offline blip), workerPromise stays a rejected promise: the early-return guard at line 48 (`if (workerSingleton || workerPromise) return`) prevents retries, and reconocer's `if (!worker && workerPromise) worker = await workerPromise` (lines 91-93) rethrows the cached rejection on every scan - the on-demand fallback at line 96 is unreachable. Fix: add .catch that resets workerPromise = null (both in preload and the on-demand path).

> ℹ️ **Verificación adversarial:** Confirmed in useTesseract.ts: workerPromise is set before await (line 49), never cleared on rejection, the line 48 guard blocks preload retries, and reconocer's `await workerPromise` (line 92) rethrows the cached rejection making the on-demand fallback (line 96) unreachable — while SplashScreen.tsx lines 54-59 explicitly catch the preload failure promising the worker "se iniciará al usar el escáner", proving the fallback was intended to work. Severity is medium rather than high because the trigger (preload failure with locally-served assets) is uncommon and recovery is a page reload affecting only the OCR feature.

`MEDIO` · `esfuerzo: small` · `Correctitud general`

#### 36. Autosave saves stale lines due to setInterval stale closure (facturas and presupuestos)

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Documentos/FacturaPage.tsx:139`

**Evidencia y solución**

The autosave effect runs with deps [actual?.id, actual?.estado] and creates setInterval(() => guardarBorrador(id, { lineas }), 3min). `lineas` is captured from the render in which the effect ran (right after load, i.e. the original lines), and the effect never re-runs when the user edits, so every autosave persists the INITIAL line state, not current edits. Identical bug in PresupuestoPage.tsx:107-113. It also sets borrador_updated_at > updated_at, so hayBorradorSucio() reports a dirty draft to the launcher based on stale data. Fix: keep the latest lineas in a ref (lineasRef.current) and read it inside the interval callback, or include lineas in the effect deps.

> ℹ️ **Verificación adversarial:** Confirmed stale closure at FacturaPage.tsx:139-145 and PresupuestoPage.tsx:107-113: interval captures `lineas` from the render when the effect ran (actually still [] at that point, since setLineas in the sibling effect commits one render later) and deps [actual?.id, actual?.estado] never re-arm it on edits, so autosave persists empty/stale lines and bumps borrador_updated_at, making hayBorradorSucio()/launcher.ts:367 see a false dirty draft. Downgraded from the implied high impact because borrador_data is write-only (no restore path anywhere), so no authoritative data is corrupted — the harm is a dead autosave safety net plus spurious dirty signals delaying launcher-driven updates.

`MEDIO` · `esfuerzo: small` · `Correctitud general`

#### 37. Lines imported from albaran use the global default margin instead of the trabajo's margin

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Documentos/FacturaPage.tsx:353`

**Evidencia y solución**

FacturaPage passes margenTrabajo={appConfig?.documentos.margen_defecto ?? 10} to ModalAnadirAlbaran, whose prop is documented as 'margen heredado del trabajo' (ModalAnadirAlbaran.tsx:65). The backend exposes the real per-trabajo margin as trabajo_margen in obtenerFactura (facturas.service.ts:174) but the frontend never reads it (grep: zero uses of trabajo_margen in frontend/src). Result: for a trabajo with a custom margin, material lines imported through the modal are priced with the global default (and an odd ?? 10 fallback vs the 20 used elsewhere), inconsistent with the backend /desde-albaran path which correctly uses trabajo.margen_porcentaje (facturas.service.ts:379-398). Fix: pass actual.trabajo_margen (fallback to the config default).

> ℹ️ **Verificación adversarial:** Verified FacturaPage.tsx:353 passes the global margen_defecto (?? 10) into ModalAnadirAlbaran's margenTrabajo prop, which seeds the margin applied to every imported line, while the backend exposes the real per-trabajo margin as trabajo_margen (facturas.service.ts:174) that no frontend code reads, and the backend desde-albaran path correctly uses trabajo.margen_porcentaje (facturas.service.ts:379). The inconsistency is real; severity is capped at medium because the margin is editable and per-line client prices are previewed in the modal before confirming.

`BAJO` · `esfuerzo: small` · `Correctitud general`

#### 38. Global errorHandler ignores err.statusCode: intended 4xx responses become 500 and pollute the error log

`📍 /Users/david/TestPersonal/vantek/app/backend/src/middleware/errorHandler.ts:46`

**Evidencia y solución**

errorHandler only special-cases ZodError; everything else is logged via registrarError(status:500) and returned as HTTP 500 (lines 52-64). But services deliberately throw errors carrying statusCode: pagos.service.ts:76-78 (404 'Trabajo no encontrado') and seguimiento.service.ts:291/299/651/662 (400 validations). The seguimiento router unwraps statusCode locally (seguimiento.router.ts:77-83), but pagos.router.ts:57 does not: POST /api/trabajos/:id/pagos with an unknown trabajo returns 500 instead of 404 AND records a bogus server error in the errores table (later emailed to the technician). Fix: in errorHandler use (err as any).statusCode ?? 500 for the response and only call registrarError for status >= 500.

> ℹ️ **Verificación adversarial:** Verified errorHandler.ts:52-64 ignores err.statusCode (only ZodError→400, else registrarError status:500 + HTTP 500), pagos.service.ts:74-79 throws statusCode=404, and pagos.router.ts POST has no local unwrap (unlike seguimiento.router.ts:81), so an unknown trabajo yields 500 plus a bogus row in the emailed errores table — the router's own header even documents the unimplemented 404 contract. Real bug, but limited to one rarely-hit endpoint edge case with log-noise/wrong-status impact only, so severity is low.

`BAJO` · `esfuerzo: small` · `Correctitud general`

#### 39. Config key typo: dashboard.dias_factura_sin_cobrar is never read (always 30)

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/dashboard.service.ts:105`

**Evidencia y solución**

Line 105 reads `(config as any).dashboard?.dashboard?.dias_factura_sin_cobrar ?? 30` - the `.dashboard` segment is doubled, so the lookup is always undefined and the threshold silently falls back to 30 days regardless of the configured value (AppConfig defines dashboard.dias_factura_sin_cobrar at utils/config.ts:104-108, and ConfigPage lets the user edit it). Line 104 shows the correct single-level access for dias_presupuesto_antiguo. Fix: remove the duplicated `.dashboard`.

> ℹ️ **Verificación adversarial:** Confirmed at dashboard.service.ts:105 the doubled `.dashboard?.dashboard?` access against an AppConfig whose schema (config.ts:104-108) and setup defaults (setup.service.ts:226-230) define dias_factura_sin_cobrar one level under `dashboard`, so the lookup is always undefined and the SQL filter at line 184 always uses 30. Impact is limited because ConfigPage does not expose this field (only dias_presupuesto_antiguo), so only manual config.json edits are silently ignored and the default happens to match the fallback.

`BAJO` · `esfuerzo: medium` · `Correctitud general`

#### 40. Seguimiento auto-conversion creates cliente/agrupador/trabajo across multiple writes without a transaction

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/seguimiento.service.ts:476`

**Evidencia y solución**

cambiarEstado -> _convertirACliente performs up to four dependent writes (INSERT clientes line 512, INSERT agrupadores line 535, INSERT trabajos line 550, UPDATE seguimiento line 556) plus the later estado UPDATE and document sync, all as separate statements with no db.transaction(). A failure after the first inserts (e.g. the getAppConfig read throwing is guarded, but any constraint/IO error on the trabajos insert isn't) leaves an orphaned cliente/agrupador not linked to any seguimiento, which the fuzzy dedup will then silently reuse or duplicate. The cancel paths (_limpiarObraAlCancelar, _cancelarObraIniciada plus their seguimiento UPDATEs at lines 305-326) have the same multi-statement exposure. Fix: wrap each state-change path in db.transaction().

> ℹ️ **Verificación adversarial:** Confirmed in seguimiento.service.ts: cambiarEstado/_convertirACliente and the cancel paths each issue 3-6 dependent writes with no db.transaction(), while sibling services (facturas, presupuestos, albaranes, reset) wrap equivalent flows in transactions, so the gap is a genuine deviation and the fix is idiomatic and architecture-neutral. Severity is low, not higher: better-sqlite3 is synchronous on a singleton connection in a single-process deployment, so only an I/O/disk error can split the sequence, and the fuzzy dedup (DNI exact, phone+name) means a retry adopts any orphaned cliente/agrupador rather than duplicating it; worst case is a stray empty cliente row, with no financial-document corruption.

`BAJO` · `esfuerzo: small` · `Correctitud general`

#### 41. DocumentoEditor empty-state colSpan off by one

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Documentos/components/DocumentoEditor.tsx:323`

**Evidencia y solución**

The header renders 6 columns in readonly mode and 7 in edit mode (6 data columns + the actions column added at line 316), but the 'Sin lineas' placeholder cell uses colSpan={readonly ? 5 : 6}, one short in both modes, so the empty-state row does not span the full table width. Fix: colSpan={readonly ? 6 : 7}.

> ℹ️ **Verificación adversarial:** Counted the header columns in DocumentoEditor.tsx lines 309-317: 6 data <th> elements plus a conditional actions <th> when not readonly, giving 6 (readonly) / 7 (edit) columns, while line 323 uses colSpan={readonly ? 5 : 6} — one short in both modes exactly as claimed. Purely cosmetic empty-state misalignment, no functional impact.

`BAJO` · `esfuerzo: small` · `Correctitud general`

#### 42. Zeros coerced to null when editing coste/margen inline (Number(x) || null)

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Documentos/components/DocumentoEditor.tsx:412`

**Evidencia y solución**

Inline editors use `coste_unitario: Number(e.target.value) || null` (line 412) and `margen_porcentaje: Number(e.target.value) || null` (line 427): typing '0' is coerced to null, so a legitimate zero cost (free item) or 0% margin cannot be entered - the field flips to '-' and the recompute at lines 265-269 treats it as absent. Fix: check for empty string explicitly (e.target.value === '' ? null : Number(e.target.value)).

> ℹ️ **Verificación adversarial:** Confirmed at DocumentoEditor.tsx:412/427 — `Number(e.target.value) || null` coerces a typed "0" to null, and since the input is controlled with `?? ''` the zero vanishes as typed and displays as '—' (lines 416/431); a legitimate 0 cost/0% margin cannot be stored. However, the recompute (lines 266-268) uses `?? 0`, so precio_unitario and all totals/PDFs are numerically unaffected; the bug is confined to internal-only cost/margin data entry and display, hence low rather than the implied higher impact.

`BAJO` · `esfuerzo: small` · `Correctitud general`

#### 43. cerrarFactura error detail discarded in the store: reads err.response which the axios interceptor strips

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/store/facturas.store.ts:181`

**Evidencia y solución**

utils/api.ts:50 rejects with `new Error(message)`, discarding the axios response object. facturas.store cerrarFactura's catch reads (err).response?.data?.error (lines 181-185), which is now always undefined, so the modal shown by FacturaPage always says the generic 'Error al cerrar la factura' instead of the backend's 422 reason ('La factura no esta en borrador', etc.). seguimiento.store.ts:173 shows the correct pattern (falls back to e.message). Fix: use (err as Error).message as the fallback.

> ℹ️ **Verificación adversarial:** Verified: api.ts:50 rejects with new Error(message), so the .response read in facturas.store.ts:182-183 is always undefined and the modal in FacturaPage always shows the generic text despite the backend returning 422 with a specific error (facturas.router.ts:119). However, the interceptor also fires a global toast with the real message (api.ts:48), so the user still sees the specific reason — the bug degrades only the modal, lowering severity.

### 5.5 · Robustez multiplataforma (10: 1 crít · 2 alto · 3 medio · 4 bajo)

`CRÍTICO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 44. Launcher dirty-draft check calls https.get on an http:// URL — crashes the launcher instead of protecting drafts

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:366`

**Evidencia y solución**

hasDirtyDraft() does `https.get('http://localhost:3000/api/status/draft', ...)`. Node's https.request throws ERR_INVALID_PROTOCOL synchronously for an http:// URL, which happens inside the Promise executor, so the promise REJECTS (the req.on('error') handler that resolves(false) is never registered). Every await of hasDirtyDraft() is uncaught: in the scheduler (launcher.ts:551,561) this is an unhandled rejection that kills the launcher process (Node >=15 default), and in checkAndUpdateAlArrancar (launcher.ts:630) it propagates to main().catch -> process.exit(1). Consequence on the Windows deployment: whenever an update is pending (update.zip present at boot, or scheduler reaches the draft check inside the maintenance window) the launcher crash-loops under NSSM, and the dirty-draft safety check never actually works. Fix: use the http module (or the existing httpModule(url) helper at launcher.ts:155) and wrap the call in try/catch.

> ℹ️ **Verificación adversarial:** Confirmed in source (launcher.ts:366 uses https.get on an http:// URL) and empirically: Node (v24, which install.ps1 provisions) throws ERR_INVALID_PROTOCOL synchronously, rejecting the promise before the resolve(false) error handler is registered, and a simulated scheduler callback crashed with exit code 1. No launch script sets --unhandled-rejections, so under NSSM every dirty-draft check path (boot with update.zip, scheduler in window, frontend apply-now) crashes the launcher; the apply-now path leaves update.zip on disk, producing a persistent crash loop that keeps the app down before startServer() runs.

`ALTO` · `esfuerzo: medium` · `Robustez multiplataforma`

#### 45. Auto-update extracts the ZIP over a running install on Windows — locked native modules make runtime updates fail and can leave a mixed-version tree

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:475`

**Evidencia y solución**

applyUpdate() runs `Expand-Archive ... -DestinationPath ROOT -Force` (launcher.ts:292-315,475) without stopping the spawned server child. The ZIP contains node_modules including better_sqlite3.node (release.yml:183-199), which the running server holds memory-mapped — on Windows overwriting a loaded native module fails with access denied, so scheduler-time updates (the normal path, launcher.ts:566) throw midway: files extracted before the locked one are already replaced, there is no rollback, and the server keeps running against a partially-updated tree (state merely reverts to 'hay_update'). Additionally, on the success path process.exit(0) (launcher.ts:485) exits the launcher while the server child may be left running holding port 3000 (spawn keeps no reference used to kill it), risking EADDRINUSE after NSSM restarts the service unless AppKillProcessTree cleans it up. Fix: kill the server child and wait for exit before extraction, extract to a staging directory and swap, and only then exit for NSSM to restart.

> ℹ️ **Verificación adversarial:** Verified in launcher.ts that applyUpdate() extracts the ZIP over ROOT (line 475) via Expand-Archive -Force without killing the spawned server (started at main:717 before the scheduler at 566 and watcher at 614), that the ZIP packages node_modules with better_sqlite3.node (release.yml:181-199) which the backend loads at startup (connection.ts:33) and thus holds locked on Windows, and that the catch block (486-496) has no rollback, leaving a partially-extracted tree with old version.json. The scheduler-window path is the designed normal update path, so runtime updates deterministically fail midway; the orphaned-child/EADDRINUSE sub-claim is plausible but secondary.

`ALTO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 46. Server child crash leaves Windows service permanently dead — NSSM supervises the launcher, not the server

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:691`

**Evidencia y solución**

startServer() spawns the backend as a child and on 'exit' only logs 'Terminación inesperada. NSSM reiniciará el proceso automáticamente.' (launcher.ts:691-696). That comment is wrong: NSSM monitors the launcher process (install-service.bat:59 registers node.exe launcher\launcher.js), and the launcher stays alive (scheduler setInterval + fs.watchFile keep the event loop running). So if the backend crashes (e.g. better-sqlite3 error, port conflict), Vantek is down until someone manually restarts the service, while Docker's restart:unless-stopped correctly restarts the Linux deployment. Fix: on child exit with non-zero code, either process.exit(1) so NSSM restarts the whole service, or respawn the child with backoff.

> ℹ️ **Verificación adversarial:** Verified launcher.ts:691-696 only logs on backend child exit (no process.exit/respawn) while install-service.bat:59 has NSSM supervise the launcher, whose event loop stays alive via setInterval (line 535) and fs.watchFile (line 580); applyUpdate's process.exit(0) at line 485 confirms the intended NSSM-restart model the crash path fails to use, and docker-compose.yml's restart:unless-stopped confirms the Linux/Windows asymmetry. A backend crash therefore leaves the Windows deployment down until manual service restart.

`MEDIO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 47. No SIGTERM/SIGINT handling; in Docker Node runs as PID 1 so `docker stop` always ends in SIGKILL with the SQLite WAL open

`📍 /Users/david/TestPersonal/vantek/app/backend/src/index.ts:178`

**Evidencia y solución**

index.ts has no process.on('SIGTERM'/'SIGINT') and never calls server.close() or closeDb() (closeDb exists unused at app/backend/src/db/connection.ts:53). backend-entrypoint.sh:61 does `exec gosu node "$@"` so the Node server becomes PID 1; as PID 1 Node ignores default-action SIGTERM, so every `docker stop`/`docker compose down` waits the 10s grace period then SIGKILLs mid-write (WAL never checkpointed, in-flight better-sqlite3 transactions cut). docker-compose.yml has neither `init: true` nor `stop_grace_period`. On Windows, NSSM stop likewise terminates the tree with no graceful DB close. Fix: add SIGTERM/SIGINT handlers that close the HTTP server and call closeDb() then exit 0 (works for both Docker and NSSM's console-Ctrl+C stop method), and add `init: true` to the backend service in docker-compose.yml as a belt-and-braces measure.

> ℹ️ **Verificación adversarial:** Confirmed in code: index.ts has zero signal handlers and never calls closeDb() (defined unused at connection.ts:53); entrypoint's `exec gosu node` makes Node PID 1 so docker stop's SIGTERM is ignored and ends in SIGKILL after 10s (no init/STOPSIGNAL/stop_grace_period anywhere). Downgraded from the implied high because SQLite WAL is crash-safe — SIGKILL causes 10s stop delays, dropped in-flight requests, and possible PDF/DB cross-consistency gaps, but not DB corruption or loss of committed transactions.

`MEDIO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 48. pdf_path stored with platform-specific separators and dist-relative form — DB not portable between Windows and Docker deployments

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/pdf.service.ts:443`

**Evidencia y solución**

generarPdf returns path.relative(__dirname, outputPath), which is persisted in factura_versiones/presupuesto_versiones.pdf_path (facturas.service.ts:531). On Windows this yields '..\..\..\..\data\pdfs\x.pdf' (backslashes), on Docker '../../data/pdfs/x.pdf'. All server-side consumers re-normalize via path.basename (facturas.router.ts:152, presupuestos.router.ts:125, email.service.ts:54), which strips backslashes only when running on Windows. If a user migrates an existing vantek.db from a Windows install into the Docker deployment (both are first-class, data dir is just <root>/data), path.basename on Linux returns the whole backslashed string and every existing 'Ver PDF'/email-attachment lookup fails. Fix: store only the file name (path.basename(outputPath)) at write time.

> ℹ️ **Verificación adversarial:** Confirmed the full chain: pdf.service.ts:443 stores path.relative(__dirname, ...) verbatim (backslashed on Windows), all consumers (routes/facturas.router.ts:152, routes/presupuestos.router.ts:125, email.service.ts:54) resolve via path.basename, which POSIX-verified passes a backslashed string through whole, so a Windows-origin DB in the Docker deployment 404s every existing Ver PDF/email attachment; no normalization exists anywhere in backend or migrations. Downgraded from the implied breadth because it only triggers on a Windows-to-Linux data-dir migration, files are intact, and regenerating a PDF recovers each document.

`MEDIO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 49. migrateConfig() silently never runs on Docker — config template only exists inside CONFIG_DIR on Windows

`📍 /Users/david/TestPersonal/vantek/app/backend/src/utils/config.ts:217`

**Evidencia y solución**

migrateConfig() looks for the template at path.join(CONFIG_DIR, 'app.config.template.json') and returns silently if missing (config.ts:219-222). On Windows the release ZIP places the templates inside config/ next to the real configs (release.yml:207-208), so migration works. In Docker, templates are shipped to /app/config-default (Dockerfile:81) and backend-entrypoint.sh:40-54 seeds only app.config.json/profile.config.json into the /app/config volume — the template never reaches CONFIG_DIR, so new config keys added in updates (e.g. sistema.chromium_modo, actualizacion.*) are never merged into existing Linux installs while Windows installs get them. Fix: have migrateConfig() fall back to <APP_ROOT>/config-default/app.config.template.json, or make backend-entrypoint.sh copy the template files into /app/config on every boot.

> ℹ️ **Verificación adversarial:** Verified in code: migrateConfig() (config.ts:217-222) only checks CONFIG_DIR (/app/config in Docker, per paths.ts + WORKDIR /app) and returns silently if the template is absent; Dockerfile:81 ships templates to /app/config-default and backend-entrypoint.sh:40-54 seeds only the two real config files into the volume, never the template, while release.yml:207-208 does place templates in config/ on Windows. Existing Docker installs therefore never get new template keys merged, exactly as claimed; severity is tempered because fresh Docker installs render the full current template and current new-key reads (sistema?.chromium_modo) are defensive, with actualizacion.* being Windows-launcher config anyway.

`BAJO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 50. Express frontend fallback path only matches the Windows layout — Dockerfile ships ./public that index.ts never serves

`📍 /Users/david/TestPersonal/vantek/app/backend/src/index.ts:95`

**Evidencia y solución**

FRONTEND_DIST = path.join(APP_ROOT, 'app', 'frontend', 'dist') matches the Windows release layout (release.yml:179) but not the Docker image, where Dockerfile:86 copies the frontend to /app/public with the comment 'Frontend como fallback en Express'. In the container /app/app/frontend/dist does not exist, so with NODE_ENV=production the SPA fallback (index.ts:167-171) does res.sendFile on a missing index.html and any non-/api request that reaches the backend directly returns a 500/ENOENT; the shipped /app/public is dead weight. Fix: resolve FRONTEND_DIST from a candidate list ([<APP_ROOT>/public, <APP_ROOT>/app/frontend/dist]) the same way pdf.service.ts resolves TEMPLATES_DIR, or drop the public copy from the Dockerfile and document that Express never serves the frontend under Docker.

> ℹ️ **Verificación adversarial:** Verified: in Docker APP_ROOT=/app (no VANTEK_ROOT, WORKDIR /app per paths.ts:35 and Dockerfile), so FRONTEND_DIST=/app/app/frontend/dist never exists while Dockerfile:86 ships the frontend to /app/public as a claimed "fallback en Express" that index.ts never serves; with NODE_ENV=production baked into the image, direct non-/api requests to the backend 500 on sendFile ENOENT. However, docker-compose keeps the backend on an internal network behind nginx which serves the SPA and proxies only /api//pdfs (and index.ts comments document this), so the defect is real but latent: dead-weight image contents, a contradictory Dockerfile comment, and a broken never-exercised fallback rather than a production-path failure.

`BAJO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 51. No .gitattributes — backend-entrypoint.sh gets CRLF on Windows checkouts, breaking Docker images built from Windows

`📍 /Users/david/TestPersonal/vantek/backend-entrypoint.sh:1`

**Evidencia y solución**

The repo has no .gitattributes (verified: file absent). backend-entrypoint.sh and scripts/update-deps.sh are currently LF, but a clone on Windows with core.autocrlf=true rewrites them to CRLF in the working tree; `docker build` COPYs the CRLF file (Dockerfile:92) and the container dies at boot with `/bin/sh^M: bad interpreter` / `set: not found`. Since Windows is a first-class environment for this project (technicians, release tooling), building the Docker image from a Windows host is a realistic path. Fix: add .gitattributes with `*.sh text eol=lf`, `Dockerfile text eol=lf`, `*.bat text eol=crlf`, `*.ps1 text eol=crlf`.

> ℹ️ **Verificación adversarial:** Verified: no .gitattributes exists, backend-entrypoint.sh has unspecified text/eol attributes, Dockerfile:92 COPYs it as the ENTRYPOINT with no line-ending normalization, so a Windows checkout with autocrlf=true would produce a CRLF entrypoint that fails at container boot. However, the documented Docker build path is git pull on the Linux server and CI builds on ubuntu-latest, so the documented production flow is unaffected — this is a real but latent cross-platform hazard triggered only by Windows-host Docker builds or the Makefile's bind-mount dev workflow on Windows.

`BAJO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 52. install.ps1 tells the user to open http://localhost but the Windows deployment listens on port 3000

`📍 /Users/david/TestPersonal/vantek/install.ps1:331`

**Evidencia y solución**

The final installer message says 'Abre la aplicacion en: http://localhost'. On Windows there is no nginx on port 80: Express serves the frontend itself on PORT=3000 (index.ts:68,184; launcher spawns it with no PORT override), so the printed URL is dead and the first thing a technician sees after a successful install is a connection error. Only the Docker deployment exposes a proxy (on 8080, docker-compose.yml:36). Fix: print http://localhost:3000.

> ℹ️ **Verificación adversarial:** Verified the full chain: install.ps1:331 prints http://localhost, but the NSSM service (install-service.bat, no env config) runs launcher.ts which spawns the backend without a PORT override, and index.ts:68 defaults to 3000; the launcher's own health check targets localhost:3000 (launcher.ts:367), and port-80 nginx exists only in the Docker/Linux deployment. The printed URL is dead on Windows, but it is only a wrong message string, not a functional defect in the app.

`BAJO` · `esfuerzo: small` · `Robustez multiplataforma`

#### 53. extractZip interpolates install paths into a single-quoted PowerShell command — breaks for install dirs containing an apostrophe

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:299`

**Evidencia y solución**

`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destPath}' -Force` embeds ROOT-derived paths inside single quotes. install.ps1 lets the technician pick any -InstallDir; a path containing a single quote (e.g. under C:\Users\O'Neill) terminates the PowerShell string and the update extraction fails permanently on that machine (spaces are fine, apostrophes are not). Fix: escape single quotes by doubling them ('' in PowerShell) or pass the script via -EncodedCommand as getIdleSeconds() already does (launcher.ts:348).

> ℹ️ **Verificación adversarial:** Confirmed: launcher.ts:299 interpolates ROOT-derived paths into a single-quoted PowerShell -Command string with no escaping, and extractZip(TMP_ZIP, ROOT) at line 475 uses paths derived from the technician-chosen install.ps1 -InstallDir (free-form string, line 90), so an apostrophe in the path breaks every update extraction. Severity is low because the default/typical install dir (C:\Vantek) has no apostrophe, the path is admin-chosen (no security boundary), and impact is limited to auto-update failure on that edge-case machine.

### 5.6 · Dependencias y configuración (12: 0 crít · 1 alto · 2 medio · 9 bajo)

`ALTO` · `esfuerzo: small` · `Dependencias y configuración`

#### 54. .npmrc ignore-scripts=true silently skips OCR-asset provisioning in the Windows release and breaks documented local dev setup

`📍 /Users/david/TestPersonal/vantek/.npmrc:1`

**Evidencia y solución**

The committed .npmrc sets ignore-scripts=true, and with it npm skips postinstall AND pre/post hooks of `npm run` (verified empirically: with ignore-scripts=true, `npm run build` executes `build` but NOT `prebuild`). Consequences: (1) In release.yml the `npm run build` step (line 108-110) never runs the frontend `prebuild` (app/frontend/package.json:10 -> scripts/setup-ocr-assets.mjs), and `npm install` (line 94) never runs `postinstall`, so the shipped frontend dist lacks public/tesseract-worker/ and public/tessdata/ — contradicting the release.yml:179 comment 'incluye assets OCR'; there is no explicit setup:ocr step anywhere in release.yml. OCR is broken in the shipped Windows artifact. (2) README.md:29-32 dev instructions (`npm install && npm run dev`) and .devcontainer/devcontainer.json postCreateCommand `npm install` leave better-sqlite3 without a native binding (its install script is skipped) and no OCR assets — the backend cannot start; only CI/release/Makefile compensate with manual `npm run build-release` steps. Fix: add explicit `npm run setup:ocr --workspace=app/frontend` to release.yml before build, and either drop ignore-scripts from the repo .npmrc (pass --ignore-scripts explicitly in CI) or document/script the mandatory rebuild + setup:ocr steps for dev.

> ℹ️ **Verificación adversarial:** Verified .npmrc is git-tracked with ignore-scripts=true, empirically reproduced npm skipping prebuild (including via the exact workspace-nested `npm run build` release.yml uses), and confirmed release.yml has no setup:ocr step while OCR assets are gitignored and referenced only via local offline paths — so every shipped Windows zip silently lacks OCR assets despite the 'incluye assets OCR' comment; README/devcontainer `npm install` likewise skips better-sqlite3's install script, breaking documented dev startup. Docker/Linux is unaffected only because the Dockerfile never copies .npmrc, which explains why the defect is Windows-release-specific.

`MEDIO` · `esfuerzo: medium` · `Dependencias y configuración`

#### 55. CI matrix gap: the Windows-deployed product is never tested on Windows

`📍 /Users/david/TestPersonal/vantek/.github/workflows/ci.yml:39`

**Evidencia y solución**

ci.yml has a single `runs-on: ubuntu-latest` job (types + tests). release.yml's quality gate (lines 38-40) just re-invokes that same Ubuntu CI, then builds the Windows package on windows-latest WITHOUT running any tests there — the source-built better-sqlite3 binary, path handling, and the launcher are only smoke-tested by one `node -e require('better-sqlite3')` line (release.yml:151). Combined with the lockfile deletion (release resolves different dependency versions than CI tested), the artifact that reaches customers has effectively zero test coverage on its target OS and dependency set. Fix: add a windows-latest leg to the ci.yml matrix (npm ci, build better-sqlite3 from source as the release does, tsc + vitest), and/or run `npm test` inside release.yml after its own install.

> ℹ️ **Verificación adversarial:** Verified in both workflows: ci.yml runs types+tests only on ubuntu-latest, release.yml's gate merely re-invokes that Ubuntu CI, and the windows-latest build deletes package-lock.json and npm-installs fresh (semver ranges re-resolved), so the shipped artifact's OS and exact dependency versions are never covered by vitest anywhere — only a better-sqlite3 smoke test runs on Windows. Downgraded from the claim's implied severity because `npm run build` on Windows does run tsc for backend/frontend/launcher against the fresh deps, the native binary gets a functional smoke test plus packaging gates, and this is a latent coverage gap rather than a demonstrated defect; the fix is CI-only and compatible with the fixed architecture.

`MEDIO` · `esfuerzo: medium` · `Dependencias y configuración`

#### 56. Release build deletes package-lock.json and ships dependency versions CI never validated

`📍 /Users/david/TestPersonal/vantek/.github/workflows/release.yml:91-95`

**Evidencia y solución**

The Windows release job runs `Remove-Item -Force package-lock.json` then `npm install --workspaces --include-workspace-root`, so every published Vantek-<version>.zip contains the NEWEST in-range versions resolved at build time, not the locked versions. The comment claims 'la integridad de versiones ya la valida el job test (ci.yml)', but ci.yml validates the lock on Ubuntu (npm ci), which the release then discards — the shipped tree is unreproducible and unaudited (supply-chain exposure amplified by caret ranges everywhere and dependabot ignoring patches). The stated reason is npm/cli#4828 (Linux-generated lock missing win32 optional native bindings for Vite 8/rolldown/esbuild, per scripts/update-deps.sh:26-31). Concrete fix: regenerate the lock once on Windows (running `npm install` on win32 MERGES platform optional deps into the existing lock without dropping Linux ones) and commit it, so release.yml can use `npm ci`; alternatively keep the lock and run a targeted `npm install @rolldown/binding-win32-x64-msvc esbuild --no-save` style step for the missing bindings only.

> ℹ️ **Verificación adversarial:** Verified release.yml:91-95 deletes package-lock.json and runs npm install, then packages that freshly-resolved node_modules (line 183) into the shipped zip, while ci.yml's npm ci gate validates only the discarded lock on Ubuntu; caret ranges in all manifests plus dependabot's semver-patch ignore confirm the unaudited-version exposure. The claim stands; it is a real reproducibility/supply-chain gap, though latent (documented npm/cli#4828 workaround, fresh tree still passes build + native smoke test, harm requires an in-range upstream compromise at release time), so severity is medium rather than high/critical.

`BAJO` · `esfuerzo: small` · `Dependencias y configuración`

#### 57. Release zip packages install.ps1 AS README.md

`📍 /Users/david/TestPersonal/vantek/.github/workflows/release.yml:219`

**Evidencia y solución**

`Copy-Item 'install.ps1' "$rel\README.md"` copies the PowerShell installer's contents into the zip under the name README.md, immediately after line 218 already copied it as install.ps1. The technician opening Vantek-<version>.zip gets a 'README.md' that is raw PowerShell. Almost certainly meant `Copy-Item 'README.md' "$rel\README.md"`. Fix the source path.

> ℹ️ **Verificación adversarial:** Verified release.yml line 219 reads `Copy-Item 'install.ps1' "$rel\README.md"` immediately after line 218 already shipped install.ps1 under its own name; a real README.md exists at the repo root and no other workflow step touches README, so the zip ships PowerShell source as README.md. The claim stands; impact is cosmetic/documentation only since install.ps1 itself is packaged correctly and nothing functional depends on the zip's README.md.

`BAJO` · `esfuerzo: small` · `Dependencias y configuración`

#### 58. Stale/floating Docker base images and no dependabot docker ecosystem

`📍 /Users/david/TestPersonal/vantek/Dockerfile:100`

**Evidencia y solución**

The nginx stage uses nginx:1.27-alpine — the 1.27 mainline branch stopped receiving updates when 1.28 (stable) / 1.29 (mainline) shipped in spring 2025, so this base collects unpatched CVEs. node:24-bookworm-slim (Dockerfile:7,44,58) and nginx tags are floating (no digest pin), and .github/dependabot.yml has npm and github-actions ecosystems but NO `docker` ecosystem, so base images are never bumped automatically. Fix: move to nginx:1.28-alpine (or current stable), add a docker ecosystem entry to dependabot.yml, and optionally pin by digest for reproducibility.

> ℹ️ **Verificación adversarial:** Verified Dockerfile:100 uses nginx:1.27-alpine (an EOL mainline branch since spring 2025) and docker-compose.yml:32 actually deploys that stage; .github/dependabot.yml has only npm and github-actions ecosystems, so base images never get bumped. Claim stands as stated; severity is low because the app is LAN-deployed, nginx only serves static files, and no concrete exploitable CVE was shown.

`BAJO` · `esfuerzo: medium` · `Dependencias y configuración`

#### 59. Dockerfile contradicts the repo's own better-sqlite3 assumptions and silently drops the .npmrc policy

`📍 /Users/david/TestPersonal/vantek/Dockerfile:23-24`

**Evidencia y solución**

ci.yml:54-64, release.yml:123-138 and Makefile:16/39-41 all state the better-sqlite3 prebuilt does not reliably cover the Node 24 ABI and force `npm run build-release` from source. The Dockerfile's deps and production-deps stages (lines 23-24, 53-54) run `npm ci` on node:24-bookworm-slim with NO build toolchain (no python3/make/g++) and no explicit better-sqlite3 build step. Note `COPY package*.json ./` (line 13) does NOT copy .npmrc, so ignore-scripts is NOT in effect inside Docker (this is what lets the frontend postinstall provision OCR assets, and what lets better-sqlite3's prebuild-install run) — the image builds only as long as a prebuilt linux-x64 binary download succeeds; if prebuild-install ever falls back to node-gyp the build fails on the slim image. This install-scripts policy divergence between Docker (scripts on) and CI/local (scripts off) is implicit and undocumented. Fix: either COPY .npmrc and add an explicit `npm rebuild better-sqlite3 --build-from-source` (with a toolchain in the deps stage only), or update the stale comments if prebuilds are in fact reliable for Node 24 (better-sqlite3 12.11.1 engines list 20.x-26.x).

> ℹ️ **Verificación adversarial:** Verified in the code: root .npmrc has ignore-scripts=true, Dockerfile's COPY package*.json cannot match .npmrc so scripts run in Docker (the Dockerfile even relies on the frontend postinstall), better-sqlite3 12.11.1 hasInstallScript=true in the lockfile, and the slim-image deps/production-deps stages install no toolchain — while ci.yml, release.yml and the Makefile all declare prebuilts unreliable for Node 24 and force+verify from-source builds. The contradiction and silent policy divergence are real, but it is a latent, loud-failing build fragility (linux prebuilds for ABI 137 exist today), not a runtime defect, so severity is low.

`BAJO` · `esfuerzo: large` · `Dependencias y configuración`

#### 60. TypeScript pinned at 6.x with deprecated moduleResolution 'node' suppressed via ignoreDeprecations

`📍 /Users/david/TestPersonal/vantek/app/backend/tsconfig.json:5-6`

**Evidencia y solución**

Spot-check confirmed: `typescript ^6.0.3` is a real published version and the lock resolves exactly typescript@6.0.3 (registry latest is 7.0.2). Backend and launcher tsconfigs use moduleResolution 'node' (node10) with `"ignoreDeprecations": "6.0"` (app/backend/tsconfig.json:5-6, launcher/tsconfig.json:5-6) to silence the TS6 deprecation, and scripts/update-deps.sh:37 permanently rejects the typescript major bump because 'TS7 drops moduleResolution: node'. This is acknowledged migration debt: the suppression flag blocks the upgrade path and hides the warning that would drive the fix. Concrete improvement: migrate backend/launcher to moduleResolution 'node16'/'nodenext' (they compile CommonJS for Node 24, so this is mostly adding explicit extensions/types), then drop ignoreDeprecations and the update-deps.sh reject.

> ℹ️ **Verificación adversarial:** Verified all cited lines: backend and launcher tsconfigs both set moduleResolution 'node' with ignoreDeprecations '6.0', the lock pins typescript@6.0.3, and update-deps.sh permanently rejects the typescript major explicitly because TS7 drops moduleResolution node — a self-referential debt loop the code itself documents. The claim stands; however it is dev-time upgrade-path debt with no runtime or deployment impact, so severity is low.

`BAJO` · `esfuerzo: medium` · `Dependencias y configuración`

#### 61. Installer downloads Node, NSSM and the release zip without version pin (Node) or any checksum verification

`📍 /Users/david/TestPersonal/vantek/install.ps1:271-300`

**Evidencia y solución**

install.ps1 fetches three binaries with Get-File (plain Invoke-WebRequest, no hash check): (1) Node portable — resolved to whatever the latest 24.x is at install time (lines 173-189), so two installs on different days get different runtimes, and nodejs.org's SHASUMS256.txt is never verified; (2) NSSM 2.24 from https://nssm.cc/release/nssm-2.24.zip (line 298) — version pinned but unverified, from a mirror the script itself notes is flaky (503s), and nssm 2.24 dates from 2014; (3) the GitHub release asset picked by wildcard `Vantek-*.zip` (lines 251-259) with no checksum/signature. This runs as Administrator and installs a Windows service. Fix: pin the exact Node version (same one release.yml built against) or at minimum verify the download against SHASUMS256.txt; embed a known SHA256 for nssm-2.24.zip; publish and verify a SHA256 for Vantek-*.zip (the launcher auto-updater should verify it too).

> ℹ️ **Verificación adversarial:** Verified install.ps1: Get-File is plain Invoke-WebRequest with retries and no hash check for Node (floating latest 24.x, SHASUMS256.txt never fetched), nssm-2.24.zip, and the Vantek-*.zip asset; repo-wide grep shows no checksum logic anywhere, release.yml publishes no checksum asset, and launcher.ts downloadUpdate() also applies unverified zips. Rated low because all sources are official HTTPS endpoints (TLS 1.2 enforced) so exploitation requires upstream compromise, the Node non-pin is a documented ABI-driven design choice with a -NodeVersion override, and a same-release SHA256 would not defend against the main threat (repo compromise) — the only strong win is an embedded hash for the pinned NSSM binary.

`BAJO` · `esfuerzo: small` · `Dependencias y configuración`

#### 62. Node version contradiction: engines >=24 and installer downloads Node 24, but README and install.ps1's own docstring say Node 22

`📍 /Users/david/TestPersonal/vantek/install.ps1:46`

**Evidencia y solución**

Confirmed what the installer actually downloads: install.ps1:92 defaults `$NodeVersion = '24'`, Resolve-NodeVersion (lines 173-189) resolves the LATEST 24.x from nodejs.org/dist/index.json, fallback 24.0.0 (line 104) — so production runs Node 24.x. This matches root package.json engines node>=24 (package.json:24-26), CI/release setup-node '24', node:24 Docker images, and the better-sqlite3 ABI-137 comments. But README.md:24 states dev requirement 'Node.js 22+' and README.md:59 states the installer 'descarga Node.js 22 portable'; install.ps1's own .DESCRIPTION at line 46 also says 'Descarga Node.js 22 portable' and the Resolve-NodeVersion comment (line 167) uses 22.x examples. A dev following the README on Node 22 violates engines (unenforced — no engine-strict) and mismatches the ABI the release binary is compiled for. Fix: update README.md:24/59 and install.ps1:46,167 to Node 24.

> ℹ️ **Verificación adversarial:** Verified every cited line: install.ps1:46 and its line-166 comment say Node 22 while the script actually defaults to and downloads Node 24 (lines 92, 104, 173-189); README.md:24/59 also say Node 22, contradicting engines >=24.0.0, CI/release setup-node 24, and node:24 Docker images; .npmrc has no engine-strict so a dev on Node 22 is only warned. Real docs/comment inconsistency, but production installs are unaffected since the installer downloads 24.x regardless.

`BAJO` · `esfuerzo: small` · `Dependencias y configuración`

#### 63. Launcher is outside the workspaces and requires nodemailer it never declares

`📍 /Users/david/TestPersonal/vantek/launcher/launcher.ts:229`

**Evidencia y solución**

Root package.json workspaces list only app/backend and app/frontend (package.json:5-8); launcher/ has no package.json and is compiled by the root build:launcher script. But launcher.ts:229 does `require('nodemailer')` at runtime (sendErrorEmail). This resolves only because nodemailer happens to be a backend prod dependency hoisted to the root node_modules inside the release zip — a phantom dependency. If the backend ever drops/replaces nodemailer, or npm stops hoisting it (e.g. a version conflict nests it under app/backend/node_modules), launcher error-emails fail silently in the field (the catch only logs). The launcher also leans on root typescript and the phantom @types/node for its build. Fix: make launcher/ a workspace with its own package.json declaring nodemailer (and @types/node), or remove the runtime dependency.

> ℹ️ **Verificación adversarial:** Confirmed: launcher/ has no package.json and is not a workspace, launcher.ts:229 requires nodemailer which is declared only in app/backend/package.json, and the release zip layout (release.yml lines 183/202) means the require resolves solely via npm hoisting to root node_modules — a genuine phantom dependency, made shakier by release.yml deleting the lockfile and re-resolving on every build. However, the failure is latent and contained: sendErrorEmail's catch only logs, so worst case is silent loss of error-notification emails, not a launcher crash.

`BAJO` · `esfuerzo: small` · `Dependencias y configuración`

#### 64. @types/node is a phantom transitive dependency — resolved to v26 typings while the runtime is Node 24

`📍 /Users/david/TestPersonal/vantek/launcher/tsconfig.json:15`

**Evidencia y solución**

No package.json in the repo declares @types/node, yet launcher/tsconfig.json sets "types": ["node"], the backend compiles Node code, and frontend tsconfig.node.json type-checks vite.config.ts which imports 'path'. It only works because @types/better-sqlite3, @types/nodemailer, @types/express-serve-static-core etc. depend on @types/node '*' (verified in package-lock.json), currently hoisting @types/node 26.1.1 — typings for Node 26 while engines demand >=24 and production ships Node 24.x, so tsc will happily accept APIs that don't exist at runtime, and any transitive re-resolution can change or break type-checking. Fix: add "@types/node": "^24" as an explicit devDependency (root or per workspace).

> ℹ️ **Verificación adversarial:** Verified every element: launcher/tsconfig.json:15 requires "types": ["node"], no package.json in root or either workspace declares @types/node, package-lock.json resolves it to 26.1.1 solely via transitive "@types/node": "*" ranges from @types/better-sqlite3/nodemailer/express-serve-static-core etc., while engines, Dockerfile (node:24-bookworm-slim) and install.ps1 (portable Node 24, ABI 137) pin runtime to Node 24. The claim stands as a genuine phantom-dependency plus typings/runtime version skew, but it is latent hygiene/fragility with no current runtime failure, so severity is low.

`BAJO` · `esfuerzo: small` · `Dependencias y configuración`

#### 65. Version identity split: version.json 1.5.0 vs package.json 0.1.0, and README names a release asset that no longer exists

`📍 /Users/david/TestPersonal/vantek/version.json:2`

**Evidencia y solución**

version.json (the launcher's update source of truth) says 1.5.0 while root and both workspace package.json files all say 0.1.0 — release.yml:112-117 overwrites version.json from the git tag at build time, so the committed 1.5.0 is permanently stale and package.json versions are never bumped, making local/dev builds report contradictory versions. Additionally README.md:49 instructs downloading `Vantek-release.zip`, but release.yml:240 names the asset `Vantek-<version>.zip` (only the wildcard-matching code in install.ps1:251 and the launcher tolerate this; a human following the README looks for a file that does not exist). Fix: derive version.json from package.json (or vice versa) in one place, and update README asset naming.

> ℹ️ **Verificación adversarial:** Confirmed version.json=1.5.0 vs 0.1.0 in all three package.json files, release.yml:112-117 overwriting version.json from the tag, and README.md:49/58/76/97 naming Vantek-release.zip while release.yml:240 produces Vantek-<version>.zip (only install.ps1:251 and launcher.ts:431 tolerate this via wildcards). All automated update/install paths still work, so this is a real but purely documentation/metadata-consistency issue with no functional breakage.

### 5.7 · Mantenibilidad y DX (13: 0 crít · 0 alto · 8 medio · 5 bajo)

`MEDIO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 66. No ESLint/Prettier/editorconfig in any package; CI only runs tsc + tests

`📍 /Users/david/TestPersonal/vantek/.github/workflows/ci.yml:67`

**Evidencia y solución**

There is no .eslintrc/eslint.config.*, no .prettierrc, no .editorconfig anywhere in the repo, no lint script in root/backend/frontend/launcher package.json, and ci.yml runs only `tsc --noEmit` (backend line 67, frontend line 70) plus `npm test`. Result: 70 occurrences of `any`/`@ts-ignore`-class looseness, unused-variable and hooks-deps mistakes go undetected (e.g. the stale-closure autosave interval in FacturaPage.tsx:139-145 whose deps omit `lineas` would be flagged by react-hooks/exhaustive-deps; the dashboard config typo would be flagged by no-explicit-any). Concrete fix: add a flat eslint.config with typescript-eslint (no-explicit-any as warn, exhaustive-deps as error) + prettier, a root `npm run lint`, and a lint step in ci.yml.

> ℹ️ **Verificación adversarial:** Verified via full-repo find and package.json inspection: zero ESLint/Prettier/editorconfig files, no lint scripts anywhere, and ci.yml runs only tsc --noEmit (lines 67/70) plus npm test; the grep count of 70 any/ts-ignore occurrences is exact, and the cited FacturaPage.tsx:139-145 effect really does omit `lineas` from its deps, making the autosave interval save stale lines — a bug exhaustive-deps would catch and tsc cannot. Only minor overstatement: frontend tsconfig has noUnusedLocals/noUnusedParameters, so unused variables are already caught there (backend lacks them); adding lint tooling is CI-only and cannot affect the fixed dual-platform deployment.

`MEDIO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 67. Inconsistent router error handling: per-route try/catch with err:any instead of statusCode-aware middleware

`📍 /Users/david/TestPersonal/vantek/app/backend/src/routes/seguimiento.router.ts:77`

**Evidencia y solución**

errorHandler.ts:46-65 maps every non-Zod error to HTTP 500, so routers that need 400/404-with-message wrap calls in their own try/catch with `err: any` and read a duck-typed err.statusCode (seguimiento.router.ts:77-93, facturas.router.ts:100-106, albaranes.router.ts:88), defeating the asyncHandler abstraction the file itself advertises ('avoids try/catch in each controller'). Services throw plain Error with an ad-hoc statusCode property attached. Fix: introduce an HttpError class (message + status) in middleware/errorHandler.ts, honor err.statusCode in errorHandler, and delete the per-route try/catch blocks — also removes 5 of the backend's any-casts.

> ℹ️ **Verificación adversarial:** Verified all cited locations: errorHandler ignores err.statusCode (500 for all non-Zod), routers seguimiento:77-93/facturas:100-106/albaranes:88 use per-route catch(err:any) with duck-typed statusCode, and services throw Object.assign(new Error(...),{statusCode}). Additionally, pagos.router documents statusCode→HTTP mapping but has no try/catch, so pagos.service's 404 actually returns 500 and gets persisted as a server error — a real behavioral consequence of the missing middleware support, confirming the claim stands.

`MEDIO` · `esfuerzo: medium` · `Mantenibilidad y DX`

#### 68. Money math duplicated in 4+ places (frontend, two backend services, inline SQL)

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/facturas.service.ts:94`

**Evidencia y solución**

Subtotal/IVA/total is computed independently in: facturas.service.ts:94-102 (calcularTotales), presupuestos.service.ts:87-92 (a diverging variant where total=subtotal), the list SQL in facturas.service.ts:150-154 (the same SUM subquery pasted twice inside one query, re-implementing IVA as `*(1 + iva/100.0)`), dashboard.service.ts:111-115 (another SUM copy), and the frontend DocumentoEditor.tsx:297-298. The margin formula `coste * (1 + margen/100)` is also repeated in DocumentoEditor.tsx:116 and :268, ModalAñadirAlbaran.tsx:152 and backend agregarLineasDesdeAlbaran. Any rounding or IVA-rule change must now be found in 6+ locations across two packages; the frontend total shown while editing can silently diverge from what the backend stores and what the PDF prints (pdf.service only formats what it is given, pdf.service.ts:344-354). Fix: one shared pure module (fits naturally in the shared package from the types finding) with calcularTotales/aplicarMargen used by DocumentoEditor, both services, and have list SQL select from a single computed expression.

> ℹ️ **Verificación adversarial:** Read every cited location: calcularTotales duplicated in facturas.service.ts:94 and presupuestos.service.ts:86 (diverging variant), the SUM subquery pasted twice with inline IVA in facturas.service.ts:150-154, another SUM copy in dashboard.service.ts:111-115, frontend re-implementation of subtotal/IVA/total in DocumentoEditor.tsx, and the margin formula coste*(1+margen/100) in DocumentoEditor, ModalAñadirAlbaran, and agregarLineasDesdeAlbaran — all confirmed verbatim, and pdf.service.ts only formats totals it is given. The formulas are currently consistent (no live bug) and the presupuesto no-IVA variant is intentional, so severity is medium rather than high: it is genuine duplication of money math across two packages that a shared pure module would fix without touching the fixed architecture.

`MEDIO` · `esfuerzo: medium` · `Mantenibilidad y DX`

#### 69. Test gaps on the highest-risk paths: PDF template engine, presupuesto lifecycle, config migration

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/pdf.service.ts:257`

**Evidencia y solución**

Backend tests cover only seguimiento, facturas (partial), pagos, migrate and reset. Untested critical paths: (1) pdf.service.ts renderTemplate/finBloque/partirElse (lines 205-290) — a hand-rolled nested {{#if}}/{{#each}} parser that users can feed CUSTOM templates through documentos.template_html/template_path (cargarPlantilla:173-192); a regression here corrupts every generated invoice and it is trivially unit-testable (pure functions). (2) presupuestos.service — no test file at all, despite cambiarEstado('aceptado') driving the trabajo-creation/seguimiento sync that seguimiento tests only exercise indirectly, and its calcularTotales intentionally differing from facturas'. (3) utils/config.ts mergeDeep/migrateConfig (189-239) which rewrites user config on every boot. (4) Frontend: only Badge/toast.store/config.store have tests; DocumentoEditor's pricing logic (margin recompute at :116/:268, totals at :297-298) — the money math users see — has none. Adding pure-function tests for (1), (3) and (4) is cheap and high-value.

> ℹ️ **Verificación adversarial:** Verified the full test inventory (backend: seguimiento/facturas/pagos/migrate/reset only; frontend: Badge/toast.store/config.store only) and confirmed each cited untested path exists as described: the hand-rolled template parser at pdf.service.ts:205-290 fed by user-custom templates via cargarPlantilla:173-192, presupuestos.service with no test file despite cambiarEstado/divergent calcularTotales, config.ts mergeDeep/migrateConfig:189-239 rewriting user config on boot (migrate.test.ts covers only DB schema), and DocumentoEditor's untested margin/totals money math at :268 and :296-299. Only caveat: the pdf parser functions are module-private so unit-testing requires exporting them, which is trivial and does not refute the claim; it is a coverage gap, not an active defect, so medium severity stands.

`MEDIO` · `esfuerzo: medium` · `Mantenibilidad y DX`

#### 70. Seguimiento state machine duplicated between backend service and frontend page

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/seguimiento.service.ts:115`

**Evidencia y solución**

The business-critical cancellation/transition rules exist twice: backend seguimiento.service.ts:115-150 (ESTADOS_CANCELABLES, ESTADOS_OBRA_INICIADA, ESTADOS_TERMINALES, ORDEN_SEGUIMIENTO) and frontend SeguimientoFichaPage.tsx:64-98 (ESTADOS_OBRA_INICIADA, ESTADOS_TERMINALES, ESTADOS_DEFECTO, getTransiciones). The default estado order additionally appears in backend utils/config.ts:141-149 (ESTADOS_SEGUIMIENTO_REFORMAS/TALLER) and again in SeguimientoPage.tsx:64-68 and SeguimientoFichaPage.tsx:76-80. If a state is added or a cancellation rule changes, five files in two packages must agree or the UI will offer transitions the backend rejects (or hide legal ones). The ESTADO_LABELS map is also pasted twice (SeguimientoPage.tsx:48-60, SeguimientoFichaPage.tsx:100-112). Move the estado union, ordered lists, transition function and labels into the shared package.

> ℹ️ **Verificación adversarial:** Verified every cited location: cancellation/terminal/obra-iniciada rules and estado lists are independently declared and actively used in backend seguimiento.service.ts (115-150, enforced at 290/297/403), frontend SeguimientoFichaPage.tsx (64-98, used at 238/285/646), config.ts (141-149), and SeguimientoPage.tsx (48-68), with no shared package in the workspace. Downgraded from a potential high because the ordered flow is actually config-driven at runtime (frontend reads profile.seguimiento.estados from the backend; the frontend lists are commented fallback-only), so the copies currently agree and only the cancellation-rule constants pose real drift risk.

`MEDIO` · `esfuerzo: medium` · `Mantenibilidad y DX`

#### 71. ConfigPage.tsx (1089 lines) bundles 13 components plus a config-migration layer that belongs in the backend

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Config/ConfigPage.tsx:102`

**Evidencia y solución**

One file contains the AppConfig type, a data hook (useAppConfig:142), generic form primitives (Campo/Input/Textarea/Grid2:175-219 — reusable but unexported), five feature panels (BotonProbarEmail:221, PanelErrores:267, PanelReset:354, LogoUpload:437, TemplatesSection:563, UpdatePanel:1022), the year-rollover dialog (DialogoAnioNuevo:681) and the page itself with an untyped `set(path: string[], value: any)` mutation helper (line 741). Worse, normalizarConfig (lines 102-139) performs legacy config migration (numeracion_facturas→numeracion_factura, sistema.actualizacion backfill) in the browser, while the backend already has its own migration mechanism (utils/config.ts migrateConfig/mergeDeep:189-239) — two migration systems in two packages for the same file, and the header comment admits 'the backend writes it without validating'. Fix: split panels into pages/Config/components/, move all normalization into backend migrateConfig, and validate PUT /config/app server-side.

> ℹ️ **Verificación adversarial:** Verified every cited symbol/line in the 1089-line ConfigPage.tsx, confirmed normalizarConfig does browser-side legacy migration (rename + backfills) while backend utils/config.ts:189-239 runs a separate template-merge migration that never handles the numeracion_facturas rename (grep: zero backend hits), and config.router.ts:68-76 writes the PUT body verbatim with no validation. The claim stands as a genuine split-migration/maintainability issue; medium because saves still round-trip through frontend normalization, so no active data corruption in normal use.

`MEDIO` · `esfuerzo: medium` · `Mantenibilidad y DX`

#### 72. Factura/Presupuesto page pairs, stores and email senders are near-verbatim copies

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Documentos/FacturasListPage.tsx:1`

**Evidencia y solución**

FacturasListPage.tsx vs PresupuestosListPage.tsx differ in ~92 of 235 lines, almost all mechanical renames (store hook, ESTADOS array, routes) — one parameterized DocumentoListPage would remove ~230 lines. facturas.store.ts and presupuestos.store.ts share the identical cargarLista/cargar/guardarLineas/guardarBorrador/cambiarEstado/generarPdf/enviar/eliminar bodies (facturas.store.ts:135-206 vs presupuestos.store.ts:126-190) — a `createDocumentoStore(basePath)` factory removes the drift risk (cerrarFactura is the only real difference). FacturaPage/PresupuestoPage duplicate the AUTOSAVE_MS timer scaffolding (FacturaPage.tsx:64,123-145 vs PresupuestoPage.tsx:59,94-112) including the same stale-closure bug (interval captures initial `lineas`; deps are [actual?.id, actual?.estado]), so the bug now must be fixed twice — extract a useAutosaveBorrador hook. Backend: enviarFactura and enviarPresupuesto in email.service.ts:126-201 are ~90% identical; fold into enviarDocumento(tipo, doc, dest).

> ℹ️ **Verificación adversarial:** Read all six cited files: the list pages are near-verbatim copies differing only in renames/estados/one column; the store action bodies at the cited line ranges are identical except URL base paths (cerrarFactura and also actualizarCabecera being the only real deltas); both editor pages duplicate the exact autosave effect including the real stale-closure defect (interval captures `lineas` with deps [actual?.id, actual?.estado]); enviarFactura/enviarPresupuesto differ only in template key and default strings. The claim stands because the duplication is verifiable line-for-line and drift has already begun (send/delete handlers diverge between the page pairs).

`MEDIO` · `esfuerzo: large` · `Mantenibilidad y DX`

#### 73. No shared types package: API contracts defined 2-3 times and already drifting

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/store/facturas.store.ts:51`

**Evidencia y solución**

Every API contract is hand-duplicated between packages with observable drift. Evidence: (1) Factura/LineaFactura defined in frontend facturas.store.ts:51-108, again in backend facturas.service.ts:59-90 (FacturaRow/LineaFactura), and a third dead copy in backend src/types/index.ts:260-290; same for Presupuesto and Seguimiento (seguimiento.service.ts:49-89 vs seguimiento.store.ts vs types/index.ts:304-327). (2) AppConfig exists in THREE disagreeing shapes: backend utils/config.ts:79-132 (email.smtp has user/pass/from, dashboard.dias_factura_sin_cobrar, sistema.chromium_modo), frontend config.store.ts:51-102 (invents a separate email.auth block that does not match the real file, omits dashboard entirely, adds conceptos_defecto and numeracion_factura.reinicio_pendiente), and ConfigPage.tsx:47-94 (omits dias_factura_sin_cobrar and chromium_modo). (3) The update-state.json protocol shared by backend index.ts:127 (readUpdateState(): any), launcher/launcher.ts:67 and ConfigPage UpdatePanel has no shared phase type. Concrete fix: add an app/shared workspace (or app/backend exports a types-only entry) with the domain types, estado unions, API DTOs, AppConfig/ProfileConfig and the update-state contract; both tsconfigs already use path aliases so wiring is cheap.

> ℹ️ **Verificación adversarial:** Verified all three evidence points in the code: Factura/LineaFactura defined in facturas.store.ts:51-93, facturas.service.ts:52-90, and a dead drifted copy in backend types/index.ts:258-290 (no backend file imports Factura/Presupuesto/Seguimiento from '../types'); AppConfig exists in four disagreeing shapes and the config router returns/writes raw JSON with no DTO transformation, so config.store.ts's invented email.auth block genuinely mismatches the real payload; update-state phase is typed as `any` in backend index.ts:127 while launcher.ts:77-95 and ConfigPage.tsx:1023 each define incompatible local unions. Kept at medium because the drift is currently latent (nothing reads email.auth, verbatim pass-through preserves unknown keys) rather than an active runtime bug, and the proposed shared-types workspace is compile-time only, not an architecture change.

`BAJO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 74. Four declared dependencies are completely unused (zod, react-hook-form, @hookform/resolvers, date-fns)

`📍 /Users/david/TestPersonal/vantek/app/backend/package.json:22`

**Evidencia y solución**

grep across src/tests finds zero imports of zod in backend or frontend, and zero imports of react-hook-form, @hookform/resolvers or date-fns in the frontend, yet all are runtime dependencies (backend package.json deps 'zod'; frontend deps '@hookform/resolvers', 'date-fns', 'react-hook-form', 'zod'). errorHandler.ts:53 even special-cases 'ZodError' — a dead branch since no schema is ever parsed; all request validation is manual `if (!req.body.x)` checks (e.g. seguimiento.router.ts:60, facturas.router.ts:129). Either adopt zod for the routers (which would also fix the untyped req.body flowing into services) or remove the four packages; today they inflate the Windows portable install and mislead readers about how validation works.

> ℹ️ **Verificación adversarial:** Confirmed via grep: zod (backend) and zod/react-hook-form/@hookform/resolvers/date-fns (frontend) are declared as runtime dependencies with zero imports anywhere; the only references are a comment and the name-based 'ZodError' check in errorHandler.ts:53, which is unreachable since no schema is ever parsed, and routers (seguimiento, facturas) validate manually with if-checks. Purely a dependency-hygiene/maintainability issue with no functional impact, so severity is low.

`BAJO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 75. any-cast on typed config hides a real bug: dias_factura_sin_cobrar is never read

`📍 /Users/david/TestPersonal/vantek/app/backend/src/services/dashboard.service.ts:105`

**Evidencia y solución**

dashboard.service.ts:104-105 does `(config as any).dashboard?.dias_presupuesto_antiguo` and `(config as any).dashboard?.dashboard?.dias_factura_sin_cobrar`. The doubled `.dashboard` means the configured value is silently ignored and the fallback 30 is always used. getAppConfig() already returns a typed AppConfig whose dashboard section contains both keys (utils/config.ts:104-108), so the cast is not only unnecessary — it is exactly what let the typo compile. Same file casts every query result to any[] (lines 124, 158, 184, 224), as do albaranes.service.ts:88/121 and clientes.service.ts:132/139. Fix: delete the `as any` on config (compiler will flag line 105 immediately) and type .all() results with row interfaces.

> ℹ️ **Verificación adversarial:** Confirmed by reading dashboard.service.ts:105 — the doubled `.dashboard?.dashboard?` path is always undefined against the typed AppConfig (config.ts:104-108) and the setup-written JSON (setup.service.ts:229), so the configured dias_factura_sin_cobrar is silently ignored and 30 is always used; the `as any` cast is what let it compile, and all cited any[] casts exist. Impact is contained because the fallback equals the setup default and the settings UI doesn't expose this field, so divergence requires hand-editing app.config.json.

`BAJO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 76. ~100 lines of dead types in backend types/index.ts plus an unused @types-app alias

`📍 /Users/david/TestPersonal/vantek/app/backend/src/types/index.ts:227`

**Evidencia y solución**

The Presupuesto/PresupuestoEstado/PresupuestoListItem, Factura/FacturaEstado/FacturaListItem, LineaDocumento, DocumentoVersion, Seguimiento/SeguimientoEstado and BaseEntity types (types/index.ts:227-327 area) are imported by nothing — verified by grepping every `from '../types'` import; the services define their own competing versions (facturas.service.ts:52-90, presupuestos.service.ts:49-83, seguimiento.service.ts:49-111). These stale shapes actively mislead (e.g. types/index.ts Factura has iva_importe and presupuesto_id fields the real code never produces). The tsconfig path alias `@types-app` (backend tsconfig.json paths) is also never used — all imports are relative. Delete the dead types (or make this file the single source and have services import from it), and drop the unused alias.

> ℹ️ **Verificación adversarial:** Repo-wide grep confirms the Presupuesto/Factura/LineaDocumento/DocumentoVersion/Seguimiento types in types/index.ts are imported nowhere, the services define their own diverging row types (e.g. real FacturaRow uses presupuesto_origen_id, not presupuesto_id, and never stores iva_importe), and the @types-app alias appears only in tsconfig/vitest config with zero imports. Only correction: BaseEntity is NOT dead — live exported types in the same file extend it — so it must be kept; the rest of the claim stands as a genuine dead-code/misleading-types issue.

`BAJO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 77. Currency/date formatters re-implemented in 8+ files with no shared util

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/pages/Documentos/components/DocumentoEditor.tsx:66`

**Evidencia y solución**

`fmt(n)` (es-ES currency formatting) is independently defined in DocumentoEditor.tsx:66 (exported but ignored elsewhere), FacturasListPage.tsx:44, PresupuestosListPage.tsx:44, ModalAñadirAlbaran.tsx:73, DashboardPage.tsx:47, PagosObra.tsx:36 and AlbaranFichaPage.tsx:289 (as formatEuros); `fmtFecha` is defined 4 ways with different output formats (PanelHistorial.tsx:49, DashboardPage.tsx:62, SeguimientoFichaPage.tsx:114, SeguimientoPage.tsx:70). The profile translator t() is also implemented twice with identical logic (backend utils/config.ts:242-252, frontend config.store.ts:131-141), and HTML-escape helpers three times (pdf.service.ts:105, email.service.ts:118 textoAHtml, SeguimientoPage.tsx escapeHtml). Create src/utils/format.ts (frontend) and reuse; consistent number/date rendering is user-visible in a billing app.

> ℹ️ **Verificación adversarial:** Grep-verified every cited location: seven independent es-ES currency formatters (with inconsistent output — some include the € symbol, some do not), four frontend fmtFecha variants plus a fifth in pdf.service.ts, duplicated t() traversal in backend config.ts and frontend config.store.ts, and three HTML-escape helpers; frontend src/utils has no format module and DocumentoEditor's exported fmt is imported nowhere. The claim stands as described, but it is duplication/maintainability only with no functional defect, so severity is low.

`BAJO` · `esfuerzo: small` · `Mantenibilidad y DX`

#### 78. Axios error boilerplate is dead code in ~15 call sites and double-notifies users

`📍 /Users/david/TestPersonal/vantek/app/frontend/src/utils/api.ts:42`

**Evidencia y solución**

The shared interceptor (api.ts:42-52) already toasts every error AND rejects with `new Error(message)`, stripping `response`. Yet ~15 catch blocks copy the pattern `e.response?.data?.error ?? e.message ?? '...'` (SeguimientoFichaPage.tsx:266,280,309,328,350; AlbaranFichaPage.tsx:175,189,243; PresupuestoPage.tsx:186,208; NuevoAlbaranModal.tsx:223; SeguimientoPage.tsx:117; ClienteFichaPage.tsx:252; seguimiento.store.ts:173): the `e.response` branch is always undefined (dead expression), and the subsequent alert()/setError duplicates the toast the interceptor already fired. Worse, facturas.store.ts:181-184 cerrarFactura reads err.response?.data?.error which is always undefined, so the specific backend refusal reason is replaced by the generic 'Error al cerrar la factura'. Fix: decide one layer for error UX (drop the global toast or the local alerts), export a `getErrorMessage(e)` helper, and delete the dead response-unwrapping in all call sites.

> ℹ️ **Verificación adversarial:** Verified api.ts interceptor both toasts and rejects with new Error(message) (no .response), and confirmed every cited catch site uses the shared api instance (directly or via stores), making e.response?.data?.error dead and the local alert/setError a duplicate of the toast; facturas.store.ts:182-184 additionally lacks an e.message fallback so FacturaPage's persistent banner shows the generic 'Error al cerrar la factura' instead of the backend's 422 reason. Claim stands in full; impact is cleanup/UX duplication, not data or logic corruption, since the correct message still surfaces via toast.

## 6 · Hallazgos refutados (verificados y descartados)

Sospechas que el verificador adversarial desmontó leyendo el código. Se documentan para que no vuelvan a plantearse.

[money] cerrarFactura is not atomic: number read and assignment are separated by await boundaries with no transaction — Read cerrarFactura, obtenerFactura, siguienteNumeroFactura, and getDb: every awaited function contains only synchronous better-sqlite3 calls, so the awaits are pure microtask boundaries, and Node drains microtasks before dispatching the next request's macrotask — a second POST /:id/cerrar cannot execute between the COUNT and the UPDATE in this single-process (no cluster/worker_threads) deployment. The claimed interleaving race is therefore impossible as described; a transaction would only be defensive hardening.

[correctness] asignarLineas with an empty linea_ids array builds 'IN ()' -> SQL syntax error 500 — Read asignarLineas (albaranes.service.ts:265-270) and the router, then empirically verified against SQLite 3.51: an empty IN () list is legal SQLite syntax (a documented SQLite extension over SQL92) that evaluates to false and returns zero rows. With linea_ids: [] the endpoint therefore assigns nothing and returns 200 — the exact 'assign none' behavior the reviewer proposes as the fix — so there is no syntax error and no 500.

[crossplatform] encontrarEdge() hardcodes C:\Program Files paths with no process.platform guard — Verified pdf.service.ts:367-414 — encontrarEdge() is Windows-only as claimed, but lanzarNavegador() already handles it: the edge probe is two instant fs.existsSync calls (no failed launch, negligible latency) followed by a designed fallback to bundled Chromium, so PDFs still generate; the 'Windows error surfaces to user' scenario is refuted because a fallback failure propagates the Chromium error, not the Edge message. Trigger requires hand-editing app.config.json to a non-default value with no UI exposure (template defaults to 'bundled', no frontend reference), leaving only a benign console.warn per PDF.

[data-integrity] busy_timeout only implicit; no explicit guard for the second-process scenarios the launcher can create — Confirmed connection.ts lacks an explicit busy_timeout, but better-sqlite3's default 5000ms busy timeout applies and the claimed dual-writer trigger is refuted: under NSSM 2.24 (installed by install.ps1/install-service.bat with defaults) the process tree — including the spawned backend — is killed when the launcher exits at launcher.ts:485, and under start.bat nothing restarts the launcher so only the single orphan backend remains; a hypothetical second backend also dies on EADDRINUSE at port 3000. The remaining scenarios (tar takes no SQLite locks; WAL readers don't block the writer) cannot produce sustained SQLITE_BUSY, leaving only a cosmetic explicit-vs-implicit pragma preference.

[maintainability] Ficha pages bypass the store layer with ad-hoc api calls and local state — Read SeguimientoFichaPage.tsx lines 300-333: it uses the stores' crearPresupuesto/crearFactura exactly where the claim says it bypasses them, and all its mutations go through stores; its only raw api calls are 2 documented read-only GETs. AlbaranFichaPage has no albaranes store to bypass, and ClienteFichaPage's inline POSTs partly need params (es_rectificativa/factura_origen_id) the store's crearFactura signature does not support — leaving only a minor style inconsistency, not the claimed systemic pattern.

---

### Nota de alcance

Todas las soluciones de este informe se mantienen dentro de la arquitectura actual: Express + SQLite + React, despliegue Windows (Node portable + NSSM + launcher) y Linux (Docker + nginx), PDF con Puppeteer y launcher sin dependencias. Ninguna recomendación introduce servicios, bases de datos ni frameworks nuevos, ni rompe la paridad entre las dos plataformas.
