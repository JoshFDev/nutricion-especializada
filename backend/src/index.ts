import { crearApp } from './app.js';
import { env } from './config/entorno.js';
import { baseViva, cerrarPool } from './db/pool.js';

/**
 * Arranque y apagado. Este archivo no importa rutas ni middleware: solo
 * levanta el servidor. Toda la composicion vive en app.ts, para poder
 * probarla sin abrir un puerto.
 */
const app = crearApp();
const servidor = app.listen(env.PORT, () => {
  console.log(`API escuchando en http://localhost:${env.PORT} (${env.NODE_ENV})`);
  void anunciarEstadoDeLaBase();
});

/**
 * Dice en la consola si la base responde de verdad.
 *
 * La conexion no se chequea ANTES de escuchar a proposito: si la base tarda,
 * no conviene que el proceso no arranque mientras espera. Se pregunta al aire,
 * apenas levanta el puerto, y el mensaje sale cuando se sabe. Si la base falla
 * aqui, el servidor sigue vivo para servir /api/salud, que es justo el
 * endpoint que separa "API caida" de "base caida".
 */
async function anunciarEstadoDeLaBase(): Promise<void> {
  if (await baseViva()) {
    console.log('Conexion a la base de datos exitosa');
  } else {
    console.error('No se pudo conectar a la base de datos en este momento');
  }
}

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
