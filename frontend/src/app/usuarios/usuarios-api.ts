import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../nucleo/api';

/**
 * Usuarios, roles y el cambio de contraseña.
 *
 * A diferencia de las otras pantallas del negocio, aquí casi todo lo que se ve
 * en el formulario es INMUTABLE, y no es una decisión de la pantalla:
 *
 *   - **El RFC no se edita jamás.** Es la llave con la que el SAT reconoce a
 *     la persona y `actualizarUsuarioEsquema` ni siquiera lo menciona. Se
 *     manda al alta y después se muestra de solo lectura, porque un RFC
 *     corregido a mano es un RFC que ya no coincide con el alta del SAT.
 *   - **El correo tampoco.** Por el mismo motivo. Y ojo con el alta: es
 *     `nullish()`, o sea que un correo vacío NO es `''`, es `null`; mandar
 *     `''` es un 400 porque `''` no es un correo válido.
 *
 * Tres reglas más vienen del sistema y hay que dejarlas visibles en la
 * pantalla, porque son la clase de error que el operador no entiende si solo
 * ve el texto del mensaje:
 *
 *   - **No te puedes desactivar a ti mismo** (`NO_SELF_DESACTIVAR`).
 *   - **No te puedes quitar a ti mismo el rol de administrador**
 *     (`NO_SELF_DEMOTEAR`). Quitarle el rol a OTRO es normal, pero entonces
 *     hay que dejar otro admin activo o el sistema se queda sin nadie que lo
 *     administre (`ULTIMO_ADMIN`).
 *   - **Desactivar y cambiar roles cierran las sesiones abiertas.** Quien está
 *     en otro equipo se cae, y no cuando expire el acceso: de inmediato. Por
 *     eso el reinicio de contraseña (que se usa para recuperar el acceso) NO
 *     cierra la sesión de quien lo pide, solo las demás.
 *
 * La contraseña temporal se devuelve UNA sola vez, en el alta y en el
 * reinicio, y en el sistema solo queda guardada cifrada. Por eso la pantalla
 * tiene que mostrarla visible y lista para copiar, y no esconderla en un aviso
 * que se va solo.
 */

/** Un rol, tal como lo devuelve el servicio de usuarios. */
export interface Rol {
  id: number;
  nombre: string;
  descripcion: string | null;
  /** Si da acceso a todo. El único con este campo en true es Admin. */
  es_admin: boolean;
}

export interface Usuario {
  id: number;
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  rfc: string;
  email: string | null;
  /** Con hora: es una fecha con tiempo, no solo el día. */
  fecha_contratacion: string;
  puesto: string | null;
  activo: boolean;
  /** El dueño del negocio. No se quita desde la pantalla. */
  es_dueno: boolean;
  /** Debe cambiar la contraseña que le reiniciaron en su próximo ingreso. */
  debe_cambiar_contrasena: boolean;
  intentos_fallidos: number;
  bloqueado_hasta: string | null;
  ultimo_acceso: string | null;
  creado_en: string;
  actualizado_en: string;
  /**
   * El fondo que esta persona verá al entrar, ya resuelto.
   *
   * Llega como objeto y no como la clave guardada para que la pantalla no
   * tenga que saber cuántas imágenes hay ni cómo se llaman: esa lista es del
   * sistema y cambia con una actualización del sistema (ver
   * `usuarios/fondos-login.ts`).
   */
  fondo: FondoLogin;
  roles: Rol[];
}

/** Un fondo de la pantalla de entrada. La lista la da el servicio. */
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
 * Al crear, el sistema devuelve la contraseña temporal junto al usuario. Solo
 * esta vez.
 *
 * `contrasenaTemporal` es `string | null` y el null no es un error: es el
 * caso en que el administrador escribió la contraseña al dar de alta. Ahí no
 * hay nada que mostrar ni que entregar, la persona ya la tiene.
 */
export interface UsuarioCreado {
  usuario: Usuario;
  contrasenaTemporal: string | null;
}

export interface Reseteo {
  contrasenaTemporal: string;
  /** Cuántas sesiones de las abiertas quedaron cerradas con esto. */
  sesionesCerradas: number;
}

