# Vantek — Evaluación «Karpathy Guidelines»

*Revisión del proyecto bajo las 4 directrices de comportamiento para evitar errores comunes de código con LLM. Documento accionable: cada punto incluye ubicación, problema y arreglo concreto.*

- **4** — Directrices aplicadas
- **27** — Puntos accionables
- **2 / 1 / 1** — Veredicto malo / mixto / ok
- **0** — Cambios hechos al código

Preparado para David · 22/07/2026 · Complementa a *«Vantek — Auditoría técnica y plan de mejora»*
Skill: `karpathy-guidelines` (MIT), instalada en `~/.claude/skills/`. Derivada de las observaciones de Andrej Karpathy sobre errores de código con LLM.
**No se ha modificado nada del proyecto.** Toda la evidencia proviene de hallazgos ya verificados de forma adversarial en la auditoría.

## 1 · Qué evalúa la skill

La skill define cuatro directrices de comportamiento. No es un linter: son criterios sobre *cómo* debe escribirse, revisarse y refactorizarse el código. Aquí se usan como lente de revisión sobre Vantek.

| Directriz | Qué pide |
| --- | --- |
| **1 · Think Before Coding** | Explicitar supuestos; si hay dudas, preguntar; presentar alternativas en vez de elegir en silencio; parar cuando algo no está claro. |
| **2 · Simplicity First** | El mínimo código que resuelve el problema. Nada especulativo: sin features de más, sin abstracciones de un solo uso, sin «flexibilidad» no pedida, sin manejar escenarios imposibles. |
| **3 · Surgical Changes** | Tocar solo lo imprescindible; no «mejorar» código adyacente; respetar el estilo existente; limpiar solo los huérfanos que creen tus propios cambios. |
| **4 · Goal-Driven Execution** | Convertir tareas en objetivos verificables: «arregla el bug» → «escribe un test que lo reproduzca y hazlo pasar». Criterios de éxito fuertes permiten iterar sin supervisión. |

## 2 · Resultado global

| Directriz | Veredicto | Lectura de una línea |
| --- | --- | --- |
| 1 · Think Before Coding | `Débil` | Varios supuestos nunca verificados que se convirtieron en bugs (algunos críticos). |
| 2 · Simplicity First | `Mixto` | Núcleo sobrio y bien dimensionado, rodeado de andamiaje especulativo que nunca se cableó. |
| 3 · Surgical Changes | `Débil` | La duplicación y los estilos coexistentes hacen que los arreglos se filtren o divergan. |
| 4 · Goal-Driven Execution | `Mixto` | Existe un buen patrón de tests, pero no cubre los caminos de mayor riesgo: hoy no se puede «test-primero» donde importa. |

**Leyenda de fichas:** etiqueta de severidad (crítico/alto/medio/bajo) o «nota» para *tradeoffs*/decisiones; «esfuerzo» estimado; ubicación `fichero:línea`; bloque **Problema** y bloque **Arreglo** (con código donde procede).

## 3 · Directriz 1 — Think Before Coding

> **Veredicto: débil.** El código arrastra supuestos que nunca se comprobaron y se volvieron defectos. La directriz pide explicitar y verificar supuestos; estos son los que fallaron.

`Crítico` `esfuerzo: pequeño`

#### 3.1 · Se asumió que `https.get` vale para una URL `http://`

`launcher/launcher.ts:366`

**Problema**

La llamada lanza `ERR_INVALID_PROTOCOL` de forma síncrona dentro del ejecutor de la promesa. `hasDirtyDraft()` rechaza siempre: la protección «no actualizar con un borrador sucio» nunca ha funcionado, y el rechazo puede tumbar el *scheduler* de actualización.

**Arreglo**

```ts
// usar el módulo http (no https) y blindar la llamada
import http from 'http';
const req = http.get('http://localhost:3000/api/status/draft', { headers: {…} }, cb);
// en el scheduler, evitar que un rechazo se propague:
const sucio = await hasDirtyDraft().catch(() => false);
```

`Alto` `esfuerzo: pequeño`

#### 3.2 · Se asumió que nunca se borra ni se reabre una factura (numeración por `COUNT(*)`)

`app/backend/src/services/facturas.service.ts:104`

**Problema**

