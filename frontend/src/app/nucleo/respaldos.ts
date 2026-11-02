/**
 * El puente con los respaldos del proceso principal.
 *
 * La pantalla no puede tocar archivos ni la base: todo pasa por
 * `window.electronAPI.respaldos`, que expone `preload.ts`. En el navegador
 * normal esa propiedad no existe, y esta capa devuelve `null`/`false` en vez
 * de reventar para que la pantalla pueda explicar que los respaldos solo
 * estan en la aplicacion de escritorio.
 */

export type TipoRespaldo = 'automatico' | 'manual' | 'seguridad';

export interface Respaldo {
  nombre: string;
  ruta: string;
  tamano: number;
  creadoEn: string;
  tipo: TipoRespaldo;
}

export interface ResultadoRestauracion {
  reiniciando: boolean;
  tablas: number;
  filas: number;
}

interface RespaldosApi {
  listar: () => Promise<Respaldo[]>;
  crear: () => Promise<Respaldo>;
  restaurar: (nombre: string) => Promise<ResultadoRestauracion>;
  abrirCarpeta: () => Promise<void>;
}

interface ElectronApi {
  respaldos?: RespaldosApi;
}

function api(): RespaldosApi | null {
  const electron = (window as Window & { electronAPI?: ElectronApi }).electronAPI;
  return electron?.respaldos ?? null;
}

/** Si la pantalla puede gestionar respaldos en este entorno. */
export function respaldosDisponibles(): boolean {
  return api() !== null;
}

export async function listarRespaldos(): Promise<Respaldo[]> {
  const puente = api();
  if (!puente) return [];
  return puente.listar();
}

export async function crearRespaldo(): Promise<Respaldo> {
  const puente = api();
  if (!puente)
    throw new Error('Los respaldos solo estan disponibles en la aplicacion de escritorio.');
  return puente.crear();
}

export async function restaurarRespaldo(nombre: string): Promise<ResultadoRestauracion> {
  const puente = api();
  if (!puente)
    throw new Error('Los respaldos solo estan disponibles en la aplicacion de escritorio.');
  return puente.restaurar(nombre);
}

export async function abrirCarpetaRespaldos(): Promise<void> {
  const puente = api();
  if (!puente)
    throw new Error('Los respaldos solo estan disponibles en la aplicacion de escritorio.');
  return puente.abrirCarpeta();
}

/** El tamano en una unidad que se pueda leer de un vistazo. */
export function tamanoLegible(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** La fecha del archivo, en la zona horaria de la computadora. */
export function fechaLegible(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return iso;
  return new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(fecha);
}
