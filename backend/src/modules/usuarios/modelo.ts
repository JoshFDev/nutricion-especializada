/**
 * Formas de la entidad, tal como las devuelve Postgres.
 *
 * Mismas reglas que en clientes: BIGINT llega como `string` para no perder
 * precision y NUMERIC tambien, y las fechas como `Date`. Se normalizan en
 * el borde (mapeoUsuarioAbajo) antes de salir del servicio.
 */

import { fondoDe, type FondoLogin } from './fondos-login.js';

export interface RolFila {
  id: number;
  nombre: string;
  descripcion: string | null;
  es_admin: boolean;
}

export interface UsuarioFila {
  id: string;
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  rfc: string;
  email: string | null;
  fecha_contratacion: Date;
  puesto: string | null;
  activo: boolean;
  es_dueno: boolean;
  debe_cambiar_contrasena: boolean;
  intentos_fallidos: number;
  bloqueado_hasta: Date | null;
  ultimo_acceso: Date | null;
  creado_en: Date;
  actualizado_en: Date;
  /** Clave del fondo de login, o null si no eligio ninguno. */
  fondo_login: string | null;
  /** json_agg de los roles, o null si el usuario no tiene ninguno. */
  roles: RolFila[] | null;
}

/** Usuario ya normalizado: numeros como numeros, fechas como ISO. */
export interface Usuario {
  id: number;
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  rfc: string;
  email: string | null;
  fecha_contratacion: string;
  puesto: string | null;
  activo: boolean;
  es_dueno: boolean;
  debe_cambiar_contrasena: boolean;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  ultimo_acceso: string | null;
  creado_en: string;
  actualizado_en: string;
  /**
   * El fondo que esta persona vera al entrar, ya resuelto a su `url`.
   *
   * Va resuelto y no como la clave cruda a proposito: el frontend no tiene por
   * que saber quantas imagenes hay ni como se llaman. Si maniara la clave,
   * cada vez que se agrega una foto habria que tocar el frontend tambien, y
   * es una decision que pertenece al backend (ver `fondos-login.ts`).
   */
  fondo: FondoLogin;
  roles: RolFila[];
}

export interface Paginado<T> {
  datos: T[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * Lo que devuelve POST /api/usuarios. La contrasena temporal viaja aqui
 * y en ningun otro lado: se muestra una vez y nunca se vuelve a poder
 * leer, porque en la base solo esta el hash.
 *
 * `contrasenaTemporal` es `string | null` y el null es un caso real, no una
 * comodidad: si el administrador escribio la clave en el formulario, la eligio
 * el y no hay nada que mostrar. La pantalla usa ese null para NO sacar el panel
 * de "esta clave se muestra una sola vez", porque poner ahi una clave que la
 * persona ya conoce solo confunde.
 */
export interface UsuarioCreado {
  usuario: Usuario;
  contrasenaTemporal: string | null;
}

export const mapeoRol = (fila: RolFila): RolFila => ({
  id: fila.id,
  nombre: fila.nombre,
  descripcion: fila.descripcion,
  es_admin: fila.es_admin,
});

export const mapeoUsuario = (fila: UsuarioFila): Usuario => ({
  id: Number(fila.id),
  nombre: fila.nombre,
  apellido_paterno: fila.apellido_paterno,
  apellido_materno: fila.apellido_materno,
  rfc: fila.rfc,
  email: fila.email,
  fecha_contratacion: fila.fecha_contratacion.toISOString(),
  puesto: fila.puesto,
  activo: fila.activo,
  es_dueno: fila.es_dueno,
  debe_cambiar_contrasena: fila.debe_cambiar_contrasena,
  intentos_fallidos: fila.intentos_fallidos,
  bloqueado_hasta: fila.bloqueado_hasta?.toISOString() ?? null,
  ultimo_acceso: fila.ultimo_acceso?.toISOString() ?? null,
  creado_en: fila.creado_en.toISOString(),
  actualizado_en: fila.actualizado_en.toISOString(),
  fondo: fondoDe(fila.fondo_login),
  roles: (fila.roles ?? []).map(mapeoRol),
});
