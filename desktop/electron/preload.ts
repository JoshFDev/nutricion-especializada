import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  version: () => process.versions.electron,
});

/**
 * Marca el documento para que el CSS sepa que está dentro de Electron.
 *
 * En el navegador normal la barra superior no debe reservar espacio para los
 * botones de la ventana ni comportarse como una zona arrastrable. En la app
 * de escritorio sí: la barra azul hace de barra de título.
 */
function marcarEscritorio() {
  document.documentElement.classList.add('escritorio');
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', marcarEscritorio, { once: true });
} else {
  marcarEscritorio();
}
