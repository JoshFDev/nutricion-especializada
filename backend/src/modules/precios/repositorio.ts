import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import type { FilaPrecioCliente, FilaPrecioPublico } from './modelo.js';
import type { ListarPreciosCliente, ListarPreciosPublicos, PrecioEfectivo } from './esquemas.js';

/**
 * SQL de precios.
 *
 * Todos los valores van como parametro. Los unicos identificadores que se
 * interpolan en el texto son nombres de columna y de tabla escritos aqui
 * mismo, nunca algo que venga de la peticion.
 */

/**
 * El producto viene por JOIN en las dos tablas.
 *
 * Un precio sin el nombre del producto es un numero suelto: la pantalla
 * de precios tiene que decir "Leche 2 L - 90.00", no "Producto 7 - 90.00".
 * Y en la de cliente el nombre del cliente tambien, porque el filtro por
 * cliente se escribe con nombres ("los precios de Doña Maria"), no con ids.
 */
const COLUMNAS_PUBLICO = `
  pp.id, pp.producto_id,
  pr.codigo AS producto_codigo,
  pr.nombre AS producto_nombre,
  pp.precio_kg, pp.vigente_desde, pp.vigente_hasta
`;

const FROM_PUBLICO = `
  FROM precios_publicos pp
  JOIN productos pr ON pr.id = pp.producto_id
`;

const COLUMNAS_CLIENTE = `
  pc.id, pc.cliente_id, pc.producto_id,
  pr.codigo AS producto_codigo,
  pr.nombre AS producto_nombre,
  c.nombre AS cliente_nombre,
  pc.precio_kg, pc.vigente_desde, pc.vigente_hasta
`;

const FROM_CLIENTE = `
  FROM precios_cliente pc
  JOIN productos pr ON pr.id = pc.producto_id
  JOIN clientes c ON c.id = pc.cliente_id
`;

/**
 * El filtro de vigencia.
 *
 * `vigente_hasta IS NULL` es "abierto" y cuenta como vigente, y el rango
 * es INCLUSIVO por los dos lados: la vigencia de un precio que empieza el
 * 1 y acaba el 31 incluye el dia 31.
 *
 *     vigente_desde <= $fecha AND (vigente_hasta IS NULL OR vigente_hasta >= $fecha)
 *
 * El comparador de fechas va aqui y no en el mapeo, para que el indice
 * parcial de 0001 (`uq_precios_cliente_vigente`, `WHERE vigente_hasta IS
 * NULL`) pueda usarse: es la unica forma de que el filtro de "vigentes"
 * no se convierta en un seq scan de la tabla entera cuando haya miles de
 * precios.
 */
const condicionVigente = (columna: string, exprFecha: string) =>
  `(${columna}.vigente_desde <= ${exprFecha}
    AND (${columna}.vigente_hasta IS NULL OR ${columna}.vigente_hasta >= ${exprFecha}))`;

/**
 * La fecha que se usa para "hoy" en el filtro por omision.
 *
 * Se calcula en Postgres con CURRENT_DATE y NO en Node con
 * `new Date().toISOString().slice(0, 10)`. La razon es el huso: el servidor
 * de la base puede estar en una zona y el backend en otra, y con el
 * `toISOString()` un backend en UTC+2 pondria "vigente" un precio que en
 * la base todavia no empieza, que es justo el caso de un precio que se
 * activo hoy. CURRENT_DATE lo decide la base, que es donde vive el resto
 * de las fechas del sistema.
 */
const HOY_EN_SQL = 'CURRENT_DATE';

/**
 * Arma el WHERE y los valores del listado, en el mismo lugar.
 *
 * `valores` y `condiciones` son locales a la llamada, NO de modulo: un
 * arreglo compartido entre peticiones seria un bug de concurrencia
 * silencioso.
 */
export interface ListadoPrecios<T> {
  filas: T[];
  total: number;
}

const construirFiltroPublico = (q: ListarPreciosPublicos) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`pp.producto_id = $${valores.length}`);
  }

  if (q.vigencia === 'vigentes') {
    condiciones.push(condicionVigente('pp', HOY_EN_SQL));
  } else if (q.vigencia === 'historicos') {
    // Historico = ya no vigente. La comparacion es `>` y no `>=` porque
    // el fin es INCLUSIVO: un precio que acaba HOY sigue vigente hoy, no
    // es historico todavia.
    condiciones.push(`pp.vigente_hasta IS NOT NULL AND pp.vigente_hasta < ${HOY_EN_SQL}`);
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '',
  };
};

