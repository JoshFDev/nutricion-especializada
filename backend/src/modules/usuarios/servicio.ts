import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Conflicto, ErrorValidacion, NoEncontrado, ReglaNegocio } from '../../core/errores.js';
import { enTransaccionDe } from '../../db/transaccion.js';
import type { ActualizarUsuario, AsignarRoles, CrearUsuario, ListarUsuarios } from './esquemas.js';
import type { Paginado, Usuario, UsuarioCreado } from './modelo.js';
import { mapeoUsuario } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Reglas del modulo de usuarios.
 *
 * El foco aqui no es el CRUD: es no dejar la caja sin forma de entrar.
 * Casi todo lo de este archivo son candados alrededor de la capacidad de
 * administrar cuentas.
 */

/** Columnas que el cliente puede tocar. Todo lo demas es del servidor. */
const COLUMNAS_EDITABLES = new Set([
  'nombre',
  'apellido_paterno',
  'apellido_materno',
  'puesto',
  'activo',
  'fondo_login',
]);

/**
 * Contrasena temporal para un alta o un reseteo.
 *
 * Se construye por garantia de forma: los primeros cuatro caracteres son
 * uno de cada clase (mayuscula, minuscula, numero, simbolo) y el resto
 * sale de un alfabeto sin caracteres ambiguos (0 contra O, 1 contra l o
 * I). Asi el administrador puede leerla en voz alta sin trocar un 8 por
 * una B, y cumple la politica fuerte aunque el resto sea azar.
 */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CLASES = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghjkmnpqrstuvwxyz', '23456789', '!#$%&*?'];

export function generarContrasenaTemporal(largo = 16): string {
  // El ?? es por noUncheckedIndexedAccess: TS no sabe que el indice que
  // devuelve randomInt siempre cae dentro del arreglo.
  const alAzar = (alfabeto: string): string => alfabeto[randomInt(alfabeto.length)] ?? 'a';
  // OJO: Array.from pasa (elemento, indice) a su callback, no el alfabeto.
  // Hay que envolver en una flecha, si no alAzar recibe undefined.
  const cuerpo = Array.from({ length: largo - 4 }, () => alAzar(ALFABETO));
  const unaDeCada = CLASES.map((clase) => alAzar(clase));
  // Baraja para que las clases queden repartidas y no siempre al inicio.
  return [...unaDeCada, ...cuerpo].sort(() => randomInt(3) - 1).join('');
}

/** Traduce el codigo de unicidad de Postgres a algo que el frontend sepa pintar. */
const esUnico = (error: unknown, constraint: string): boolean => {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === constraint;
};

const esAdmin = (u: { es_dueno: boolean; roles: { es_admin: boolean }[] | null }): boolean =>
  u.es_dueno || u.roles?.some((r) => r.es_admin) === true;

export async function listar(db: PoolClient, q: ListarUsuarios): Promise<Paginado<Usuario>> {
  const [filas, total] = await Promise.all([
    repo.listarUsuarios(db, q),
    repo.contarUsuarios(db, q),
  ]);
  return { datos: filas.map(mapeoUsuario), total, limite: q.limite, offset: q.offset };
}

export async function obtener(db: PoolClient, id: number): Promise<Usuario> {
  const fila = await repo.obtenerUsuario(db, id);
  if (!fila) throw new NoEncontrado('El usuario no existe');
  return mapeoUsuario(fila);
}

export const roles = (db: PoolClient) => repo.listarRoles(db);

/** Verifica que todos los ids de rol existan; devuelve el catalogo. */
async function rolesValidos(db: PoolClient, pedido: number[]) {
  const catalogo = await repo.listarRoles(db);
  const porId = new Map(catalogo.map((r) => [r.id, r]));

  const desconocidos = pedido.filter((id) => !porId.has(id));
  if (desconocidos.length > 0) {
    throw new ErrorValidacion('Uno de los roles no existe', [
      { campo: 'roles', mensaje: `Roles sin dar de alta: ${desconocidos.join(', ')}` },
    ]);
  }
  return { catalogo, porId };
}

export async function crear(
  db: PoolClient,
  actualId: number,
  datos: CrearUsuario,
): Promise<UsuarioCreado> {
  // Los roles se validan ANTES de abrir la transaccion: es una lectura
  // rapida y asi el error sale limpio, sin dejar una transaccion abierta.
  await rolesValidos(db, datos.roles);

  const contrasenaTemporal = generarContrasenaTemporal();

  const id = await enTransaccionDe(db, async (t) => {
    let nuevo: { id: number };
    try {
      nuevo = await repo.insertarUsuario(t, {
        nombre: datos.nombre,
        apellido_paterno: datos.apellido_paterno,
        apellido_materno: datos.apellido_materno ?? null,
        rfc: datos.rfc,
        email: datos.email ?? null,
        puesto: datos.puesto ?? null,
        fecha_contratacion: datos.fecha_contratacion ?? new Date().toISOString().slice(0, 10),
        contrasena: contrasenaTemporal,
      });
    } catch (error) {
      // El UNIQUE de la base es la autoridad; aqui solo se traduce el
      // codigo de Postgres a algo que el frontend sepa pintar.
      if (esUnico(error, 'usuarios_email_key')) {
        throw new Conflicto('EMAIL_DUPLICADO', 'Ya existe un usuario con ese correo');
      }
      if (esUnico(error, 'usuarios_rfc_key')) {
        throw new Conflicto('RFC_DUPLICADO', 'Ya existe un usuario con ese RFC');
      }
      throw error;
    }
    await repo.reemplazarRoles(t, nuevo.id, datos.roles);
    return nuevo.id;
  });

  void actualId;
  return { usuario: await obtener(db, id), contrasenaTemporal };
}

