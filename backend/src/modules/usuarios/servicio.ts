import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Conflicto, ErrorValidacion, NoEncontrado, ReglaNegocio } from '../../core/errores.js';
import { enTransaccionDe } from '../../db/transaccion.js';
import { enviarCodigoBaja, enviarCuentaCreada } from './correo.js';
import type { ActualizarUsuario, AsignarRoles, CrearUsuario, ListarUsuarios } from './esquemas.js';
import type { Paginado, Usuario, UsuarioCreado, UsuarioFila } from './modelo.js';
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
  'email',
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

/* --- La eliminacion definitiva de una cuenta ---------------------------- */

/**
 * Cuanto dura el codigo de baja y cuantos errores se aguantan.
 *
 * No son numeros decorativos: 15 minutos es lo que tarda una llamada al
 * empleado, y 5 intentos es lo que aleja a quien pruebe a adivinar sin
 * volver loco a quien se equivoca al dictarlo. Con 6 digitos (un millon de
 * combinaciones) y este tope, acertar por fuerza bruta no es viable.
 */
const VIGENCIA_MINUTOS = 15;
const VIGENCIA_MS = VIGENCIA_MINUTOS * 60 * 1000;
const MAX_INTENTOS_BAJA = 5;

/** Un codigo de 6 digitos, facil de dictar por telefono. */
export function generarCodigoBaja(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
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

  /*
   * Dos caminos de alta, y no son el mismo codigo con un if suelto.
   *
   * - Sin `contrasena` en el cuerpo: se genera la temporal de siempre, el
   *   usuario nace con `debe_cambiar_contrasena` en TRUE y se le devuelve la
   *   clave para entregar. Es el camino viejo.
   * - Con `contrasena`: el administrador eligio la clave, se usa esa, y el
   *   usuario nace con `debe_cambiar_contrasena` en FALSE.
   *
   * El punto que no es obvio es el `debe_cambiar` de FALSE. Es tentador
   * dejarlo en TRUE "por seguridad", pero seria un bug de flujo: la persona ya
   * sabe su clave y la eligio el administrador, si se le obliga a cambiarla
   * lo unico que pasa es que entre, el sistema le pida otra vez y el
   * administrador se entere de un paso extra que nadie pidio. La clave ya
   * cumple la politica fuerte porque la valido el MISMO esquema que la del
   * cambio de clave.
   *
   * Y `contrasenaTemporal` sale en null cuando la eligio el administrador:
   * no hay nada que mostrar y se evita un panel "esta clave se muestra una
   * sola vez" con una clave que nadie eligio y que ya conoce la persona.
   */
  const contrasenaElegida = datos.contrasena ?? null;
  const contrasenaTemporal = contrasenaElegida ?? generarContrasenaTemporal();

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
        debeCambiar: contrasenaElegida === null,
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
  const usuario = await obtener(db, id);
  if (usuario.email) {
    const nombreCompleto = [usuario.nombre, usuario.apellido_paterno, usuario.apellido_materno]
      .filter(Boolean)
      .join(' ');
    try {
      await enviarCuentaCreada({
        nombre: nombreCompleto || usuario.nombre,
        correo: usuario.email,
        contrasenaTemporal: contrasenaElegida ? null : contrasenaTemporal,
      });
    } catch (error) {
      console.error(
        `No se pudo enviar el correo de alta al usuario ${usuario.id} (${usuario.email}):`,
        error,
      );
    }
  }
  return {
    usuario,
    contrasenaTemporal: contrasenaElegida ? null : contrasenaTemporal,
  };
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

  try {
    await repo.actualizarUsuario(db, id, campos);
  } catch (error) {
    // El UNIQUE de la base es la autoridad; aqui solo se traduce el codigo de
    // Postgres a algo que el frontend sepa pintar pegado al campo del correo.
    // Es el mismo trato que le da el alta en `crear()`.
    if (esUnico(error, 'usuarios_email_key')) {
      throw new Conflicto('EMAIL_DUPLICADO', 'Ya existe un usuario con ese correo');
    }
    throw error;
  }

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

  /**
   * A la dueña no se le resetea la contrasena.
   *
   * Borrarle la cuenta esta prohibido (`verificarPuedeEliminarse`), y
   * esta es la otra forma de quedarse con ella: resetearle la clave y
   * cambiar la temporal. El reseteo devuelve la contrasena en claro, asi
   * que quien lo hace se queda con la cuenta.
   *
   * La dueña puede cambiar su propia contrasena ella misma, desde la
   * pantalla de "cambia tu contrasena", que es el camino normal.
   */
  if (objetivo.es_dueno) {
    throw new ReglaNegocio(
      'DUENO_NO_RESETABLE',
      'La contrasena de la dueña no se puede resetear desde aqui',
    );
  }

  const contrasenaTemporal = generarContrasenaTemporal();
  const sesionesCerradas = await enTransaccionDe(db, async (t) => {
    await repo.ponerContrasena(t, id, contrasenaTemporal);
    return repo.cerrarSesiones(t, id, 'contrasena_reseteada', sesionActual);
  });

  return { contrasenaTemporal, sesionesCerradas };
}