const construirFiltroCliente = (q: ListarPreciosCliente) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`pc.cliente_id = $${valores.length}`);
  }
  if (q.producto_id !== undefined) {
    valores.push(q.producto_id);
    condiciones.push(`pc.producto_id = $${valores.length}`);
  }

  if (q.vigencia === 'vigentes') {
    condiciones.push(condicionVigente('pc', HOY_EN_SQL));
  } else if (q.vigencia === 'historicos') {
    condiciones.push(`pc.vigente_hasta IS NOT NULL AND pc.vigente_hasta < ${HOY_EN_SQL}`);
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '',
  };
};

/**
 * El orden es por producto y luego por fecha descendente, que es como se
 * lee una linea de tiempo de precios: los recientes primero, y de un
 * producto todos juntos.
 *
 * `pr.codigo COLLATE pos.es_es` por la misma razon que en productos: un
 * producto que empiece con "Ñ" no se va al final.
 */
const ORDEN_PUBLICO = `ORDER BY pr.codigo COLLATE pos.es_es ASC, pp.vigente_desde DESC, pp.id DESC`;
const ORDEN_CLIENTE = `ORDER BY c.nombre COLLATE pos.es_es ASC, pr.codigo COLLATE pos.es_es ASC, pc.vigente_desde DESC, pc.id DESC`;

export async function listarPublicos(
  cliente: PoolClient,
  q: ListarPreciosPublicos,
): Promise<ListadoPrecios<FilaPrecioPublico>> {
  const { valores, donde } = construirFiltroPublico(q);

  const conPaginacion = [...valores, q.limite, q.offset];
  const filas = await consultar<FilaPrecioPublico>(
    cliente,
    `SELECT ${COLUMNAS_PUBLICO} ${FROM_PUBLICO} ${donde} ${ORDEN_PUBLICO}
     LIMIT $${conPaginacion.length - 1} OFFSET $${conPaginacion.length}`,
    conPaginacion,
  );
  const total = await contar(
    cliente,
    `SELECT count(*)::int AS total ${FROM_PUBLICO} ${donde}`,
    valores,
  );

  return { filas, total };
}

export async function listarClientes(
  cliente: PoolClient,
  q: ListarPreciosCliente,
): Promise<ListadoPrecios<FilaPrecioCliente>> {
  const { valores, donde } = construirFiltroCliente(q);

  const conPaginacion = [...valores, q.limite, q.offset];
  const filas = await consultar<FilaPrecioCliente>(
    cliente,
    `SELECT ${COLUMNAS_CLIENTE} ${FROM_CLIENTE} ${donde} ${ORDEN_CLIENTE}
     LIMIT $${conPaginacion.length - 1} OFFSET $${conPaginacion.length}`,
    conPaginacion,
  );
  const total = await contar(
    cliente,
    `SELECT count(*)::int AS total ${FROM_CLIENTE} ${donde}`,
    valores,
  );

  return { filas, total };
}

export async function obtenerPublicoPorId(
  cliente: PoolClient,
  id: number,
): Promise<FilaPrecioPublico | null> {
  return consultarUno<FilaPrecioPublico>(
    cliente,
    `SELECT ${COLUMNAS_PUBLICO} ${FROM_PUBLICO} WHERE pp.id = $1`,
    [id],
  );
}

export async function obtenerClientePorId(
  cliente: PoolClient,
  id: number,
): Promise<FilaPrecioCliente | null> {
  return consultarUno<FilaPrecioCliente>(
    cliente,
    `SELECT ${COLUMNAS_CLIENTE} ${FROM_CLIENTE} WHERE pc.id = $1`,
    [id],
  );
}

/**
 * El INSERT escribe `vigente_desde` explicito, aunque el esquema traiga
 * DEFAULT CURRENT_DATE, y no se deja que Postgres lo ponga.
 *
 * La razon esta al final de la migracion 0007: el trigger anti-traslape
 * compara contra NEW.vigente_desde. Si el INSERT lo dejara en el DEFAULT,
 * el trigger veria la fecha igual (DEFAULT se aplica antes del trigger),
 * asi que en realidad NO hay diferencia. Se escribe explicito de todos
 * modos porque hace visible en el SQL que la fecha viaja, y porque el dia
 * que se agregue un DEFAULT distinto, el modulo deja de depender de el.
 */
