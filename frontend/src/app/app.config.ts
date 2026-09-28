import { provideHttpClient, withInterceptors } from '@angular/common/http';
import type { ApplicationConfig } from '@angular/core';
import { provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
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

    // `withComponentInputBinding` hace que el `data` de la ruta se escriba
    // solo en los inputs del componente. Es lo que permite que `Pendiente`
    // lea su titulo y su texto de `data` sin volver a pedir el
    // `ActivatedRoute` por cada campo.
    provideRouter(routes, withComponentInputBinding()),

    // El interceptor va aqui y no en cada peticion. Ver el archivo.
    provideHttpClient(withInterceptors([interceptorSesion])),
  ],
};
