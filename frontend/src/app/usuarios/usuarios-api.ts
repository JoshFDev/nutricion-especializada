import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * Usuarios, roles y el cambio de contrasena.
 *
 * A diferencia de las otras pantallas del negocio, aqui casi todo lo que se
 * ve en el formulario es INMUTABLE, y no es una decision de la pantalla:
 *
 *   - **El RFC no se edita jamas.** Es la llave con la que el SAT recognizes
 *     a la persona y el `actualizarUsuarioEsquema` ni lo menciona. Se manda
 *     al alta y despues se muestra de solo lectura, porque un RFC corregido
 *     a mano es un RFC que ya no coincide con el alta del SAT.
 *   - **El correo tampoco.** Por el mismo motivo. Y ojo con el alta: es
 *     `nullish()`, o sea que un correo vacio NO es `''`, es `null`; mandar
 *     `''` es un 400 porque `''` no es un correo valido.
 *
 * Tres reglas mas vienen del servicio y hay que dejarlas visibles en la
 * pantalla, porque son la clase de error que el operador no entiende si solo
 * ve el texto del servidor:
 *
 *   - **No te puedes desactivar a ti mismo** (`NO_SELF_DESACTIVAR`).
 *   - **No te puedes quitar a ti mismo el rol de administrador**
 *     (`NO_SELF_DEMOTEAR`). Quitarse el rol a OTRO es normal, pero entonces
 *     hay que dejar otro admin activo o el sistema se queda sin nadie que lo
 *     administre (`ULTIMO_ADMIN`).
 *   - **Desactivar y cambiar roles cierran las sesiones abiertas.** Quien
 *     esta en otro equipo se cae, y no cuando expire el token: de inmediato.
 *     Por eso el reseteo de contrasena (que se usa para recuperar el acceso)
 *     NO cierra la sesion de quien lo pide, solo las demas.
 *
 * La contrasena temporal se devuelve UNICA vez, en el alta y en el reseteo, y
 * en la base solo esta el hash. Por eso la pantalla tiene que mostrarla
 *vvisible y copy-pasteable, y no esconderla en un aviso que se va solo.
 */

/** Un rol, tal como lo devuelve `GET /api/usuarios/roles`. */
export interface Rol {
  id: number;
  nombre: string;
  descripcion: string | null;
  /** Si da acceso a todo. El unico con este campo en true es Admin. */
  es_admin: boolean;
}

export interface Usuario {
  id: number;
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  rfc: string;
  email: string | null;
  /** ISO con hora: es una fecha con tiempo, no solo el dia. */
  fecha_contratacion: string;
  puesto: string | null;
  activo: boolean;
  /** El dueno del negocio. No se quita desde la pantalla. */
  es_dueno: boolean;
  /** Debe cambiar la clave que le resetearon en su proximo ingreso. */
  debe_cambiar_contrasena: boolean;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  ultimo_acceso: string | null;
  creado_en: string;
  actualizado_en: string;
  /**
   * El fondo que esta persona vera al entrar, ya resuelto.
   *
   * Llega como objeto y no como la clave guardada para que el frontend no
   * tenga que saber quantas imagenes hay ni como se llaman: esa lista es del
   * backend y cambia con una migracion (ver `usuarios/fondos-login.ts`).
   */
  fondo: FondoLogin;
  roles: Rol[];
}

/** Un fondo del login. La lista llega de `GET /api/usuarios/fondos`. */
export interface FondoLogin {
  clave: string;
  etiqueta: string;
  url: string;
}

/** La envoltura del listado (`usuarios/servicio.ts`). */
export interface ListaUsuarios {
  datos: Usuario[];
  total: number;
  limite: number;
  offset: number;
}

/**
 * El POST devuelve la clave temporal junto al usuario. Solo esta vez.
 *
 * `contrasenaTemporal` es `string | null` y el null no es un error: es el
 * caso en que el administrador escribio la clave en el alta. Ahi no hay nada
 * que mostrar ni que entregar, la persona ya la tiene.
 */
export interface UsuarioCreado {
  usuario: Usuario;
  contrasenaTemporal: string | null;
}

export interface Reseteo {
  contrasenaTemporal: string;
  /** Cuantas sesiones de las abiertas quedaron cerradas con esto. */
  sesionesCerradas: number;
}

/**
 * La forma del editor: lo que se teclea, sin normalizar.
 *
 * Los roles NO van en el form (son checkboxes sobre un catalogo), por eso
 * `cuerpoDeUsuario` los recibe aparte.
 */
