import type { PoolClient } from 'pg';
import { NoEncontrado } from '../../core/errores.js';
import { hoyEnLaBase } from '../../db/transaccion.js';
import { componerFolio } from '../notas-remision/modelo.js';
import * as excel from './excel.js';
import * as excelGeneral from './excel-general.js';
import type { HojaCliente, Movimiento, RenglonHoja } from './modelo.js';
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
export interface VentaConId {
  nota_id: number;
  fecha: string;
  serie: string;
  folio_numero: string;
  monto: string;
}

export interface AplicacionSimple {
  nota_id: number;
  pago_id: number;
  monto_aplicado: string;
  pago_fecha: string;
  pago_metodo: string | null;
}

export function armarMovimientos(
  ventas: { fecha: string; serie: string; folio_numero: string; monto: string }[],
  abonos: { fecha: string; metodo: string | null; monto: string }[],
): Movimiento[] {
  const mezclados: Movimiento[] = [];
  let i = 0;
  let j = 0;
  while (i < ventas.length || j < abonos.length) {
    const venta = ventas[i];
    const abono = abonos[j];
    if (venta === undefined) {
      mezclados.push({
        fecha: fechaDiaMesAnio(abono!.fecha),
        esAbono: true,
        monto: Number(abono!.monto),
        ...(abono!.metodo === null ? {} : { metodo: abono!.metodo }),
      });
      j += 1;
      continue;
    }
    if (abono === undefined) {
      mezclados.push({
        fecha: fechaDiaMesAnio(venta.fecha),
        esAbono: false,
        folio: componerFolio(venta.serie, Number(venta.folio_numero)),
        monto: Number(venta.monto),
      });
      i += 1;
      continue;
    }
    if (venta.fecha <= abono.fecha) {
      mezclados.push({
        fecha: fechaDiaMesAnio(venta.fecha),
        esAbono: false,
        folio: componerFolio(venta.serie, Number(venta.folio_numero)),
        monto: Number(venta.monto),
      });
      i += 1;
    } else {
      mezclados.push({
        fecha: fechaDiaMesAnio(abono.fecha),
        esAbono: true,
        monto: Number(abono.monto),
        ...(abono.metodo === null ? {} : { metodo: abono.metodo }),
      });
      j += 1;
    }
  }
  return mezclados;
}

export function armarRenglones(
  ventas: VentaConId[],
  abonos: { fecha: string; metodo: string | null; monto: string }[],
  aplicaciones: AplicacionSimple[] = [],
): RenglonHoja[] {
  const aplicPorNota = new Map<number, AplicacionSimple[]>();
  for (const a of aplicaciones) {
    const arr = aplicPorNota.get(a.nota_id) ?? [];
    arr.push(a);
    aplicPorNota.set(a.nota_id, arr);
  }

  const renglones: RenglonHoja[] = [];
  for (const v of ventas) {
    const apps = aplicPorNota.get(v.nota_id);
    if (apps && apps.length > 0) {
      for (const app of apps) {
        renglones.push({
          fecha: fechaDiaMesAnio(v.fecha),
          esVenta: true,
          folio: componerFolio(v.serie, Number(v.folio_numero)),
          montoVenta: Number(v.monto),
          esAbono: true,
          ...(app.pago_metodo === null ? {} : { metodoAbono: app.pago_metodo }),
          montoAbono: Number(app.monto_aplicado),
        });
      }
      aplicPorNota.delete(v.nota_id);
    } else {
      renglones.push({
        fecha: fechaDiaMesAnio(v.fecha),
        esVenta: true,
        folio: componerFolio(v.serie, Number(v.folio_numero)),
        montoVenta: Number(v.monto),
        esAbono: false,
      });
    }
  }

  for (const [, apps] of aplicPorNota) {
    for (const app of apps) {
      renglones.push({
        fecha: fechaDiaMesAnio(app.pago_fecha),
        esVenta: false,
        esAbono: true,
        ...(app.pago_metodo === null ? {} : { metodoAbono: app.pago_metodo }),
        montoAbono: Number(app.monto_aplicado),
      });
    }
  }

  renglones.sort((x, y) => (x.fecha < y.fecha ? -1 : x.fecha > y.fecha ? 1 : 0));
  return renglones;
}

export async function listar(
  cliente: PoolClient,
  consulta: ListarEstadoCuenta,
): Promise<Listado<RenglonEstadoCuenta>> {
  return repo.listarClientes(cliente, consulta);
}

/**
 * El primer dia del rango, en 'AAAA-MM-DD'.
 *
 * La fecha viene de la base (el 'hoy' de Postgres) y se arma con sus
 * partes, sin pasar por `toISOString()`: ese metodo convierte a UTC, y en un
 * huso negativo (Mexico, UTC-6) un dia local se convierte al dia ANTERIOR.
 * Es el mismo corrimiento que arregla `fechaComoTexto` en el resto del
 * proyecto, y por eso la fecha se arma a mano y no con el metodo.
 */
