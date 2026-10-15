import type { HttpInterceptorFn } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Sesion } from './sesion';

/**
 * Le pone la credencial a las peticiones y se encarga cuando el sistema dice
 * que ya no sirve.
 *
 * Se hace con un interceptor y no en cada servicio porque son quince módulos y
 * ninguno puede olvidarse: una petición sin la credencial falla con un 401 que
 * no dice nada de por qué, y quien lo tiene que descifrar es quien está
 * capturando el error.
 *
 * Los dos `inject` de arriba son a propósito y en este orden. `catchError`
 * corre después, cuando la petición ya falló, y ahí `inject()` ya no funciona
 * (fuera del contexto de inyección lanza). Por eso el `Router` se pide aquí y
 * no dentro del `catchError`.
 */
export const interceptorSesion: HttpInterceptorFn = (peticion, siguiente) => {
  const sesion = inject(Sesion);
  const router = inject(Router);
  const token = sesion.token();

  const conToken = token
    ? peticion.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : peticion;

  return siguiente(conToken).pipe(
    catchError((error: unknown) => {
      // 401 con la credencial puesta = la sesión se murió en el sistema:
      // expiró, alguien cerró sesión en otra computadora, o le cambiaron la
      // contraseña y se cerraron las sesiones.
      //
      // Las DOS comprobaciones importan:
      //
      //   - `token` es el de ANTES de la petición: si la petición sin
      //     credencial (el propio inicio de sesión) falla con 401, no hay
      //     sesión que haya caducado y hay que dejar que la pantalla de inicio
      //     de sesión muestre el "correo o contraseña incorrectos".
      //   - `sesion.hayToken()` es el de AHORA: si mientras la respuesta
      //     volvía alguien ya cerró la sesión (el propio `salir`), o si ya
      //     entró un 401 previo y limpió, no hay nada que expire ni que
      //     navegar. Sin esto, un cierre de sesión con la credencial ya muerta
      //     disparaba una SEGUNDA navegación a `/login` y la transición de
      //     vista se colgaba a media animación; y dos peticiones fallidas a la
      //     vez navegaban dos veces.
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        token !== null &&
        sesion.hayToken()
      ) {
        sesion.expirar();
        // `state.url` es la de donde venía la persona, para que al volver a
        // entrar caiga donde estaba y no siempre en el inicio. Solo tiene
        // sentido si venía de adentro: si ya estaba en `/login`, mandar a
        // `/login?returnUrl=/login` es un ciclo.
        const returning = router.url.startsWith('/login') ? null : router.url;
        void router.navigate(
          ['/login'],
          returning ? { queryParams: { returnUrl: returning } } : {},
        );
      }
      return throwError(() => error);
    }),
  );
};
