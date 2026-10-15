import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, errorLegible } from './api';

/**
 * Lo que el sistema responde en el inicio de sesión.
 *
 * Copiado de `modules/auth/esquemas.ts` (`RespuestaLogin` y `UsuarioPublico`).
 * Va copiado y no compartido a propósito: la pantalla y el sistema son dos
 * paquetes separados con dos compilaciones distintas, y el único que puede
 * exigir que coincidan es el sistema, que ya responde con estos nombres. Si
 * alguien cambia un campo aquí, lo que se rompe es la pantalla de inicio de
 * sesión, que es justo donde se ve de inmediato.
 */
export interface UsuarioPublico {
  id: number;
  nombre: string;
  email: string | null;
  puesto: string | null;
  debeCambiarContrasena: boolean;
}

export interface RespuestaLogin {
  token: string;
  usuario: UsuarioPublico;
}

/**
 * `GET /auth/yo`: lo mismo que `UsuarioPublico` más los permisos y los roles.
 *
 * Los permisos vienen AQUÍ y no en el inicio de sesión a propósito: pueden
 * cambiar mientras la persona está trabajando (un admin le quita un permiso, o
 * le dan uno nuevo), y con la lista guardada en el navegador el menú seguiría
 * mostrando cosas que ya no puede hacer hasta que recargara con F5.
 */
export interface Perfil extends UsuarioPublico {
  permisos: string[];
  roles: string[];
}

/**
 * Dónde se guarda la credencial.
 *
 * `localStorage` y no una variable en memoria a propósito: en un mostrador la
 * sesión dura el turno, y con la credencial en memoria cualquier recarga de la
 * página (un F5 sin querer, un cierre de pestaña que el navegador «restaura»,
 * un campo que se trabó) echaría a la persona fuera a media operación.
 *
 * El precio de esto es conocido y está anotado en el README: cualquier
 * `innerHTML` que alguien meta por error da lectura de la credencial.
 * Arreglarlo de verdad es una cookie `httpOnly` de refresco y es un cambio del
 * SISTEMA (hoy la credencial solo se acepta en la cabecera `Authorization`, no
 * en cookie), no un ajuste de la pantalla.
 */
const CLAVE_TOKEN = 'ne.token';

/**
 * La sesión de quien está usando la aplicación.
 *
 * Un solo servicio con signals, en vez de varias variables sueltas con
 * `BehaviorSubject`: el menú, las guardas y el botón de salir leen del mismo
 * lugar, y no puede quedar uno desincronizado de otro.
 */
@Injectable({ providedIn: 'root' })
export class Sesion {
  private readonly http = inject(HttpClient);

  /**
   * La credencial opaca del sistema.
   *
   * `signal` y no una clase aparte con BehaviorSubject porque a quien lo mira
   * le alcanza con saber si hay credencial y con leerla.
   */
  private readonly _token = signal<string | null>(leerTokenGuardado());

  /**
   * El perfil con los permisos.
   *
   * NO se guarda en `localStorage`, aunque el inicio de sesión ya lo mande: se
   * vuelve a pedir a `/auth/yo` en cada carga de la aplicación. Cuesta una
   * petición de 30 bytes y compra que el menú refleje los permisos de ahora.
   */
  private readonly _perfil = signal<Perfil | null>(null);

  private readonly _cargando = signal(true);

  /** Hay credencial guardada. NO significa que la sesión siga viva en el sistema. */
  readonly hayToken = computed(() => this._token() !== null);

  /** El perfil, o `null` si todavía no se ha cargado. */
  readonly perfil = this._perfil.asReadonly();

  /**
   * Que se está preguntando si la sesión sigue viva.
   *
   * El marco lo muestra en vez de una pantalla en blanco, porque al abrir la
   * aplicación SIEMPRE hay un instante con credencial pero sin perfil.
   */
  readonly cargando = this._cargando.asReadonly();

  /** Los permisos como `Set`, que es como se consultan. */
  private readonly _permisos = computed(() => new Set(this._perfil()?.permisos ?? []));

