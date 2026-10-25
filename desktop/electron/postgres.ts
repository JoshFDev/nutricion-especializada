import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { obtenerRutas } from './rutas.js';

type Rutas = ReturnType<typeof obtenerRutas>;

let pgInstance: EmbeddedPostgres | null = null;

export async function iniciarPostgres(rutas: Rutas) {
  const yaExiste = existsSync(join(rutas.pgData, 'PG_VERSION'));

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