El número se calcula contando facturas no-borrador del año. Al reabrir se limpia el número y al borrar una cerrada no hay guardia, así que el contador retrocede. Escenario verificado: cerrar 0001 y 0002, borrar/reabrir 0001, el siguiente cierre reemite «0002» → numeración legal duplicada.

**Arreglo**

```ts
// numerar por MAX del año, nunca por COUNT
const row = db.prepare(`SELECT MAX(numero) AS maxn FROM facturas WHERE anio_numero = ?`).get(anio);
const siguiente = (row.maxn ?? 0) + 1;
// y blindar con una restricción que la BD garantice (migración nueva):
CREATE UNIQUE INDEX ux_factura_serie ON facturas(anio_numero, numero) WHERE numero IS NOT NULL;
```

`Medio` `esfuerzo: pequeño`

#### 3.3 · Se asumió que el `setInterval` del autosave ve el estado fresco

`app/frontend/src/pages/Documentos/FacturaPage.tsx:139 · PresupuestoPage.tsx:107`

**Problema**

El intervalo captura `lineas` del render en que se montó el efecto (deps `[actual?.id, actual?.estado]`). Los borradores se autoguardan con las líneas **originales**, nunca con las ediciones. Además, esto anula la protección de «borrador sucio» del launcher.

**Arreglo**

```ts
// leer siempre las líneas vivas a través de una ref actualizada en cada render
const lineasRef = useRef(lineas);
useEffect(() => { lineasRef.current = lineas; });        // sin deps: corre cada render
useEffect(() => {
  if (!actual || !id || actual.estado !== 'borrador') return;
  autosaveTimer.current = setInterval(
    () => guardarBorrador(id, { lineas: lineasRef.current }), AUTOSAVE_MS);
  return () => { if (autosaveTimer.current) clearInterval(autosaveTimer.current); };
}, [actual?.id, actual?.estado]);
```

`Alto` `esfuerzo: pequeño`

#### 3.4 · Se asumió que la detección de inactividad funciona bajo el servicio

`launcher/launcher.ts:320,357`

**Problema**

El launcher corre como servicio NSSM en la Sesión 0, donde `GetLastInputInfo` no puede ver la actividad del usuario interactivo; ante cualquier fallo devuelve `Infinity` («siempre inactivo»). El gate de inactividad es, en la práctica, inoperante — y la ventana por defecto (15:00–16:00) cae en plena jornada.

**Arreglo**

No depender de la inactividad como garantía. Hacer explícito que el gate real es **borrador limpio + ventana horaria**; mover la ventana a la madrugada y permitir que cruce medianoche. Si se quiere conservar la comprobación de idle, marcarla como *best-effort* y documentar que no aplica bajo servicio.

`Medio` `esfuerzo: pequeño`

#### 3.5 · Se asumió que `toISOString()` da la fecha local del negocio

`app/backend/src/services/facturas.service.ts:238`

**Problema**

Las fechas de negocio derivadas de UTC se desplazan al día anterior para usuarios españoles (de madrugada, en verano hasta 2 h de desfase), y conviven comparaciones UTC/local mezcladas.

**Arreglo**

Derivar las fechas de negocio en la zona `Europe/Madrid` (formateo con `Intl`/utilidad de fecha compartida) y almacenar/comparar de forma consistente (siempre local de negocio o siempre UTC, no mezclado).

`Bajo` `esfuerzo: pequeño`

#### 3.6 · Se asumió la ruta de una clave de configuración (y un `as any` lo ocultó)

`app/backend/src/services/dashboard.service.ts:105`

**Problema**

Se lee `(config as any).dashboard?.dashboard?.dias_factura_sin_cobrar` — «dashboard» duplicado. El valor configurado se ignora siempre en favor del default de 30 días, y el `as any` impidió que el compilador avisara.

**Arreglo**

```ts
// ANTES: (config as any).dashboard?.dashboard?.dias_factura_sin_cobrar ?? 30
// DESPUÉS: getAppConfig().dashboard?.dias_factura_sin_cobrar ?? 30   // tipado, sin any
```

## 4 · Directriz 2 — Simplicity First

> **Veredicto: mixto.** El corazón es admirablemente simple (routers finos, sin ORM, un handle SQLite síncrono, config en JSON). El problema es un anillo de andamiaje especulativo que la directriz desaconseja explícitamente: cosas construidas «por si acaso» que nunca se cablearon.

