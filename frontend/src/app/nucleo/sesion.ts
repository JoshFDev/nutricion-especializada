import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API, errorLegible } from './api';

/**
 * Lo que el backend responde en el login.
 *
 * Copiado de `modules/auth/esquemas.ts` (`RespuestaLogin` y
 * `UsuarioPublico`). Va copiado y no compartido a proposito: el frontend y el
 * backend son dos paquetes separados con dos compilaciones distintas, y el
 * unico que puede exigir que coincidan es el backend, que ya responde con
 * estos nombres. Si alguien cambia un campo aqui, lo que se rompe es la
 * pantalla de login, que es justo donde se ve de inmediato.
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
 * `GET /auth/yo`: lo mismo que `UsuarioPublico` mas los permisos y los roles.
 *
 * Los permisos vienen AQUI y no en el login a proposito: pueden cambiar
 * mientras la persona esta trabajando (un admin le quita un permiso, o le
 * dan uno nuevo), y con la lista guardada en el navegador el menu seguiria
 * mostrando cosas que ya no puede hacer hasta que recargara con F5.
 */
export interface Perfil extends UsuarioPublico {
  permisos: string[];
  roles: string[];
}

/**
 * Donde se guarda el token.
 *
 * `localStorage` y no una variable en memoria a proposito: en un mostrador
 * la sesion dura el turno, y con el token en memoria cualquier recarga de
 * la pagina (un F5 sin querer, un cierre de pestana que el navegador
 * "restaura", un campo que se trabo) echaria a la persona fuera a media
 * operacion.
 *
 * El precio de esto es conocido y esta anotado en el README: cualquier
 * `innerHTML` que alguien meta por error da lectura del token. Arreglarlo
 * de verdad es un cookie `httpOnly` de refresco y es un cambio del BACKEND
 * (hoy el token solo se acepta en la cabecera `Authorization`, no en
 * cookie), no un ajuste del front.
 */
const CLAVE_TOKEN = 'ne.token';

/**
 * La sesion de quien esta usando la app.
 *
 * Un solo servicio con signals, en vez de varias variables sueltas con
 * `BehaviorSubject`: el menu, las guardas y el boton de salir leen del
 * mismo lugar, y no puede quedar uno desincronizado de otro.
 */
@Injectable({ providedIn: 'root' })
export class Sesion {
  private readonly http = inject(HttpClient);

  /**
   * El token opaco del backend.
   *
   * `signal` y no una clase aparte con BehaviorSubject porque a quien lo
   * mira le alcanza con saber si hay token y con leerlo.
   */
  private readonly _token = signal<string | null>(leerTokenGuardado());

  /**
   * El perfil con los permisos.
   *
   * NO se guarda en `localStorage`, aunque el login ya lo mande: se vuelve a
   * pedir a `/auth/yo` en cada carga de la app. Cuesta una peticion de
   * 30 bytes y compra que el menu refleje los permisos de ahora.
   */
  private readonly _perfil = signal<Perfil | null>(null);

  private readonly _cargando = signal(true);

  /** Hay token guardado. NO significa que la sesion siga viva en el servidor. */
  readonly hayToken = computed(() => this._token() !== null);

  /** El perfil, o `null` si todavia no se ha cargado. */
  readonly perfil = this._perfil.asReadonly();

  /**
   * Que se esta preguntando si la sesion sigue viva.
   *
   * El shell lo muestra en vez de una pantalla en blanco, porque al abrir
   * la app SIEMPE hay un instante con token pero sin perfil.
   */
  readonly cargando = this._cargando.asReadonly();

  /** Los permisos como `Set`, que es como se consultan. */
  private readonly _permisos = computed(() => new Set(this._perfil()?.permisos ?? []));

  /**
   * La sesion se perdio en el servidor (401, logout, cierre de la sesion).
   *
   * Se distingue de "nunca he entrado" porque quien lo llama es el
   * interceptor, y el mensaje que se le muestra a la persona depende de la
   * diferencia: "tu sesion se cerro, vuelve a entrar" no es lo mismo que
   * una pantalla de login en blanco.
   */
  private readonly _sesionPerdida = signal(false);

  readonly sesionPerdida = this._sesionPerdida.asReadonly();

  token(): string | null {
    return this._token();
  }

  /**
   * Si la persona puede hacer esto.
   *
   * Es una AYUDA para la interfaz, no una proteccion: el backend vuelve a
   * comprobar el permiso en cada peticion (`requierePermiso`, y el trigger
   * `fn_trg_permiso` debajo). Un boton escondido no es seguridad; lo es
   * que el menu no le prometa a la persona algo que el servidor le va a
   * negar.
   */
  puede(permiso: string): boolean {
    return this._permisos().has(permiso);
  }

