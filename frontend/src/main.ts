import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

/*
 * En la app de escritorio el marco nativo está oculto y los botones de la
 * ventana viven encima de la barra azul. La clase `escritorio` activa los
 * ajustes de CSS para esa barra (espacio a la derecha y zona arrastrable).
 *
 * Se detecta por el user agent y no por el preload a propósito: así también
 * funciona si el preload no carga, y en el navegador normal no se activa.
 */
if (navigator.userAgent.includes('Electron')) {
  document.documentElement.classList.add('escritorio');
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
