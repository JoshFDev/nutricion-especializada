import type { PoolClient } from 'pg';
import { NoEncontrado } from '../../core/errores.js';
import { componerFolio } from '../notas-remision/modelo.js';
import * as excel from './excel.js';
import * as excelGeneral from './excel-general.js';
import type { HojaCliente, Movimiento } from './modelo.js';
import { fechaDiaMesAnio } from './plantilla.js';
import * as repo from './repositorio.js';
import type { ListarEstadoCuenta } from './esquemas.js';
import type { Listado, RenglonEstadoCuenta } from './modelo.js';

/**
 * El estado de cuenta, del SQL al Excel.
 *
 * El listado es un pasar la consulta al controlador. La hoja junta las ventas
 * y los abonos en una sola lista cronologica (primero la venta y luego el
 * abono del mismo dia), y esa lista es la que `excel.ts` vierte en la
 * plantilla. Combinar aca, y no en el SQL, deja la regla del orden bien
 * visible y probable sin base de datos.
 */

/**
 * Las ventas y los abonos del cliente, ya mezclados en orden cronologico.
 *
 * El `fecha::TEXT` del SQL llega como "AAAA-MM-DD" y se pasa al formato del
 * papel (DD-MM-AAAA) aqui, junto con el folio armado y el metodo, para que el
 * Excel solo escriba. El orden del mismo dia es venta-antes-que-abono: parece
 * el detalle menor, pero es que la venta es la que crea la deuda y el abono el
 * que la paga, y en el papel deben verse en ese orden.
 *
 * La mezcla es un merge de DOS listas ya ordenadas por fecha (las manda el
 * repositorio con `ORDER BY fecha, id`), no un orden global: si se pusiera un
 * venta y un abono de la misma fecha en listas distintas, el sort miraria la
 * hora que no existe y el orden del empate estaria a la suerte.
 */
export function armarMovimientos(
  ventas: { fecha: string; serie: string; folio_numero: string; monto: string }[],
  abonos: { fecha: string; metodo: string | null; monto: string }[],
): Movimiento[] {
  const ventasLista: Movimiento[] = ventas.map((v) => ({
    fecha: v.fecha,
    esAbono: false,
    folio: componerFolio(v.serie, Number(v.folio_numero)),
    monto: Number(v.monto),
  }));

  const abonosLista: Movimiento[] = abonos.map((a) => ({
    fecha: a.fecha,
    esAbono: true,
    monto: Number(a.monto),
    // Un abono sin metodo anotado no es un metodo vacio: se deja la columna F
    // sin texto en vez de escribir una cadena vacia. El spread condicional es
    // lo que `exactOptionalPropertyTypes` pide: la propiedad se OMITE, no se
    // pone en undefined.
    ...(a.metodo === null ? {} : { metodo: a.metodo }),
  }));

  const mezclados: Movimiento[] = [];
  let i = 0;
  let j = 0;
  while (i < ventasLista.length || j < abonosLista.length) {
    const venta = ventasLista[i];
    const abono = abonosLista[j];

    if (venta === undefined) {
      mezclados.push(abono!);
      j += 1;
      continue;
    }
    if (abono === undefined) {
      mezclados.push(venta);
      i += 1;
      continue;
    }

    // Mismo dia -> venta primero. El empate no lo rompe el contenido de las
    // listas sino el orden en que se lee: venta y luego abono.
    if (venta.fecha <= abono.fecha) {
      mezclados.push(venta);
      i += 1;
    } else {
      mezclados.push(abono);
      j += 1;
    }
  }

  return mezclados.map((m) => ({ ...m, fecha: fechaDiaMesAnio(m.fecha) }));
}

/** El listado de clientes con su saldo. */
export async function listar(
  cliente: PoolClient,
  consulta: ListarEstadoCuenta,
): Promise<Listado<RenglonEstadoCuenta>> {
  return repo.listarClientes(cliente, consulta);
}

/**
 * La hoja de estado de cuenta de UN cliente, lista para el navegador.
 *
 * El nombre del archivo NO lleva el nombre del cliente: queda colgando en la
 * descarga y en el historial del navegador de cualquier maquina compartida de
 * la oficina. Mismo criterio que las notas de remision.
 */
export async function hoja(
  cliente: PoolClient,
  clienteId: number,
  rango: 'todo' | 'semana' | 'mes' = 'todo',
): Promise<{ bytes: Buffer; nombreArchivo: string; renglonesFuera: number }> {
  const nuevo = await repo.buscarCliente(cliente, clienteId);
  if (nuevo === null) {
    throw new NoEncontrado('Ese cliente no existe.');
  }

  let { ventas, abonos } = await repo.leerMovimientos(cliente, clienteId);
  const hoy = new Date();
  let inicio: Date | null = null;
  if (rango === 'semana') {
    const dia = hoy.getDay();
    inicio = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - dia);
  } else if (rango === 'mes') {
    inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  }
  if (inicio !== null) {
    const desdeIso = inicio.toISOString().split('T')[0]!;
    ventas = ventas.filter((v) => v.fecha >= desdeIso);
    abonos = abonos.filter((a) => a.fecha >= desdeIso);
  }
  const cuenta: HojaCliente = {
    cliente_id: nuevo.cliente_id,
    cliente: nuevo.cliente,
    movimientos: armarMovimientos(ventas, abonos),
  };

  const { bytes, renglonesFuera } = await excel.excelEstadoCuenta(cuenta);
  const hoyArchivo = new Date().toISOString().split('T')[0];
  return {
    bytes,
    nombreArchivo: `estado-cuenta-cliente-${nuevo.cliente_id}-${hoyArchivo}.xlsx`,
    renglonesFuera,
  };
}

export async function general(
  cliente: PoolClient,
  clienteIds: number[],
): Promise<{ bytes: Buffer; nombreArchivo: string; renglonesFuera: number; escritos: number }> {
  const filas = await repo.listarClientesPorIds(cliente, clienteIds);
  const renglones = filas.map((f) => ({
    cliente: f.cliente,
    saldo_actual: Number(f.saldo_actual),
  }));
  const { bytes, renglonesFuera, escritos } =
    await excelGeneral.excelEstadoCuentaGeneral(renglones);
  const hoy = new Date().toISOString().split('T')[0];
  return {
    bytes,
    nombreArchivo: `estado-cuenta-general-${hoy}.xlsx`,
    renglonesFuera,
    escritos,
  };
}
