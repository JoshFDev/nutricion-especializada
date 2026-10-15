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
 * Todas devuelven una promesa o un `UrlTree`, nunca `true` a ciegas: una guarda
 * que devuelve `true` sin comprobar nada es la forma más común de que la
 * aplicación «funcione» en la máquina de quien la programa y se rompa en la del
 * que la usa.
 */

/**
 * Dejar pasar solo a quien tiene sesión, y con el perfil ya cargado.
 *
 * Se espera al perfil antes de dejar entrar porque el menú se dibuja a partir
 * de él: si se dejara pasar de inmediato, la primera pantalla aparecería sin
 * menú y luego «aparecerían» los permisos solos, que se ve como un fallo de la
 * aplicación y confunde.
 *
 * Si el sistema está caído, `asegurarPerfil` lanza y aquí se convierte en «no
 * se pudo verificar la sesión», que es distinto de «no tienes sesión» y por eso
 * va a una pantalla propia y no al inicio de sesión.
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
    // La credencial parece buena pero no se pudo preguntar. Casi siempre es que
    // el sistema no está arriba.
    return router.parseUrl('/sin-conexion');
  }

  // El sistema obliga a cambiar la contraseña, así que esto no es una
  // preferencia de la aplicación: mientras la bandera esté puesta, TODO lo
  // demás queda cerrado. Se deja pasar solo el cierre de sesión, que está en la
  // cabecera y no pasa por aquí, para que la persona pueda salir si el cambio
  // no le sale y no quedarse encerrada.
  if (sesion.perfil()?.debeCambiarContrasena) {
    return router.parseUrl('/cambiar-contrasena');
  }

  return true;
};

/**
 * Al revés: fuera de `/login` quien ya tiene sesión.
 *
 * Sin esto, recargar la página del inicio de sesión con la credencial guardada
 * deja a alguien que ya entró escribiendo su contraseña otra vez. Y con el
 * inicio de sesión equivocado se acaba de venir, se respeta el `returnUrl` y no
 * se pisa.
 */
export const guardaSinSesion: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const sesion = inject(Sesion);
  const router = inject(Router);

  if (!sesion.hayToken()) return true;

  // Con credencial pero sin perfil no se decide nada: se deja pasar al inicio
  // de sesión. Si la credencial estuviera buena, el menú se puede pintar sin
  // preguntas.
  if (!sesion.perfil()) return true;

  return router.parseUrl(sesion.perfil()!.debeCambiarContrasena ? '/cambiar-contrasena' : '/');
};

/**
 * Deja pasar solo a quien tiene el permiso del módulo.
 *
 * El permiso va en el `data` de la ruta, que se genera desde `menu.ts`, y se
 * lee con corchetes porque el proyecto trae
 * `noPropertyAccessFromIndexSignature`: `data['permiso']`, no `data.permiso`.
 *
 * Otra vez: esto es para la comodidad de la interfaz, no seguridad. El sistema
 * responde 403 igual, y si alguien cambia el permiso entre que se dibuja el
 * menú y que se hace clic, lo que se ve es el mensaje de 403, no una pantalla
 * en blanco.
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
 * La pantalla de inicio: al primer módulo al que la persona tenga acceso.
 *
 * En vez de una pantalla de bienvenida que habría que rehacer el día que
 * sepamos qué va a haber, entra de una vez a lo que va a usar. Si no tiene
 * ningún módulo, se queda en la raíz y el marco le explica por qué.
 */
export const guardaInicio: CanActivateFn = (): boolean | UrlTree => {
  const sesion = inject(Sesion);
  const router = inject(Router);

  const destino = rutaDeInicio(new Set(sesion.perfil()?.permisos ?? []));
  return destino ? router.parseUrl(destino) : true;
};

/** Al inicio de sesión, guardando de dónde venía para volver ahí al entrar. */
function alLogin(router: Router, desde: string): UrlTree {
  // El `returnUrl` se manda solo si la persona venía de una ruta real de la
  // aplicación. Se descartan las de la propia autenticación para no encadenar
  // `/login?returnUrl=/cambiar-contrasena` y que al entrar la mande a cambiar
  // la contraseña otra vez.
  const esRutaInterna = !desde.startsWith('/login') && !desde.startsWith('/cambiar-contrasena');
  return router.parseUrl(
    esRutaInterna ? `/login?returnUrl=${encodeURIComponent(desde)}` : '/login',
  );
}
