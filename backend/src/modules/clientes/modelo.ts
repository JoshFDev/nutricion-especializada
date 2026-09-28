/**
 * Formas de la entidad, tal como las devuelve Postgres.
 *
 * El driver devuelve BIGINT y NUMERIC como string para no perder
 * precision, asi que llegan como `string` y se convierten en el borde de
 * la aplicacion (ver mapeoAbajo), no aqui. Estos tipos describen lo que
 * viene de la base, no lo que consume el frontend.
 */

export interface ClienteFila {
  id: string;
  codigo_cliente: string | null;
  nombre: string;
  establo: string | null;
  especie_id: number | null;
  especie: string | null;
  estatus: 'Activo' | 'Inactivo';
  telefono: string | null;
  direccion: string | null;
  rfc: string | null;
  razon_social: string | null;
  saldo_actual: string;
  creado_en: Date;
  actualizado_en: Date;
}

export interface NotaResumenFila {
  id: string;
  serie: string;
  folio_numero: number;
  fecha: Date;
  estatus: string;
  subtotal: string;
  pagado: string;
}

/** Cliente ya normalizado: numeros como numeros, fechas como ISO. */
export interface Cliente {
  id: number;
  codigo_cliente: string | null;
  nombre: string;
  establo: string | null;
  especie_id: number | null;
  especie: string | null;
  estatus: 'Activo' | 'Inactivo';
  telefono: string | null;
  direccion: string | null;
  rfc: string | null;
  razon_social: string | null;
  saldo_actual: number;
  creado_en: string;
  actualizado_en: string;
}

export interface NotaResumen {
  id: number;
  serie: string;
  folio: number;
  fecha: string;
  estatus: string;
  subtotal: number;
  pagado: number;
  saldo: number;
}

export interface ClienteConNotas extends Cliente {
  notas: NotaResumen[];
}

/**
 * Convierte la fila cruda a la forma pública.
 *
 * Vive en un solo lugar a proposito: si cada endpoint hiciera su propio
 * Number(...) se acabarian viendo inconsistencias cuando uno se olvide, y el
 * frontend recibiria "1500.00" en un campo y 1500 en otro.
 */
export function mapeoCliente(fila: ClienteFila): Cliente {
  return {
    id: Number(fila.id),
    codigo_cliente: fila.codigo_cliente,
    nombre: fila.nombre,
    establo: fila.establo,
    especie_id: fila.especie_id === null ? null : Number(fila.especie_id),
    especie: fila.especie,
    estatus: fila.estatus,
    telefono: fila.telefono,
    direccion: fila.direccion,
    rfc: fila.rfc ?? null,
    razon_social: fila.razon_social ?? null,
    saldo_actual: Number(fila.saldo_actual),
    creado_en: fila.creado_en.toISOString(),
    actualizado_en: fila.actualizado_en.toISOString(),
  };
}

export function mapeoNota(fila: NotaResumenFila): NotaResumen {
  const subtotal = Number(fila.subtotal);
  const pagado = Number(fila.pagado);
  return {
    id: Number(fila.id),
    serie: fila.serie,
    folio: Number(fila.folio_numero),
    fecha: fila.fecha.toISOString(),
    estatus: fila.estatus,
    subtotal,
    pagado,
    saldo: subtotal - pagado,
  };
}
