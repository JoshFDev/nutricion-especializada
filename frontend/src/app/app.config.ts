import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { inject } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  Router,
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withViewTransitions,
} from '@angular/router';
import { interceptorSesion } from './nucleo/interceptor-sesion';
import { routes } from './app.routes';

/**
 * Las dos pantallas de sesion, reconocidas por la URL.
 *
 * `/login` con su `?returnUrl=...` y `/cambiar-contrasena`, y tambien lo que
 * apunte hacia ellas. No hay otras rutas que empiecen asi (ver
 * `app.routes.ts`), y el `[/?#]` despues evita confundir `/login` con una
 * ruta hipotetica `/logina`.
 */
const PANTALLA_DE_SESION = /^\/(login|cambiar-contrasena)([/?#]|$)/;

/**
 * Como se arma la app.
 *
 * Va en un archivo y no en `main.ts` porque `main.ts` solo arranca. Asi las
 * pruebas pueden construir la misma configuracion con `TestBed` sin abrir
 * un puerto, igual que en el backend, donde la composicion esta en `app.ts`
 * y no en `index.ts`.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAnimationsAsync(),

    // `withComponentInputBinding` hace que el `data` de la ruta se escriba
    // solo en los inputs del componente. Es lo que permite que `Pendiente`
    // lea su titulo y su texto de `data` sin volver a pedir el
    // `ActivatedRoute` por cada campo.
    //
    // `withViewTransitions` es lo que hace que cambiar de pantalla no sea un
    // corte en seco: el navegador toma una foto de lo que hay, la cambia y
    // mezcla las dos con la animacion de `::view-transition-old(contenido)` y
    // `::view-transition-new(contenido)` en `styles.scss`. Sin esto el
    // cambio era un salto seco, y con las animaciones de filas de encima se
    // veía como que la pagina se trababa.
    //
    // `skipInitialTransition` apaga la de la PRIMERA navegacion. Al cargar la
    // app con `/notas` ya en la barra de direcciones no hay pagina anterior
    // de la que cruzar, y animar ese primer render hacia un frame en blanco.
    //
    // `onViewTransitionCreated` salta la animacion cuando el cruce toca
    // `/login` o `/cambiar-contrasena`, en cualquier sentido. La razon es el
    // trabazon del logout: dos navegaciones seguidas hacia o desde el login
    // (el interceptor y el boton de salir, o la guarda de cambio obligatorio)
    // arrancaban DOS view-transitions, la segunda cancelaba a la primera a
    // media mezcla y la pantalla se quedaba congelada con la foto vieja.
    // Saltando la transicion en esas dos pantallas la navegacion sale limpia
    // y ademas entrar al login no se anima, que es un corte: no hay nada que
    // mezclar con una pantalla de contrasena.
    //
    // El callback corre en contexto de inyeccion (lo dice el tipo del
    // router), asi que `inject(Router)` va. En ese momento el router todavia
    // apunta a la pantalla DE DONDE se viene (`router.url`) y la navegacion
    // en curso da hacia DONDE se va; el estado se cambia despues, al
    // activar las rutas.
    //
    // `withInMemoryScrolling` devuelve cada pantalla arriba al entrar. Sin
    // esto se hereda la posicion del scroll de la pantalla anterior, asi que
    // cambiar de productos a clientes te dejaba a media tabla del sitio
    // donde estabas, y con la transicion se nota todavia mas.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions({
        skipInitialTransition: true,
        onViewTransitionCreated: ({ transition }) => {
          const router = inject(Router);
          const navegacion = router.getCurrentNavigation();
          const hacia = navegacion
            ? router.serializeUrl(navegacion.finalUrl ?? navegacion.extractedUrl)
            : router.url;
          if (PANTALLA_DE_SESION.test(router.url) || PANTALLA_DE_SESION.test(hacia)) {
            transition.skipTransition();
          }
        },
      }),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
    ),

    // El interceptor va aqui y no en cada peticion. Ver el archivo.
    provideHttpClient(withInterceptors([interceptorSesion])),
  ],
};
