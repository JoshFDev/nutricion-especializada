import { crearApp } from './app.js';
import { env } from './config/entorno.js';
import { cerrarPool } from './db/pool.js';

/**
 * Arranque y apagado. Este archivo no importa rutas ni middleware: solo
 * levanta el servidor. Toda la composicion vive en app.ts, para poder
 * probarla sin abrir un puerto.
 */
const app = crearApp();
const servidor = app.listen(env.PORT, () => {
  console.log(`API escuchando en http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

/**
 * Cierra el pool ANTES de salir. Si no, las conexiones abiertas mantienen
 * vivo el proceso y el comando de deploy se queda colgado esperando.
 */
let apagando = false;
async function apagar(senal: string): Promise<void> {
  // Sin esta guarda, Ctrl-C dos veces dispara dos apagados y la segunda
  // pooled().end() revienta con "Called end() twice".
  if (apagando) return;
  apagando = true;
  console.log(`\n${senal} recibida, cerrando...`);
  servidor.close();
  await cerrarPool();
  process.exit(0);
}

process.on('SIGINT', () => void apagar('SIGINT'));
process.on('SIGTERM', () => void apagar('SIGTERM'));
