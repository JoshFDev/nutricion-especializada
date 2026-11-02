import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { obtenerRutas } from "./rutas.js";
import { iniciarPostgres, detenerPostgres } from "./postgres.js";
import { aplicarMigracionesEscritorio } from "./migrar-escritorio.js";
import { iniciarBackend, detenerBackend } from "./backend.js";
import { leerConfiguracion, type Configuracion } from "./configuracion.js";
import { crearAdminInicial } from "./admin-inicial.js";
import {
  crearRespaldo,
  crearRespaldoAutomatico,
  listarRespaldos,
  restaurarRespaldo,
  type ConfiguracionPg,
  type ResumenRespaldo,
} from "./respaldos.js";

// Este archivo se compila como ESM (package.json tiene "type": "module"),
// y en ESM no existe __dirname.
const dirname = fileURLToPath(new URL(".", import.meta.url));

let ventana: BrowserWindow | null = null;
let apagando = false;

/**
 * La configuracion de la base y del negocio, una vez que arrancaron.
 *
 * Se guardan en el modulo porque los manejadores de IPC (respaldos) y el
 * apagado las necesitan despues del arranque. Antes de que `arrancar()`
 * termine son `null`, y los manejadores lo dicen en vez de reventar.
 */
let pgConfigActual: ConfiguracionPg | null = null;
let configuracionActual: Configuracion | null = null;

/**
 * El respaldo que se esta escribiendo, si hay uno.
 *
 * Sirve para dos cosas: que dos clics seguidos no escriban dos archivos a la
 * vez, y que el apagado espere al que ya iba en curso antes de crear el
 * suyo. Un respaldo a medias no se puede restaurar, asi que la espera es
 * parte de la garantia.
 */
let respaldoEnCurso: Promise<unknown> | null = null;

/** Evita dos restauraciones simultaneas. */
let restaurando = false;

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    center: true,
    show: false,
    backgroundColor: "#f7f4ec",
    autoHideMenuBar: true,
    title: "Nutrición Especializada",
    // En Windows quitamos la barra de título nativa y dejamos sólo los
    // botones de minimizar/maximizar/cerrar encima de la barra azul de la
    // aplicación. Así la ventana se ve integrada y no como un marco gris.
    ...(process.platform === "win32"
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            // Transparente para que se vea la barra azul (o la foto del
            // login) por debajo y los botones queden integrados.
            color: "#00000000",
            symbolColor: "#ffffff",
            height: 56,
          },
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(
        dirname,
        existsSync(join(dirname, "preload.cjs")) ? "preload.cjs" : "preload.js",
      ),
    },
  });

  // Doble seguro contra el menú File/Edit/View/Window/Help. En Windows el
  // `Menu.setApplicationMenu(null)` global ya lo quita, pero si alguna
  // versión de Electron vuelve a dibujarlo al crear la ventana, esto lo
  // elimina de esta ventana concreta.
  ventana.removeMenu();
  ventana.setMenuBarVisibility(false);

  // Mostrar la ventana sólo cuando el frontend ya pintó evita el destello
  // blanco del arranque.
  ventana.once("ready-to-show", () => {
    ventana?.show();
  });

  ventana.on("closed", () => {
    ventana = null;
  });

  const rutas = obtenerRutas();
  const url = `http://127.0.0.1:${rutas.puertoApi}/`;
  console.log(`[main] Cargando ${url}`);
  void ventana.loadURL(url);

  return ventana;
}

/** Arranca el backend con la configuracion ya cargada. */
async function arrancarBackend(
  pg: ConfiguracionPg,
  config: Configuracion,
): Promise<void> {
  const rutas = obtenerRutas();
  await iniciarBackend({
    pgHost: pg.host,
    pgPort: pg.port,
    pgDatabase: pg.database,
    pgUser: pg.user,
    pgPassword: pg.password,
    puertoApi: rutas.puertoApi,
    smtp: config.smtp,
  });
}

/**
 * Crea un respaldo automatico si paso el tiempo minimo.
 *
 * No lanza: un respaldo que falla no debe impedir que la aplicacion abra o
 * cierre. Queda en el log y se reintenta en el siguiente arranque.
 */
async function respaldarAutomatico(
  horasMinimas: number,
): Promise<ResumenRespaldo | null> {
  if (respaldoEnCurso || !pgConfigActual) return null;

  const promesa = crearRespaldoAutomatico(
    pgConfigActual,
    obtenerRutas().backups,
    horasMinimas,
  );
  respaldoEnCurso = promesa;
  try {
    return await promesa;
  } catch (error) {
    console.error("[main] No se pudo crear el respaldo automatico:", error);
    return null;
  } finally {
    if (respaldoEnCurso === promesa) respaldoEnCurso = null;
  }
}

/** Crea un respaldo manual, sin permitir dos a la vez. */
async function respaldarManual(): Promise<ResumenRespaldo> {
  if (respaldoEnCurso) {
    throw new Error("Ya hay un respaldo en curso. Espera a que termine.");
  }
  if (!pgConfigActual) {
    throw new Error("La base de datos todavia no esta lista.");
  }

  const promesa = crearRespaldo(
    pgConfigActual,
    obtenerRutas().backups,
    "manual",
  );
  respaldoEnCurso = promesa;
  try {
    return await promesa;
  } finally {
    if (respaldoEnCurso === promesa) respaldoEnCurso = null;
  }
}

/**
 * Los canales que usa la pantalla de Respaldos.
 *
 * Todo el trabajo pesado vive en el proceso principal y no en la pantalla:
 * el renderer esta en sandbox y no tiene acceso a archivos ni a la base.
 * Esto es la unica puerta, y solo acepta estas cuatro operaciones.
 */
