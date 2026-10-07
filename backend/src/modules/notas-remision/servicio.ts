import type { PoolClient } from 'pg';
import { consultar as consultarDB, consultarUno, enTransaccionDe } from '../../db/transaccion.js';
import { env } from '../../config/entorno.js';
import { Conflicto, ErrorValidacion, NoEncontrado, ReglaNegocio } from '../../core/errores.js';
import { resolverEfectivo } from '../precios/repositorio.js';
import { excelListaNotas, excelNotaRemision } from './excel.js';
import { pdfNotaRemision, renglonesFuera } from './pdf.js';
import * as repo from './repositorio.js';
import { componerFolio, FROM_NOTA, ordenDeNotas } from './repositorio.js';
import type {
  CrearNota,
  CrearTalonario,
  EditarNota,
  ListarFolios,
  ListarNotas,
  RenglonNota,
} from './esquemas.js';
import {
  mapearNota,
  mapearRenglon,
  type ClienteImprimible,
  type EstatusNota,
  type Folio,
  type Listado,
  type Nota,
  type NotaListada,
  type ResumenTalonario,
} from './modelo.js';

/**
 * Reglas de notas de remision.
 *
 * Lo que hay aqui es lo que la base NO puede saber: que precio va, que hay
 * en la bodega y que se puede tocar. Lo que la base ya sabe (quemar el
 * folio, recalcular el subtotal, mover el inventario, recalcular el saldo)
 * no se repite aqui; se le deja.
 */

const MENSAJE_EDITABLE = (estatus: EstatusNota): string =>
  estatus === 'pagada'
    ? 'Esta nota ya esta pagada: cancelala si de verdad hay que deshacer el cobro'
    : 'Esta nota esta cancelada y sus renglones ya no se pueden cambiar';

/**
 * Estatus en los que la nota todavia se puede mover.
 *
 * `pagada` y `cancelada` quedan fuera porque el trigger de 0008 los
 * congela en la base. Aca se avisa antes, para poder dar un 409 con un
 * mensaje que diga que hacer en vez de dejar que reviente un 23514.
 */
const editable = (estatus: EstatusNota): boolean =>
  estatus === 'pendiente' || estatus === 'parcial';

/** Como queda un renglon despues de resolver precio y kg por bulto. */
interface RenglonListo {
  id: number | undefined;
  producto_id: number;
  almacen_id: number;
  cantidad_bultos: string;
  kg_bulto: string | null;
  precio_unit_kg: string;
}

export async function listar(cliente: PoolClient, q: ListarNotas): Promise<Listado<NotaListada>> {
  return repo.listar(cliente, q);
}

export async function consultar(cliente: PoolClient, id: number): Promise<Nota> {
  return leer(cliente, id);
}

/**
 * El PDF.
 *
 * Reusa `leer`, o sea la MISMA consulta que `GET /:id`: el papel y la
 * pantalla no pueden mostrar dos versiones distintas de la misma nota, y
 * armar el PDF con una consulta propia "para imprimir" es como empiezan los
 * descuadres entre lo que se ve y lo que se cobra.
 *
 * El membrete sale del entorno.
 */
export async function pdf(
  cliente: PoolClient,
  id: number,
): Promise<{ bytes: Buffer; nombreArchivo: string; renglonesFuera: number }> {
  const nota = await leer(cliente, id);

  const datosCliente = await clienteImprimible(cliente, nota);

  const bytes = await pdfNotaRemision(nota, datosCliente, {
    nombre: env.EMPRESA_NOMBRE,
    rfc: env.EMPRESA_RFC,
    direccion: env.EMPRESA_DIRECCION,
    telefono: env.EMPRESA_TELEFONO,
  });

  // El papel tiene nueve renglones, igual que la plantilla del Excel, asi que
  // una nota mas larga imprime los primeros nueve. Se devuelve cuantas se
  // quedaron fuera para que el frente avise, que es lo que ya hacia el Excel: un
  // papel impreso con 9 de 30 renglones no se nota hasta que se cuenta.
  return {
    bytes,
    nombreArchivo: nombreDelArchivo(nota, 'pdf'),
    renglonesFuera: renglonesFuera(nota),
  };
}

/**
 * El Excel.
 *
 * Misma nota y mismo cliente que el PDF y que la pantalla: comparten `leer`
 * y `clienteImprimible`, asi que los tres muestran exactamente lo que hay
 * en la base. A diferencia de `pdf`, el Excel devuelve tambien cuantos
 * renglones se quedaron fuera del papel (la plantilla solo trae 9 bloques),
 * para que el frente avise si la nota no cabe entera.
 */
