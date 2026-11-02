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
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
}) {
  const cwd = carpetaBackend();
  const script = join(cwd, 'dist', 'index.js');

  console.log(`[backend] Iniciando ${script} desde ${cwd}`);

  const hijo = fork(script, [], {
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
      SMTP_HOST: config.smtp.host,
      SMTP_PORT: String(config.smtp.port),
      SMTP_SECURE: String(config.smtp.secure),
      SMTP_USER: config.smtp.user,
      SMTP_PASS: config.smtp.pass,
      SMTP_FROM: config.smtp.from,
    },
    stdio: 'inherit',
  });

  proceso = hijo;

  hijo.on('exit', (codigo) => {
    console.log(`[backend] Proceso finalizado con codigo ${codigo}`);
    // Solo se limpia si sigue siendo el proceso actual. Sin esta
    // comparacion, el `exit` del backend viejo (al restaurar y reiniciar)
    // borraria la referencia al backend NUEVO y la aplicacion se quedaria
    // creyendo que no hay ninguno.
    if (proceso === hijo) proceso = null;
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

/**
 * Detiene el backend y ESPERA a que el proceso termine.
 *
 * La version anterior mandaba SIGTERM y ponia `proceso = null` de inmediato.
 * Para apagar la aplicacion alcanzaba, pero para restaurar un respaldo no:
 * la restauracion necesita el esquema sin conexiones activas, y si el
 * backend seguia cerrando, el DROP SCHEMA se quedaba esperando sus locks.
 *
 * Si en cinco segundos no salio, se mata. Es el mismo plazo que usa
 * PostgreSQL para un apagado ordenado; mas tiempo solo deja la ventana
 * congelada.
 */
export async function detenerBackend(): Promise<void> {
  const hijo = proceso;
  if (!hijo) return;

  proceso = null;
  console.log('[backend] Deteniendo...');

  await new Promise<void>((resolver) => {
    const plazo = setTimeout(() => {
      try {
        hijo.kill('SIGKILL');
      } catch {
        // Ya habia terminado.
      }
      resolver();
    }, 5000);

    hijo.once('exit', () => {
      clearTimeout(plazo);
      resolver();
    });

    try {
      hijo.kill('SIGTERM');
    } catch {
      clearTimeout(plazo);
      resolver();
    }
  });
}