/**
 * La forma del editor: lo que se teclea, sin normalizar.
 *
 * Los roles NO van en el formulario (son casillas sobre un catálogo), por eso
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
   * La contraseña del alta, en texto plano. Vacía = que la genere el sistema.
   *
   * Existe solo en el alta y no se recorta: las contraseñas admiten espacios
   * a propósito (el sistema tampoco aplica `.trim()`), y un recorte aquí
   * cambiaría la contraseña sin aviso. `confirmar` viaja en la forma y NO en
   * los datos que se mandan: es para que no se equivoquen al escribirla, nada
   * más.
   */
  contrasena: string;
  confirmar: string;
}

/** Lo que se manda al crear un usuario. Las reglas de validación no admiten campos de más: sobra uno y es 400. */
export interface CuerpoUsuario {
  nombre: string;
  apellido_paterno: string;
  apellido_materno: string | null;
  rfc: string;
  email: string | null;
  puesto: string | null;
  fecha_contratacion?: string;
  /**
   * La contraseña, si el administrador la escribió. Si no viene, el sistema
   * genera la temporal de siempre (`crearUsuarioEsquema`).
   */
  contrasena?: string;
  roles: number[];
}

/**
 * Lo que se manda al actualizar un usuario.
 *
 * Solo estos cinco campos. El sistema arma la actualización a partir de lo que
 * llega (`COLUMNAS_EDITABLES`), así que mandar de más no cambia el dato pero
 * sí mete ruido en el cable; y las reglas de validación rechazan los datos
 * vacíos con 400.
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
   * Va la clave y no la `url` a propósito: el sistema valida contra su lista y
   * devuelve el `fondo` ya resuelto. Mandar la url sería pedirle al sistema
   * que se fíe de un texto que eligió el usuario.
   */
  fondo_login?: string | null;
}

// ------------------------------------------------------------------ el RFC

/**
 * La MISMA expresión que el `CHECK` de la tabla y que las reglas de validación
 * (`usuarios/esquemas.ts`). Copiada, no importada: el sistema tiene su propio
 * árbol y la aplicación no puede importar de ahí.
 *
 * Está aquí para que el error salga pegado al campo, y no después de un viaje
 * al sistema. El sistema pone en mayúsculas ANTES de validar, así que la
 * pantalla también lo hace: así el `pattern` del campo y la regla del sistema
 * dicen exactamente lo mismo.
 */
export const REGEX_RFC = /^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

/** Como lo manda el sistema: recortado y en mayúsculas. */
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
 * Arma los datos del alta.
 *
 * Cuatro cosas que no son obvias:
 *
 *   1. **El RFC va en mayúsculas y sin espacios.** Las reglas de validación lo
 *      hacen igual, pero mandarlo ya normalizado evita el 400 en el caso de
 *      que alguien lo escriba con el teclado en minúsculas.
 *   2. **Lo vacío va como `null`, no como `''`.** Es lo que admiten los tres
 *      campos opcionales (`nullish`); `''` es un valor VÁLIDO para un texto
 *      pero no para el correo, y ahí lo que se quiere decir es "no hay".
 *   3. **La fecha solo va si se escribió.** Las reglas de validación la ponen
 *      opcional y el sistema la rellena con hoy si no llega; mandarla vacía
 *      sería un 400 del `regex`.
 *   4. **La contraseña solo va si se escribió**, y sin recortarla: los
 *      espacios de adentro son parte de la contraseña y el sistema tampoco los
 *      toca. En blanco se omite el campo entero (no `''`, que daría 400) y el
 *      sistema genera la temporal. `confirmar` jamás sale de aquí.
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
 * Arma los datos de la edición.
 *
 * `activo` NO va con los otros cuatro: la baja y el alta se alternan con una
 * actualización de un solo campo desde el botón de la fila, para que dar de
 * baja a alguien no pueda reescribirle el nombre. Y se manda lo que hay, sin
 * comparar con la versión anterior: las reglas de validación piden al menos un
 * campo y estos cuatro siempre están, así que nunca se mandan datos vacíos.
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
 * Los roles que se van a mandar, sin repetir y en el orden del catálogo.
 *
 * Sin repetir porque las reglas de validación aceptan hasta 5 pero el `INSERT`
 * no los distingue, y en el orden del catálogo para que las casillas marcadas
 * y lo que se guarda sean la misma lista. El catálogo llega por nombre
 * (`ORDER BY nombre`), así que sin esto "Cajera" marcado salía guardado al
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
 * Cómo se ve la cuenta en la lista.
 *
 * El orden importa: una cuenta desactivada que además está bloqueada se
 * muestra como desactivada, porque eso es lo que hay que arreglar primero, y
 * "bloqueado" confundiría ("pero si no está dado de baja...").
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