export async function excel(
  cliente: PoolClient,
  id: number,
): Promise<{ bytes: Buffer; nombreArchivo: string; renglonesFuera: number }> {
  const nota = await leer(cliente, id);
  const datosCliente = await clienteImprimible(cliente, nota);
  const { bytes, renglonesFuera } = await excelNotaRemision(nota, datosCliente);
  return { bytes, nombreArchivo: nombreDelArchivo(nota, 'xlsx'), renglonesFuera };
}

/**
 * Exportar la lista completa de notas a Excel.
 *
 * Descarga TODAS las notas que coincidan con el filtro (sin paginación),
 * no solo la página visible.
 */
export async function exportarExcel(cliente: PoolClient, q: ListarNotas): Promise<Buffer> {
  // Usar la misma consulta de listar pero SIN límite ni offset
  const { valores, donde } = repo.construirFiltro(q);

  const filas = await consultarDB<{
    id: string;
    folio_numero: number;
    serie: string;
    cliente_id: string;
    cliente_nombre: string;
    vendedor_nombre: string | null;
    fecha: string;
    subtotal: string;
    estatus: string;
    renglones: string;
    kg_total: string | null;
  }>(
    cliente,
    `SELECT n.id, n.cliente_id, n.fecha, n.subtotal, n.estatus,
            f.folio_numero, f.serie,
            c.nombre AS cliente_nombre,
            v.nombre AS vendedor_nombre,
            (SELECT count(*) FROM nota_remision_detalle d WHERE d.nota_id = n.id)::TEXT AS renglones,
            (SELECT COALESCE(SUM(d.cantidad_bultos * d.kg_bulto), 0)
               FROM nota_remision_detalle d WHERE d.nota_id = n.id)::TEXT AS kg_total
       ${FROM_NOTA}
       ${donde}
       ${ordenDeNotas(q.ordenar)}`,
    valores,
  );

  const notas: NotaListada[] = filas.map((f) => ({
    id: Number(f.id),
    folio: componerFolio(f.serie, f.folio_numero),
    cliente_id: Number(f.cliente_id),
    cliente: f.cliente_nombre,
    vendedor: f.vendedor_nombre,
    fecha: f.fecha,
    subtotal: Number(f.subtotal),
    estatus: f.estatus as EstatusNota,
    renglones: Number(f.renglones),
    kg_total: Number(f.kg_total ?? 0),
  }));

  return excelListaNotas(notas);
}

/**
 * La ficha del cliente para un impreso.
 *
 * `consultarNota` solo trae el nombre del cliente (ver
 * `repo.consultarClienteImprimible`), y PDF y Excel necesitan la direccion
 * de entrega con la que se arma el papel. La FK hace imposible que el
 * cliente no exista mientras la nota viva, y las notas bloquean su borrado:
 * si la fila se pierde es un bug del borrado, y un 404 de "nota inexistente"
 * llevaria a revisar el lado equivocado.
 */
async function clienteImprimible(cliente: PoolClient, nota: Nota): Promise<ClienteImprimible> {
  const datosCliente = await repo.consultarClienteImprimible(cliente, nota.cliente_id);
  if (!datosCliente) {
    throw new NoEncontrado('La nota existe pero su cliente ya no: revisa el borrado de clientes');
  }
  return datosCliente;
}

/**
 * Como se llama el archivo que descarga el navegador.
 *
 * Solo el folio y la fecha: el nombre no lleva el nombre del cliente, que
 * queda colgando en la descarga y en el historial del navegador de cualquier
 * maquina compartida de la oficina. Y sin acentos ni espacios, que hay
 * navegadores viejos que no saben que existen.
 */
function nombreDelArchivo(nota: Nota, extension: string): string {
  return `nota-remision-${nota.folio}-${nota.fecha}.${extension}`;
}

