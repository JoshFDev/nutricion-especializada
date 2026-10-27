import './compatibilidad.js';
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { net } from 'node:net';
import pg from 'pg';
import type { obtenerRutas } from './rutas.js';

type Rutas = ReturnType<typeof obtenerRutas>;

let pgInstance: EmbeddedPostgres | null = null;

/** Devuelve `true` si el puerto ya está en uso (hay un PostgreSQL corriendo). */
function puertoEnUso(puerto: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(puerto, () => {
      server.close();
      resolve(false);
    });
    server.on('error', () => resolve(true));
  });
}

export async function iniciarPostgres(rutas: Rutas) {
  // Si ya hay un PostgreSQL corriendo en el puerto esperado, no lo reiniciamos.
  const yaCorriendo = await puertoEnUso(rutas.puertoPg);
  if (yaCorriendo) {
    console.log('[postgres] Ya hay un servidor PostgreSQL en el puerto', rutas.puertoPg, '(se omite el inicio embebido)');
    return {
      host: '127.0.0.1',
      port: rutas.puertoPg,
      database: rutas.baseDatos,
      user: rutas.usuario,
      password: rutas.password,
    };
  }

  pgInstance = new EmbeddedPostgres({
    databaseDir: rutas.pgData,
    user: rutas.usuario,
    password: rutas.password,
    port: rutas.puertoPg,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  if (!yaExiste) {
    console.log('[postgres] Inicializando clúster...');
    await pgInstance.initialise();
  }

  console.log('[postgres] Iniciando servidor...');
  await pgInstance.start();

  // Crear BD si no existe
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: rutas.puertoPg,
    user: rutas.usuario,
    password: rutas.password,
    database: 'postgres',
    client_encoding: 'UTF8',
  });

  try {
    await admin.connect();
    const existe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [rutas.baseDatos]);
    if (!existe.rowCount || existe.rowCount === 0) {
      console.log(`[postgres] Creando base de datos ${rutas.baseDatos}...`);
      await admin.query(`CREATE DATABASE "${rutas.baseDatos}"`);
    }
  } finally {
    await admin.end();
  }

  return {
    host: '127.0.0.1',
    port: rutas.puertoPg,
    database: rutas.baseDatos,
    user: rutas.usuario,
    password: rutas.password,
  };
}

export async function detenerPostgres() {
  if (pgInstance) {
    console.log('[postgres] Deteniendo servidor...');
    await pgInstance.stop();
    pgInstance = null;
  }
}
