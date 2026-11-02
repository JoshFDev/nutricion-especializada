import { contextBridge, ipcRenderer } from "electron";

/**
 * La unica puerta entre la pantalla y el proceso principal.
 *
 * El renderer corre en sandbox y con `contextIsolation`: no ve `ipcRenderer`
 * ni puede leer archivos. Lo que se expone aqui es la lista cerrada de cosas
 * que la interfaz puede pedir, y cada una la resuelve un manejador concreto
 * en `main.ts`.
 */
contextBridge.exposeInMainWorld("electronAPI", {
  /** La version de Electron. Se conserva por compatibilidad. */
  version: () => process.versions.electron,

  /**
   * La version de la aplicacion, la que se muestra en "Acerca de" y en el
   * menu Sistema. Sale de `app.getVersion()` en el proceso principal, que a
   * su vez lee el `version` del package.json empaquetado.
   */
  appVersion: () => ipcRenderer.invoke("app:version"),

  respaldos: {
    /** Devuelve los archivos que hay en la carpeta de respaldos. */
    listar: () => ipcRenderer.invoke("respaldos:listar"),
    /** Devuelve el estado de salud de los respaldos (dias sin copia, etc). */
    obtenerSaludRespaldos: () => ipcRenderer.invoke("respaldos:salud"),
    /** Crea un respaldo manual y devuelve su ficha. */
    crear: () => ipcRenderer.invoke("respaldos:crear"),
    /** Restaura un respaldo por nombre. La aplicacion se reinicia sola. */
    restaurar: (nombre: string) =>
      ipcRenderer.invoke("respaldos:restaurar", nombre),
    /** Valida la integridad de un respaldo antes de restaurarlo. */
    validar: (nombre: string) =>
      ipcRenderer.invoke("respaldos:validar", nombre),
    /** Devuelve la carpeta donde se guardan los respaldos. */
    obtenerCarpetaRespaldos: () =>
      ipcRenderer.invoke("respaldos:obtener-carpeta"),
    /** Abre el selector de carpeta y guarda la nueva ubicacion de respaldos. */
    cambiarCarpetaRespaldos: () =>
      ipcRenderer.invoke("respaldos:cambiar-carpeta"),
    /** Devuelve la configuracion de respaldos programados (horario). */
    obtenerHorarioRespaldos: () =>
      ipcRenderer.invoke("respaldos:obtener-horario"),
    /** Guarda la configuracion de respaldos programados y reinicia el temporizador. */
    guardarHorarioRespaldos: (horario: unknown) =>
      ipcRenderer.invoke("respaldos:guardar-horario", horario),
    /** Abre la carpeta de respaldos en el explorador de Windows. */
    abrirCarpeta: () => ipcRenderer.invoke("respaldos:abrir-carpeta"),
  },
});

/**
 * Marca el documento para que el CSS sepa que está dentro de Electron.
 *
 * En el navegador normal la barra superior no debe reservar espacio para los
 * botones de la ventana ni comportarse como una zona arrastrable. En la app
 * de escritorio sí: la barra azul hace de barra de título.
 */
function marcarEscritorio() {
  document.documentElement.classList.add("escritorio");
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", marcarEscritorio, { once: true });
} else {
  marcarEscritorio();
}
