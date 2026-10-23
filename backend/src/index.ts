import type { PoolClient } from 'pg';
import { crearApp } from './app.js';
import { env } from './config/entorno.js';
import { baseViva, cerrarPool, pool } from './db/pool.js';
import { podarSesiones } from './modules/auth/repositorio.js';

/** Cuanto se guardan las sesiones ya cerradas, solo para diagnostico. */
const DIAS_SESIONES_CERRADAS = 30;

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
    await podarSesionesDeArranque();
  } else {
    console.error('No se pudo conectar a la base de datos en este momento');
  }
}

/**
 * Limpia las sesiones que ya no sirven, una vez al arrancar.
 *
 * No se hace en cada peticion ni con un cron aparte: son pocas filas, el
 * arranque es el momento natural para hacerlo y, si falla, el servidor tiene
 * que seguir levantando igual. Una tabla de sesiones que solo crece termina
 * costando en cada consulta de autenticacion.
 */
async function podarSesionesDeArranque(): Promise<void> {
  let cliente: PoolClient | undefined;
  try {
    cliente = await pool.connect();
    const borradas = await podarSesiones(cliente, DIAS_SESIONES_CERRADAS);
    if (borradas > 0) {
      console.log(`Sesiones antiguas eliminadas: ${borradas}`);
    }
  } catch (error) {
    console.error('No se pudieron podar las sesiones antiguas:', error);
  } finally {
    cliente?.release();
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