export interface FormaUsuario {
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string;
  rfc: string;
  email: string;
  puesto: string;
  fecha_contratacion: string;
  /**
   * La clave del alta, en texto plano. Vacia = que la genere el sistema.
   *
   * Existe solo en el alta y no se recorta: las contrasenas admiten espacios
   * a proposito (el backend tampoco aplica `.trim()`), y un recorte aqui
   * cambiaria la clave sin aviso. `confirmar` viaja en la forma y NO en el
   * cuerpo: es para que no se equivoquen al escribirla, nada mas.
   */
  contrasena: string;
  confirmar: string;
}

/** Lo que acepta `POST /api/usuarios`. Es `strictObject`: sobra un campo y es 400. */
export interface CuerpoUsuario {
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  rfc: string;
  email: string | null;
  puesto: string | null;
  fecha_contratacion?: string;
  /**
   * La clave, si el administrador la escribio. Si no viene, el servidor
   * genera la temporal de siempre (`crearUsuarioEsquema`).
   */
  contrasena?: string;
  roles: number[];
}

/**
 * Lo que acepta `PATCH /api/usuarios/:id`.
 *
 * Solo estos cinco campos. El servicio arma el UPDATE a partir de lo que
 * llega (`COLUMNAS_EDITABLES`), asi que mandar de mas no cambia el dato pero
 * si mete ruido en el cable; y el esquema rechaza el cuerpo vacio con 400.
 */
export interface CuerpoActualizacion {
  nombre?: string;
  apellido_paterno?: string;
  apellido_materno?: string | null;
  puesto?: string | null;
  activo?: boolean;
  /**
   * La CLAVE del fondo, o null para volver al de por defecto.
   *
   * Va la clave y no la `url` a proposito: el backend valida contra su lista y
   * devuelve el `fondo` ya resuelto. Mandar la url seria pedirle al servidor
   * que se fíe de un texto que eligio el cliente.
   */
  fondo_login?: string | null;
}

// ------------------------------------------------------------------ el RFC

/**
 * La MISMA expresion que el `CHECK` de la tabla y que el esquema del backend
 * (`usuarios/esquemas.ts`). Copiada, no importada: el backend tiene su propio
 * arbol y la app no puede importar de ahi.
 *
 * Esta aqui para que el error salga pegado al campo, y no despues de un viaje
 * al servidor. El backend pone en mayusculas ANTES de validar, asi que el
 * frontend tambien lo hace: asi el `pattern` del input y la regla del servidor
 * dicen exactamente lo mismo.
 */
export const REGEX_RFC = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

/** Como lo manda el backend: recortado y en mayusculas. */
export function rfcNormalizado(texto: string): string {
  return texto.trim().toUpperCase();
}

export function rfcValido(texto: string): boolean {
  return REGEX_RFC.test(rfcNormalizado(texto));
}

// ---------------------------------------------------------------- los cuerpos

function textoONull(valor: string): string | null {
  const limpio = valor.trim();
  return limpio === '' ? null : limpio;
}

/**
 * Arma el cuerpo del alta.
 *
 * Tres cosas que no son obvias:
 *
 *   1. **El RFC va en mayusculas y sin espacios.** El esquema lo hace igual,
 *      pero mandarlo ya normalizado evita el 400 en el caso de que alguien
 *      lo escriba con el teclado en minusculas.
 *   2. **Lo vacio va como `null`, no como `''`.** Es lo que admiten los tres
 *      campos opcionales (`nullish`); `''` es un valor VALIDO para un texto
 *      pero no para el correo, y ahi lo que se quiere decir es "no hay".
 *   3. **La fecha solo va si se escribio.** El esquema la pone opcional y el
 *      servicio la rellena con hoy si no llega; mandarla vacia seria un 400
 *      del `regex`.
 *   4. **La contrasena solo va si se escribio**, y sin recortarla: los
 *      espacios adentro son parte de la clave y el backend tampoco los
 *      toca. En blanco se omite el campo entero (no `''`, que daria 400) y
 *      el servidor genera la temporal. `confirmar` jamas sale de aqui.
 */
export function cuerpoDeUsuario(forma: FormaUsuario, roles: number[]): CuerpoUsuario {
  const cuerpo: CuerpoUsuario = {
    nombre: forma.nombre.trim(),
    apellido_paterno: forma.apellido_paterno.trim(),
    apellido_materno: textoONull(forma.apellido_materno),
    rfc: rfcNormalizado(forma.rfc),
    email: textoONull(forma.email),
    puesto: textoONull(forma.puesto),
    roles,
  };
  const fecha = forma.fecha_contratacion.trim();
  if (fecha !== '') cuerpo.fecha_contratacion = fecha;
  if (forma.contrasena !== '') cuerpo.contrasena = forma.contrasena;
  return cuerpo;
}

