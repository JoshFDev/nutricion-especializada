import { app, BrowserWindow, dialog, Menu } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { obtenerRutas } from './rutas.js';
import { iniciarPostgres, detenerPostgres } from './postgres.js';
import { aplicarMigracionesEscritorio } from './migrar-escritorio.js';
import { iniciarBackend, detenerBackend } from './backend.js';
import { leerConfiguracion } from './configuracion.js';
import { crearAdminInicial } from './admin-inicial.js';

// Este archivo se compila como ESM (package.json tiene "type": "module"),
// y en ESM no existe __dirname.
const dirname = fileURLToPath(new URL('.', import.meta.url));

let ventana: BrowserWindow | null = null;
let apagando = false;

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    center: true,
    show: false,
    backgroundColor: '#f7f4ec',
    autoHideMenuBar: true,
    title: 'Nutrición Especializada',
    // En Windows quitamos la barra de título nativa y dejamos sólo los
    // botones de minimizar/maximizar/cerrar encima de la barra azul de la
    // aplicación. Así la ventana se ve integrada y no como un marco gris.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#1e3a8a',
            symbolColor: '#ffffff',
            height: 56,
          },
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(dirname, existsSync(join(dirname, 'preload.cjs')) ? 'preload.cjs' : 'preload.js'),
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
  ventana.once('ready-to-show', () => {
    ventana?.show();
  });

  ventana.on('closed', () => {
    ventana = null;
  });

  const rutas = obtenerRutas();
  const url = `http://127.0.0.1:${rutas.puertoApi}/`;
  console.log(`[main] Cargando ${url}`);
  void ventana.loadURL(url);

  return ventana;
}

async function arrancar() {
  const rutas = obtenerRutas();
  const configuracion = leerConfiguracion();
  console.log('[main] Rutas:', rutas.datos);

  try {
    const pgConfig = await iniciarPostgres(rutas);
    console.log('[main] PostgreSQL listo');

    await aplicarMigracionesEscritorio(pgConfig);
    console.log('[main] Migraciones listas');

    const admin = await crearAdminInicial(pgConfig, configuracion.admin);
    if (admin.creada) {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Cuenta de administrador creada',
        message: 'La cuenta de administrador quedó lista.',
        detail:
          `Correo: ${configuracion.admin.email}\n` +
          `Contraseña temporal: ${configuracion.admin.contrasena}\n\n` +
          'Al iniciar sesión el sistema pedirá cambiarla por una tuya.',
        buttons: ['Entendido'],
        noLink: true,
      });
    }

    await iniciarBackend({
      pgHost: pgConfig.host,
      pgPort: pgConfig.port,
      pgDatabase: pgConfig.database,
      pgUser: pgConfig.user,
      pgPassword: pgConfig.password,
      puertoApi: rutas.puertoApi,
      smtp: configuracion.smtp,
    });
    console.log('[main] Backend listo');

    crearVentana();
  } catch (error) {
    const mensaje = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error('[main] Error arrancando:', mensaje);
    dialog.showErrorBox(
      'No se pudo iniciar Nutricion Especializada',
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
  app.on('second-instance', () => {
    if (!ventana) return;
    if (ventana.isMinimized()) ventana.restore();
    ventana.focus();
  });

  app.whenReady().then(() => {
    // Sin esto Electron dibuja el menú File/Edit/View/Window/Help, que no
    // aporta nada a la aplicación y además se ve encima de la interfaz.
    Menu.setApplicationMenu(null);
    void arrancar();
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void apagar();
  }
});

app.on('before-quit', (evento) => {
  evento.preventDefault();
  void apagar();
});

async function apagar() {
  if (apagando) return;
  apagando = true;

  try {
    await detenerBackend();
    await detenerPostgres();
  } catch (error) {
    console.error('[main] Error apagando:', error);
  } finally {
    app.exit(0);
  }
}
