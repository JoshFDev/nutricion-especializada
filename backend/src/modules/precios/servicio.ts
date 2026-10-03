import type { PoolClient } from 'pg';
import { Conflicto, ErrorValidacion, NoEncontrado } from '../../core/errores.js';
import type {
  ActualizarPrecioCliente,
  ActualizarPrecioPublico,
  CrearPrecioCliente,
  CrearPrecioPublico,
  ListarPreciosCliente,
  ListarPreciosPublicos,
  PrecioEfectivo,
} from './esquemas.js';
import type {
  FilaPrecioCliente,
  FilaPrecioPublico,
  PrecioCliente,
  PrecioPublico,
} from './modelo.js';
import { mapeoPrecioCliente, mapeoPrecioPublico } from './modelo.js';
import * as repo from './repositorio.js';
import ExcelJS from 'exceljs';

/**
 * Reglas de precios.
 *
 * Este modulo NO tiene DELETE, y esa es su diferencia de fondo con
 * productos. Ahi un producto sin historial se borra; un precio nunca se
 * borra, porque las notas de remision guardan el precio que se leyo al
 * cobrar y si la fila desaparece ya no hay forma de reconstruir de donde
 * salio ese numero. El "borrar" de un precio es cerrarlo con fecha de fin,
 * que es lo que hace `cerrar`.
 *
 * Lo que si comparte con productos: la forma del listado (`{ datos, total,
 * limite, offset }`) y el PATCH parcial.
 */

/** La misma forma que productos y usuarios, no la anidada de clientes. */
export interface PaginadoPublicos {
  datos: PrecioPublico[];
  total: number;
  limite: number;
  offset: number;
}

export interface PaginadoClientes {
  datos: PrecioCliente[];
  total: number;
  limite: number;
  offset: number;
}

export async function listarPublicos(
  db: PoolClient,
  q: ListarPreciosPublicos,
): Promise<PaginadoPublicos> {
  const { filas, total } = await repo.listarPublicos(db, q);
  return { datos: filas.map(mapeoPrecioPublico), total, limite: q.limite, offset: q.offset };
}

export async function listarClientes(
  db: PoolClient,
  q: ListarPreciosCliente,
): Promise<PaginadoClientes> {
  const { filas, total } = await repo.listarClientes(db, q);
  return { datos: filas.map(mapeoPrecioCliente), total, limite: q.limite, offset: q.offset };
}

export async function obtenerPublico(db: PoolClient, id: number): Promise<PrecioPublico> {
  const fila = await repo.obtenerPublicoPorId(db, id);
  if (!fila) throw new NoEncontrado(`No existe el precio publico ${id}`);
  return mapeoPrecioPublico(fila);
}

export async function obtenerCliente(db: PoolClient, id: number): Promise<PrecioCliente> {
  const fila = await repo.obtenerClientePorId(db, id);
  if (!fila) throw new NoEncontrado(`No existe el precio de cliente ${id}`);
  return mapeoPrecioCliente(fila);
}

export async function crearPublico(
  db: PoolClient,
  datos: CrearPrecioPublico,
): Promise<PrecioPublico> {
  await revisarProducto(db, datos.producto_id);
  revisarVigencia(datos.vigente_desde, datos.vigente_hasta ?? null);

  try {
    return mapeoPrecioPublico(
      await repo.crearPublico(db, {
        producto_id: datos.producto_id,
        precio_kg: datos.precio_kg,
        vigente_desde: datos.vigente_desde,
        vigente_hasta: datos.vigente_hasta ?? null,
      }),
    );
  } catch (error) {
    if (esTraslape(error)) throw traslape('del producto');
    if (esUnico(error))
      throw inicioRepetido(`del producto ${datos.producto_id}`, datos.vigente_desde);
    throw error;
  }
}