export async function crear(cliente: PoolClient, d: CrearNota, usuarioId: number): Promise<Nota> {
  return enTransaccionDe(cliente, async (c) => {
    await revisarCliente(c, d.cliente_id);

    // El folio se toma PRIMERO, y con candado. Primero porque si un renglon
    // falla despues todo se revierte y el folio vuelve a quedar
    // disponible: la unidad es la transaccion entera, no solo los renglones.
    // Una nota cuyo alta se revierte no puede dejar el 1002 quemado, o el
    // talonario pierde numeros sin que exista ninguna nota que los use.
    //
    // La serie la resuelve el servicio y no el POS: el cliente no la manda
    // (`cuerpoDeNota` ni la incluye), y el talonario del que se quema lo
    // dejo puesta quien administra `notas.folios`. Si el alta trae una, se
    // respeta (la API la acepta para quien la quiera mandar), pero el POS
    // no tiene por que saber que serie es la de hoy.
    const serie = d.serie ?? (await repo.leerSerieActiva(c));
    const folioId = await repo.tomarFolioDisponible(c, serie);
    if (folioId === 0) {
      throw new ReglaNegocio(
        'SIN_FOLIOS',
        `No queda ningun folio disponible de la serie ${etiquetaDeSerie(serie)}`,
        {
          serie,
        },
      );
    }

    const fecha = d.fecha ?? (await hoyEnLaBase(c));
    const renglones = await prepararRenglones(c, d.cliente_id, fecha, d.renglones, new Map());

    const notaId = await repo.insertarCabecera(c, {
      folio_id: folioId,
      cliente_id: d.cliente_id,
      vendedor_id: usuarioId,
      fecha,
      direccion_entrega: d.direccion_entrega ?? null,
    });

    for (const r of renglones) {
      await repo.insertarRenglon(c, {
        nota_id: notaId,
        producto_id: r.producto_id,
        almacen_id: r.almacen_id,
        cantidad_bultos: r.cantidad_bultos,
        kg_bulto: r.kg_bulto,
        precio_unit_kg: r.precio_unit_kg,
      });
    }

    return leer(c, notaId);
  });
}