/* ---------------------------------------------------------------------- */
/* La eliminacion definitiva de una cuenta                                */
/* ---------------------------------------------------------------------- */

/** El nombre para el correo, sin los `null` de los apellidos que faltan. */
function nombreDe(usuario: {
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
}): string {
  return [usuario.nombre, usuario.apellido_paterno, usuario.apellido_materno]
    .filter((parte) => parte !== null && parte !== '')
    .join(' ');
}

/**
 * Los candados comunes a pedir el codigo y a eliminar. Lanza si no se puede.
 *
 * Se escriben una vez porque las dos mitades del flujo tienen que exigir
 * exactamente lo mismo: si la solicitud dejara pasar algo que la eliminacion
 * rechaza, el administrador le pediria el codigo al empleado para nada.
 *
 * Las reglas, en orden:
 *
 *   1. No a tu propia cuenta: un administrador que se borra a si mismo se
 *      queda fuera de su propio sistema y, si es el unico, ya no hay vuelta.
 *   2. No a la dueña: `es_dueno` es la cuenta que garantiza que siempre haya
 *      alguien capaz de administrar. Borrarla es justo lo que hay que evitar.
 *   3. Primero desactivada: es la regla de negocio ("primero se desactiva,
 *      luego se elimina"). Desactivar es reversible y ademas ya corre sus
 *      propios candados; eliminar no tiene vuelta.
 *   4. Tiene que quedar un administrador activo. Normalmente no salta —el
 *      paso 3 ya obligo a que hubiera otro—, pero es barato y cubre el caso
 *      raro de un admin inactivo.
 */
async function verificarPuedeEliminarse(
  db: PoolClient,
  actualId: number,
  objetivo: UsuarioFila,
): Promise<void> {
  if (objetivo.id === String(actualId)) {
    throw new ReglaNegocio('NO_SELF_ELIMINAR', 'No puedes eliminar tu propia cuenta');
  }
  if (objetivo.es_dueno) {
    throw new ReglaNegocio('DUENO_INELIMINABLE', 'La cuenta de la dueña no se puede eliminar');
  }
  if (objetivo.activo) {
    throw new ReglaNegocio(
      'CUENTA_ACTIVA',
      'Primero desactiva la cuenta; hasta entonces no se puede eliminar',
    );
  }
  if (esAdmin(objetivo) && (await repo.contarAdminsActivos(db, Number(objetivo.id))) === 0) {
    throw new ReglaNegocio('ULTIMO_ADMIN', 'No puedes eliminar al único administrador activo');
  }
}

