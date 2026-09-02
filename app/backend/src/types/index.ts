/**
 * ──────────────────────────────────────────────────────────────────────────────
 * index.ts (types) — Central TypeScript type definitions
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IT DOES
 *   Declares every shared TypeScript interface/type for the backend domain:
 *   API envelopes, usuarios, clientes/agrupadores/trabajos, proveedores,
 *   albaranes, document lines, presupuestos, facturas, versions, seguimiento,
 *   setup payloads and the default/app config shapes.
 *
 * RELATIONSHIPS
 *   Imports:
 *     · (none) → pure type declarations
 *   Used by:
 *     · services & routers across the backend → typed entities and payloads
 *       (e.g. setup.router.ts imports SetupPayload, PerfilNegocio)
 *
 * EXPORTS
 *   · BaseEntity, ApiResponse<T>, ApiError → base + API shapes
 *   · UserRole, Usuario → user infrastructure
 *   · Cliente(+ConAgrupadores), Agrupador(+ConTrabajos) → client hierarchy
 *   · TrabajoEstado, Trabajo, TrabajoBrief, TrabajoConContexto → trabajos
 *   · Proveedor, Albaran(+Linea/Estado/ListItem) → suppliers & delivery notes
 *   · LineaTipo, LineaDocumento → document line model
 *   · Presupuesto(Estado/ListItem), Factura(Estado/ListItem) → documents
 *   · DocumentoVersion, SeguimientoEstado, Seguimiento → versions & tracking
 *   · PerfilNegocio, SetupPayload, DefaultConfig, AppConfig → setup & config
 *
 * INPUTS / OUTPUTS
 *   Input:  n/a (compile-time only)
 *   Output: type-level exports
 *
 * NOTES
 *   · coste_unitario / margen_porcentaje on LineaDocumento are internal and must
 *     never reach a PDF.
 *   · The AppConfig here is the type-only mirror; @utils/config has its own.
 * ──────────────────────────────────────────────────────────────────────────────
 */
// ─── Base ────────────────────────────────────────────────────────────────────

export interface BaseEntity {
  id: string;
  created_at: string;
  updated_at: string;
}

// ─── Respuestas API ───────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}

// ─── Usuarios ────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'usuario';

export interface Usuario extends BaseEntity {
  nombre: string;
  email: string;
  rol: UserRole;
  activo: boolean;
}

// ─── Clientes ────────────────────────────────────────────────────────────────

export interface Cliente extends BaseEntity {
  nombre: string;
  empresa?: string;
  dni_cif?: string;
  telefono?: string;
  email?: string;
  notas?: string;
  activo: boolean;
}

export interface ClienteConAgrupadores extends Cliente {
  agrupadores: AgrupadorConTrabajos[];
  incidencias?: ClienteIncidencia[];
}

// ─── Incidencias de cliente ──────────────────────────────────────────────────

export interface ClienteIncidencia {
  id: string;
  cliente_id: string;
  seguimiento_id?: string;
  trabajo_id?: string;
  trabajo_nombre?: string;
  estado_cancelacion: string;
  motivo: string;
  created_at: string;
}

// ─── Agrupadores ─────────────────────────────────────────────────────────────

export interface Agrupador extends BaseEntity {
  cliente_id: string;
  label: string;
  descripcion?: string;
  activo: boolean;
}

export interface AgrupadorConTrabajos extends Agrupador {
  trabajos: TrabajoBrief[];
}

// ─── Trabajos ────────────────────────────────────────────────────────────────

export type TrabajoEstado = 'activo' | 'completado' | 'cancelado';

export interface Trabajo extends BaseEntity {
  agrupador_id: string;
  nombre: string;
  descripcion?: string;
  margen_porcentaje: number;
  estado: TrabajoEstado;
}

export interface TrabajoBrief {
  id: string;
  nombre: string;
  estado: TrabajoEstado;
  estado_seguimiento?: string;
  matricula?: string;
  marca_modelo?: string;
  created_at: string;
}

export interface TrabajoConContexto extends Trabajo {
  agrupador_id: string;
  agrupador_label: string;
  cliente_id: string;
  cliente_nombre: string;
  cliente_empresa?: string;
}

// ─── Anticipos / pagos por obra ───────────────────────────────────────────

export type ObraPagoTipo = 'fijo' | 'porcentaje';

export interface ObraPago {
  id: string;
  trabajo_id: string;
  tipo: ObraPagoTipo;
  valor: number;
  importe: number;
  base?: number;
  nota?: string;
  fecha: string;
  created_at: string;
}

// ─── Proveedores ─────────────────────────────────────────────────────────────

export interface Proveedor extends BaseEntity {
  nombre: string;
  telefono?: string;
  email?: string;
}

// ─── Albaranes ───────────────────────────────────────────────────────────────

export interface AlbaranLinea {
  id: string;
  albaran_id: string;
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  unidad?: string;
  orden: number;
  created_at: string;
  trabajos_asignados?: { trabajo_id: string; trabajo_nombre: string }[];
}

export interface Albaran extends BaseEntity {
  proveedor_id?: string;
  proveedor_nombre?: string;
  numero?: string;
  fecha: string;
  imagen_path?: string;
  ocr_procesado: boolean;
  notas?: string;
  lineas: AlbaranLinea[];
}

export type AlbaranEstado = 'sin_asignar' | 'parcial' | 'asignado';