export async function crearPublico(
  cliente: PoolClient,
  datos: {
    producto_id: number;
    precio_kg: string;
    vigente_desde: string;
    vigente_hasta: string | null;
  },
): Promise<FilaPrecioPublico> {
  const insertado = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO precios_publicos (producto_id, precio_kg, vigente_desde, vigente_hasta)
     VALUES ($1, $2::numeric, $3::date, $4::date)
     RETURNING id`,
    [datos.producto_id, datos.precio_kg, datos.vigente_desde, datos.vigente_hasta],
  );
  if (!insertado) throw new Error('El INSERT de precios_publicos no devolvio id');

  const fila = await obtenerPublicoPorId(cliente, Number(insertado.id));
  if (!fila) throw new Error('El precio publico insertado no se pudo volver a leer');
  return fila;
}

export async function crearCliente(
  cliente: PoolClient,
  datos: {
    cliente_id: number;
    producto_id: number;
    precio_kg: string;
    vigente_desde: string;
    vigente_hasta: string | null;
  },
): Promise<FilaPrecioCliente> {
  const insertado = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO precios_cliente (cliente_id, producto_id, precio_kg, vigente_desde, vigente_hasta)
     VALUES ($1, $2, $3::numeric, $4::date, $5::date)
     RETURNING id`,
    [
      datos.cliente_id,
      datos.producto_id,
      datos.precio_kg,
      datos.vigente_desde,
      datos.vigente_hasta,
    ],
  );
  if (!insertado) throw new Error('El INSERT de precios_cliente no devolvio id');

  const fila = await obtenerClientePorId(cliente, Number(insertado.id));
  if (!fila) throw new Error('El precio de cliente insertado no se pudo volver a leer');
  return fila;
}

export async function actualizarPublico(
  cliente: PoolClient,
  id: number,
  datos: { precio_kg: string; vigente_desde: string; vigente_hasta: string | null },
): Promise<FilaPrecioPublico | null> {
  const actualizado = await consultarUno<{ id: string }>(
    cliente,
    `UPDATE precios_publicos
        SET precio_kg = $2::numeric,
            vigente_desde = $3::date,
            vigente_hasta = $4::date
      WHERE id = $1
     RETURNING id`,
    [id, datos.precio_kg, datos.vigente_desde, datos.vigente_hasta],
  );
  if (!actualizado) return null;

  return obtenerPublicoPorId(cliente, id);
}

export async function actualizarCliente(
  cliente: PoolClient,
  id: number,
  datos: { precio_kg: string; vigente_desde: string; vigente_hasta: string | null },
): Promise<FilaPrecioCliente | null> {
  const actualizado = await consultarUno<{ id: string }>(
    cliente,
    `UPDATE precios_cliente
        SET precio_kg = $2::numeric,
            vigente_desde = $3::date,
            vigente_hasta = $4::date
      WHERE id = $1
     RETURNING id`,
    [id, datos.precio_kg, datos.vigente_desde, datos.vigente_hasta],
  );
  if (!actualizado) return null;

  return obtenerClientePorId(cliente, id);
}

/**
 * El precio que toca cobrar, en una sola consulta.
 *
 * Se resuelven los DOS niveles con un par de CTEs y no con dos consultas
 * separadas porque entre una y otra caben otras peticiones: si se preguntara
 * primero el especial, luego el publico, y en medio alguien abriera o
 * cerrara un precio, la respuesta seria una combinacion que no existio
 * nunca. En una sentencia, los dos niveles salen de la misma foto.
 *
 * La precedencia: el precio ESPECIAL del cliente gana sobre el publico.
 * Es la que se eligio al exponer el modulo, y la razon de negocio es que
 * lo pactado cara a cara manda sobre el precio de lista. Cuando
 * `cliente_id` no viene, solo se resuelve el nivel publico.
 */
