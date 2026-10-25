import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { obtenerRutas } from './rutas.js';
import { iniciarPostgres, detenerPostgres } from './postgres.js';
import { aplicarMigracionesEscritorio } from './migrar-escritorio.js';
import { iniciarBackend, detenerBackend } from './backend.js';

// Este archivo se compila como ESM (package.json tiene "type": "module"),
// y en ESM no existe __dirname.
const dirname = fileURLToPath(new URL('.', import.meta.url));

let ventana: BrowserWindow | null = null;
let apagando = false;

function crearVentana() {
  ventana = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: 'Nutricion Especializada',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: join(dirname, existsSync(join(dirname, 'preload.cjs')) ? 'preload.cjs' : 'preload.js'),
    },
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
  console.log('[main] Rutas:', rutas.datos);

  try {
    const pgConfig = await iniciarPostgres(rutas);
    console.log('[main] PostgreSQL listo');

    await aplicarMigracionesEscritorio(pgConfig);
    console.log('[main] Migraciones listas');

    await iniciarBackend({
      pgHost: pgConfig.host,
      pgPort: pgConfig.port,
      pgDatabase: pgConfig.database,
      pgUser: pgConfig.user,
      pgPassword: pgConfig.password,
      puertoApi: rutas.puertoApi,
    });
    console.log('[main] Backend listo');

    crearVentana();
  } catch (error) {
    console.error('[main] Error arrancando:', error);
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