  /**
   * Carga el perfil, una sola vez por carga de la app.
   *
   * Lo llaman las guardas antes de dejar pasar a alguien, y por eso tiene
   * que devolver una promesa y no un observable: si el menu se dibuja antes
   * de que lleguen los permisos, aparece vacio y luego "se llena solo", que
   * se ve como un fallo.
   *
   * Con un token que ya no sirve, el interceptor limpia la sesion y un 401
   * sale de aqui como error normal: quien llama lo atrapa y manda a
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
      // Un 401 lo limpio el interceptor. Lo que llega aqui es otra cosa
      // (el servidor caido, por ejemplo) y hay que distinguirlos: si el
      // backend no responde no se puede decir "tu sesion se cerro".
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
   * Guarda el token y el perfil que devuelve el login, sin volver a pedir
   * `/auth/yo`: son los mismos datos y aqui ya estan.
   *
   * El error se propaga tal cual (envuelto por el interceptor en su forma
   * final) para que la pantalla pueda pintar el mensaje y, si fue
   * `VALIDACION`, pegarlo junto al campo. Por eso no se captura aqui.
   */
  async entrar(correo: string, contrasena: string): Promise<UsuarioPublico> {
    const respuesta = await firstValueFrom(
      this.http.post<RespuestaLogin>(`${API}/auth/login`, { correo, contrasena }),
    );

    guardarToken(respuesta.token);
    this._token.set(respuesta.token);
    this._sesionPerdida.set(false);
    // NO se guarda el perfil a partir de la respuesta del login. Trae el
    // usuario pero no los permisos, y guardar un perfil con la lista vacia
    // haria que `asegurarPerfil` saliera temprano y el menu se quedara
    // vacio. Se deja que lo pida `/auth/yo` de verdad, que es donde estan
    // los permisos.
    this._perfil.set(null);
    this._cargando.set(false);
    return respuesta.usuario;
  }

  /**
   * Entra como un rol sin escribir contrasena.
   *
   * SOLO existe en desarrollo, y en los dos lados: el boton se dibuja
   * unicamente con `ng serve` (`environment.produccion`), y el backend solo
   * monta la ruta con `NODE_ENV=development`. Si el build de desarrollo
   * llegara a un servidor por error, el boton daria 404 y no entraria nadie.
   *
   * Va en este servicio y no en la pantalla de login para que el token se
   * guarde por el mismo camino que en un login normal. Dos lugares que
   * guardan una sesion es la forma de que uno de los dos se quede viejo.
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
   * Marca la sesion como perdida, sin llamar al backend.
   *
   * La usa el interceptor cuando la API responde 401. NO se manda
   * `/auth/logout` porque esa peticion ya fallo: ademas necesita el token
   * que el servidor acaba de declarar invalido.
   */
  expirar(): void {
    this._sesionPerdida.set(true);
    this.limpiar();
  }

  /**
   * Cierra la sesion de verdad.
   *
   * Primero se avisa al backend, que es lo que deja de valer el token en su
   * tabla `sesiones`, y despues se limpia lo local. Se limpia en los dos
   * casos aunque el backend falle: quedarse "dentro" de la app sin sesion
   * solo produce errores 401 en cada clic, y el token ya no sirve para
   * nada. El error del logout se ignora a proposito.
   */
  async salir(): Promise<void> {
    if (this.hayToken()) {
      try {
        await firstValueFrom(this.http.post(`${API}/auth/logout`, {}));
      } catch {
        // Si el servidor no responde, el token se caduca solo. No hay nada
        // que el usuario pueda hacer al respecto, asi que no se le avisa.
      }
    }
    this.limpiar();
  }

  /**
   * Se acaba de cambiar la contrasena y el backend ya la dio por buena.
   *
   * La sesion actual sigue viva a proposito (cerrar las de los demas, no la
   * propia) y la bandera `debe_cambiar_contrasena` ya valio `false` en la
   * base. Aqui solo se replica ese cambio en la copia local: si no, el
   * guard que obliga a cambiarla volveria a redirigir aqui y la persona
   * quedaria atrapada en un ciclo de redirecciones.
   */
  marcarContrasenaCambiada(): void {
    const perfil = this._perfil();
    if (!perfil) return;
    this._perfil.set({ ...perfil, debeCambiarContrasena: false });
  }

  /** Borra todo lo local. Es el unico lugar que toca el almacen. */
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
    // `localStorage` lanza al tocarlo. Perder la sesion al recargar es
    // molesto pero no rompe la app, y relajar el modo privado no lo es.
    return null;
  }
}

function guardarToken(token: string): void {
  try {
    localStorage.setItem(CLAVE_TOKEN, token);
  } catch {
    // Sin almacen la app funciona igual, con la sesion perdida en cada
    // recarga. Ver la nota de `CLAVE_TOKEN`.
  }
}

function borrarTokenGuardado(): void {
  try {
    localStorage.removeItem(CLAVE_TOKEN);
  } catch {
    // idem.
  }
}