export async function crearCliente(
  db: PoolClient,
  datos: CrearPrecioCliente,
): Promise<PrecioCliente> {
  await revisarProducto(db, datos.producto_id);
  await revisarCliente(db, datos.cliente_id);
  revisarVigencia(datos.vigente_desde, datos.vigente_hasta ?? null);

  try {
    return mapeoPrecioCliente(
      await repo.crearCliente(db, {
        cliente_id: datos.cliente_id,
        producto_id: datos.producto_id,
        precio_kg: datos.precio_kg,
        vigente_desde: datos.vigente_desde,
        vigente_hasta: datos.vigente_hasta ?? null,
      }),
    );
  } catch (error) {
    if (esTraslape(error)) throw traslape('de este cliente y producto');
    if (esUnico(error)) {
      throw inicioRepetido(
        `del cliente ${datos.cliente_id} y el producto ${datos.producto_id}`,
        datos.vigente_desde,
      );
    }
    throw error;
  }
}

/**
 * PATCH parcial: se arranca de la fila actual y se pisa solo lo que vino.
 *
 * El merge va aqui y no en el SQL con COALESCE porque el SQL no distingue
 * "no lo mandaste" de "lo mandaste en null", y para `vigente_hasta` esas dos
 * cosas significan lo contrario: dejarlo abierto (null) frente a cerrarlo
 * con fecha.
 */
export async function actualizarPublico(
  db: PoolClient,
  id: number,
  datos: ActualizarPrecioPublico,
): Promise<PrecioPublico> {
  const antes = await repo.obtenerPublicoPorId(db, id);
  if (!antes) throw new NoEncontrado(`No existe el precio publico ${id}`);

  const desde = datos.vigente_desde ?? aTextoFecha(antes.vigente_desde);
  const hasta =
    datos.vigente_hasta !== undefined
      ? datos.vigente_hasta
      : aTextoFechaOpcional(antes.vigente_hasta);
  revisarVigencia(desde, hasta);

  let fila: FilaPrecioPublico | null;
  try {
    fila = await repo.actualizarPublico(db, id, {
      precio_kg: datos.precio_kg ?? antes.precio_kg,
      vigente_desde: desde,
      vigente_hasta: hasta,
    });
  } catch (error) {
    if (esTraslape(error)) throw traslape('del producto');
    if (esUnico(error)) throw inicioRepetido(`del producto ${antes.producto_id}`, desde);
    throw error;
  }

  if (!fila) throw new NoEncontrado(`No existe el precio publico ${id}`);
  return mapeoPrecioPublico(fila);
}

export async function actualizarCliente(
  db: PoolClient,
  id: number,
  datos: ActualizarPrecioCliente,
): Promise<PrecioCliente> {
  const antes = await repo.obtenerClientePorId(db, id);
  if (!antes) throw new NoEncontrado(`No existe el precio de cliente ${id}`);

  const desde = datos.vigente_desde ?? aTextoFecha(antes.vigente_desde);
  const hasta =
    datos.vigente_hasta !== undefined
      ? datos.vigente_hasta
      : aTextoFechaOpcional(antes.vigente_hasta);
  revisarVigencia(desde, hasta);

  let fila: FilaPrecioCliente | null;
  try {
    fila = await repo.actualizarCliente(db, id, {
      precio_kg: datos.precio_kg ?? antes.precio_kg,
      vigente_desde: desde,
      vigente_hasta: hasta,
    });
  } catch (error) {
    if (esTraslape(error)) throw traslape('de este cliente y producto');
    if (esUnico(error)) {
      throw inicioRepetido(
        `del cliente ${antes.cliente_id} y el producto ${antes.producto_id}`,
        desde,
      );
    }
    throw error;
  }

  if (!fila) throw new NoEncontrado(`No existe el precio de cliente ${id}`);
  return mapeoPrecioCliente(fila);
}

