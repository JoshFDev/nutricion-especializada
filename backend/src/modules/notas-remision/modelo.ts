/**
 * Tipos de notas de remision: lo que devuelve Postgres y lo que sale por
 * la API.
 *
 * Los tipos de la base usan `string` para BIGINT, NUMERIC y DATE, porque
 * `pg` no los convierte solo: un BIGINT llega como texto (para no perder
 * precision en ids grandes), un NUMERIC como texto (para no arrastrar el
 * double) y una DATE como texto tambien. El mapeo a number/string esta en
 * `modelo.ts` de precios y se copia aqui a proposito, con la misma regla:
 * si un numero viene de Postgres y se usa sin convertir, el `+` de dos
 * strings concatena y el subtotal de la nota sale como "100.0090.00".
 */

/** Cabecera, tal como la devuelve la consulta. */
export interface FilaNota {
  id: string;
  folio_id: string;
  folio_numero: number;
  serie: string;
  cliente_id: string;
  cliente_nombre: string;
  vendedor_id: string | null;
  vendedor_nombre: string | null;
  fecha: string;
  direccion_entrega: string | null;
  subtotal: string;
  estatus: EstatusNota;
  motivo_cancelacion: string | null;
  creado_en: Date;
  actualizado_en: Date;
}

export type EstatusNota = 'pendiente' | 'parcial' | 'pagada' | 'cancelada';

/** Renglon, tal como la devuelve la consulta. */
export interface FilaRenglon {
  id: string;
  nota_id: string;
  producto_id: string;
  producto_codigo: string;
  producto_nombre: string;
  almacen_id: number;
  almacen_nombre: string;
  cantidad_bultos: string;
  kg_bulto: string;
  precio_unit_kg: string;
  subtotal: string;
}

/** Existencia de un producto en un almacen, para validar antes de guardar. */
export interface FilaExistencia {
  producto_id: string;
  almacen_id: number;
  producto_activo: boolean;
  existencia: string;
}

/** Lo que sale por la API: la cabecera con el renglon anadido. */
export interface Nota {
  id: number;
  folio_id: number;
  folio: string;
  cliente_id: number;
  cliente: string;
  vendedor_id: number | null;
  vendedor: string | null;
  fecha: string;
  direccion_entrega: string | null;
  subtotal: number;
  estatus: EstatusNota;
  motivo_cancelacion: string | null;
  creado_en: string;
  actualizado_en: string;
  renglones: Renglon[];
}

export interface Renglon {
  id: number;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  almacen_id: number;
  almacen: string;
  cantidad_bultos: number;
  kg_bulto: number;
  precio_unit_kg: number;
  subtotal: number;
}

export interface NotaListada {
  id: number;
  folio: string;
  cliente_id: number;
  cliente: string;
  vendedor: string | null;
  fecha: string;
  subtotal: number;
  estatus: EstatusNota;
  renglones: number;
}

/** Como devuelve el listado, igual que en productos y precios. */
export interface Listado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/** Folio del talonario, para la pantalla de administracion. */
export interface Folio {
  id: number;
  serie: string;
  folio_numero: number;
  completo: string;
  estatus: 'disponible' | 'usado' | 'cancelado';
  nota_id: number | null;
}

/**
 * `serie + folio_numero` en un solo texto: "A-1001".
 *
 * Es lo que se muestra y lo que se busca, no algo que el frontend tenga
 * que armar. Un numero suelto no dice nada: el mismo 1001 en la serie A y
 * en la serie B son dos documentos distintos.
 */
export const componerFolio = (serie: string, numero: number): string => `${serie}-${numero}`;

/** Una fecha de Postgres puede venir como Date o como string segun la columna. */
export const formatearFecha = (valor: Date | string): string => {
  if (typeof valor === 'string') return valor.slice(0, 10);
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
};

export const mapearRenglon = (f: FilaRenglon): Renglon => ({
  id: Number(f.id),
  producto_id: Number(f.producto_id),
  producto_codigo: f.producto_codigo,
  producto_nombre: f.producto_nombre,
  almacen_id: f.almacen_id,
  almacen: f.almacen_nombre,
  cantidad_bultos: Number(f.cantidad_bultos),
  kg_bulto: Number(f.kg_bulto),
  precio_unit_kg: Number(f.precio_unit_kg),
  subtotal: Number(f.subtotal),
});

/**
 * La cabecera sin renglones.
 *
 * El listado la usa tal cual (no trae renglones: traerlos todos para 50
 * notas seria cargar la pantalla entera de Pedido n.) y el detalle le
 * pega los suyos despues.
 */
export const mapearNota = (f: FilaNota, renglones: Renglon[] = []): Nota => ({
  id: Number(f.id),
  folio_id: Number(f.folio_id),
  folio: componerFolio(f.serie, f.folio_numero),
  cliente_id: Number(f.cliente_id),
  cliente: f.cliente_nombre,
  vendedor_id: f.vendedor_id === null ? null : Number(f.vendedor_id),
  vendedor: f.vendedor_nombre,
  fecha: formatearFecha(f.fecha),
  direccion_entrega: f.direccion_entrega,
  subtotal: Number(f.subtotal),
  estatus: f.estatus,
  motivo_cancelacion: f.motivo_cancelacion,
  creado_en: f.creado_en.toISOString(),
  actualizado_en: f.actualizado_en.toISOString(),
  renglones,
});