export async function editar(cliente: PoolClient, id: number, d: EditarNota): Promise<Nota> {
  return enTransaccionDe(cliente, async (c) => {
    const antes = await repo.consultarNota(c, id);
    if (!antes) throw new NoEncontrado('Esa nota de remision no existe');

    if (!editable(antes.estatus)) {
      throw new Conflicto('NOTA_CONGELADA', MENSAJE_EDITABLE(antes.estatus), {
        estatus: antes.estatus,
      });
    }

    if (d.cliente_id !== undefined) {
      await revisarCliente(c, d.cliente_id);
    }

    // El objeto se arma campo por campo y no pasandolo tal cual: con
    // `exactOptionalPropertyTypes` mandar `cliente_id: undefined` NO es lo
    // mismo que no mandarlo, y el repositorio usa `!== undefined` para
    // decidir que columnas tocar. Sin este filtro, una edicion de la
    // direccion borraria el cliente.
    const cabecera: {
      cliente_id?: number;
      fecha?: string;
      direccion_entrega?: string | null;
    } = {};
    if (d.cliente_id !== undefined) cabecera.cliente_id = d.cliente_id;
    if (d.fecha !== undefined) cabecera.fecha = d.fecha;
    if (d.direccion_entrega !== undefined) cabecera.direccion_entrega = d.direccion_entrega;
    await repo.actualizarCabecera(c, id, cabecera);

    if (d.renglones !== undefined) {
      const clienteId = d.cliente_id ?? Number(antes.cliente_id);
      // La fecha es la de la NOTA, no la de hoy. Con `?? hoyEnLaBase` una
      // edicion que no manda fecha resolvia precios con el dia de hoy, y
      // como `fechaCambia` salia verdadera, eso revaluaba TODOS los
      // renglones de una nota del mes pasado al precio de hoy con solo
      // cambiar una cantidad.
      const fecha = d.fecha ?? antes.fecha;
      const existentes = await repo.listarRenglones(c, id);

      /**
       * El precio de un renglon que YA estaba y no cambio no se vuelve a
       * buscar. Solo se releen los precios de los renglones nuevos, de los
       * que cambian de producto, y de todos los que venga en la peticion si
       * cambio el cliente o la fecha de la nota.
       *
       * Pasar todos por el resolvedor haria que un cambio de cantidad
       * releyera el precio de una nota de hace un mes, y si meanwhile se
       * metio un precio nuevo, la nota se revaluaria sola. La nota guarda
       * el precio que se cobro, no el que seria hoy.
       *
       * El "y no cambio" del parrafo anterior es por renglon, y el mapa
       * guarda el producto junto al precio: un renglon al que le cambian
       * el producto conservando el id NO puede quedarse con el precio del
       * producto anterior, que es lo que pasaba antes de esto.
       *
       * Lo que NO se revalua es la cabecera sola. Si la peticion no trae
       * `renglones`, no hay renglones que revaluar: corregir la fecha de
       * una nota no cambia lo que se cobro en ella. Para que el precio
       * siga a la fecha hay que mandar los renglones en la misma
       * peticion, que es cuando la pantalla los esta mandando igual.
       */
      const clienteCambia = d.cliente_id !== undefined && d.cliente_id !== Number(antes.cliente_id);
      const fechaCambia = fecha !== antes.fecha;

      const aConservar = new Map<number, { precio: string; producto_id: number }>();
      if (!clienteCambia && !fechaCambia) {
        for (const e of existentes) {
          aConservar.set(Number(e.id), {
            precio: e.precio_unit_kg,
            producto_id: Number(e.producto_id),
          });
        }
      }

      // Al editar, la existencia que hay que comparar NO es la de ahora:
      // la nota que se esta editando ya tiene su salida descontada, asi que
      // sin esto un renglon que se deja igual rechazaria una edicion de
      // otra cosa ("no hay producto suficiente" con 45 bultos en bodega y
      // 45 en la nota). Lo que esta en disputa es solo lo que se suma.
      const consumoPropio = new Map<string, number>();
      for (const e of existentes) {
        const clave = `${Number(e.producto_id)}:${Number(e.almacen_id)}`;
        consumoPropio.set(clave, (consumoPropio.get(clave) ?? 0) + Number(e.cantidad_bultos));
      }

      const renglones = await prepararRenglones(
        c,
        clienteId,
        fecha,
        d.renglones,
        aConservar,
        consumoPropio,
      );
      const idsExistentes = new Set(existentes.map((e) => Number(e.id)));
      const idsQueQuedan = new Set<number>();

      for (const r of renglones) {
        if (r.id !== undefined && idsExistentes.has(r.id)) {
          await repo.actualizarRenglon(c, r.id, id, {
            producto_id: r.producto_id,
            almacen_id: r.almacen_id,
            cantidad_bultos: r.cantidad_bultos,
            kg_bulto: r.kg_bulto,
            precio_unit_kg: r.precio_unit_kg,
          });
          idsQueQuedan.add(r.id);
        } else {
          const nuevo = await repo.insertarRenglon(c, {
            nota_id: id,
            producto_id: r.producto_id,
            almacen_id: r.almacen_id,
            cantidad_bultos: r.cantidad_bultos,
            kg_bulto: r.kg_bulto,
            precio_unit_kg: r.precio_unit_kg,
          });
          idsQueQuedan.add(nuevo);
        }
      }

      // Los que no volvieron en el arreglo se van. El trigger de
      // inventario borra su movimiento de salida, asi que el stock regresa
      // solo.
      for (const e of existentes) {
        const idViejo = Number(e.id);
        if (!idsQueQuedan.has(idViejo)) {
          await repo.borrarRenglon(c, idViejo, id);
        }
      }
    }

    return leer(c, id);
  });
}

export async function cancelar(cliente: PoolClient, id: number, motivo: string): Promise<Nota> {
  return enTransaccionDe(cliente, async (c) => {
    const fila = await repo.consultarNota(c, id);
    if (!fila) throw new NoEncontrado('Esa nota de remision no existe');

    if (fila.estatus === 'cancelada') {
      throw new Conflicto('NOTA_YA_CANCELADA', 'Esta nota ya estaba cancelada', {
        estatus: fila.estatus,
      });
    }

    // El UPDATE lleva su propio `WHERE estatus <> 'cancelada'`, asi que
    // la fila que cambio es la que comprueba: si otra peticion cancelo la
    // nota entre la lectura y aqui, el UPDATE no toca nada y se avisa con
    // 409, en vez de devolver una nota que el llamador creyo cancelar.
    if (!(await repo.cancelar(c, id, motivo))) {
      throw new Conflicto('NOTA_YA_CANCELADA', 'Esta nota ya estaba cancelada');
    }

    return leer(c, id);
  });
}

// =====================================================================
// FOLIOS
// =====================================================================

/** Como se le dice a una serie en un mensaje: el prefijo, o su ausencia. */
function etiquetaDeSerie(serie: string): string {
  return serie === '' ? 'sin prefijo' : serie;
}

export async function listarFolios(cliente: PoolClient, q: ListarFolios): Promise<Listado<Folio>> {
  return repo.listarFolios(cliente, q);
}

