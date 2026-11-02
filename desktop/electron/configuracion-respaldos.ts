import { app } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

const NOMBRE_ARCHIVO = "configuracion-respaldos.json";

interface ConfiguracionRespaldos {
  /** Carpeta personalizada donde se guardan los respaldos. Si no se setea, se usa la por defecto. */
  carpetaRespaldos?: string;

  /** Configuracion de respaldos programados automaticamente. */
  horario?: {
    /** Si los respaldos programados estan activos. */
    activo: boolean;
    /** Hora del dia (0-23) para crear el respaldo automatico. */
    hora: number;
    /** Minuto de la hora (0-59) para crear el respaldo automatico. */
    minuto: number;
    /** Dias de la semana (0=domingo, 1=lunes, ... 6=Sabado) en que correr. */
    diasSemana: number[];
  };
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

/**
 * Valores por defecto para los respaldos programados.
 *
 * Por defecto estan desactivados. Si se activan, corren todos los dias a
 * las 20:00 (8 PM), justo despues del cierre habitual del negocio.
 */
const HORARIO_POR_DEFECTO: Required<ConfiguracionRespaldos>["horario"] = {
  activo: false,
  hora: 20,
  minuto: 0,
  diasSemana: [0, 1, 2, 3, 4, 5, 6],
};

/**
 * Devuelve la configuracion de horario de respaldos programados.
 */
export async function obtenerHorarioRespaldos(): Promise<
  Required<ConfiguracionRespaldos>["horario"]
> {
  const config = await leerConfiguracionRespaldos();
  return {
    activo: config.horario?.activo ?? HORARIO_POR_DEFECTO.activo,
    hora: config.horario?.hora ?? HORARIO_POR_DEFECTO.hora,
    minuto: config.horario?.minuto ?? HORARIO_POR_DEFECTO.minuto,
    diasSemana: config.horario?.diasSemana ?? HORARIO_POR_DEFECTO.diasSemana,
  };
}

/**
 * Guarda la configuracion de horario de respaldos programados.
 */
export async function guardarHorarioRespaldos(
  horario: Required<ConfiguracionRespaldos>["horario"],
): Promise<void> {
  const config = await leerConfiguracionRespaldos();
  config.horario = horario;
  await guardarConfiguracionRespaldos(config);
}