export interface AlbaranListItem {
  id: string;
  proveedor_nombre?: string;
  numero?: string;
  fecha: string;
  estado: AlbaranEstado;
  trabajo_id?: string;
  trabajo_nombre?: string;
  lineas_count: number;
  lineas_asignadas: number;
  created_at: string;
}

// ─── Líneas de documento ─────────────────────────────────────────────────────

export type LineaTipo = 'material' | 'manual' | 'concepto';

export interface LineaDocumento {
  id: string;
  descripcion: string;
  detalle?: string;
  cantidad: number;
  precio_unitario: number;
  coste_unitario?: number;
  margen_porcentaje?: number;
  unidad?: string;
  tipo: LineaTipo;
  es_libre: boolean;
  orden: number;
  albaran_linea_id?: string;
}

// ─── Presupuestos ────────────────────────────────────────────────────────────

export type PresupuestoEstado = 'borrador' | 'enviado' | 'aceptado' | 'rechazado' | 'caducado';

export interface Presupuesto extends BaseEntity {
  trabajo_id: string;
  numero?: string;
  estado: PresupuestoEstado;
  notas?: string;
  borrador_data?: string;
  borrador_updated_at?: string;
  lineas: LineaDocumento[];
  subtotal: number;
  total: number;
}

export interface PresupuestoListItem {
  id: string;
  numero?: string;
  estado: PresupuestoEstado;
  trabajo_id: string;
  trabajo_nombre: string;
  agrupador_label: string;
  cliente_nombre: string;
  subtotal: number;
  created_at: string;
  updated_at: string;
}

// ─── Facturas ────────────────────────────────────────────────────────────────

export type FacturaEstado = 'borrador' | 'cerrada' | 'entregada' | 'pendiente_pago' | 'pagada';

export interface Factura extends BaseEntity {
  trabajo_id: string;
  presupuesto_id?: string;
  numero?: string;
  estado: FacturaEstado;
  notas?: string;
  borrador_data?: string;
  borrador_updated_at?: string;
  lineas: LineaDocumento[];
  subtotal: number;
  iva_porcentaje: number;
  iva_importe: number;
  total: number;
  anticipo_total?: number;
  anticipo_aplicado?: number;
  restante?: number;
}

export interface FacturaListItem {
  id: string;
  numero?: string;
  estado: FacturaEstado;
  trabajo_id: string;
  trabajo_nombre: string;
  agrupador_label: string;
  cliente_nombre: string;
  subtotal: number;
  iva_porcentaje: number;
  total: number;
  created_at: string;
  updated_at: string;
}

// ─── Versiones ───────────────────────────────────────────────────────────────

export interface DocumentoVersion {
  id: string;
  numero_version: number;
  datos: string;
  pdf_path?: string;
  created_at: string;
}

// ─── Seguimiento ─────────────────────────────────────────────────────────────

export type SeguimientoEstado =
  | 'nuevo'
  | 'contactado'
  | 'visita_agendada'
  | 'pendiente_presupuesto'
  | 'a_la_espera'
  | 'en_curso'
  | 'pendiente_facturar'
  | 'entregada'
  | 'pagada'
  | 'completado'
  | 'cancelado';

export interface Seguimiento extends BaseEntity {
  cliente_id?: string;
  nombre: string;
  telefono?: string;
  direccion?: string;
  dni_cif?: string;
  accion_peticion?: string;
  estado: SeguimientoEstado;
  trabajo_id?: string;
  notas?: string;
}

// ─── Setup ───────────────────────────────────────────────────────────────────

export type PerfilNegocio = 'reformas' | 'taller' | 'otro';

export interface SetupPayload {
  perfil: PerfilNegocio;
  entidades_custom?: {
    cliente: string;
    clientes: string;
    agrupador: string;
    agrupadores: string;
    trabajo: string;
    trabajos: string;
  };
  empresa: {
    nombre: string;
    cif: string;
    direccion?: string;
    telefono?: string;
    email?: string;
    logo?: string;
  };
}

export interface DefaultConfig {
  perfil: string;
  version: string;
  entidades: {
    cliente: string;
    clientes: string;
    agrupador: string;
    agrupadores: string;
    trabajo: string;
    trabajos: string;
  };
  menu: {
    dashboard: string;
    clientes: string;
    facturas: string;
    presupuestos: string;
    albaranes: string;
    seguimiento: string;
    configuracion: string;
  };
  documentos: {
    albaran: string;
    albaranes: string;
    presupuesto: string;
    presupuestos: string;
    factura: string;
    facturas: string;
  };
  modulos: {
    albaranes: boolean;
    seguimiento: boolean;
    matriculas: boolean;
  };
  seguimiento: {
    tipo: string;
    label: string;
    // Lista ordenada de estados del flujo aplicables a este perfil. Define qué
    // estados aparecen como filtros y por qué transiciones avanza la ficha.
    estados?: string[];
  };
  footer: {
    factura: string;
    presupuesto: string;
  };
}

export interface AppConfig {
  empresa: {
    nombre: string;
    cif: string;
    direccion: string;
    telefono: string;
    email: string;
    logo: string;
  };
  documentos: {
    iva: number;
    margen_defecto: number;
    max_versiones: number;
    numeracion_factura: {
      contador: number;
      anno: number;
      reinicio_pendiente: boolean;
    };
  };
  conceptos_defecto: Array<{
    id: string;
    label: string;
    precio_hora: number;
    unidad: string;
  }>;
  sistema: {
    email_errores: string;
    actualizacion: {
      hora_inicio: string;
      hora_fin: string;
      inactividad_minutos: number;
    };
  };
}