/**
 * Cerrar un precio: el equivalente de "borrar" en este modulo.
 *
 * Le pone `vigente_hasta` a una fecha y nada mas. La fila se queda, que es
 * justo lo que la distingue de un DELETE, y a partir de esa fecha el precio
 * deja de aparecer en el filtro de vigentes.
 *
 * NO se puede cerrar con una fecha que ya paso. Seria un precio que nunca
 * estuvo vigente: el registro diria "estuvo activo del 3 al 1", que es una
 * contradiccion y además un agujero para alguien que quisiera meter una
 * fila vieja para acomodar un numero.
 *
 * Volver a abrir un precio cerrado (`cerrar` con una fecha futura) se
 * permite: el trigger de traslape es el que decide si choca o no, y asi el
 * servicio no tiene que mantener una segunda copia de la regla de traslape
 * que se desincronizaria de la de 0007.
 */
export async function cerrarPublico(
  db: PoolClient,
  id: number,
  vigenteHasta: string,
): Promise<PrecioPublico> {
  const antes = await repo.obtenerPublicoPorId(db, id);
  if (!antes) throw new NoEncontrado(`No existe el precio publico ${id}`);

  if (vigenteHasta < hoy()) {
    throw new ErrorValidacion('No se puede cerrar un precio con una fecha que ya paso');
  }

  if (antes.vigente_hasta && vigenteHasta < aTextoFecha(antes.vigente_hasta)) {
    throw new ErrorValidacion('El precio ya estaba cerrado en una fecha posterior');
  }

  return actualizarPublico(db, id, { vigente_hasta: vigenteHasta });
}

export async function cerrarCliente(
  db: PoolClient,
  id: number,
  vigenteHasta: string,
): Promise<PrecioCliente> {
  const antes = await repo.obtenerClientePorId(db, id);
  if (!antes) throw new NoEncontrado(`No existe el precio de cliente ${id}`);

  if (vigenteHasta < hoy()) {
    throw new ErrorValidacion('No se puede cerrar un precio con una fecha que ya paso');
  }

  if (antes.vigente_hasta && vigenteHasta < aTextoFecha(antes.vigente_hasta)) {
    throw new ErrorValidacion('El precio ya estaba cerrado en una fecha posterior');
  }

  return actualizarCliente(db, id, { vigente_hasta: vigenteHasta });
}

/**
 * El precio que toca cobrar.
 *
 * Distingue tres casos, y los tres se responden distinto a proposito:
 *
 * - el producto no existe: 404.
 * - el producto existe pero no tiene ningun precio en esa fecha: 200 con
 *   `vigente: false` y `precio_kg: null`. NO es un error, es una respuesta
 *   real de negocio ("este producto no tiene precio el viernes"), y la
 *   cajera tiene que poder vender igual dejando el precio en cero. Un 404
 *   aqui seria mentir sobre lo que paso.
 * - hay precio: 200 con el especial si el cliente tiene, si no el publico.
 */
export interface PrecioEfectivoRespuesta {
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  fecha: string;
  cliente_id: number | null;
  vigente: boolean;
  origen: 'cliente' | 'publico' | null;
  precio_id: number | null;
  precio_kg: number | null;
  vigente_desde: string | null;
  vigente_hasta: string | null;
}

export async function efectivo(
  db: PoolClient,
  q: PrecioEfectivo,
): Promise<PrecioEfectivoRespuesta> {
  if (q.cliente_id !== undefined) {
    const existe = await repo.existeCliente(db, q.cliente_id);
    if (!existe) throw new ErrorValidacion(`El cliente ${q.cliente_id} no existe`);
  }

  const r = await repo.resolverEfectivo(db, q);
  if (!r) throw new NoEncontrado(`No existe el producto ${q.producto_id}`);

  return {
    producto_id: r.producto_id,
    producto_codigo: r.producto_codigo,
    producto_nombre: r.producto_nombre,
    fecha: r.fecha,
    cliente_id: q.cliente_id ?? null,
    vigente: r.vigente,
    origen: r.origen,
    precio_id: r.precio_id,
    precio_kg: r.precio_kg,
    vigente_desde: r.vigente_desde,
    vigente_hasta: r.vigente_hasta,
  };
}

// ---------------------------------------------------------------------
// Ayudas internas
// ---------------------------------------------------------------------