export async function resolverEfectivo(
  cliente: PoolClient,
  q: PrecioEfectivo,
): Promise<{
  fecha: string;
  producto_id: number;
  producto_codigo: string;
  producto_nombre: string;
  vigente: boolean;
  origen: 'cliente' | 'publico' | null;
  precio_id: number | null;
  precio_kg: number | null;
  vigente_desde: string | null;
  vigente_hasta: string | null;
} | null> {
  // La fecha llega como parametro cuando el usuario la escribio y como
  // CURRENT_DATE cuando se pide "hoy". El CTE `fecha` la unifica en un
  // solo COALESCE, para que la comparacion sea identica en los dos casos.
  const fecha = q.fecha ?? null;

  const fila = await consultarUno<{
    fecha: string;
    producto_id: string;
    producto_codigo: string;
    producto_nombre: string;
    especial_id: string | null;
    especial_precio: string | null;
    especial_desde: Date | null;
    especial_hasta: Date | null;
    publico_id: string | null;
    publico_precio: string | null;
    publico_desde: Date | null;
    publico_hasta: Date | null;
  }>(
    cliente,
    `WITH fecha AS (SELECT COALESCE($1::date, CURRENT_DATE) AS d),
     especial AS (
       SELECT pc.id, pc.precio_kg, pc.vigente_desde, pc.vigente_hasta
       FROM precios_cliente pc, fecha f
       WHERE pc.cliente_id = $2
         AND pc.producto_id = $3
         AND pc.vigente_desde <= f.d
         AND (pc.vigente_hasta IS NULL OR pc.vigente_hasta >= f.d)
       ORDER BY pc.vigente_desde DESC
       LIMIT 1
     ),
     publico AS (
       SELECT pp.id, pp.precio_kg, pp.vigente_desde, pp.vigente_hasta
       FROM precios_publicos pp, fecha f
       WHERE pp.producto_id = $3
         AND pp.vigente_desde <= f.d
         AND (pp.vigente_hasta IS NULL OR pp.vigente_hasta >= f.d)
       ORDER BY pp.vigente_desde DESC
       LIMIT 1
     )
     SELECT
       to_char(f.d, 'YYYY-MM-DD') AS fecha,
       pr.id AS producto_id, pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
       e.id AS especial_id, e.precio_kg AS especial_precio,
       e.vigente_desde AS especial_desde, e.vigente_hasta AS especial_hasta,
       u.id AS publico_id, u.precio_kg AS publico_precio,
       u.vigente_desde AS publico_desde, u.vigente_hasta AS publico_hasta
     FROM fecha f
     CROSS JOIN productos pr
     LEFT JOIN especial e ON TRUE
     LEFT JOIN publico u ON TRUE
     WHERE pr.id = $3`,
    [fecha, q.cliente_id ?? null, q.producto_id],
  );

  // `consultarUno` devuelve null cuando la consulta no trae filas, y aca
  // eso solo pasa si el producto no existe: si existiera pero no tuviera
  // ningun precio, los dos LEFT JOIN darian null y la fila volveria igual.
  // El 404 lo lanza el servicio, que es donde vive el mensaje.
  if (!fila) return null;

  const r = fila;
  const hayEspecial = r.especial_id !== null;
  const hayPublico = r.publico_id !== null;

  return {
    fecha: r.fecha,
    producto_id: Number(r.producto_id),
    producto_codigo: r.producto_codigo,
    producto_nombre: r.producto_nombre,
    vigente: hayEspecial || hayPublico,
    origen: hayEspecial ? 'cliente' : hayPublico ? 'publico' : null,
    precio_id: hayEspecial ? Number(r.especial_id) : hayPublico ? Number(r.publico_id) : null,
    precio_kg: hayEspecial
      ? Number(r.especial_precio)
      : hayPublico
        ? Number(r.publico_precio)
        : null,
    vigente_desde: r.especial_desde
      ? formatearFecha(r.especial_desde)
      : r.publico_desde
        ? formatearFecha(r.publico_desde)
        : null,
    vigente_hasta: r.especial_hasta
      ? formatearFecha(r.especial_hasta)
      : r.publico_hasta
        ? formatearFecha(r.publico_hasta)
        : null,
  };
}

/** `vigente_desde` sale de Postgres como DATE (un string ya), no como Date. */
const formatearFecha = (valor: Date | string): string => {
  if (typeof valor === 'string') return valor.slice(0, 10);
  const anio = valor.getFullYear();
  const mes = String(valor.getMonth() + 1).padStart(2, '0');
  const dia = String(valor.getDate()).padStart(2, '0');
  return `${anio}-${mes}-${dia}`;
};

/**
 * ¿Existe el producto y el cliente a los que se quiere apuntar?
 *
 * Se pregunta antes de escribir, por lo mismo que en productos: sin esto,
 * una referencia inventada llega a Postgres y sale un 23503 que el manejador
 * traduce a "el registro hace referencia a algo que no existe, o esta en
 * uso". Un mensaje que no dice cual de las dos cosas fue, y que ademas
 * insinua un problema de concurrencia que aqui no existe. Con esto, el
 * formulario puede marcar el campo exacto.
 *
 * Para el RESOLUTOR esto no alcanza y por eso `resolverEfectivo` distingue
 * por su cuenta el producto inexistente (sin filas) del producto sin
 * precio (una fila con los dos precios en null).
 */
export async function existeProducto(cliente: PoolClient, id: number): Promise<boolean> {
  const { rows } = await cliente.query<{ existe: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM productos WHERE id = $1) AS existe`,
    [id],
  );
  return rows[0]?.existe ?? false;
}

export async function existeCliente(cliente: PoolClient, id: number): Promise<boolean> {
  const { rows } = await cliente.query<{ existe: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM clientes WHERE id = $1) AS existe`,
    [id],
  );
  return rows[0]?.existe ?? false;
}