`Decisión` `esfuerzo: medio`

#### 4.1 · Tabla y tipos de usuarios/auth construidos y sin usar

`app/backend/src/db/migrate.ts:38 · types/index.ts:62`

**Problema**

Existe una tabla `usuarios` con `password_hash` y roles, tipada, pero **ninguna línea de código la usa** (no hay login ni middleware). Es exactamente la «flexibilidad no solicitada» que la directriz señala.

**Arreglo (decidir, no dejar a medias)**

O bien **implementar la autenticación** apoyándose en esa tabla (ver Fase 3 del informe principal — es además un fallo de seguridad de severidad alta), o bien **eliminar la tabla y los tipos** hasta que se necesiten. Lo que la directriz prohíbe es el estado actual: el esquema sin el comportamiento.

`Bajo` `esfuerzo: pequeño`

#### 4.2 · Cinco dependencias declaradas y jamás importadas

`app/backend/package.json · app/frontend/package.json`

**Problema**

Verificado (0 imports en `src`): `zod` (backend **y** frontend), `react-hook-form`, `@hookform/resolvers`, `date-fns` y `lucide-react` (frontend). Señal de una estrategia de validación planeada y abandonada; hoy la validación de formularios es «solo nombre obligatorio».

**Arreglo (una vía, no las dos)**

```ts
// A) eliminarlas
npm uninstall zod -w app/backend -w app/frontend
npm uninstall react-hook-form @hookform/resolvers date-fns lucide-react -w app/frontend
// B) O adoptar zod en el borde de las rutas (ver 5.5 y Fase 7) — pero entonces
//    quítalo del frontend si allí no se usa. No dejar dependencias «por si acaso».
```

`Bajo` `esfuerzo: pequeño`

#### 4.3 · Manejo de un error que no puede ocurrir (rama `ZodError` muerta)

`app/backend/src/middleware/errorHandler.ts:53`

**Problema**

El `errorHandler` tiene una rama para `ZodError` que no puede dispararse nunca (nadie usa zod) — «error handling for impossible scenarios». Al mismo tiempo, **ignora** `err.statusCode`, así que los 4xx previstos por los servicios se convierten en 500 y ensucian el log de errores.

**Arreglo**

```ts
// respetar statusCode; la rama ZodError solo vive si se adopta zod (4.2-B)
const status = err.statusCode ?? (err.name === 'ZodError' ? 400 : 500);
if (status >= 500) registrarError(err);        // solo loguear lo que es 5xx real
res.status(status).json({ error: err.message });
```

`Bajo` `esfuerzo: pequeño`

#### 4.4 · ~100 líneas de tipos muertos y un alias sin uso

`app/backend/src/types/index.ts:227`

**Problema**

Interfaces no referenciadas por ningún módulo, más un alias de rutas `@types-app` sin uso. Peso de mantenimiento sin valor.

**Arreglo**

Eliminar los tipos no referenciados y el alias. (Un paso de lint con `no-unused` — Fase 7 — evita que vuelvan a acumularse.)

`Nota / tradeoff` `esfuerzo: —`

#### 4.5 · Motor de plantillas de PDF propio (~200 líneas reimplementando Handlebars)

`app/backend/src/services/pdf.service.ts:203-290`

**Observación**

Un motor `{{ }}`/`{{#if}}`/`{{#each}}` hecho a mano. La directriz de simplicidad lo marcaría como candidato a sustituir por una librería. **Pero** puede estar justificado por el principio de «instalación/launcher sin dependencias externas».

**Decisión (no acción ciega)**

Mantenerlo es defendible; lo importante es que sea una **decisión consciente y documentada** en el código, no un accidente. Si en el futuro se adopta una dependencia de plantillas en el backend (que no viaja en el launcher), reconsiderarlo.

`Medio` `esfuerzo: pequeño`

#### 4.6 · Clon profundo de toda la config en cada pulsación de tecla

`app/frontend/src/pages/Config/ConfigPage.tsx:741`

**Problema**

`JSON.parse(JSON.stringify(config))` en cada `onChange`, incluso cuando `documentos.template_html` contiene hasta 512 KB de HTML. Complejidad y coste innecesarios frente a una actualización puntual.

