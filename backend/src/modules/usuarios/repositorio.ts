import type { PoolClient } from 'pg';
import { consultar, consultarUno, contar } from '../../db/transaccion.js';
import type { RolFila, UsuarioFila } from './modelo.js';

/**
 * SQL del modulo de usuarios.
 *
 * Dos detalles que no son obvios:
 *
 * 1. `contrasena` SIEMPRE se escribe con crypt() dentro de Postgres.
 *    El hash nunca sale de la base y la contrasena en texto plano no se
 *    toca la tabla en ningun momento.
 *
 * 2. `es_dueno` NO se expone en la API. Se calcula con una funcion de la
 *    base para que un cliente no pueda auto-asignarse el permiso de
 *    duena por el simple hecho de mandar el campo.
 */

/** Proyeccion comun: usuario + sus roles en un solo objeto. */
const PROYECCION = `
  u.id, u.nombre, u.apellido_paterno, u.apellido_materno, u.rfc, u.email,
  u.fecha_contratacion, u.puesto, u.activo, u.es_dueno,
  u.debe_cambiar_contrasena, u.intentos_fallidos, u.bloqueado_hasta,
  u.ultimo_acceso, u.creado_en, u.actualizado_en, u.fondo_login,
  (SELECT json_agg(json_build_object(
              'id', r.id, 'nombre', r.nombre, 'descripcion', r.descripcion,
              'es_admin', r.es_admin) ORDER BY r.nombre)
     FROM usuarios_roles ur
     JOIN roles r ON r.id = ur.rol_id
    WHERE ur.usuario_id = u.id) AS roles
`;

/**
 * Arma el WHERE de busqueda, filtros y paginacion.
 *
 * El texto de `buscar` va SIEMPRE como placeholder ($n), nunca pegado
 * con template string: concatenar el dato del usuario dentro del SQL es
 * justo el error de inyeccion que la capa de repositorio no puede
 * cometer. Los permisos de PostgreSQL ya nos cubren, pero relying on
 * eso seria confiar en que nadie active DDL accidentalmente.
 */
interface FiltrosUsuarios {
  buscar?: string | undefined;
  rol?: number | undefined;
  activo?: boolean | undefined;
}

function condicionesFiltro(filtros: FiltrosUsuarios): { donde: string; valores: unknown[] } {
  const condiciones: string[] = [];
  const valores: unknown[] = [];

  if (filtros.buscar) {
    valores.push(`%${filtros.buscar}%`);
    const p = `$${valores.length}`;
    condiciones.push(`(
        u.nombre ILIKE ${p} OR u.apellido_paterno ILIKE ${p}
     OR u.apellido_materno ILIKE ${p} OR u.email ILIKE ${p}
     OR u.rfc ILIKE ${p} OR u.puesto ILIKE ${p})`);
  }

  if (filtros.rol !== undefined) {
    valores.push(filtros.rol);
    condiciones.push(
      `EXISTS (SELECT 1 FROM usuarios_roles ur WHERE ur.usuario_id = u.id
                AND ur.rol_id = $${valores.length})`,
    );
  }

  if (filtros.activo !== undefined) {
    valores.push(filtros.activo);
    condiciones.push(`u.activo = $${valores.length}`);
  }

  return {
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '',
    valores,
  };
}

