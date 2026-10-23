import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import pg from 'pg';

const ESQUEMA = 'pos';

function quitarComandosPsql(sql: string): string {
  const lineas = sql.split('\n');
  return lineas.filter((l) => !/^\s*\\/.test(l)).join('\n');
}

export async function aplicarMigracionesEscritorio(config: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}) {
  const cliente = new pg.Client(config);
  await cliente.connect();

  try {
    await cliente.query(`CREATE SCHEMA IF NOT EXISTS ${ESQUEMA}`);
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS ${ESQUEMA}.schema_migrations (
        version     TEXT PRIMARY KEY,
        aplicada_en TIMESTAMP NOT NULL DEFAULT now(),
        duracion_ms INTEGER
      )
    `);

    await cliente.query(`SET search_path TO ${ESQUEMA}, public`);

    // Buscar migraciones: en desarrollo desde repo, en producción desde recursos
    let carpetaMigraciones: string;
    if (app.isPackaged) {
      carpetaMigraciones = join(process.resourcesPath, 'db', 'migrations');
    } else {
      carpetaMigraciones = resolve(app.getAppPath(), '..', 'db', 'migrations');
    }

    const archivos = await readdir(carpetaMigraciones);
    const migraciones = archivos
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((archivo) => ({
        version: archivo.replace(/\.sql$/, ''),
        ruta: join(carpetaMigraciones, archivo),
      }));

    const hechas = await cliente.query(`SELECT version FROM ${ESQUEMA}.schema_migrations`);
    const aplicadasSet = new Set(hechas.rows.map((f: { version: string }) => String(f.version)));

    for (const m of migraciones) {
      if (aplicadasSet.has(m.version)) continue;
      console.log(`[migrar] Aplicando ${m.version}...`);
      const sql = await readFile(m.ruta, 'utf8');
      const limpio = quitarComandosPsql(sql);

      const inicio = Date.now();
      await cliente.query('BEGIN');
      try {
        await cliente.query(limpio);
        await cliente.query(
          `INSERT INTO ${ESQUEMA}.schema_migrations (version, duracion_ms) VALUES ($1, $2)
           ON CONFLICT (version) DO UPDATE SET duracion_ms = EXCLUDED.duracion_ms`,
          [m.version, Date.now() - inicio],
        );
        await cliente.query('COMMIT');
        console.log(`[migrar] ${m.version} OK`);
      } catch (error) {
        await cliente.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }

    console.log('[migrar] Todo al día');
  } finally {
    await cliente.end();
  }
}