export async function actualizar(
  db: PoolClient,
  actualId: number,
  id: number,
  datos: ActualizarUsuario,
): Promise<Usuario> {
  const objetivo = await repo.obtenerUsuario(db, id);
  if (!objetivo) throw new NoEncontrado('El usuario no existe');

  const campos: Record<string, unknown> = {};
  for (const [clave, valor] of Object.entries(datos)) {
    if (!COLUMNAS_EDITABLES.has(clave)) continue;
    // null y no undefined: si se manda null hay que escribir NULL, y si
    // no viene el campo, ni se toca.
    campos[clave] = valor ?? null;
  }

  if (campos.activo === false) {
    // Candado 1: un admin que se da de baja a si mismo se queda afuera
    // de su propio sistema, y si es el unico, ya no hay vuelta.
    if (id === actualId) {
      throw new ReglaNegocio('NO_SELF_DESACTIVAR', 'No puedes desactivar tu propia cuenta');
    }
    // Candado 2: si el objetivo administra y lo bajas, tiene que quedar
    // alguien mas capaz de administrar.
    if (objetivo.activo && esAdmin(objetivo) && (await repo.contarAdminsActivos(db, id)) === 0) {
      throw new ReglaNegocio('ULTIMO_ADMIN', 'No puedes desactivar al unico administrador activo');
    }
  }

  await repo.actualizarUsuario(db, id, campos);

  // Desactivar mata sus sesiones abiertas ahora, no "cuando expire el
  // token": la cuenta ya no sirve para entrar.
  if (campos.activo === false) {
    await repo.cerrarSesiones(db, id, 'cuenta_desactivada');
  }

  return obtener(db, id);
}

export async function asignarRoles(
  db: PoolClient,
  actualId: number,
  id: number,
  datos: AsignarRoles,
): Promise<Usuario> {
  const objetivo = await repo.obtenerUsuario(db, id);
  if (!objetivo) throw new NoEncontrado('El usuario no existe');

  const { porId } = await rolesValidos(db, datos.roles);

  const mantieneAdmin = datos.roles.some((r) => porId.get(r)?.es_admin === true);

  // Candado 3: no te quites a ti mismo el rol de administrador, y no
  // dejes la base sin ninguno.
  if (esAdmin(objetivo) && !mantieneAdmin) {
    if (id === actualId) {
      throw new ReglaNegocio(
        'NO_SELF_DEMOTEAR',
        'No puedes quitarte a ti mismo el rol de administrador',
      );
    }
    if (objetivo.activo && (await repo.contarAdminsActivos(db, id)) === 0) {
      throw new ReglaNegocio(
        'ULTIMO_ADMIN',
        'No puedes quitar el rol al unico administrador activo',
      );
    }
  }

  await enTransaccionDe(db, async (t) => {
    await repo.reemplazarRoles(t, id, datos.roles);
    // Cambiar el alcance de alguien obliga a que vuelva a entrar: su
    // sesion arrastra permisos viejos en el frontend.
    await repo.cerrarSesiones(t, id, 'roles_actualizados');
  });

  return obtener(db, id);
}

/**
 * Resetea la contrasena de alguien. Devuelve la nueva UNA vez.
 *
 * Si el reseteo es sobre la propia cuenta se conserva la sesion actual
 * (el admin acaba de autenticarse y no tiene por que perder su acceso),
 * pero se matan las demas.
 */
export async function resetearContrasena(
  db: PoolClient,
  id: number,
  sesionActual: number,
): Promise<{ contrasenaTemporal: string; sesionesCerradas: number }> {
  const objetivo = await repo.obtenerUsuario(db, id);
  if (!objetivo) throw new NoEncontrado('El usuario no existe');

  const contrasenaTemporal = generarContrasenaTemporal();
  const sesionesCerradas = await enTransaccionDe(db, async (t) => {
    await repo.ponerContrasena(t, id, contrasenaTemporal);
    return repo.cerrarSesiones(t, id, 'contrasena_reseteada', sesionActual);
  });

  return { contrasenaTemporal, sesionesCerradas };
}