export async function listarUsuarios(
  cliente: PoolClient,
  filtros: FiltrosUsuarios & { limite: number; offset: number },
): Promise<UsuarioFila[]> {
  const { donde, valores } = condicionesFiltro(filtros);

  valores.push(filtros.limite, filtros.offset);
  return consultar<UsuarioFila>(
    cliente,
    `SELECT ${PROYECCION}
       FROM usuarios u
       ${donde}
      ORDER BY u.nombre, u.apellido_paterno
      LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
    valores,
  );
}

export async function contarUsuarios(
  cliente: PoolClient,
  filtros: FiltrosUsuarios,
): Promise<number> {
  const { donde, valores } = condicionesFiltro(filtros);

  return contar(cliente, `SELECT count(*)::int AS total FROM usuarios u ${donde}`, valores);
}

export async function obtenerUsuario(cliente: PoolClient, id: number): Promise<UsuarioFila | null> {
  return consultarUno<UsuarioFila>(
    cliente,
    `SELECT ${PROYECCION} FROM usuarios u WHERE u.id = $1`,
    [id],
  );
}

export async function listarRoles(cliente: PoolClient): Promise<RolFila[]> {
  return consultar<RolFila>(
    cliente,
    `SELECT id, nombre, descripcion, es_admin
       FROM roles ORDER BY nombre`,
  );
}

/**
 * Inserta al usuario. El id se devuelve porque el resto de la operacion
 * (roles, sesion) lo necesita, y porque la API responde 201 con el
 * recurso ya creado.
 */
export async function insertarUsuario(
  cliente: PoolClient,
  datos: {
    nombre: string;
    apellido_paterno: string;
    apellido_materno: string | null;
    rfc: string;
    email: string | null;
    puesto: string | null;
    fecha_contratacion: string;
    contrasena: string;
    /**
     * Si el usuario nace con que cambiar la clave.
     *
     * Va como parametro ($9) y no como `TRUE` fijo: con contrasena temporal
     * es `true` siempre, pero si el administrador eligio la clave en el
     * formulario es `false`, porque la persona ya la sabe y forzar el cambio
     * solo agrega un paso que nadie pidio. Ver el comentario de `crear()` en
     * `servicio.ts`.
     */
    debeCambiar: boolean;
  },
): Promise<{ id: number }> {
  const fila = await consultarUno<{ id: number }>(
    cliente,
    `WITH nuevo AS (
       INSERT INTO usuarios
         (nombre, apellido_paterno, apellido_materno, rfc, email, puesto,
          fecha_contratacion, contrasena, debe_cambiar_contrasena)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date,
               crypt($8, gen_salt('bf', 12)), $9)
       RETURNING id
     )
     SELECT id::int AS id FROM nuevo`,
    [
      datos.nombre,
      datos.apellido_paterno,
      datos.apellido_materno,
      datos.rfc,
      datos.email,
      datos.puesto,
      datos.fecha_contratacion,
      datos.contrasena,
      datos.debeCambiar,
    ],
  );
  // El RETURNING garantiza la fila; el null solo aparece por el tipo.
  if (!fila) throw new Error('El INSERT de usuario no devolvio id');
  return fila;
}

/** Reemplaza el conjunto completo de roles del usuario. */
export async function reemplazarRoles(
  cliente: PoolClient,
  usuarioId: number,
  roles: number[],
): Promise<void> {
  await cliente.query(`DELETE FROM usuarios_roles WHERE usuario_id = $1`, [usuarioId]);

  // UNNEST de un array en una sola sentencia: meterlos en bucle serian N
  // viajes de ida y vuelta por nada.
  await cliente.query(
    `INSERT INTO usuarios_roles (usuario_id, rol_id, asignado_en)
     SELECT $1, r, now() FROM UNNEST($2::smallint[]) AS r`,
    [usuarioId, roles],
  );
}

/**
 * UPDATE dinamico. Los campos vienen de un objeto ya validado por Zod
 * y de una lista blanca (columnas permitidas), nunca de lo que mando
 * el cliente, asi que no hay forma de inyectar un nombre de columna.
 */
export async function actualizarUsuario(
  cliente: PoolClient,
  id: number,
  campos: Record<string, unknown>,
): Promise<void> {
  const columnas = Object.keys(campos);
  if (columnas.length === 0) return;

  const asignaciones = columnas.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = [id, ...columnas.map((c) => campos[c])];

  await cliente.query(
    `UPDATE usuarios SET ${asignaciones}, actualizado_en = now() WHERE id = $1`,
    valores,
  );
}

/**
 * Poner una contrasena nueva. `debe_cambiar_contrasena` se pone en TRUE
 * a proposito: si el administrador se la esta dictando al usuario, ese
 * usuario debe cambiarla en su primer ingreso.
 */
export async function ponerContrasena(
  cliente: PoolClient,
  id: number,
  contrasena: string,
): Promise<void> {
  await cliente.query(
    `UPDATE usuarios
        SET contrasena = crypt($2, gen_salt('bf', 12)),
            debe_cambiar_contrasena = TRUE,
            intentos_fallidos = 0,
            bloqueado_hasta = NULL,
            actualizado_en = now()
      WHERE id = $1`,
    [id, contrasena],
  );
}

/**
 * Cierra las sesiones abiertas de un usuario. Se usa cuando se le cambia
 * la contrasena: si alguien mas la tenia, esa sesion tiene que morir ya.
 *
 * `exceptoSesion` deja viva una sesion concreta. Hace falta en el reseteo
 * de la propia contrasena, donde cerrar la sesion del propio admin lo
 * dejaria fuera del sistema en el mismo instante en que entro.
 */
export async function cerrarSesiones(
  cliente: PoolClient,
  usuarioId: number,
  motivo: string,
  exceptoSesion?: number,
): Promise<number> {
  const { rows } = await cliente.query(
    `UPDATE sesiones
        SET cerrada_en = now(), cierre_motivo = $2
      WHERE usuario_id = $1
        AND cerrada_en IS NULL
        AND ($3::bigint IS NULL OR id <> $3)`,
    [usuarioId, motivo, exceptoSesion ?? null],
  );
  return rows.length;
}

/**
 * Cuentas con poder de administracion: rol Administrador o la dueña.
 *
 * Sirve para la regla que evita dejar el sistema sin admins. Usa la misma
 * definicion que fn_es_admin() a proposito: si aqui contara menos gente
 * que la que puede entrar al panel, la proteccion dejaria pasar justo el
 * caso que quiere impedir.
 */
export async function contarAdminsActivos(
  cliente: PoolClient,
  excluirUsuarioId?: number,
): Promise<number> {
  const { rows } = await cliente.query<{ total: number }>(
    `SELECT count(DISTINCT u.id)::int AS total
       FROM usuarios u
      WHERE u.activo
        AND ($2::bigint IS NULL OR u.id <> $2)
        AND (u.es_dueno
             OR EXISTS (SELECT 1 FROM usuarios_roles ur
                          JOIN roles r ON r.id = ur.rol_id
                         WHERE ur.usuario_id = u.id AND r.nombre = 'Administrador'))`,
    [null, excluirUsuarioId ?? null],
  );
  return rows[0]?.total ?? 0;
}