/**
 * Arma el cuerpo de la edicion.
 *
 * `activo` NO va con los otros cuatro: la baja y la alta se alternan con un
 * PATCH de un solo campo desde el boton de la fila, para que bajar a alguien
 * no pueda reescribirle el nombre. Y se manda lo que hay, sin comparar con
 * la version anterior: el esquema pide al menos un campo y estos cuatro
 * siempre estan, asi que nunca se manda un cuerpo vacio.
 */
export function cuerpoDeActualizacion(forma: FormaUsuario): CuerpoActualizacion {
  return {
    nombre: forma.nombre.trim(),
    apellido_paterno: forma.apellido_paterno.trim(),
    apellido_materno: textoONull(forma.apellido_materno),
    puesto: textoONull(forma.puesto),
  };
}

/**
 * Los roles que se van a mandar, sin repetir y en el orden del catalogo.
 *
 * Sin repetir porque el esquema acepta hasta 5 pero el `INSERT` no lo
 * distingue, y en el orden del catalogo para que las casillas marcadas y lo
 * que se guarda sean la misma lista. El catalogo llega por nombre
 * (`ORDER BY nombre`), asi que sin esto "Cajera" marcado salia guardado al
 * final y la lista de la ficha lo muestra en otro orden.
 */
export function rolesNormalizados(seleccionados: number[], catalogo: Rol[]): number[] {
  const enCatalogo = new Set(catalogo.map((rol) => rol.id));
  return catalogo
    .map((rol) => rol.id)
    .filter((id) => seleccionados.includes(id) && enCatalogo.has(id));
}

// ------------------------------------------------------------- la cuenta

/**
 * Como se ve la cuenta en la lista.
 *
 * El orden importa: una cuenta desactivada que ademas esta bloqueada se
 * muestra como desactivada, porque eso es lo que hay que arreglar primero, y
 * "bloqueado" confundiria ("pero si no esta dado de baja...").
 */
export type EstadoCuenta = 'inactivo' | 'bloqueado' | 'debe_cambiar' | 'ok';

export function estadoDeCuenta(usuario: Usuario, ahora: Date = new Date()): EstadoCuenta {
  if (!usuario.activo) return 'inactivo';
  if (usuario.bloqueado_hasta !== null && new Date(usuario.bloqueado_hasta) > ahora) {
    return 'bloqueado';
  }
  if (usuario.debe_cambiar_contrasena) return 'debe_cambiar';
  return 'ok';
}

export const ETIQUETA_ESTADO: Record<EstadoCuenta, string> = {
  inactivo: 'Inactivo',
  bloqueado: 'Bloqueado',
  debe_cambiar: 'Debe cambiar su clave',
  ok: 'Activo',
};

/** "Juan Perez Lopez". El materno es opcional y no se pone "null". */
export function nombreCompleto(usuario: Usuario): string {
  return [usuario.nombre, usuario.apellido_paterno, usuario.apellido_materno]
    .filter((parte) => parte !== null && parte !== '')
    .join(' ');
}

/** Los roles en una linea, para la columna de la lista. */
export function rolesEnLinea(usuario: Usuario): string {
  return usuario.roles.map((rol) => rol.nombre).join(', ');
}

// --------------------------------------------------------- los candados

export type AccionDeCuenta = 'desactivar' | 'quitar_admin';

/**
 * Por que un boton NO se puede usar, en palabras. `null` si se puede.
 *
 * Las dos reglas que se saben desde la pantalla son las de "no te lo hagas
 * a ti mismo". La de `ULTIMO_ADMIN` NO se sabe aqui (habria que contar los
 * administradores activos de toda la base, y la pantalla solo tiene la
 * pagina que esta viendo), asi que el boton se deja activo y es el backend
 * el que responde: es mejor un 409 con su mensaje que un boton gris sin
 * explicacion.
 */
export function motivoDeCandado(
  accion: AccionDeCuenta,
  usuario: Usuario,
  idActual: number,
  quedaAdmin: boolean,
): string | null {
  const esElMismo = usuario.id === idActual;
  if (accion === 'desactivar') {
    if (esElMismo) return 'No puedes desactivar tu propia cuenta.';
    return null;
  }
  if (esElMismo) return 'No puedes quitarte a ti mismo el rol de administrador.';
  if (!quedaAdmin) return 'Tiene que quedar un administrador activo.';
  return null;
}

