import { crearApp } from './app.js';
import { env } from './config/entorno.js';
import { pool } from './db/pool.js';

const app = crearApp();
const servidor = app.listen(env.PORT, () => {
  console.log(`API escuchando en http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

/**
 * Cierra el pool ANTES de salir. Si no, las conexiones abiertas mantienen
 * vivo el proceso y el comando de deploy se cuelga esperando.
 */
async function apagar(senal: string) {
  console.log(`\n${senal} recibida, cerrando...`);
  servidor.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void apagar('SIGINT'));
process.on('SIGTERM', () => void apagar('SIGTERM'));