**Arreglo**

Actualización inmutable solo del campo editado (copia superficial por ruta) en lugar de clonar el objeto completo en cada tecla.

## 5 · Directriz 3 — Surgical Changes

> **Veredicto: débil.** La directriz pide tocar solo lo imprescindible y «respetar el estilo existente» — pero Vantek tiene **lógica duplicada y varios estilos coexistiendo**, así que un cambio «quirúrgico» tiende a filtrarse a copias o a diverger. Estos son los focos que hay que consolidar para que los arreglos de las Fases 1 y 5 no se escapen.

`Medio` `esfuerzo: medio`

#### 5.1 · Cálculo de dinero duplicado en 4+ sitios

`facturas.service.ts:94 · presupuestos.service.ts · SQL en listados · fmt() en frontend`

**Problema**

Un arreglo de redondeo (Fase 1) hay que replicarlo en los cuatro sitios o el PDF, el listado y el dashboard mostrarán céntimos distintos. Un cambio «quirúrgico» en uno solo diverge.

**Arreglo**

```ts
// una única utilidad compartida (paquete de workspace), usada por todos
export const cent = (n) => Math.round(n * 100) / 100;
export function totales(lineas, ivaPct) {
  const base = cent(lineas.reduce((a,l) => a + cent(l.precio_unitario * l.cantidad), 0));
  const iva  = cent(base * (ivaPct / 100));
  return { base, iva, total: cent(base + iva) };   // total = base + iva por construcción
}
```

`Medio` `esfuerzo: medio`

#### 5.2 · Páginas, stores y envío de email de Factura/Presupuesto casi idénticos (~80%)

`pages/Documentos/FacturaPage.tsx ≈ PresupuestoPage.tsx · FacturasListPage ≈ PresupuestosListPage`

**Problema**

Cada bug hay que arreglarlo dos veces — el propio autosave (3.3) es un ejemplo. La directriz de cambios quirúrgicos se vuelve imposible cuando hay dos copias que deben moverse juntas.

**Arreglo**

Extraer un `hook`/componente de documento compartido parametrizado por tipo (`'factura' | 'presupuesto'`): autosave, descarga de PDF, modal de envío e historial. Refactor explícito y aislado (no colar dentro de un bugfix).

`Bajo` `esfuerzo: pequeño`

#### 5.3 · `fmt()`/`fmtFecha()` reimplementados en 8+ ficheros

`DocumentoEditor.tsx:66 · FacturasListPage:44 · DashboardPage:47 · SeguimientoPage:70 · PagosObra:36 · …`

**Problema**

Formateadores de moneda/fecha copiados por todas partes, con riesgo de formato inconsistente entre pantallas.

**Arreglo**

```ts
// app/frontend/src/utils/format.ts (una sola definición, importada en todos lados)
export const fmt = (n) => new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR' }).format(n ?? 0);
export const fmtFecha = (s) => new Intl.DateTimeFormat('es-ES').format(new Date(s));
```

`Medio` `esfuerzo: pequeño`

#### 5.4 · Tres convenciones de manejo de errores conviviendo

`seguimiento.router.ts:77 (try/catch con err:any) · albaranes.service.ts:309 (enum) · facturas.service.ts:431 ({ok,error})`

**Problema**

Cada ruta maneja los errores a su manera; algunas mapean `statusCode` a mano y otras no. Corregir el flujo de errores en un sitio no se propaga al resto.

**Arreglo**

```ts
// convención única: los servicios lanzan Error con statusCode; un solo middleware lo traduce
const e = new Error('Presupuesto en uso por una factura'); e.statusCode = 409; throw e;
// y el errorHandler ya respeta statusCode (ver 4.3) → se eliminan los try/catch por ruta
```

`Bajo` `esfuerzo: pequeño`

#### 5.5 · Envelope de respuesta de la API inconsistente

`clientes/albaranes/pagos → { data } · facturas/presupuestos/seguimiento/dashboard → crudo`

**Problema**

Los clientes desenvuelven a la defensiva con `res.data.data ?? res.data` en 6+ sitios. Cualquier cambio de contrato hay que reflejarlo en todos esos *unwraps*.

**Arreglo**