/** El resumen por serie, para la pantalla del talonario (ver `ResumenTalonario`). */
export async function resumenDeTalonarios(cliente: PoolClient): Promise<ResumenTalonario[]> {
  return repo.resumenDeTalonarios(cliente);
}

/** La serie activa: la que el POS usara para su siguiente folio. */
export async function leerSerieActiva(cliente: PoolClient): Promise<{ serie: string }> {
  return { serie: await repo.leerSerieActiva(cliente) };
}

/** Guarda la serie activa y devuelve como quedo. */
export async function establecerSerieActiva(
  cliente: PoolClient,
  serie: string,
): Promise<{ serie: string }> {
  return { serie: await repo.establecerSerieActiva(cliente, serie) };
}

/**
 * Carga un tramo de talonario.
 *
 * Idempotente a proposito: pedir otra vez folios que ya existen no revienta
 * nada. Cargar el talonario dos veces es el error mas comun y el menos
 * grave, y la alternativa (un 23505 de clave primaria) solo obligaria al
 * admin a hacerlo de a uno. Si el rango pedido esta ENTERO ya cargado, ahi
 * si se avisa con 422, porque ahi el error no es de este tramo sino del
 * anterior.
 */
export async function crearTalonario(
  cliente: PoolClient,
  d: CrearTalonario,
): Promise<{ creados: number; omitidos: number; primero: number; ultimo: number }> {
  return enTransaccionDe(cliente, async (c) => {
    const existentes = await repo.foliosExistentesEnRango(c, d.serie, d.desde, d.hasta);
    const pedidos = d.hasta - d.desde + 1;

    if (existentes.length === pedidos) {
      // 409 y no 422: choca con lo que YA esta, la misma familia que
      // CODIGO_DUPLICADO en clientes o NOMBRE_DUPLICADO en el catalogo.
      throw new Conflicto(
        'TALONARIO_YA_CARGADO',
        `La serie ${d.serie} ya tiene todos los folios del ${d.desde} al ${d.hasta}`,
        { serie: d.serie, desde: d.desde, hasta: d.hasta },
      );
    }

    const creados = await repo.insertarFolios(c, d);
    return { creados, omitidos: existentes.length, primero: d.desde, ultimo: d.hasta };
  });
}

// =====================================================================
// RENG LONES
// =====================================================================

/**
 * Resuelve lo que falta de cada renglon: el precio y el kg por bulto.
 *
 * El precio sale del modulo de precios, con la FECHA DE LA NOTA y no la de
 * hoy. Es la diferencia entre una nota con fecha del mes pasado y una nota
 * de hoy que dicen lo mismo, y es lo que hace que `GET /api/precios/efectivo`
 * sirva para algo mas que mostrar un precio en una pantalla.
 *
 * Si el renglon trae precio, se respeta. El operador que escribe un precio
 * distinto al de lista esta haciendo un trato, y el trato vale mas que la
 * pantalla: la nota guarda lo que se cobro, no lo que decia la lista.
 *
 * Lo que NO se acepta es que falte y no haya precio. `vigente = false` en
 * el resolvedor significa que no hay precio, no que el precio es cero: un
 * producto de cortesia se captura con `precio_unit_kg: 0`, que es un numero
 * explicito que alguien escribio a proposito.
 *
 * `conservar` lleva el precio de los renglones que ya estaban y siguen
 * igual, para no releerlos (ver `editar`).
 */
