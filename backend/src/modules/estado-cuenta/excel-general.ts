import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RUTA_PLANTILLA = join(RAIZ, 'plantillas', 'EstadoCuentaGeneral.xlsx');
const RUTA_PLANTILLA_EJEMPLO = join(RAIZ, 'plantillas', 'EstadoCuentaGeneral.example.xlsx');

async function leerPlantillaGeneral(): Promise<Buffer> {
  try {
    return await readFile(RUTA_PLANTILLA);
  } catch (falla) {
    if ((falla as NodeJS.ErrnoException).code !== 'ENOENT') throw falla;
    return readFile(RUTA_PLANTILLA_EJEMPLO);
  }
}

export interface RenglonGeneral {
  cliente: string;
  saldo_actual: number;
}

export async function excelEstadoCuentaGeneral(renglones: RenglonGeneral[]): Promise<{
  bytes: Buffer;
  renglonesFuera: number;
  escritos: number;
}> {
  const plantilla = await leerPlantillaGeneral();
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(plantilla as unknown as ArrayBuffer);
  const hoja = libro.worksheets[0];
  if (hoja === undefined) {
    throw new Error('La plantilla de estado de cuenta general no trae ninguna hoja de calculo');
  }

  libro.title = 'Estado de cuenta general';
  libro.creator = 'Nutricion Especializada';

  const MAX_RENGLONES = 18; // filas 8-25
  const PRIMERA_FILA = 8;

  const hoy = new Date();
  const fechaTexto = hoy
    .toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
    .replace('.', '');
  const celdaFecha = hoja.getCell('B6');
  celdaFecha.value = fechaTexto;
  celdaFecha.alignment = { horizontal: 'right', vertical: 'middle' };

  const visibles = renglones.slice(0, MAX_RENGLONES);
  let suma = 0;

  for (let i = 0; i < visibles.length; i += 1) {
    const fila = PRIMERA_FILA + i;
    const renglon = visibles[i];
    if (renglon === undefined) continue;

    hoja.getCell(`B${fila}`).value = renglon.cliente;
    const celdaSaldo = hoja.getCell(`C${fila}`);
    celdaSaldo.value = renglon.saldo_actual;
    celdaSaldo.numFmt = '#,##0.00';
    suma += renglon.saldo_actual;
  }

  hoja.getCell('B26').value = 'Total';
  const celdaTotal = hoja.getCell('C26');
  celdaTotal.value = suma;
  celdaTotal.numFmt = '#,##0.00';

  const bytes = Buffer.from(await libro.xlsx.writeBuffer());
  const escritos = visibles.length;
  const renglonesFuera = Math.max(0, renglones.length - MAX_RENGLONES);

  return { bytes, renglonesFuera, escritos };
}
