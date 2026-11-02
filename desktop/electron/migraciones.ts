import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { app } from "electron";
import type pg from "pg";

/**
 * Lectura y aplicacion de las migraciones de la base `pos`.
 *
 * Vive aparte de `migrar-escritorio.ts` porque hay DOS momentos que aplican
 * exactamente los mismos archivos:
 *
 *   1. el arranque normal, que aplica solo las que faltan; y
 *   2. la restauracion de un respaldo, que borra el esquema y las aplica
 *      TODAS dentro de la misma transaccion que la importacion.
 *
 * Si cada uno tuviera su copia, un cambio en la forma de leer los archivos
 * (o en la limpieza de `\` y de BEGIN/COMMIT) se haria en una y no en la
 * otra, y el respaldo restaurado quedaria con un esquema distinto al que la
 * aplicacion espera.
 */

export const ESQUEMA = "pos";

export interface Migracion {
  version: string;
  ruta: string;
}

/** Quita las lineas que son comandos de `psql` y no SQL (`\c`, `\echo`...). */
export function quitarComandosPsql(sql: string): string {
  return sql
    .split("\n")
    .filter((linea) => !/^\s*\\/.test(linea))
    .join("\n");
}

/**
 * Quita los `BEGIN;` y `COMMIT;` que traen algunos archivos.
 *
 * La convencion es que las migraciones NO traigan transaccion: la abre el
 * runner para poder registrar la version en el mismo commit. Pero
 * `0001_init.sql` es anterior a esa convencion y trae la suya.
 *
 * En el arranque normal esto no se notaba porque PostgreSQL avisa "there is
 * already a transaction in progress" y el COMMIT de adentro cerraba la
 * transaccion del runner, dejando el INSERT de `schema_migrations` fuera.
 * En una restauracion eso seria peor: el COMMIT cerraria la transaccion
 * unica y un fallo posterior ya no podria deshacer el DROP del esquema.
 *
 * Se quitan solo las lineas que son exactamente la orden, para no tocar un
 * `BEGIN` que viva dentro del cuerpo de una funcion.
 */
export function quitarTransacciones(sql: string): string {
  return sql
    .split("\n")
    .filter((linea) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(linea))
    .join("\n");
}

/** El SQL listo para ejecutar: sin comandos de psql ni transacciones propias. */
export function limpiarSql(sql: string): string {
  return quitarTransacciones(quitarComandosPsql(sql));
}

/**
 * La carpeta de migraciones segun el modo de ejecucion.
 *
 * En desarrollo se lee del repositorio; en el paquete viaja en
 * `resources/db/migrations` (ver `electron-builder.yml`).
 */
export function carpetaMigraciones(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "db", "migrations")
    : resolve(app.getAppPath(), "..", "db", "migrations");
}

/** Los archivos `.sql` de la carpeta, en orden alfabetico (que es el de version). */
export async function leerMigraciones(): Promise<Migracion[]> {
  const carpeta = carpetaMigraciones();
  const archivos = await readdir(carpeta);
  return archivos
    .filter((archivo) => archivo.endsWith(".sql"))
    .sort()
    .map((archivo) => ({
      version: archivo.replace(/\.sql$/, ""),
      ruta: join(carpeta, archivo),
    }));
}

/**
 * Deja listo el esquema y su tabla de control, y apunta `search_path` a el.
 *
 * Es idempotente a proposito: en el arranque normal se llama sobre un
 * esquema que ya existe, y en la restauracion sobre uno recien creado.
 */
export async function prepararEsquema(cliente: pg.ClientBase): Promise<void> {
  await cliente.query(`CREATE SCHEMA IF NOT EXISTS ${ESQUEMA}`);
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS ${ESQUEMA}.schema_migrations (
      version     TEXT PRIMARY KEY,
      aplicada_en TIMESTAMP NOT NULL DEFAULT now(),
      duracion_ms INTEGER
    )
  `);
  await cliente.query(`SET search_path TO ${ESQUEMA}, public`);
}

/** Ejecuta un archivo de migracion ya limpio. */
export async function ejecutarMigracion(
  cliente: pg.ClientBase,
  migracion: Migracion,
): Promise<void> {
  const sql = await readFile(migracion.ruta, "utf8");
  await cliente.query(limpiarSql(sql));
}

/**
 * Anota una version como aplicada.
 *
 * `ON CONFLICT` porque `0001_init.sql` se anota sola al final de su propio
 * SQL. En la restauracion el runner vuelve a anotarla y no debe reventar por
 * eso.
 */
export async function registrarMigracion(
  cliente: pg.ClientBase,
  version: string,
  duracionMs: number,
): Promise<void> {
  await cliente.query(
    `INSERT INTO ${ESQUEMA}.schema_migrations (version, duracion_ms) VALUES ($1, $2)
     ON CONFLICT (version) DO UPDATE SET duracion_ms = EXCLUDED.duracion_ms`,
    [version, duracionMs],
  );
}

/**
 * Aplica las migraciones que falten, cada una en su propia transaccion.
 *
 * Es el camino del arranque normal. Si una falla, esa migracion se revierte
 * y las anteriores quedan aplicadas: la proxima vez se reintenta desde la
 * que fallo.
 */
export async function aplicarMigracionesPendientes(
  cliente: pg.ClientBase,
): Promise<void> {
  await prepararEsquema(cliente);

  const migraciones = await leerMigraciones();
  const hechas = await cliente.query(
    `SELECT version FROM ${ESQUEMA}.schema_migrations`,
  );
  const aplicadas = new Set(
    hechas.rows.map((fila: { version: string }) => String(fila.version)),
  );

  for (const migracion of migraciones) {
    if (aplicadas.has(migracion.version)) continue;

    console.log(`[migrar] Aplicando ${migracion.version}...`);
    const inicio = Date.now();
    await cliente.query("BEGIN");
    try {
      await ejecutarMigracion(cliente, migracion);
      await registrarMigracion(cliente, migracion.version, Date.now() - inicio);
      await cliente.query("COMMIT");
      console.log(`[migrar] ${migracion.version} OK`);
    } catch (error) {
      await cliente.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  console.log("[migrar] Todo al dia");
}

/**
 * Aplica TODAS las migraciones dentro de una transaccion que ya esta abierta.
 *
 * La usa la restauracion. No abre ni cierra transaccion: si lo hiciera, un
 * fallo al importar los datos ya no podria deshacer el DROP del esquema, y
 * la base quedaria a medias.
 */
export async function aplicarTodasLasMigraciones(
  cliente: pg.ClientBase,
): Promise<void> {
  await prepararEsquema(cliente);

  for (const migracion of await leerMigraciones()) {
    const inicio = Date.now();
    await ejecutarMigracion(cliente, migracion);
    await registrarMigracion(cliente, migracion.version, Date.now() - inicio);
  }
}
