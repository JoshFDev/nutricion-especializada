import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const NOMBRE_ARCHIVO = "configuracion-respaldos.json";

interface ConfiguracionRespaldos {
  /** Carpeta personalizada donde se guardan los respaldos. Si no se setea, se usa la por defecto. */
  carpetaRespaldos?: string;
}

let cache: ConfiguracionRespaldos | null = null;

function rutaArchivo(): string {
  return join(app.getPath("userData"), NOMBRE_ARCHIVO);
}

/**
 * Lee la configuracion de respaldos guardada en `userData`.
 * No lanza: si no existe o esta corrupta, devuelve un objeto vacio.
 */
export async function leerConfiguracionRespaldos(): Promise<ConfiguracionRespaldos> {
  if (cache) return cache;

  const ruta = rutaArchivo();
  try {
    const crudo = JSON.parse(
      await readFile(ruta, "utf8"),
    ) as Partial<ConfiguracionRespaldos>;
    cache = crudo;
  } catch {
    cache = {};
  }
  return cache;
}

/**
 * Guarda la configuracion de respaldos en `userData`.
 */
export async function guardarConfiguracionRespaldos(
  config: ConfiguracionRespaldos,
): Promise<void> {
  const ruta = rutaArchivo();
  const dir = join(ruta, "..");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(ruta, JSON.stringify(config, null, 2), "utf8");
  cache = config;
}

/**
 * Devuelve la carpeta de respaldos a usar: la personalizada si se eligio una,
 * o la por defecto (`datos/backups`) si no.
 */
export async function obtenerCarpetaRespaldos(
  carpetaPorDefecto: string,
): Promise<string> {
  const config = await leerConfiguracionRespaldos();
  return config.carpetaRespaldos ?? carpetaPorDefecto;
}

/**
 * Establece la carpeta personalizada de respaldos y la persiste.
 */
export async function establecerCarpetaRespaldos(
  carpeta: string,
): Promise<void> {
  const config = await leerConfiguracionRespaldos();
  config.carpetaRespaldos = carpeta;
  await guardarConfiguracionRespaldos(config);
}
