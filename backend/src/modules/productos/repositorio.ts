import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import type { FilaProducto } from './modelo.js';
import type { ListarProductos } from './esquemas.js';

type FiltroListar = ListarProductos;

/**
 * SQL de productos.
 *
 * Todos los valores van como parametro. Los unicos identificadores que se
 * interpolan en el texto son nombres de columna y de tabla escritos aqui
 * mismo, nunca algo que venga de la peticion.
 */

/**
 * El catalogo viene por JOIN y no por id suelto.
 *
 * `categoria` y `especie` son el nombre del catalogo resuelto. Sin esto,
 * la pantalla de productos tendria que pedir /api/categorias-producto y
 * /api/especies enteras para cruzarlas en el cliente, con el catalogo
 * desactualizado entre una pantalla y otra.
 *
 * LEFT JOIN y no INNER porque un producto puede quedar sin clasificar
 * (categoria_id o especie_id en NULL) y tiene que salir igual en la lista,
 * con su campo en null.
 */
const COLUMNAS = `
  p.id, p.codigo, p.nombre,
  p.categoria_id, p.especie_id,
  c.nombre AS categoria,
  e.nombre AS especie,
  p.presentacion_kg, p.activo,
  p.creado_en, p.actualizado_en
`;

const FROM = `
  FROM productos p
  LEFT JOIN categorias_producto c ON c.id = p.categoria_id
  LEFT JOIN especies e ON e.id = p.especie_id
`;

/**
 * Orden por codigo y no por nombre: el codigo es el identificador con el
 * que trabaja la bodega, asi que es por donde se busca. Y COLLATE
 * pos.es_es (la colacion de 0004) para que un producto que empiece con
 * "Ñ" o una vocal acentuada no se vaya al final de la lista.
 */
const ORDEN = `ORDER BY p.codigo COLLATE pos.es_es ASC`;

/**
 * Arma el WHERE y los valores del listado, en el mismo lugar.
 *
 * El numero de parametro se saca del tamanio del arreglo de valores en
 * cada paso (`$${valores.length}`) en vez de contarlos a mano: si alguien
 * agrega un filtro nuevo y se olvida de subir los numeros, el SQL queda
 * desalineado y Postgres avienta con "there is no parameter $3" en vez de
 * devolver algo raro.
 *
 * NOTA: `valores` y `condiciones` son locales a la llamada, NO de modulo.
 * Un arreglo compartido entre peticiones seria un bug de concurrencia
 * silencioso: dos listados simultaneos se pisarian los filtros y cada uno
 * devolveria los productos del otro.
 *
 * LIMITACION CONOCIDA: la busqueda NO ignora acentos. Buscar "lacteo" no
 * encuentra "Sustituto lacteo" escrito con acento. Se podria arreglar con
 * `unaccent()`, que ya esta disponible en este PostgreSQL pero hay que
 * instalar la extension primero, y eso es un cambio de schema que no se
 * cuela de cacherlo en un modulo. Si se decide instalarla, este es el
 * unico predicado que hay que tocar.
 */
const construirFiltro = (q: FiltroListar) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.buscar) {
    // ILIKE ya es sin distincion de mayusculas, asi que el lower() sobra
    // y se evita pagar la transformacion dos veces.
    valores.push(`%${q.buscar}%`);
    const n = valores.length;
    condiciones.push(`(p.codigo ILIKE $${n} OR p.nombre ILIKE $${n})`);
  }

  if (q.activo === 'activos') {
    condiciones.push(`p.activo = TRUE`);
  } else if (q.activo === 'inactivos') {
    condiciones.push(`p.activo = FALSE`);
  }

  if (q.categoria_id !== undefined) {
    valores.push(q.categoria_id);
    condiciones.push(`p.categoria_id = $${valores.length}`);
  }

  if (q.especie_id !== undefined) {
    valores.push(q.especie_id);
    condiciones.push(`p.especie_id = $${valores.length}`);
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '',
  };
};

