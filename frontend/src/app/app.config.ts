import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withViewTransitions,
} from '@angular/router';
import { interceptorSesion } from './nucleo/interceptor-sesion';
import { routes } from './app.routes';

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
    // `withInMemoryScrolling` devuelve cada pantalla arriba al entrar. Sin
    // esto se hereda la posicion del scroll de la pantalla anterior, asi que
    // cambiar de productos a clientes te dejaba a media tabla del sitio
    // donde estabas, y con la transicion se nota todavia mas.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withViewTransitions({ skipInitialTransition: true }),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }),
    ),

    // El interceptor va aqui y no en cada peticion. Ver el archivo.
    provideHttpClient(withInterceptors([interceptorSesion])),
  ],
};
