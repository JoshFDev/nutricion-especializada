/**
 * Runner de migraciones.
 *
 * Que resuelve: hoy el esquema se aplicaba a mano. En cuanto haya un
 * 0002, aplicarlo a mano es facil de olvidar y mas facil de hacer dos
 * veces. Este script aplica solo lo que falta y deja registro de que se
 * aplico.
 *
 * Decisiones que importan:
 *
 * - Cada migracion corre DENTRO de su propia transaccion, y el registro
 *   en schema_migrations se escribe en esa misma transaccion. Si la
 *   migracion falla, no queda ni el schema a medias ni se marca como aplicada.
 *
 * - Las migraciones aplicadas NUNCA se vuelven a correr. Por eso
 *   0001_init lanza una excepcion si se intenta repetir: es una red de
 *   seguridad por si alguien edita un archivo viejo.
 *
 * - El orden es por nombre de archivo, asi que el prefijo numerico
 *   (0001, 0002...) es lo que define el orden. No se ordenan por fecha.
 *
 * COMO SE ESCRIBE UNA MIGRACION NUEVA (0002 en adelante):
 *
 *   - NO la envuelvas en BEGIN/COMMIT: la transaccion la maneja el runner.
 *   - NO insertes en schema_migrations: de eso se ocupa el runner.
 *   - NO edites un archivo ya aplicado. Crea uno nuevo.
 *
 * 0001_init si lleva BEGIN/COMMIT y su propio INSERT, porque se escribio
 * antes de que existiera este runner. Por eso el INSERT de aqui va con
 * ON CONFLICT: si la migracion ya se registro sola, no se reventa.
 *
 * Uso:
 *   pnpm migrar              crea la base si falta y aplica lo pendiente
 *   pnpm migrar --estado     solo muestra que hay aplicado y que falta
 *   pnpm migrar --seed       aplica migraciones y luego el seed demo
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as cargarDotenv } from 'dotenv';
import pg from 'pg';

// Se carga el .env de backend/ igual que lo hace la aplicacion, para que
// el runner y el API apunten siempre a la misma base. Sin esto, el script
// usaria el nombre por defecto y podria aplicarle el esquema a otra.
cargarDotenv();

const { Client } = pg;

// El script vive en backend/scripts, asi que la raiz del proyecto es un
// nivel arriba. Se calcula desde la ruta del propio archivo y no desde el
// process.cwd(), porque si se lanza desde otra carpeta apuntaria mal.
const aqui = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(aqui, '..', '..');
const CARPETA_MIGRACIONES = join(RAIZ, 'db', 'migrations');
const CARPETA_SEEDS = join(RAIZ, 'db', 'seeds');

const ESQUEMA = 'pos';

/** Configuracion de conexion, tomada de las variables de entorno. */
function conexion(base: string) {
  return {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgresql',
    database: base,
  };
}

const BASE = process.env.PGDATABASE ?? process.env.DB_NAME ?? 'nutricion_especializada';

/** Nombres de archivo tipo 0002_agrega_indice.sql -> version '0002_agrega_indice'. */
interface Migracion {
  version: string;
  archivo: string;
  ruta: string;
}

async function listarMigraciones(): Promise<Migracion[]> {
  const archivos = await readdir(CARPETA_MIGRACIONES);
  return archivos
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((archivo) => ({
      version: archivo.replace(/\.sql$/, ''),
      archivo,
      ruta: join(CARPETA_MIGRACIONES, archivo),
    }));
}

/**
 * Crea la base si no existe. Se conecta a 'postgres' porque no se puede
 * crear una base desde adentro de ella misma.
 */
async function asegurarBase(): Promise<boolean> {
  const admin = new Client(conexion('postgres'));
  await admin.connect();
  try {
    const existe = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [BASE]);
    if (existe.rowCount && existe.rowCount > 0) return false;

    // El nombre no se puede parametrizar en un CREATE DATABASE, asi que
    // se escapa a mano. No es inyeccion desde fuera porque BASE viene
    // del .env del proyecto, pero igual se valida.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(BASE)) {
      throw new Error(
        `El nombre de base "${BASE}" no es valido. Solo letras, numeros y guion bajo.`,
      );
    }
    await admin.query(`CREATE DATABASE "${BASE}" ENCODING 'UTF8'`);
    console.log(`  base creada: ${BASE}`);
    return true;
  } finally {
    await admin.end();
  }
}

/**
 * Prepara el esquema de control antes de la primera migracion.
 *
 * 0001 crea el esquema pos y la tabla schema_migrations por su cuenta,
 * pero el runner necesita saber QUE hay aplicado ANTES de aplicarla. Por
 * eso el bootstrap va aparte, y usa IF NOT EXISTS para no molestar a una
 * base que ya esta lista.
 */