export interface ListadoProductos {
  filas: FilaProducto[];
  total: number;
}

export async function listar(cliente: PoolClient, q: ListarProductos): Promise<ListadoProductos> {
  const { valores, donde } = construirFiltro(q);

  // El total se cuenta aparte y no con un COUNT(*) OVER() sobre la misma
  // consulta, para que el frontend sepa cuantas paginas hay sin depender
  // de la longitud de la pagina que le toco, que es justo lo que pasa en
  // la ultima.
  const conPaginacion = [...valores, q.limite, q.offset];
  const filas = await consultar<FilaProducto>(
    cliente,
    `SELECT ${COLUMNAS} ${FROM} ${donde} ${ORDEN}
     LIMIT $${conPaginacion.length - 1} OFFSET $${conPaginacion.length}`,
    conPaginacion,
  );
  const total = await contar(cliente, `SELECT count(*)::int AS total ${FROM} ${donde}`, valores);

  return { filas, total };
}

export async function obtenerPorId(cliente: PoolClient, id: number): Promise<FilaProducto | null> {
  return consultarUno<FilaProducto>(cliente, `SELECT ${COLUMNAS} ${FROM} WHERE p.id = $1`, [id]);
}

/**
 * El INSERT y el UPDATE devuelven solo el id y la fila completa se vuelve
 * a leer con obtenerPorId.
 *
 * Se podria meter el RETURNING completo y evitar el segundo SELECT, pero
 * eso obliga a repetir el bloque de JOINes en el RETURNING (que en una CTE
 * no se puede poner igual de limpio) y el dia que se agregue una columna
 * hay que acordarse de editarla en dos sitios. El SELECT extra cuesta
 * una ida a la tabla y queda siempre igual.
 *
 * Todo va dentro de la misma transaccion del request, asi que la segunda
 * lectura ve la fila que acaba de escribir.
 */