@Injectable({ providedIn: 'root' })
export class UsuariosApi {
  private readonly http = inject(HttpClient);

  /**
   * El catalogo de roles.
   *
   * No son paginados: son cinco filas fijas y salen de memoria. Es la
   * pantalla que los consulta para dibujar los checkboxes.
   */
  async roles(): Promise<Rol[]> {
    return firstValueFrom(this.http.get<Rol[]>(`${API}/usuarios/roles`));
  }

  /**
   * Los fondos de login que se pueden elegir.
   *
   * Viene del backend en vez de estar escrito aqui a mano por lo mismo que los
   * roles: la lista crece con una migracion, y si el frontend tuviera su propia
   * copia se podrian desincronizar sin que nada avise.
   */
  async fondos(): Promise<FondoLogin[]> {
    const r = await firstValueFrom(
      this.http.get<{ datos: FondoLogin[] }>(`${API}/usuarios/fondos`),
    );
    return r.datos;
  }

  /**
   * Lista con busqueda, filtro por rol y filtro de estado.
   *
   * El filtro de estado tiene tres posiciones porque el backend solo sabe
   * decir `activo: true` o `activo: false` (`listarUsuariosEsquema`), y
   * "todos" es no mandar el parametro. Por omision salen solo los ACTIVOS,
   * como en proveedores: lo que se busca el 99% de las veces es quien
   * puede entrar, y el dado de baja lo cambia quien lo busca.
   *
   * `rol` es un id y no un nombre, y el filtro es `=` y no `ILIKE` (esta en
   * el repositorio), asi que se manda el id del check.
   */
  async listar(opciones: {
    buscar?: string;
    rol?: number | null;
    activo?: 'todos' | 'activos' | 'inactivos';
    limite?: number;
    offset?: number;
  }): Promise<ListaUsuarios> {
    const params: Record<string, string | number> = {
      limite: opciones.limite ?? 50,
      offset: opciones.offset ?? 0,
    };
    if (opciones.buscar) params['buscar'] = opciones.buscar;
    if (opciones.rol) params['rol'] = opciones.rol;
    if (opciones.activo === 'activos') params['activo'] = 'true';
    if (opciones.activo === 'inactivos') params['activo'] = 'false';
    return firstValueFrom(this.http.get<ListaUsuarios>(`${API}/usuarios`, { params }));
  }

  /** El detalle. Se usa para refrescar la ficha abierta. */
  async obtener(id: number): Promise<Usuario> {
    return firstValueFrom(this.http.get<Usuario>(`${API}/usuarios/${id}`));
  }

  /** Crea. 201, con la clave temporal que hay que mostrar una vez. */
  async crear(cuerpo: CuerpoUsuario): Promise<UsuarioCreado> {
    return firstValueFrom(this.http.post<UsuarioCreado>(`${API}/usuarios`, cuerpo));
  }

  /**
   * Edita los datos y/o el estado.
   *
   * El `activo` va en el mismo PATCH y no aparte porque el candado de
   * "no te desactives" vive en el servicio (`usuarios/servicio.ts`) y se
   * comprueba sobre el campo que llega, no sobre el metodo de HTTP.
   */
  async actualizar(id: number, cuerpo: CuerpoActualizacion): Promise<Usuario> {
    return firstValueFrom(this.http.patch<Usuario>(`${API}/usuarios/${id}`, cuerpo));
  }

  /**
   * Reemplaza los roles completos.
   *
   * Es un PUT, no un PATCH: la lista que llega es la que queda, y por eso el
   * esquema exige al menos uno. Un POST "agregar rol" permitiria quedarse
   * con cero sin querer.
   */
  async asignarRoles(id: number, roles: number[]): Promise<Usuario> {
    return firstValueFrom(this.http.put<Usuario>(`${API}/usuarios/${id}/roles`, { roles }));
  }

  /**
   * Resetea la clave. La nueva vuelve una sola vez.
   *
   * No hay cuerpo y no hay `contrasena` que mandar: la genera el servidor
   * (`generarContrasenaTemporal`). Mandar una clave desde aqui dejaria en
   * manos de la pantalla decidir que clave se le pone a otra persona.
   */
  async resetearContrasena(id: number): Promise<Reseteo> {
    return firstValueFrom(this.http.post<Reseteo>(`${API}/usuarios/${id}/resetear-contrasena`, {}));
  }
}
