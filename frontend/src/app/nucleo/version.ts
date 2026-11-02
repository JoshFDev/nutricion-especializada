import { signal } from '@angular/core';
import { INFO_SISTEMA } from './info';

/**
 * La version que se muestra en la aplicacion.
 *
 * En escritorio la version REAL es la del paquete que se instalo
 * (`app.getVersion()` en Electron), no la constante de `info.ts`. La
 * constante queda como respaldo para cuando la app corre en un navegador o
 * el preload no esta disponible.
 *
 * Se usa una senal y no una lectura directa en cada plantilla por una razon
 * simple: la respuesta del proceso principal llega despues del primer
 * pintado. Con una constante, "Acerca de" mostraria un numero y luego
 * cambiaria; con la senal, Angular repinta solo las dos etiquetas que la
 * usan.
 */
export const versionApp = signal<string>(INFO_SISTEMA.version);

interface ElectronApiVersion {
  appVersion?: () => Promise<string>;
}

/**
 * Pregunta la version al proceso principal. No lanza: si falla, se queda el
 * valor de `INFO_SISTEMA.version`, que es mejor que un "desconocida".
 */
export async function cargarVersionApp(): Promise<void> {
  try {
    const api = (window as Window & { electronAPI?: ElectronApiVersion }).electronAPI;
    if (!api?.appVersion) return;
    const version = await api.appVersion();
    if (typeof version === 'string' && version.trim() !== '') {
      versionApp.set(version.trim());
    }
  } catch {
    // Se conserva el respaldo de INFO_SISTEMA.
  }
}