function registrarIpc(): void {
  ipcMain.handle("app:version", () => app.getVersion());

  ipcMain.handle("respaldos:listar", () =>
    listarRespaldos(obtenerRutas().backups),
  );

  ipcMain.handle("respaldos:crear", () => respaldarManual());

  ipcMain.handle("respaldos:abrir-carpeta", async () => {
    const error = await shell.openPath(obtenerRutas().backups);
    if (error) throw new Error(error);
  });

  ipcMain.handle("respaldos:restaurar", async (_evento, nombre: unknown) => {
    if (typeof nombre !== "string" || nombre.trim() === "") {
      throw new Error("El nombre del respaldo no es valido.");
    }
    if (restaurando) {
      throw new Error("Ya hay una restauracion en curso.");
    }
    if (respaldoEnCurso) {
      throw new Error("Hay un respaldo en curso. Espera a que termine.");
    }
    if (!pgConfigActual || !configuracionActual) {
      throw new Error("La base de datos todavia no esta lista.");
    }

    restaurando = true;
    const pg = pgConfigActual;
    const config = configuracionActual;
    const rutas = obtenerRutas();

    try {
      // Primero se guarda lo que hay AHORA. La restauracion ya es
      // transaccional y un fallo no toca nada, pero este archivo cubre el
      // error humano de restaurar el respaldo equivocado.
      await crearRespaldo(pg, rutas.backups, "seguridad");

      // El backend tiene que soltar el esquema: si sigue conectado, el
      // DROP SCHEMA espera sus locks y la restauracion no avanza.
      await detenerBackend();

      const resultado = await restaurarRespaldo(
        pg,
        rutas.backups,
        nombre.trim(),
      );

      // Se cierra PostgreSQL y se relanza la aplicacion. Es la forma de
      // garantizar que nadie quede con una conexion al esquema anterior.
      await detenerPostgres();
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 500);

      return { reiniciando: true, ...resultado };
    } catch (error) {
      // La restauracion hizo ROLLBACK, asi que la base sigue como estaba.
      // Se levanta el backend otra vez para que la persona pueda seguir
      // trabajando sin reiniciar a mano.
      try {
        await arrancarBackend(pg, config);
      } catch (errorRearranque) {
        console.error(
          "[main] No se pudo reiniciar el backend despues del fallo:",
          errorRearranque,
        );
      }
      throw error;
    } finally {
      restaurando = false;
    }
  });
}

async function arrancar() {
  const rutas = obtenerRutas();
  const configuracion = leerConfiguracion();
  console.log("[main] Rutas:", rutas.datos);

  try {
    const pgConfig = await iniciarPostgres(rutas);
    console.log("[main] PostgreSQL listo");

    // Se guardan ANTES de las migraciones para que un fallo posterior ya
    // tenga con que crear el respaldo de seguridad.
    pgConfigActual = pgConfig;
    configuracionActual = configuracion;

    await aplicarMigracionesEscritorio(pgConfig);
    console.log("[main] Migraciones listas");

    const admin = await crearAdminInicial(pgConfig, configuracion.admin);
    if (admin.creada) {
      dialog.showMessageBoxSync({
        type: "info",
        title: "Cuenta de administrador creada",
        message: "La cuenta de administrador quedó lista.",
        detail:
          `Correo: ${configuracion.admin.email}\n` +
          `Contraseña temporal: ${configuracion.admin.contrasena}\n\n` +
          "Al iniciar sesión el sistema pedirá cambiarla por una tuya.",
        buttons: ["Entendido"],
        noLink: true,
      });
    }

    // Respaldo del arranque: si el ultimo automatico tiene menos de 20
    // horas no se repite. Asi abrir la aplicacion varias veces al dia no
    // llena la carpeta, pero un dia sin respaldos no pasa.
    await respaldarAutomatico(20);

    await arrancarBackend(pgConfig, configuracion);
    console.log("[main] Backend listo");

    crearVentana();
  } catch (error: any) {
    const mensaje =
      error && typeof error === "object"
        ? error.stack ||
          error.message ||
          JSON.stringify(error, Object.getOwnPropertyNames(error))
        : String(error);
    console.error("[main] Error arrancando:", mensaje);
    dialog.showErrorBox(
      "No se pudo iniciar Nutricion Especializada",
      `La aplicación no pudo arrancar.\n\n${mensaje}`,
    );
    await apagar();
  }
}

// Una sola instancia: dos procesos pelearian por el mismo puerto de
// PostgreSQL y por los mismos archivos de datos.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!ventana) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });

  app.whenReady().then(() => {
    // Sin esto Electron dibuja el menú File/Edit/View/Window/Help, que no
    // aporta nada a la aplicación y además se ve encima de la interfaz.
    Menu.setApplicationMenu(null);
    registrarIpc();
    void arrancar();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void apagar();
  }
});

app.on("before-quit", (evento) => {
  evento.preventDefault();
  void apagar();
});

async function apagar() {
  if (apagando) return;
  apagando = true;

  try {
    // Si hay un respaldo escribiendose, se espera: cerrar a media escritura
    // dejaria un archivo que no se puede restaurar.
    if (respaldoEnCurso) {
      await respaldoEnCurso.catch(() => undefined);
    }
    // Respaldo del cierre: solo si no hay uno de la ultima hora.
    await respaldarAutomatico(1);
  } catch (error) {
    console.error("[main] Error creando el respaldo de cierre:", error);
  }

  try {
    await detenerBackend();
    await detenerPostgres();
  } catch (error) {
    console.error("[main] Error apagando:", error);
  } finally {
    app.exit(0);
  }
}