  /**
   * La sesión se perdió en el sistema (401, cierre de sesión, fin de la
   * sesión).
   *
   * Se distingue de «nunca he entrado» porque quien lo llama es el interceptor,
   * y el mensaje que se le muestra a la persona depende de la diferencia: «tu
   * sesión se cerró, vuelve a entrar» no es lo mismo que una pantalla de inicio
   * de sesión en blanco.
   */
  private readonly _sesionPerdida = signal(false);

  readonly sesionPerdida = this._sesionPerdida.asReadonly();

  token(): string | null {
    return this._token();
  }

  /**
   * Si la persona puede hacer esto.
   *
   * Es una AYUDA para la interfaz, no una protección: el sistema vuelve a
   * comprobar el permiso en cada petición (`requierePermiso`, y la regla
   * automática `fn_trg_permiso` debajo). Un botón escondido no es seguridad; lo
   * es que el menú no le prometa a la persona algo que el sistema le va a
   * negar.
   */
  puede(permiso: string): boolean {
    return this._permisos().has(permiso);
  }

  /**
   * Carga el perfil, una sola vez por carga de la aplicación.
   *
   * Lo llaman las guardas antes de dejar pasar a alguien, y por eso tiene que
   * devolver una promesa y no un observable: si el menú se dibuja antes de que
   * lleguen los permisos, aparece vacío y luego «se llena solo», que se ve como
   * un fallo.
   *
   * Con una credencial que ya no sirve, el interceptor limpia la sesión y un
   * 401 sale de aquí como error normal: quien llama lo atrapa y manda a
   * `/login`.
   */
  async asegurarPerfil(): Promise<Perfil | null> {
    const yaCargado = this._perfil();
    if (yaCargado) return yaCargado;
    if (!this.hayToken()) {
      this._cargando.set(false);
      return null;
    }

    this._cargando.set(true);
    try {
      const perfil = await firstValueFrom(this.http.get<Perfil>(`${API}/auth/yo`));
      this._perfil.set(perfil);
      this._sesionPerdida.set(false);
      return perfil;
    } catch (error) {
      // Un 401 lo limpió el interceptor. Lo que llega aquí es otra cosa (el
      // sistema caído, por ejemplo) y hay que distinguirlos: si el sistema no
      // responde no se puede decir «tu sesión se cerró».
      if (errorLegible(error).codigo !== 'NO_AUTENTICADO') {
        throw error;
      }
      this.limpiar();
      return null;
    } finally {
      this._cargando.set(false);
    }
  }

  /**
   * Entra.
   *
   * Guarda la credencial y el perfil que devuelve el inicio de sesión, sin
   * volver a pedir `/auth/yo`: son los mismos datos y aquí ya están.
   *
   * El error se propaga tal cual (envuelto por el interceptor en su forma
   * final) para que la pantalla pueda pintar el mensaje y, si fue
   * `VALIDACION`, pegarlo junto al campo. Por eso no se captura aquí.
   */
  async entrar(correo: string, contrasena: string): Promise<UsuarioPublico> {
    const respuesta = await firstValueFrom(
      this.http.post<RespuestaLogin>(`${API}/auth/login`, { correo, contrasena }),
    );

    guardarToken(respuesta.token);
    this._token.set(respuesta.token);
    this._sesionPerdida.set(false);
    // NO se guarda el perfil a partir de la respuesta del inicio de sesión.
    // Trae el usuario pero no los permisos, y guardar un perfil con la lista
    // vacía haría que `asegurarPerfil` saliera temprano y el menú se quedara
    // vacío. Se deja que lo pida `/auth/yo` de verdad, que es donde están los
    // permisos.
    this._perfil.set(null);
    this._cargando.set(false);
    return respuesta.usuario;
  }