function inicioDelRango(hoy: string, rango: 'semana' | 'mes'): string {
  const partes = hoy.split('-').map(Number);
  // `hoy` viene de la base como 'AAAA-MM-DD'. Si viniera vacia (que no
  // deberia), el rango se cae al dia 1 del mes en vez de inventar una fecha.
  const anio = partes[0] ?? 1970;
  const mes = partes[1] ?? 1;
  const dia = partes[2] ?? 1;

  if (rango === 'mes') {
    return `${anio}-${String(mes).padStart(2, '0')}-01`;
  }

  // La semana empieza en domingo, como en el calendario del mostrador.
  const diaDeSemana = new Date(anio, mes - 1, dia).getDay();
  const inicio = new Date(anio, mes - 1, dia - diaDeSemana);
  return `${inicio.getFullYear()}-${String(inicio.getMonth() + 1).padStart(2, '0')}-${String(
    inicio.getDate(),
  ).padStart(2, '0')}`;
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
  rango: 'todo' | 'semana' | 'mes' | 'personalizado' = 'todo',
  opts?: { fecha_inicio?: string | undefined; fecha_fin?: string | undefined },
): Promise<{ bytes: Buffer; nombreArchivo: string; renglonesFuera: number }> {
  const nuevo = await repo.buscarCliente(cliente, clienteId);
  if (nuevo === null) {
    throw new NoEncontrado('Ese cliente no existe.');
  }

  let { ventas, abonos } = await repo.leerMovimientos(cliente, clienteId);
  /**
   * El "hoy" es el de la BASE, no el del servidor.
   *
   * El rango "semana" y "mes" decide que dias entran en la hoja, asi que si
   * el reloj del servidor y el de Postgres no coinciden (que es lo normal:
   * el servidor de la app y el de la base no tienen por que estar en la
   * misma zona, ni tener la misma hora), la hoja incluye o excluye un dia
   * distinto del que define la base, y sus totales no cuadran con el
   * `saldo_actual` que dice la ultima linea.
   *
   * Los otros siete modulos usan `hoyEnLaBase()` por esto mismo.
   */
  const hoy = await hoyEnLaBase(cliente);
  let desdeIso: string | null = null;
  if (rango === 'semana' || rango === 'mes') {
    desdeIso = inicioDelRango(hoy, rango);
  } else if (rango === 'personalizado' && opts?.fecha_inicio) {
    desdeIso = opts.fecha_inicio;
  }
  if (desdeIso !== null) {
    ventas = ventas.filter((v) => v.fecha >= desdeIso);
    abonos = abonos.filter((a) => a.fecha >= desdeIso);
  }
  /**
   * La fecha de fin se guarda en una variable antes de filtrar.
   *
   * TypeScript no puede estrechar `opts.fecha_fin` dentro de la flecha:
   * ahi `opts` podria haber cambiado, asi que vuelve a ser opcional y el
   * filtro no compila. Guardandola en una constante, el estrechamiento
   * se aplica una vez y las flechas la ven ya como string.
   */
  const fechaFin = opts?.fecha_fin;
  if (rango === 'personalizado' && fechaFin) {
    ventas = ventas.filter((v) => v.fecha <= fechaFin);
    abonos = abonos.filter((a) => a.fecha <= fechaFin);
  }
  const aplicaciones = await repo.leerAplicacionesPorCliente(cliente, clienteId);
  const renglones = armarRenglones(
    ventas.map((v) => ({ ...v, nota_id: Number(v.nota_id) })),
    abonos,
    aplicaciones,
  );
  // convert to movimiento form for current excel? or write new excel
  const movimientos: Movimiento[] = renglones.map((r) => {
    if (r.esVenta && r.esAbono) {
      return {
        fecha: r.fecha,
        esAbono: true,
        metodo: r.metodoAbono,
        monto: r.montoAbono ?? 0,
      } as Movimiento;
    }
    if (r.esVenta) {
      return {
        fecha: r.fecha,
        esAbono: false,
        folio: r.folio,
        monto: r.montoVenta ?? 0,
      } as Movimiento;
    }
    return {
      fecha: r.fecha,
      esAbono: true,
      metodo: r.metodoAbono,
      monto: r.montoAbono ?? 0,
    } as Movimiento;
  });
  const cuenta: HojaCliente = {
    cliente_id: nuevo.cliente_id,
    cliente: nuevo.cliente,
    movimientos,
    renglones,
  };

  const { bytes, renglonesFuera } = await excel.excelEstadoCuenta(cuenta);
  // El nombre del archivo lleva el dia de la BASE, por lo mismo que el
  // rango: si el servidor va un dia adelante, el archivo se guarda con
  // el dia de mañana.
  const hoyArchivo = await hoyEnLaBase(cliente);
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
  const hoy = await hoyEnLaBase(cliente);
  return {
    bytes,
    nombreArchivo: `estado-cuenta-general-${hoy}.xlsx`,
    renglonesFuera,
    escritos,
  };
}