async function prepararRenglones(
  cliente: PoolClient,
  clienteId: number,
  fecha: string,
  renglones: RenglonNota[],
  conservar: Map<number, { precio: string; producto_id: number }>,
  consumoPropio: Map<string, number> = new Map<string, number>(),
): Promise<RenglonListo[]> {
  const salida: RenglonListo[] = [];

  // El consumo de cada producto-almacen, para no validar dos veces el mismo
  // si aparece en dos renglones: pasa con el mismo producto en dos almacenes,
  // o en el mismo almacen con distinto kg por bulto.
  const consumo = new Map<string, number>();

  for (const r of renglones) {
    const clave = `${r.producto_id}:${r.almacen_id}`;
    const yaPedido = consumo.get(clave) ?? 0;
    const pedido = Number(r.cantidad_bultos);

    // Candado ANTES de leer la existencia. Al reves, dos peticiones que
    // venden el mismo producto se leen la misma existencia y las dos pasan
    // el chequeo: 20 bultos vendidos con 12 en el almacen.
    await repo.candearProductoAlmacen(cliente, r.producto_id, r.almacen_id);

    const info = await repo.existencia(cliente, r.producto_id, r.almacen_id);
    if (!info) {
      throw new ErrorValidacion(`El producto ${r.producto_id} no existe`, [
        { campo: 'producto_id', problema: `El producto ${r.producto_id} no existe` },
      ]);
    }
    if (!(await repo.almacenExiste(cliente, r.almacen_id))) {
      throw new ErrorValidacion(`El almacen ${r.almacen_id} no existe`, [
        { campo: 'almacen_id', problema: `El almacen ${r.almacen_id} no existe` },
      ]);
    }
    if (!info.productoActivo) {
      throw new ReglaNegocio('PRODUCTO_INACTIVO', 'No se puede vender un producto dado de baja', {
        producto_id: r.producto_id,
      });
    }

    const total = yaPedido + pedido;
    consumo.set(clave, total);

    /**
     * Aqui se decide el stock negativo, y es una regla del negocio, no de
     * la base: `fn_verificar_stock` (0001) solo genera una alerta y deja
     * pasar. Se rechaza en el API porque una venta que no se puede
     * entregar no es una venta. La alerta de la base sigue sirviendo, pero
     * para enterarse de los AJUSTES de inventario, que si son legitimos y
     * no tienen nada que ver con esto.
     */
    const disponible = info.existencia + (consumoPropio.get(clave) ?? 0);
    if (total > disponible) {
      // 409 y no 422: no es una peticion mal formada, es una peticion que
      // choca con el estado actual del almacen. Es la misma familia que
      // NOTA_CONGELADA o TALONARIO_YA_CARGADO, y el frontend puede
      // distinguirla de un error de tecleo por el codigo.
      throw new Conflicto(
        'STOCK_INSUFICIENTE',
        `No hay producto suficiente en el almacen ${r.almacen_id}`,
        {
          producto_id: r.producto_id,
          almacen_id: r.almacen_id,
          existencia: disponible,
          solicitado: total,
          faltan: Number((total - disponible).toFixed(2)),
        },
      );
    }

    let precioUnit = r.precio_unit_kg;
    if (precioUnit === undefined) {
      const previo = r.id === undefined ? undefined : conservar.get(r.id);
      if (previo?.producto_id === r.producto_id) {
        precioUnit = previo.precio;
      } else {
        const efectivo = await resolverEfectivo(cliente, {
          cliente_id: clienteId,
          producto_id: r.producto_id,
          fecha,
        });
        if (!efectivo?.vigente || efectivo.precio_kg === null) {
          throw new ReglaNegocio(
            'SIN_PRECIO',
            'Ese producto no tiene precio vigente en la fecha de la nota',
            { producto_id: r.producto_id, fecha },
          );
        }
        precioUnit = String(efectivo.precio_kg);
      }
    }

    salida.push({
      id: r.id,
      producto_id: r.producto_id,
      almacen_id: r.almacen_id,
      cantidad_bultos: r.cantidad_bultos,
      kg_bulto: r.kg_bulto ?? null,
      precio_unit_kg: precioUnit,
    });
  }

  return salida;
}

// =====================================================================
// AYUDAS
// =====================================================================

async function revisarCliente(cliente: PoolClient, clienteId: number): Promise<void> {
  if (!(await repo.clienteExiste(cliente, clienteId))) {
    throw new ErrorValidacion(`El cliente ${clienteId} no existe`, [
      { campo: 'cliente_id', problema: `El cliente ${clienteId} no existe` },
    ]);
  }
}

/**
 * "Hoy" lo decide la base, no Node.
 *
 * Mismo criterio que el filtro de precios: el backend puede estar en otra
 * zona horaria que la base, y una nota creada a las 11 de la noche con
 * `new Date()` puede quedar con fecha de manana. `CURRENT_DATE` es la
 * fecha con la que trabaja el resto del sistema.
 */
async function hoyEnLaBase(cliente: PoolClient): Promise<string> {
  const fila = await consultarUno<{ hoy: string }>(
    cliente,
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hoy`,
  );
  return fila?.hoy ?? '';
}

async function leer(cliente: PoolClient, id: number): Promise<Nota> {
  const fila = await repo.consultarNota(cliente, id);
  if (!fila) throw new NoEncontrado('Esa nota de remision no existe');
  const renglones = await repo.listarRenglones(cliente, id);
  return mapearNota(fila, renglones.map(mapearRenglon));
}
