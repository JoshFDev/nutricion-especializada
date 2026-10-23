import { fork, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import { join, resolve } from 'node:path';

let proceso: ChildProcess | null = null;

/**
 * Carpetas del backend segun el modo de ejecucion.
 *
 * En desarrollo electron-vite arranca Electron desde `desktop/`, asi que la
 * raiz del repositorio es un nivel arriba. En el paquete el backend viaja en
 * `resources/backend` (ver `electron-builder.yml`).
 */
function carpetaBackend() {
  return app.isPackaged
    ? join(process.resourcesPath, 'backend')
    : resolve(app.getAppPath(), '..', 'backend');
}

export async function iniciarBackend(config: {
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  puertoApi: number;
}) {
  const cwd = carpetaBackend();
  const script = join(cwd, 'dist', 'index.js');

  console.log(`[backend] Iniciando ${script} desde ${cwd}`);

  proceso = fork(script, [], {
    cwd,
    env: {
      ...process.env,

      // El hijo se lanza con el ejecutable de Electron. Esta variable hace
      // que ese ejecutable se comporte como Node en vez de abrir otra
      // ventana de la aplicacion.
      ELECTRON_RUN_AS_NODE: '1',

      NODE_ENV: 'production',
      PORT: String(config.puertoApi),
      PGHOST: config.pgHost,
      PGPORT: String(config.pgPort),
      PGDATABASE: config.pgDatabase,
      PGUSER: config.pgUser,
      PGPASSWORD: config.pgPassword,
      DB_SCHEMA: 'pos',
      DB_MAX_CONEXIONES: '10',
      CORS_ORIGINS: `http://127.0.0.1:${config.puertoApi}`,
      TRUST_PROXY: '0',
      JWT_EXPIRES_IN: '8h',
      EMPRESA_NOMBRE: 'Nutricion Especializada',
      APP_URL: `http://127.0.0.1:${config.puertoApi}`,
      SMTP_HOST: 'localhost',
      SMTP_PORT: '25',
      SMTP_SECURE: 'false',
    },
    stdio: 'inherit',
  });

  proceso.on('exit', (codigo) => {
    console.log(`[backend] Proceso finalizado con codigo ${codigo}`);
    proceso = null;
  });

  return new Promise<void>((resolveListo, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(intervalo);
      reject(new Error('Timeout esperando el backend'));
    }, 30000);

    const intervalo = setInterval(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${config.puertoApi}/api/salud`);
        if (res.ok) {
          clearInterval(intervalo);
          clearTimeout(timeout);
          console.log('[backend] Listo');
          resolveListo();
        }
      } catch {
        // El backend todavia no acepta conexiones; se sigue esperando.
      }
    }, 500);
  });
}

export async function detenerBackend() {
  if (proceso) {
    console.log('[backend] Deteniendo...');
    proceso.kill('SIGTERM');
    proceso = null;
  }
}