async function prepararControl(cliente: pg.Client): Promise<void> {
  await cliente.query(`CREATE SCHEMA IF NOT EXISTS ${ESQUEMA}`);
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS ${ESQUEMA}.schema_migrations (
      version     TEXT PRIMARY KEY,
      aplicada_en TIMESTAMP NOT NULL DEFAULT now(),
      duracion_ms INTEGER
    )
  `);
}

async function aplicadas(cliente: pg.Client): Promise<Set<string>> {
  const r = await cliente.query(`SELECT version FROM ${ESQUEMA}.schema_migrations`);
  return new Set(r.rows.map((f) => String(f.version)));
}

/**
 * Quita los comandos de psql (los que empiezan por \).
 *
 * El seed esta escrito para que se pueda leer con psql, y ahi los \echo
 * sirven para ver secciones. Pero `pg` los manda tal cual al servidor y
 * PostgreSQL no los entiende. Se filtran aqui para que el mismo archivo
 * sirva para las dos cosas.
 */
function quitarComandosPsql(sql: string): { limpio: string; quitados: number } {
  const lineas = sql.split('\n');
  const quitados = lineas.filter((l) => /^\s*\\/.test(l)).length;
  return { limpio: lineas.filter((l) => !/^\s*\\/.test(l)).join('\n'), quitados };
}

async function aplicarSeed(cliente: pg.Client, archivo: string): Promise<void> {
  const ruta = join(CARPETA_SEEDS, archivo);
  console.log(`\n  seed: ${archivo}`);
  const original = await readFile(ruta, 'utf8');
  const { limpio: sql, quitados } = quitarComandosPsql(original);
  if (quitados > 0) {
    console.log(`  (${quitados} comandos \\echo omitidos: solo funcionan en psql)`);
  }
  await cliente.query('BEGIN');
  try {
    await cliente.query(sql);
    await cliente.query('COMMIT');
    console.log('  seed aplicado');
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  }
}

async function principal(): Promise<number> {
  const soloEstado = process.argv.includes('--estado');
  const conSeed = process.argv.includes('--seed');

  console.log(`Base: ${BASE}\n`);

  if (!soloEstado) {
    await asegurarBase();
  }

  const cliente = new Client(conexion(BASE));
  await cliente.connect();
  let codigo = 0;

  try {
    // search_path para que los nombres cortos (schema_migrations) valgan
    // en las consultas de control, y para que pgcrypto quede disponible.
    await cliente.query(`SET search_path TO ${ESQUEMA}, public`);
    await prepararControl(cliente);

    const migraciones = await listarMigraciones();
    const hechas = await aplicadas(cliente);
    const pendientes = migraciones.filter((m) => !hechas.has(m.version));

    console.log(`Migraciones en disco: ${migraciones.length}`);
    console.log(`  aplicadas: ${hechas.size}`);
    console.log(`  pendientes: ${pendientes.length}\n`);

    for (const m of migraciones) {
      const estado = hechas.has(m.version) ? 'aplicada' : 'PENDIENTE';
      console.log(`  [${estado.padEnd(9)}] ${m.archivo}`);
    }

    if (soloEstado) {
      console.log('\n(solo lectura: no se aplico nada)');
      return codigo;
    }

    if (pendientes.length === 0) {
      console.log('\nNo hay migraciones pendientes.');
    }

    for (const m of pendientes) {
      console.log(`\nAplicando ${m.archivo}...`);
      const sql = await readFile(m.ruta, 'utf8');
      const inicio = Date.now();

      /**
       * OJO: la migracion y su registro van en la MISMA transaccion. Si
       * se registrara aparte y la migracion fallara, quedaria marcada
       * como aplicada sin estarlo, y no se volveria a intentar nunca.
       *
       * El ON CONFLICT esta por 0001_init: ese archivo se cierra con su
       * propio COMMIT y su propio INSERT en schema_migrations, asi que la
       * fila ya existe cuando aqui se llega y un INSERT normal reventaria
       * con "llave duplicada". Con DO UPDATE solo se completa la duracion.
       */
      await cliente.query('BEGIN');
      try {
        await cliente.query(sql);
        const duracion = Date.now() - inicio;
        await cliente.query(
          `INSERT INTO ${ESQUEMA}.schema_migrations (version, duracion_ms)
           VALUES ($1, $2)
           ON CONFLICT (version) DO UPDATE SET duracion_ms = EXCLUDED.duracion_ms`,
          [m.version, duracion],
        );
        await cliente.query('COMMIT');
        console.log(`  ok en ${duracion} ms`);
      } catch (error) {
        await cliente.query('ROLLBACK').catch(() => undefined);
        console.error(`  FALLO ${m.archivo}: rollback completo, nada quedo a medias`);
        throw error;
      }
    }

    if (conSeed) {
      await aplicarSeed(cliente, 'seed_demo.sql');
    }

    console.log(`\nListo. Base "${BASE}" al dia.`);
    return codigo;
  } finally {
    await cliente.end();
  }
}

try {
  process.exitCode = await principal();
} catch (error) {
  const mensaje = error instanceof Error ? error.message : String(error);
  console.error(`\nERROR: ${mensaje}`);
  process.exitCode = 1;
}