Estandarizar **un único** envelope (o siempre `{ data }` o siempre crudo) y eliminar los *unwraps* defensivos. Fijarlo en el paquete de tipos compartido (5.6).

`Medio` `esfuerzo: medio`

#### 5.6 · Dos tipos `AppConfig` divergentes + máquina de estado duplicada

`config.store.ts:51 vs ConfigPage.tsx:47 · seguimiento.service.ts:115 vs SeguimientoFichaPage.tsx`

**Problema**

El mismo `AppConfig` está tipado a mano dos veces solo en el frontend (una de ellas incorrecta: `email.auth` vs `email.smtp`), y las transiciones de seguimiento están definidas en backend y frontend por separado. Los contratos ya están derivando.

**Arreglo**

Una única fuente de verdad en un **paquete de workspace compartido** (tipos de API + máquinas de estado + utilidades de dinero/fecha). Es la palanca que hace que 5.1–5.5 y las Fases 1/5 se sostengan; es una librería de workspace, no un cambio de arquitectura.

## 6 · Directriz 4 — Goal-Driven Execution

> **Veredicto: mixto.** Existe un buen patrón (tests de integración de servicio contra SQLite real, con migraciones frescas por fichero, ejecutados como *gate* de release), pero no llega a los caminos de mayor riesgo. Hoy «arregla el bug» no puede convertirse en «escribe el test que lo reproduce» donde más importa. Estos son los habilitadores.

`Alto` `esfuerzo: medio`

#### 6.1 · Cero tests de ruta/HTTP en los 9 routers

`app/backend/src/routes/*.router.ts (sin supertest en el lockfile)`

**Problema**

La validación de entrada, los códigos de estado y el `errorHandler` no tienen ninguna cobertura automática. No hay red para verificar objetivos a nivel de API.

**Arreglo — arnés supertest**

```ts
import request from 'supertest';
import app from '../src/index';
it('GET /api/config/app no expone la contraseña SMTP', async () => {
  const res = await request(app).get('/api/config/app');
  expect(res.body?.email?.smtp?.pass).not.toBe(SMTP_REAL);   // objetivo verificable
});
```

`Alto` `esfuerzo: pequeño`

#### 6.2 · Los caminos de máximo riesgo no tienen test reproductor

`numeración/cierre · redondeo de dinero · migraciones · motor de PDF · presupuestos`

**Problema**

Justo lo crítico está sin red. La forma «Karpathy» de arreglar la duplicación de numeración (3.2) es escribir primero el test que la reproduce, y luego hacerlo pasar.

**Arreglo — test que reproduce el bug de numeración**

```ts
it('no reutiliza número tras borrar una factura cerrada', async () => {
  const t = await crearTrabajoDePrueba();
  const f1 = await crear({ trabajo_id: t }); await cerrarFactura(f1.id);   // 0001
  const f2 = await crear({ trabajo_id: t }); await cerrarFactura(f2.id);   // 0002
  await eliminarFactura(f1.id);                                            // borra 0001
  const f3 = await crear({ trabajo_id: t }); const r = await cerrarFactura(f3.id);
  expect(r.factura.numero).toBe('0003');   // ❌ hoy devuelve '0002' (duplicado) → arreglar con MAX+UNIQUE
});
```

`Medio` `esfuerzo: pequeño`

#### 6.3 · 10 de 14 servicios del backend sin test

`presupuestos, pdf, albaranes, setup, dashboard, email, clientes, trabajos, errores, agrupadores`

**Problema**

Solo facturas, pagos, seguimiento y reset están cubiertos. `presupuestos` (425 líneas) refleja la lógica ya testada de facturas pero no tiene tests propios.

**Arreglo**

Priorizar `presupuestos` (espejo de facturas → alto valor, bajo coste), luego `pdf` (motor de plantillas) y `albaranes` (el `GROUP BY` con estado «parcial» inalcanzable).

`Medio` `esfuerzo: pequeño`

#### 6.4 · Sin medición de cobertura y tests del backend sin type-check

`app/backend/vitest.config.ts (sin coverage) · tsconfig.json:24 include ["src/**/*"]`

**Problema**

No hay umbral que pueda fallar en CI si la cobertura baja, y los ficheros de `tests/` quedan fuera del `tsc --noEmit`, así que sus errores de tipo pasan inadvertidos.

