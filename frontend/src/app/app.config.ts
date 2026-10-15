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
 * Las dos pantallas de sesión, reconocidas por la URL.
 *
 * `/login` con su `?returnUrl=...` y `/cambiar-contrasena`, y también lo que
 * apunte hacia ellas. No hay otras rutas que empiecen así (ver
 * `app.routes.ts`), y el `[/?#]` después evita confundir `/login` con una
 * ruta hipotética `/logina`.
 */
const PANTALLA_DE_SESION = /^\/(login|cambiar-contrasena)([/?#]|$)/;

/**
 * Cómo se arma la aplicación.
 *
 * Va en un archivo y no en `main.ts` porque `main.ts` solo arranca. Así las
 * pruebas pueden construir la misma configuración con `TestBed` sin abrir
 * un puerto, igual que en el sistema, donde la composición está en `app.ts`
 * y no en `index.ts`.
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideAnimationsAsync(),

    // `withComponentInputBinding` hace que el `data` de la ruta se escriba
    // solo en los inputs del componente. Es lo que permite que `Pendiente`
    // lea su título y su texto de `data` sin volver a pedir el
    // `ActivatedRoute` por cada campo.
    //
    // `withViewTransitions` es lo que hace que cambiar de pantalla no sea un
    // corte en seco: el navegador toma una foto de lo que hay, la cambia y
    // mezcla las dos con la animación de `::view-transition-old(contenido)` y
    // `::view-transition-new(contenido)` en `styles.scss`. Sin esto el
    // cambio era un salto seco, y con las animaciones de filas de encima se
    // veía como que la página se trababa.
    //
    // `skipInitialTransition` apaga la de la PRIMERA navegación. Al cargar la
    // aplicación con `/notas` ya en la barra de direcciones no hay página
    // anterior de la que cruzar, y animar ese primer dibujado terminaba en un
    // fotograma en blanco.
    //
    // `onViewTransitionCreated` salta la animación cuando el cruce toca
    // `/login` o `/cambiar-contrasena`, en cualquier sentido. La razón es el
    // enredo del cierre de sesión: dos navegaciones seguidas hacia o desde el
    // inicio de sesión (el interceptor y el botón de salir, o la guarda de
    // cambio obligatorio) arrancaban DOS transiciones de vista, la segunda
    // cancelaba a la primera a media mezcla y la pantalla se quedaba congelada
    // con la foto vieja. Saltando la transición en esas dos pantallas la
    // navegación sale limpia y además entrar al inicio de sesión no se anima,
    // que es un corte: no hay nada que mezclar con una pantalla de contraseña.
    //
    // El callback corre en contexto de inyección (lo dice el tipo del
    // enrutador), así que `inject(Router)` va. En ese momento el enrutador
    // todavía apunta a la pantalla DE DONDE se viene (`router.url`) y la
    // navegación en curso da hacia DONDE se va; el estado se cambia después,
    // al activar las rutas.
    //
    // `withInMemoryScrolling` devuelve cada pantalla arriba al entrar. Sin
    // esto se hereda la posición del scroll de la pantalla anterior, así que
    // cambiar de productos a clientes te dejaba a media tabla del sitio
    // donde estabas, y con la transición se nota todavía más.
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

    // El interceptor va aquí y no en cada petición. Ver el archivo.
    provideHttpClient(withInterceptors([interceptorSesion])),
  ],
};