/**
 * "Hoy" en el backend, en texto AAAA-MM-DD.
 *
 * Ojo con esto: la fecha de HOY la decide la BASE (CURRENT_DATE), que es
 * donde viven el resto de las fechas. Aqui solo se usa para dos
 * validaciones de negocio (no cerrar en pasado, no encadenar cierres), que
 * toleran una diferencia de un dia por el huso. El filtro de vigencia de
 * los listados y el resolutor NO usan esta funcion, usan CURRENT_DATE en
 * SQL: si el calculo fuera distinto, un precio de hoy podria salir en el
 * listado y no en el resolutor, o al reves.
 *
 * Se calcula con las partes locales, no con toISOString(): un backend en
 * UTC-6 escribiendole "hoy" a Postgres en UTC seria un dia adelantado.
 *
 * Y es una FUNCION, no una constante de modulo a proposito. Como
 * `const HOY = new Date()` el valor se fija cuando se importa el archivo, y
 * un servidor que lleva days vivo cruzando las medianoche seguiria
 * creyendo que hoy es el dia en que arranco: cerraria un precio de ayer
 * como si fuera de hoy y dejaria cerrar con una fecha que ya paso. Es un
 * bug de midnight que solo aparece en produccion y nunca en las pruebas.
 */
const hoy = (): string => aTextoFecha(new Date());

const aTextoFecha = (valor: Date): string => {
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
};

const aTextoFechaOpcional = (valor: Date | null): string | null =>
  valor ? aTextoFecha(valor) : null;

/**
 * 23514 es violacion de check. La usan tres cosas en este esquema y hay que
 * distinguirlas por el mensaje, no solo por el codigo:
 *
 * - el trigger anti-traslape de 0007;
 * - el CHECK de vigencia de 0001 (hasta < desde);
 * - el CHECK de precio >= 0.
 *
 * Se mira que el mensaje venga del trigger ("se traslapa") y no cualquier
 * 23514, para no traducir un problema de precio negativo como si fuera de
 * fechas. El servicio ya valida ambos antes de escribir, asi que en la
 * practica un 23514 aqui es el trigger.
 */
const esTraslape = (error: unknown): boolean =>
  (error as { code?: string })?.code === '23514' &&
  String((error as { message?: string })?.message ?? '').includes('se traslapa');

/**
 * 23505 es violacion de unicidad. El UNIQUE
 * (cliente_id, producto_id, vigente_desde) de 0001 atrapa el caso de dos
 * precios que empiezan el MISMO dia, que el trigger de traslape NO atrapa:
 * un rango de un solo dia [d, d] y otro igual se pisan, asi que el trigger
 * tambien los rechaza, pero el orden importa — Postgres puede disparar el
 * indice antes que el trigger, y el mensaje que se leeria al usuario seria
 * el equivocado. Por eso los dos se traducen por separado.
 */
const esUnico = (error: unknown): boolean => (error as { code?: string })?.code === '23505';

const traslape = (deQuien: string): Conflicto =>
  new Conflicto(
    'VIGENCIA_TRASLAPADA',
    `Ese precio se traslapa con otro ya vigente ${deQuien}. Cierra el anterior o ajusta las fechas.`,
  );

const inicioRepetido = (ambito: string, desde: string): Conflicto =>
  new Conflicto(
    'VIGENCIA_DUPLICADA',
    `Ya hay un precio ${ambito} que empieza el ${desde}. Dos precios no pueden empezar el mismo dia.`,
  );

/**
 * Revisa que la vigencia no termine antes de empezar.
 *
 * El CHECK de 0001 ya lo prohibe, pero llega como un 23514 generico, y
 * ademas el trigger de traslape podria disparar PRIMERO y reportar un
 * traslape donde lo que hay es una fecha al reves. Revisar aqui evita el
 * mensaje equivocado.
 */
function revisarVigencia(desde: string, hasta: string | null): void {
  if (hasta !== null && hasta < desde) {
    throw new ErrorValidacion('La vigencia no puede terminar antes de empezar');
  }
}