  /**
   * Entra como un rol sin escribir contraseña.
   *
   * SOLO existe en desarrollo, y en los dos lados: el botón se dibuja
   * únicamente con `ng serve` (`environment.produccion`), y el sistema solo
   * monta la ruta con `NODE_ENV=development`. Si la compilación de desarrollo
   * llegara al sistema por error, el botón daría 404 y no entraría nadie.
   *
   * Va en este servicio y no en la pantalla de inicio de sesión para que la
   * credencial se guarde por el mismo camino que en un inicio de sesión normal.
   * Dos lugares que guardan una sesión es la forma de que uno de los dos se
   * quede viejo.
   */
  async entrarComo(rol: string): Promise<UsuarioPublico> {
    const respuesta = await firstValueFrom(
      this.http.post<RespuestaLogin>(`${API}/auth/dev/entrar-como`, { rol }),
    );

    guardarToken(respuesta.token);
    this._token.set(respuesta.token);
    this._sesionPerdida.set(false);
    this._perfil.set(null);
    this._cargando.set(false);
    return respuesta.usuario;
  }

  /**
   * Marca la sesión como perdida, sin llamar al sistema.
   *
   * La usa el interceptor cuando el servicio responde 401. NO se manda
   * `/auth/logout` porque esa petición ya falló: además necesita la credencial
   * que el sistema acaba de declarar inválida.
   */
  expirar(): void {
    this._sesionPerdida.set(true);
    this.limpiar();
  }

  /**
   * Cierra la sesión de verdad.
   *
   * Se limpia lo local SIN esperar al sistema y el `/auth/logout` sale en
   * segundo plano. La razón es lo que pasaba al salir: mientras la petición
   * volvía no pasaba nada en pantalla, y si la credencial ya estaba muerta el
   * 401 del cierre de sesión provocaba una SEGUNDA navegación a `/login` desde
   * el interceptor —dos transiciones de vista encima, y la segunda cancela a la
   * primera a la mitad: la pantalla se quedaba congelada con la foto vieja.
   *
   * Se limpia aunque la salida falle: quedarse «dentro» de la aplicación sin
   * sesión solo produce errores 401 en cada clic, y la credencial ya no sirve
   * para nada. El error se ignora a propósito —si el sistema no responde, la
   * credencial se caduca sola y no hay nada que la persona pueda hacer— y
   * tampoco se espera: ver el comentario de arriba.
   */
  salir(): void {
    if (this.hayToken()) {
      // Sin `await` a propósito. `firstValueFrom` se suscribe de inmediato, así
      // que la petición sale igual, todavía con la credencial puesta (el
      // interceptor la lee al suscribir, antes de `limpiar`).
      void firstValueFrom(this.http.post(`${API}/auth/logout`, {})).catch(() => undefined);
    }
    this.limpiar();
  }

  /**
   * Se acaba de cambiar la contraseña y el sistema ya la dio por buena.
   *
   * La sesión actual sigue viva a propósito (cerrar las de los demás, no la
   * propia) y la bandera `debe_cambiar_contrasena` ya valió `false` en la base.
   * Aquí solo se replica ese cambio en la copia local: si no, la guarda que
   * obliga a cambiarla volvería a redirigir aquí y la persona quedaría atrapada
   * en un ciclo de redirecciones.
   */
  marcarContrasenaCambiada(): void {
    const perfil = this._perfil();
    if (!perfil) return;
    this._perfil.set({ ...perfil, debeCambiarContrasena: false });
  }

  /** Borra todo lo local. Es el único lugar que toca el almacén. */
  private limpiar(): void {
    borrarTokenGuardado();
    this._token.set(null);
    this._perfil.set(null);
    this._cargando.set(false);
  }
}

function leerTokenGuardado(): string | null {
  try {
    return localStorage.getItem(CLAVE_TOKEN);
  } catch {
    // Con las cookies de terceros bloqueadas o en modo privado de Safari,
    // `localStorage` lanza al tocarlo. Perder la sesión al recargar es molesto
    // pero no rompe la aplicación, y relajar el modo privado no lo es.
    return null;
  }
}

function guardarToken(token: string): void {
  try {
    localStorage.setItem(CLAVE_TOKEN, token);
  } catch {
    // Sin almacén la aplicación funciona igual, con la sesión perdida en cada
    // recarga. Ver la nota de `CLAVE_TOKEN`.
  }
}

function borrarTokenGuardado(): void {
  try {
    localStorage.removeItem(CLAVE_TOKEN);
  } catch {
    // ídem.
  }
}