/** "Juan Pérez López". El materno es opcional y no se pone "null". */
export function nombreCompleto(usuario: Usuario): string {
  return [usuario.nombre, usuario.apellido_paterno, usuario.apellido_materno]
    .filter((parte) => parte !== null && parte !== '')
    .join(' ');
}

/** Los roles en una línea, para la columna de la lista. */
export function rolesEnLinea(usuario: Usuario): string {
  return usuario.roles.map((rol) => rol.nombre).join(', ');
}

// --------------------------------------------------------- los candados

export type AccionDeCuenta = 'desactivar' | 'quitar_admin';

/**
 * Por qué un botón NO se puede usar, en palabras. `null` si se puede.
 *
 * Las dos reglas que se saben desde la pantalla son las de "no te lo hagas a
 * ti mismo". La de `ULTIMO_ADMIN` NO se sabe aquí (habría que contar los
 * administradores activos de todo el sistema, y la pantalla solo tiene la
 * página que está viendo), así que el botón se deja activo y es el sistema el
 * que responde: es mejor un 409 con su mensaje que un botón gris sin
 * explicación.
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
   * El catálogo de roles.
   *
   * No son paginados: son cinco filas fijas y salen de memoria. Es la pantalla
   * que los consulta para dibujar las casillas.
   */
  async roles(): Promise<Rol[]> {
    return firstValueFrom(this.http.get<Rol[]>(`${API}/usuarios/roles`));
  }

  /**
   * Los fondos de la pantalla de entrada que se pueden elegir.
   *
   * Vienen del sistema en vez de estar escritos aquí a mano por lo mismo que
   * los roles: la lista crece con una actualización del sistema, y si la
   * pantalla tuviera su propia copia se podrían desincronizar sin que nada
   * avise.
   */
  async fondos(): Promise<FondoLogin[]> {
    const r = await firstValueFrom(
      this.http.get<{ datos: FondoLogin[] }>(`${API}/usuarios/fondos`),
    );
    return r.datos;
  }

  /**
   * Lista con búsqueda, filtro por rol y filtro de estado.
   *
   * El filtro de estado tiene tres posiciones porque el sistema solo sabe
   * decir `activo: true` o `activo: false` (`listarUsuariosEsquema`), y
   * "todos" es no mandar el parámetro. Por omisión salen solo los ACTIVOS,
   * como en proveedores: lo que se busca el 99% de las veces es quien puede
   * entrar, y el dado de baja lo cambia quien lo busca.
   *
   * `rol` es un id y no un nombre, y el filtro es `=` y no `ILIKE` (está en
   * el servicio), así que se manda el id de la casilla.
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

  /** Crea. 201, con la contraseña temporal que hay que mostrar una vez. */
  async crear(cuerpo: CuerpoUsuario): Promise<UsuarioCreado> {
    return firstValueFrom(this.http.post<UsuarioCreado>(`${API}/usuarios`, cuerpo));
  }

  /**
   * Edita los datos y/o el estado.
   *
   * El `activo` va en la misma actualización y no aparte porque el candado de
   * "no te desactives" vive en el sistema (`usuarios/servicio.ts`) y se
   * comprueba sobre el campo que llega, no sobre la acción en sí.
   */
  async actualizar(id: number, cuerpo: CuerpoActualizacion): Promise<Usuario> {
    return firstValueFrom(this.http.patch<Usuario>(`${API}/usuarios/${id}`, cuerpo));
  }

  /**
   * Reemplaza los roles completos.
   *
   * Reemplaza, no agrega: la lista que llega es la que queda, y por eso las
   * reglas de validación exigen al menos uno. Una acción de "agregar rol"
   * permitiría quedarse con cero sin querer.
   */
  async asignarRoles(id: number, roles: number[]): Promise<Usuario> {
    return firstValueFrom(this.http.put<Usuario>(`${API}/usuarios/${id}/roles`, { roles }));
  }

  /**
   * Reinicia la contraseña. La nueva vuelve una sola vez.
   *
   * No hay datos que mandar y no hay `contrasena` que enviar: la genera el
   * sistema (`generarContrasenaTemporal`). Mandar una contraseña desde aquí
   * dejaría en manos de la pantalla decidir qué contraseña se le pone a otra
   * persona.
   */
  async resetearContrasena(id: number): Promise<Reseteo> {
    return firstValueFrom(this.http.post<Reseteo>(`${API}/usuarios/${id}/resetear-contrasena`, {}));
  }
}