async function revisarProducto(db: PoolClient, productoId: number): Promise<void> {
  const existe = await repo.existeProducto(db, productoId);
  if (!existe) throw new ErrorValidacion(`El producto ${productoId} no existe`);
}

async function revisarCliente(db: PoolClient, clienteId: number): Promise<void> {
  const existe = await repo.existeCliente(db, clienteId);
  if (!existe) throw new ErrorValidacion(`El cliente ${clienteId} no existe`);
}

/**
 * Exporta los precios PUBLICOS a Excel.
 *
 * Incluye: Producto (codigo + nombre), Precio/kg, Vigente desde, Vigente hasta.
 * Solo se usan los filtros que el usuario haya puesto (sin paginacion).
 */
export async function exportarExcelPublicos(
  db: PoolClient,
  q: ListarPreciosPublicos,
): Promise<Buffer> {
  const { filas } = await repo.listarTodosPublicos(db, q);
  const datos = filas.map(mapeoPrecioPublico);

  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Precios de lista');

  libro.title = 'Listado de precios de lista';
  libro.creator = 'Nutricion Especializada';

  hoja.columns = [
    { header: 'Producto', key: 'producto', width: 40 },
    { header: 'Precio/kg', key: 'precio_kg', width: 14 },
    { header: 'Vigente desde', key: 'vigente_desde', width: 14 },
    { header: 'Vigente hasta', key: 'vigente_hasta', width: 14 },
  ];

  for (let c = 1; c <= 4; c++) {
    const cell = hoja.getRow(1).getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E40AF' },
    };
  }

  for (const p of datos) {
    hoja.addRow({
      producto: `${p.producto_codigo} ${p.producto_nombre}`,
      precio_kg: p.precio_kg,
      vigente_desde: p.vigente_desde,
      vigente_hasta: p.vigente_hasta ?? '',
    });
  }

  hoja.getColumn('precio_kg').numFmt = '#,##0.00';
  hoja.getColumn('vigente_desde').alignment = { horizontal: 'center' };
  hoja.getColumn('vigente_hasta').alignment = { horizontal: 'center' };

  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 4 } };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await libro.xlsx.writeBuffer());
}

/**
 * Exporta los precios DE CLIENTE a Excel.
 *
 * Incluye: Cliente, Producto (codigo + nombre), Precio/kg, Vigente desde, Vigente hasta.
 */
export async function exportarExcelClientes(
  db: PoolClient,
  q: ListarPreciosCliente,
): Promise<Buffer> {
  const { filas } = await repo.listarTodosClientes(db, q);
  const datos = filas.map(mapeoPrecioCliente);

  const libro = new ExcelJS.Workbook();
  const hoja = libro.addWorksheet('Precios de cliente');

  libro.title = 'Listado de precios de cliente';
  libro.creator = 'Nutricion Especializada';

  hoja.columns = [
    { header: 'Cliente', key: 'cliente', width: 30 },
    { header: 'Producto', key: 'producto', width: 40 },
    { header: 'Precio/kg', key: 'precio_kg', width: 14 },
    { header: 'Vigente desde', key: 'vigente_desde', width: 14 },
    { header: 'Vigente hasta', key: 'vigente_hasta', width: 14 },
  ];

  for (let c = 1; c <= 5; c++) {
    const cell = hoja.getRow(1).getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E40AF' },
    };
  }

  for (const p of datos) {
    hoja.addRow({
      cliente: p.cliente_nombre,
      producto: `${p.producto_codigo} ${p.producto_nombre}`,
      precio_kg: p.precio_kg,
      vigente_desde: p.vigente_desde,
      vigente_hasta: p.vigente_hasta ?? '',
    });
  }

  hoja.getColumn('precio_kg').numFmt = '#,##0.00';
  hoja.getColumn('vigente_desde').alignment = { horizontal: 'center' };
  hoja.getColumn('vigente_hasta').alignment = { horizontal: 'center' };

  hoja.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };
  hoja.views = [{ state: 'frozen', ySplit: 1 }];

  return Buffer.from(await libro.xlsx.writeBuffer());
}
