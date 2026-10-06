import type { HttpInterceptorFn } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Sesion } from './sesion';

/**
 * Le pone el token a las peticiones y se encarga cuando el servidor dice
 * que ya no sirve.
 *
 * Se hace con un interceptor y no en cada servicio porque son quince
 * modulos y ninguno puede olvidarse: un `post` sin el token falla con un 401
 * que no dice nada de por que, y el que lo tiene que descifrar es el que
 * esta capturando el error.
 *
 * Los dos `inject` de arriba son a proposito y en este orden. `catchError`
 * corre despues, cuando la peticion ya fallo, y ahi `inject()` ya no
 * funciona (fuera del contexto de inyeccion lanza). Por eso el `Router` se
 * pide aqui y no dentro del `catchError`.
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
      // 401 con token puesto = la sesion se murio en el servidor: expiro,
      // alguien hizo logout en otra compu, o le cambiaron la contrasena y
      // cerro las sesiones.
      //
      // Las DOS comprobaciones importan:
      //
      //   - `token` es el de ANTES de la peticion: si la peticion sin token
      //     (el propio login) falla con 401, no hay sesion que haya
      //     caducado y hay que dejar que la pantalla de login muestre el
      //     "correo o contrasena incorrectos".
      //   - `sesion.hayToken()` es el de AHORA: si mientras la respuesta
      //     volvia alguien ya cerro la sesion (el propio `salir`), o si ya
      //     entro un 401 previo y limpio, no hay nada que expire ni que
      //     navegar. Sin esto, un logout con el token ya muerto disparaba
      //     una SEGUNDA navegacion a `/login` y la view-transition se
      //     colgaba a media animacion; y dos peticiones fallidas a la vez
      //     navegaban dos veces.
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        token !== null &&
        sesion.hayToken()
      ) {
        sesion.expirar();
        // `state.url` es la de donde venia la persona, para que al volver a
        // entrar caiga donde estaba y no siempre en el inicio. Solo tiene
        // sentido si venia de adentro: si ya estaba en `/login`, mandar a
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