**Arreglo**

```ts
// vitest.config.ts — activar cobertura con umbral
test: { coverage: { provider: 'v8', reporter: ['text','html'], thresholds: { lines: 60, functions: 60 } } }
// incluir los tests en el type-check (tsconfig.json o un tsconfig.test.json en CI)
"include": ["src/**/*", "tests/**/*"]
```

`Bajo` `esfuerzo: medio`

#### 6.5 · Frontend: 3 tests simbólicos

`config.store.test.ts · toast.store.test.ts · Badge.test.tsx`

**Problema**

Seis stores (clientes, dashboard, facturas, presupuestos, seguimiento) y todas las páginas —incluido el flujo de OCR con tesseract.js— sin test.

**Arreglo**

Tests de store para facturas/presupuestos/seguimiento y, al menos, el flujo de cierre de factura (que hoy tiene las reglas de negocio solo en el cliente).

## 7 · Orden de arreglo sugerido

Cada punto de este informe mapea a una fase del informe principal de auditoría, para que puedan abordarse de forma coordinada. Los habilitadores (paquete compartido + tests) van antes o a la par de los arreglos que los necesitan.

| Punto | Arreglo | Directriz | Fase informe | Esfuerzo |
| --- | --- | --- | --- | --- |
| 3.1 | Launcher `http.get` + `.catch` | Think | Fase 0 | pequeño |
| 3.3 | Autosave con ref viva | Think | Fase 5 | pequeño |
| 3.2 | Numeración `MAX` + índice `UNIQUE` | Think | Fase 1 | pequeño |
| 3.6 | Corregir clave `dias_factura_sin_cobrar` + quitar `any` | Think | Fase 5 | pequeño |
| 3.4 | Ventana de mantenimiento + gate real documentado | Think | Fase 4 | pequeño |
| 3.5 | Fechas de negocio en zona local | Think | Fase 5 | medio |
| 4.1 | Decidir auth: implementar o eliminar tabla `usuarios` | Simplicity | Fase 3 | medio |
| 4.2 / 4.4 | Eliminar 5 deps y ~100 líneas de tipos sin uso | Simplicity | Fase 7 | pequeño |
| 4.3 | errorHandler respeta `statusCode`; decidir zod | Simplicity | Fase 5/7 | pequeño |
| 4.6 | ConfigPage sin deep-clone por tecla | Simplicity | Fase 7 | pequeño |
| 5.6 | **Paquete de workspace compartido** (tipos + estados + utils) | Surgical | Fase 7 | medio |
| 5.1 / 5.3 | Utilidad única de dinero y de formato | Surgical | Fase 1/7 | medio |
| 5.4 / 5.5 | Middleware de error único + envelope estándar | Surgical | Fase 7 | pequeño |
| 5.2 | Deduplicar Factura/Presupuesto | Surgical | Fase 7 | medio |
| 6.1 / 6.2 | Arnés supertest + test reproductor de numeración | Goal-Driven | Fase 7 | medio |
| 6.3 / 6.5 | Tests de presupuestos/pdf/albaranes y stores | Goal-Driven | Fase 7 | medio |
| 6.4 | Cobertura con umbral + type-check de tests | Goal-Driven | Fase 6/7 | pequeño |

> **Síntesis.** Vantek cumple lo que la guía valora en el **diseño macro** (simplicidad estructural) y falla en lo que valora en el **proceso**: supuestos sin verificar (Directriz 1), andamiaje especulativo (Directriz 2), duplicación que impide cambios quirúrgicos (Directriz 3) y ausencia de criterios de éxito verificables en los caminos críticos (Directriz 4). La lectura Karpathy y la auditoría técnica coinciden en la misma palanca: **una única fuente de verdad** (punto 5.6) + **tests que reproducen** los fallos de facturación (puntos 6.1–6.2). Eso es lo que convierte las Fases 1–5 en cambios quirúrgicos y verificables en vez de arreglos que se filtran.

Nota de alcance: todas las propuestas se mantienen dentro de la arquitectura actual (Express + SQLite + React; despliegue Windows y Linux). Ninguna introduce servicios, bases de datos ni frameworks nuevos, ni rompe la paridad entre plataformas. No se ha modificado ningún fichero del proyecto.