export async function crear(
  cliente: PoolClient,
  datos: {
    codigo: string;
    nombre: string;
    presentacion_kg: string;
    categoria_id: number | null;
    especie_id: number | null;
  },
): Promise<FilaProducto> {
  const insertado = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO productos (codigo, nombre, presentacion_kg, categoria_id, especie_id)
     VALUES ($1, $2, $3::numeric, $4, $5)
     RETURNING id`,
    [datos.codigo, datos.nombre, datos.presentacion_kg, datos.categoria_id, datos.especie_id],
  );
  if (!insertado) throw new Error('El INSERT de productos no devolvio id');

  const fila = await obtenerPorId(cliente, Number(insertado.id));
  if (!fila) throw new Error('El producto insertado no se pudo volver a leer');
  return fila;
}

export async function actualizar(
  cliente: PoolClient,
  id: number,
  datos: {
    codigo: string;
    nombre: string;
    presentacion_kg: string;
    categoria_id: number | null;
    especie_id: number | null;
    activo: boolean;
  },
): Promise<FilaProducto | null> {
  const actualizado = await consultarUno<{ id: string }>(
    cliente,
    `UPDATE productos
        SET codigo = $2,
            nombre = $3,
            presentacion_kg = $4::numeric,
            categoria_id = $5,
            especie_id = $6,
            activo = $7
      WHERE id = $1
     RETURNING id`,
    [
      id,
      datos.codigo,
      datos.nombre,
      datos.presentacion_kg,
      datos.categoria_id,
      datos.especie_id,
      datos.activo,
    ],
  );
  if (!actualizado) return null;

  return obtenerPorId(cliente, id);
}

export async function eliminar(cliente: PoolClient, id: number): Promise<boolean> {
  const { rows } = await cliente.query<{ id: string }>(
    `DELETE FROM productos WHERE id = $1 RETURNING id`,
    [id],
  );
  return rows.length > 0;
}

/**
 * En que lugares se apoya un producto.
 *
 * NUEVE tablas lo referencian, y la lista se ve mas larga de lo que es
 * porque incluye dos de auditoria. Se cuentan igual a proposito, y esta es
 * la razon:
 *
 * `auditoria_precios` y `auditoria_inventario` tienen producto_id con FK
 * dura, sin ON DELETE. El borrado fisico revienta con 23503 estan o no
 * esten en esta lista. Contarlas solo convierte un error seco en un 409
 * que explica el porque, que es la diferencia entre un mensaje utilizable
 * y un "algo fallo" que nadie sabe interpretar.
 *
 * El mensaje va a decir "lo usan 3 precios de cliente y 2 movimientos de
 * inventario", y eso es cierto. Ahi queda a la vista la leccion: un
 * producto con historial no se borra, se da de baja. Para eso esta la
 * columna `activo`.
 */
const USOS = [
  { etiqueta: 'precio de cliente', tabla: 'precios_cliente' },
  { etiqueta: 'precio publico', tabla: 'precios_publicos' },
  { etiqueta: 'precio de proveedor', tabla: 'producto_proveedor_precios' },
  { etiqueta: 'renglon de compra', tabla: 'compra_detalle' },
  { etiqueta: 'renglon de nota de remision', tabla: 'nota_remision_detalle' },
  { etiqueta: 'movimiento de inventario', tabla: 'inventario_movimientos' },
  { etiqueta: 'registro de inventario semanal', tabla: 'inventario_semanal' },
  { etiqueta: 'auditoria de inventario', tabla: 'auditoria_inventario' },
  { etiqueta: 'auditoria de precios', tabla: 'auditoria_precios' },
] as const;

/** Plurales para el mensaje, indexed por el mismo orden que la etiqueta. */
const PLURALES: Record<(typeof USOS)[number]['etiqueta'], string> = {
  'precio de cliente': 'precios de cliente',
  'precio publico': 'precios publicos',
  'precio de proveedor': 'precios de proveedor',
  'renglon de compra': 'renglones de compra',
  'renglon de nota de remision': 'renglones de nota de remision',
  'movimiento de inventario': 'movimientos de inventario',
  'registro de inventario semanal': 'registros de inventario semanal',
  'auditoria de inventario': 'auditorias de inventario',
  'auditoria de precios': 'auditorias de precios',
};

export type EtiquetaUso = (typeof USOS)[number]['etiqueta'];

export async function contarUsos(
  cliente: PoolClient,
  id: number,
): Promise<{ etiqueta: string; plural: string; total: number }[]> {
  const conteos = await Promise.all(
    USOS.map(async (uso) => {
      const { rows } = await cliente.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM ${uso.tabla} WHERE producto_id = $1`,
        [id],
      );
      const total = rows[0]?.total ?? 0;
      return { etiqueta: uso.etiqueta, plural: PLURALES[uso.etiqueta], total };
    }),
  );
  return conteos.filter((c) => c.total > 0);
}

/**
 * ¿Existe la fila de catalogo a la que se quiere apuntar?
 *
 * Se pregunta antes de escribir en vez de dejar que Postgres aviente con
 * 23503, porque el manejador traduce ese codigo a un 409 generico ("el
 * registro hace referencia a algo que no existe, o esta en uso") que no
 * dice QUE es lo que no existe. Con esta comprobacion el mensaje puede
 * decir "la categoria 42 no existe" y el formulario puede marcar el campo.
 *
 * El nombre de tabla es un tipo union de dos literales: lo restringe
 * TypeScript en tiempo de compilacion, asi que no hay forma de que un
 * valor de la peticion llegue aqui. No es lo mismo que el modulo de
 * catalogo, que recibe la tabla como string y por eso lo prohibio con
 * tantisimo comentario.
 */
export async function existeEnCatalogo(
  cliente: PoolClient,
  tabla: 'especies' | 'categorias_producto',
  id: number,
): Promise<boolean> {
  const { rows } = await cliente.query<{ existe: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${tabla} WHERE id = $1) AS existe`,
    [id],
  );
  return rows[0]?.existe ?? false;
}
