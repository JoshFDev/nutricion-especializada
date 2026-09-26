import type { PoolClient } from 'pg';
import { Conflicto, ErrorValidacion, NoEncontrado } from '../../core/errores.js';
import type { ActualizarProducto, CrearProducto, ListarProductos } from './esquemas.js';
import type { FilaProducto, Producto } from './modelo.js';
import { mapeoProducto } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Reglas de productos.
 *
 * Aqui viven tres decisiones que el SQL no puede tomar solo:
 *
 * 1. El codigo es unico sin distinguir mayusculas (indice
 *    ux_productos_codigo_ci, migracion 0005), y Postgres avisa con 23505.
 * 2. Las referencias al catalogo se comprueban antes de escribir, para
 *    poder decir QUE falta en vez de dejar que 23503 se traduzca a un 409
 *    que no dice nada.
 * 3. Borrar es para productos sin historial. Los que ya se movieron o ya
 *    se vendieron se dan de baja con `activo = false`.
 */

/**
 * Forma del listado: la misma que usuarios, `{ datos, total, limite, offset }`,
 * y NO la anidada de clientes.
 *
 * Se unifico en un bloque aparte; mientras tanto cada modulo responde con
 * la que ya traia y esta es la que queda.
 */
export interface PaginadoProductos {
  datos: Producto[];
  total: number;
  limite: number;
  offset: number;
}

export async function listar(db: PoolClient, q: ListarProductos): Promise<PaginadoProductos> {
  const { filas, total } = await repo.listar(db, q);
  return { datos: filas.map(mapeoProducto), total, limite: q.limite, offset: q.offset };
}

export async function obtener(db: PoolClient, id: number): Promise<Producto> {
  const fila = await repo.obtenerPorId(db, id);
  if (!fila) throw new NoEncontrado(`No existe el producto ${id}`);
  return mapeoProducto(fila);
}

export async function crear(db: PoolClient, datos: CrearProducto): Promise<Producto> {
  await revisarReferencias(db, datos.categoria_id, datos.especie_id);

  try {
    return mapeoProducto(
      await repo.crear(db, {
        codigo: datos.codigo,
        nombre: datos.nombre,
        presentacion_kg: datos.presentacion_kg,
        categoria_id: datos.categoria_id,
        especie_id: datos.especie_id,
      }),
    );
  } catch (error) {
    if (esCodigoDuplicado(error)) throw codigoDuplicado(datos.codigo);
    throw error;
  }
}

/**
 * PATCH parcial: se arranca de la fila actual y se pisa solo lo que vino
 * en el cuerpo.
 *
 * El merge se hace aqui y no en el SQL con un COALESCE por campo, porque
 * el SQL no distingue "no lo mandaste" de "lo mandaste en null", y para
 * `categoria_id` esas dos cosas significan lo contrario (dejarlo como
 * estaba frente a quitarle la categoria).
 */
export async function actualizar(
  db: PoolClient,
  id: number,
  datos: ActualizarProducto,
): Promise<Producto> {
  const antes = await repo.obtenerPorId(db, id);
  if (!antes) throw new NoEncontrado(`No existe el producto ${id}`);

  const categoriaId = datos.categoria_id !== undefined ? datos.categoria_id : antes.categoria_id;
  const especieId = datos.especie_id !== undefined ? datos.especie_id : antes.especie_id;

  await revisarReferencias(db, categoriaId, especieId);

  const destino = {
    codigo: datos.codigo ?? antes.codigo,
    nombre: datos.nombre ?? antes.nombre,
    // La fila viene de Postgres como string y el cuerpo ya viene
    // validado como string: los dos encajan en el cast ::numeric.
    presentacion_kg: datos.presentacion_kg ?? antes.presentacion_kg,
    categoria_id: categoriaId,
    especie_id: especieId,
    activo: datos.activo ?? antes.activo,
  };

  let fila: FilaProducto | null;
  try {
    fila = await repo.actualizar(db, id, destino);
  } catch (error) {
    if (esCodigoDuplicado(error)) throw codigoDuplicado(destino.codigo);
    throw error;
  }

  if (!fila) throw new NoEncontrado(`No existe el producto ${id}`);
  return mapeoProducto(fila);
}

/**
 * Borrado fisico, y solo para productos que nadie ha tocado.
 *
 * NUEVE tablas los referencian y ninguna tiene ON DELETE, asi que borrar
 * a ciegas revienta con 23503 seco. Se cuenta primero y se explica, igual
 * que en el catalogo: "lo usan 3 precios de cliente y 2 movimientos de
 * inventario". Con eso queda claro que el arreglo esta del otro lado de
 * la clave foranea, y que la via que corresponde es darlo de baja.
 */
export async function borrar(db: PoolClient, id: number): Promise<void> {
  const actual = await repo.obtenerPorId(db, id);
  if (!actual) throw new NoEncontrado(`No existe el producto ${id}`);

  const usos = await repo.contarUsos(db, id);
  if (usos.length > 0) {
    const detalle = usos
      .map((u) => `${u.total} ${u.total === 1 ? u.etiqueta : u.plural}`)
      .join(', ');
    throw new Conflicto(
      'EN_USO',
      `No se puede borrar "${actual.nombre}": ${detalle}. Si solo se deja de vender, dalo de baja.`,
      { usos },
    );
  }

  await repo.eliminar(db, id);
}

/**
 * 23505 es "violacion de unicidad". El indice ux_productos_codigo_ci es
 * sobre lower(codigo), asi que este error tambien salta cuando el codigo
 * solo difiere en mayusculas, que es justo el caso que el indice existe
 * para atrapar.
 */
const esCodigoDuplicado = (error: unknown): boolean =>
  (error as { code?: string })?.code === '23505';

const codigoDuplicado = (codigo: string): Conflicto =>
  new Conflicto('CODIGO_DUPLICADO', `Ya existe un producto con el codigo "${codigo}"`);

/**
 * Comprueba que la categoria y la especie existan, antes de escribir.
 *
 * Sin esto, una categoria inventada llega a Postgres y sale un 23503 que
 * el manejador traduce a "el registro hace referencia a algo que no
 * existe, o esta en uso" — un mensaje que no dice cual de las dos cosas
 * fue, y que además insinua un problema de concurrencia que aqui no
 * existe. Con la comprobacion previa el mensaje dice exactamente qué
 * campo corregir.
 *
 * 400 y no 404: el recurso que sepidio crear (el producto) es valido; lo
 * que viene mal es un dato de la peticion.
 */
async function revisarReferencias(
  db: PoolClient,
  categoriaId: number | null,
  especieId: number | null,
): Promise<void> {
  if (categoriaId !== null) {
    const existe = await repo.existeEnCatalogo(db, 'categorias_producto', categoriaId);
    if (!existe) {
      throw new ErrorValidacion(`La categoria ${categoriaId} no existe en el catalogo`);
    }
  }
  if (especieId !== null) {
    const existe = await repo.existeEnCatalogo(db, 'especies', especieId);
    if (!existe) {
      throw new ErrorValidacion(`La especie ${especieId} no existe en el catalogo`);
    }
  }
}