/**
 * Manda un codigo de verificacion al correo del empleado.
 *
 * Devuelve a donde se mando, para que la pantalla pueda decirselo al
 * administrador. El codigo NO vuelve: solo viaja al correo de la persona, que
 * es justo el punto —el administrador tiene que pedirselo, no recibirlo el.
 *
 * Se exige que la cuenta tenga correo: sin el no hay forma de hacerle llegar
 * el codigo a nadie, y sin codigo la eliminacion no se puede cerrar.
 */
export async function solicitarCodigoBaja(
  db: PoolClient,
  actualId: number,
  id: number,
): Promise<{ correo: string }> {
  const objetivo = await repo.obtenerUsuario(db, id);
  if (!objetivo) throw new NoEncontrado('El usuario no existe');

  await verificarPuedeEliminarse(db, actualId, objetivo);

  if (!objetivo.email) {
    throw new ReglaNegocio(
      'SIN_CORREO',
      'Esa cuenta no tiene correo; no se le puede enviar el código de verificación',
    );
  }

  const codigo = generarCodigoBaja();
  const expiraEn = new Date(Date.now() + VIGENCIA_MS);
  await repo.guardarCodigoBaja(db, id, codigo, expiraEn);

  try {
    await enviarCodigoBaja({
      nombre: nombreDe(objetivo),
      correo: objetivo.email,
      codigo,
      vigenciaMinutos: VIGENCIA_MINUTOS,
    });
  } catch (error) {
    // Sin correo no hay codigo que teclear: se tira el que se acaba de
    // guardar para no dejar un codigo valido que nadie recibio, y el error
    // sale para que el administrador sepa que no se mando.
    await repo.borrarCodigoBaja(db, id).catch(() => {
      /* el error que importa es el del correo */
    });
    console.error(`No se pudo enviar el código de baja al usuario ${id}:`, error);
    throw new ReglaNegocio(
      'CORREO_NO_ENVIADO',
      'No se pudo enviar el correo con el código. Inténtalo de nuevo.',
    );
  }

  return { correo: objetivo.email };
}

/**
 * Elimina la cuenta de verdad, con el codigo que dictó el empleado.
 *
 * El codigo se revisa FUERA de la transaccion. Es a proposito: un intento
 * fallido tiene que sumarse aunque despues se lance el error, y lanzar dentro
 * de una transaccion revierte todo lo que se hizo adentro, el `UPDATE` de los
 * intentos incluido. El borrado de la fila si va en su transaccion, para que
 * los triggers de auditoria y de permisos entren en el mismo COMMIT.
 */
export async function eliminarCuenta(
  db: PoolClient,
  actualId: number,
  id: number,
  codigo: string,
): Promise<void> {
  const objetivo = await repo.obtenerUsuario(db, id);
  if (!objetivo) throw new NoEncontrado('El usuario no existe');

  await verificarPuedeEliminarse(db, actualId, objetivo);

  const estado = await repo.leerCodigoBaja(db, id, codigo);
  if (!estado) {
    throw new ReglaNegocio(
      'SIN_CODIGO',
      'Primero pide el código de verificación que le llega al correo del empleado',
    );
  }
  if (estado.expirado) {
    await repo.borrarCodigoBaja(db, id);
    throw new ReglaNegocio('CODIGO_EXPIRADO', 'El código venció. Pide uno nuevo.');
  }
  if (!estado.coincide) {
    const intentos = await repo.sumarIntentoBaja(db, id);
    if (intentos >= MAX_INTENTOS_BAJA) {
      await repo.borrarCodigoBaja(db, id);
      throw new ReglaNegocio(
        'CODIGO_AGOTADO',
        'Demasiados intentos fallidos. Pide un código nuevo.',
      );
    }
    throw new ReglaNegocio('CODIGO_INCORRECTO', 'El código no es correcto');
  }

  const borrado = await enTransaccionDe(db, (t) => repo.eliminarUsuario(t, id));
  if (!borrado) {
    // Se valido el codigo pero ya no habia fila: otra peticion la borro en el
    // intermedio. No es un exito que haya que callar.
    throw new NoEncontrado('Esa cuenta ya no existe');
  }
}
