import { inject } from '@angular/core';
import type {
  ActivatedRouteSnapshot,
  CanActivateFn,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import { Router } from '@angular/router';
import { rutaDeInicio } from './menu';
import { Sesion } from './sesion';

/**
 * Las guardas de ruta.
 *
 * Todas devuelven una promesa o un `UrlTree`, nunca `true` a ciegas: una
 * guarda que devuelve `true` sin comprobar nada es la forma mas comun de
 * que la app "funcione" en la maquina de quien la programa y se rompa en la
 * del que la usa.
 */

/**
 * Dejar pasar solo a quien tiene sesion, y con el perfil ya cargado.
 *
 * Se espera al perfil antes de dejar entrar porque el menu se dibuja a
 * partir de el: si se dejara pasar de inmediato, la primera pantalla
 * apareceria sin menu y luego "aparecerian" los permisos solos, que se ve
 * como un fallo de la app y confunde.
 *
 * Si el backend esta caido, `asegurarPerfil` lanza y aqui se convierte en
 * "no se pudo verificar la sesion", que es distinto de "no tienes sesion" y
 * por eso va a una pantalla propia y no al login.
 */
export const guardaSesion: CanActivateFn = async (
  _ruta: ActivatedRouteSnapshot,
  estado: RouterStateSnapshot,
): Promise<boolean | UrlTree> => {
  const sesion = inject(Sesion);
  const router = inject(Router);

  if (!sesion.hayToken()) return alLogin(router, estado.url);

  try {
    const perfil = await sesion.asegurarPerfil();
    if (!perfil) return alLogin(router, estado.url);
  } catch {
    // El token parece bueno pero no se pudo preguntar. Casi siempre es que
    // el backend no esta arriba.
    return router.parseUrl('/sin-conexion');
  }

  // El backend obliga a cambiar la contrasena, asi que esto no es una
  // preferencia de la app: mientras la bandera este puesta, TODO lo demas
  // queda cerrado. Se deja pasar solo el logout, que esta en la cabecera y
  // no pasa por aqui, para que la persona pueda salir si el cambio no le
  // sale y no quedarse encerrada.
  if (sesion.perfil()?.debeCambiarContrasena) {
    return router.parseUrl('/cambiar-contrasena');
  }

  return true;
};

/**
 * Al reves: fuera de `/login` quien ya tiene sesion.
 *
 * Sin esto, recargar la pagina del login con el token guardado deja a
 * alguien que ya entro escribiendo su contrasena otra vez. Y con el login
 *-equivocado se acaba de venir, se respeta el `returnUrl` y no se pisa.
 */
export const guardaSinSesion: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const sesion = inject(Sesion);
  const router = inject(Router);

  if (!sesion.hayToken()) return true;

  // Con token pero sin perfil no se decide nada: se deja pasar al login. Si
  // el token estuviera bueno, el menu se puede pintar sin preguntas.
  if (!sesion.perfil()) return true;

  return router.parseUrl(sesion.perfil()!.debeCambiarContrasena ? '/cambiar-contrasena' : '/');
};

/**
 * Deja pasar solo a quien tiene el permiso del modulo.
 *
 * El permiso va en el `data` de la ruta, que se genera desde `menu.ts`, y
 * se lee con corchetes porque el proyecto trae `noPropertyAccessFromIndexSignature`:
 * `data['permiso']`, no `data.permiso`.
 *
 * Otra vez: esto es UX, no seguridad. El backend responde 403 igual, y si
 * alguien cambia el permiso entre que se dibuja el menu y que se hace clic,
 * lo que se ve es el mensaje de 403, no una pantalla en blanco.
 */
export const guardaPermiso: CanActivateFn = (ruta: ActivatedRouteSnapshot): boolean | UrlTree => {
  const sesion = inject(Sesion);
  const router = inject(Router);

  const permiso = ruta.data['permiso'];
  if (typeof permiso !== 'string') return true;
  if (sesion.puede(permiso)) return true;

  return router.parseUrl('/sin-permisos');
};

/**
 * La pantalla de inicio: al primer modulo al que la persona tenga acceso.
 *
 * En vez de una pantalla de bienvenida que habria que rehacer el dia que
 * sepamos que va a haber, entra de una vez a lo que va a usar. Si no tiene
 * ningun modulo, se queda en la raiz y el shell le explica por que.
 */
export const guardaInicio: CanActivateFn = (): boolean | UrlTree => {
  const sesion = inject(Sesion);
  const router = inject(Router);

  const destino = rutaDeInicio(new Set(sesion.perfil()?.permisos ?? []));
  return destino ? router.parseUrl(destino) : true;
};

/** Al login, guardando de donde venia para volver ahi al entrar. */
function alLogin(router: Router, desde: string): UrlTree {
  // El `returnUrl` se manda solo si la persona venia de una ruta real de
  // la app. Se descartan las de la propia autenticacion para no encadenar
  // `/login?returnUrl=/cambiar-contrasena` y que al entrar la mande a
  // cambiar la contrasena otra vez.
  const esRutaInterna = !desde.startsWith('/login') && !desde.startsWith('/cambiar-contrasena');
  return router.parseUrl(
    esRutaInterna ? `/login?returnUrl=${encodeURIComponent(desde)}` : '/login',
  );
}
