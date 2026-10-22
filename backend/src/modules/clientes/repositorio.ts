import type { PoolClient } from 'pg';
import { consultar, consultarUno, contar } from '../../db/transaccion.js';
import type { ActualizarCliente, CrearCliente, ListarClientes } from './esquemas.js';
import type { ClienteFila, NotaResumenFila } from './modelo.js';

/**
 * Capa de datos: aqui vive el SQL y SOLO SQL.
 *
 * No conoce Express ni los errores de la aplicacion. Si una consulta
 * viola una restriccion, deja que Postgres lance y que el traductor de
 * errores de la capa superior la traduzca.
 */

const CAMPOS = `c.id, c.codigo_cliente, c.nombre, c.establo, c.especie_id,
                e.nombre AS especie, c.estatus, c.telefono, c.email, c.direccion,
                c.saldo_actual, c.saldo_ajustado, c.creado_en, c.actualizado_en,
                f.rfc, f.razon_social`;

const FROM_CLIENTES = `FROM clientes c
                       LEFT JOIN especies e ON e.id = c.especie_id
                       LEFT JOIN datos_fiscales_cliente f ON f.cliente_id = c.id`;

/**
 * Arma el WHERE de la lista y sus valores.
 *
 * Devuelve el fragmento y el arreglo de parametros en el MISMO orden en
 * que aparecen los $1, $2... Es facil desalinearlos y acabar filtrando
 * por el valor equivocado sin que ningun test lo note.
 */
function construirFiltro(q: ListarClientes): { donde: string; valores: unknown[] } {
  const condiciones: string[] = [];
  const valores: unknown[] = [];

  if (q.buscar) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(c.nombre ILIKE $${valores.length} OR c.codigo_cliente ILIKE $${valores.length} OR f.rfc ILIKE $${valores.length})`,
    );
  }
  if (q.estatus) {
    valores.push(q.estatus);
    condiciones.push(`c.estatus = $${valores.length}`);
  }

  const s = q.saldo ?? 'todos';
  if (s === 'adeudado') {
    condiciones.push('c.saldo_actual > 0');
  } else if (s === 'a_favor') {
    condiciones.push('c.saldo_actual < 0');
  } else if (s === 'sin_saldo') {
    condiciones.push('c.saldo_actual = 0');
  } else if (s === 'con_saldo') {
    condiciones.push('c.saldo_actual <> 0');
  }

  return {
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '',
    valores,
  };
}

export async function listar(
  cliente: PoolClient,
  q: ListarClientes,
): Promise<{ filas: ClienteFila[]; total: number }> {
  const { donde, valores } = construirFiltro(q);

  const filas = await consultar<ClienteFila>(
    cliente,
    `SELECT ${CAMPOS} ${FROM_CLIENTES} ${donde}
      ORDER BY c.nombre
      LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  const total = await contar(
    cliente,
    `SELECT count(*)::int AS total
       FROM clientes c
       LEFT JOIN datos_fiscales_cliente f ON f.cliente_id = c.id
       ${donde}`,
    valores,
  );

  return { filas, total };
}

/**
 * La MISMA consulta sin `LIMIT`, para el Excel.
 *
 * El `limite` de `listar` es de 200 por peticion, y un listado de clientes
 * cabe de sobra en eso, pero la exportacion no puede depender de cuantos
 * quepan en una pagina: se exporta lo que hay filtrado, no lo que se ve.
 * Por eso el filtro es el mismo (`construirFiltro`) y lo que se cae es solo
 * el recorte.
 *
 * No hace falta el `total` de aquí: el COUNT solo lo necesita el listado,
 * que lo pinta para la barra de paginación.
 */
export async function listarTodos(cliente: PoolClient, q: ListarClientes): Promise<ClienteFila[]> {
  const { donde, valores } = construirFiltro(q);
  return consultar<ClienteFila>(
    cliente,
    `SELECT ${CAMPOS} ${FROM_CLIENTES} ${donde}
      ORDER BY c.nombre`,
    valores,
  );
}

export async function obtenerPorId(cliente: PoolClient, id: number): Promise<ClienteFila | null> {
  return consultarUno<ClienteFila>(cliente, `SELECT ${CAMPOS} ${FROM_CLIENTES} WHERE c.id = $1`, [
    id,
  ]);
}

export async function listarNotas(
  cliente: PoolClient,
  clienteId: number,
): Promise<NotaResumenFila[]> {
  return consultar<NotaResumenFila>(
    cliente,
    `SELECT n.id,
            f.serie,
            f.folio_numero,
            n.fecha,
            n.estatus,
            n.subtotal,
            COALESCE((SELECT SUM(pa.monto_aplicado)
                        FROM pagos_aplicacion pa
                       WHERE pa.nota_id = n.id), 0) AS pagado
       FROM notas_remision n
       JOIN folios f ON f.id = n.folio_id
      WHERE n.cliente_id = $1
      ORDER BY n.fecha DESC, n.id DESC`,
    [clienteId],
  );
}

export async function crear(cliente: PoolClient, datos: CrearCliente): Promise<ClienteFila> {
  const fila = await consultarUno<ClienteFila>(
    cliente,
    `INSERT INTO clientes (codigo_cliente, nombre, establo, especie_id,
                           estatus, telefono, email, direccion, saldo_ajustado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, codigo_cliente, nombre, establo, especie_id, estatus,
               telefono, email, direccion, saldo_actual, saldo_ajustado,
               creado_en, actualizado_en`,
    [
      datos.codigo_cliente,
      datos.nombre,
      datos.establo ?? null,
      datos.especie_id ?? null,
      datos.estatus,
      datos.telefono ?? null,
      datos.email ?? null,
      datos.direccion ?? null,
      datos.saldo_ajustado ?? 0,
    ],
  );
  // RETURNING en un INSERT siempre trae fila; si no, el INSERT fallo.
  if (!fila) throw new Error('El INSERT de clientes no devolvio fila');
  return fila;
}

export async function actualizar(
  cliente: PoolClient,
  id: number,
  datos: ActualizarCliente,
): Promise<ClienteFila | null> {
  const campos = Object.keys(datos) as (keyof ActualizarCliente)[];

  /**
   * Los nombres de columna se citan como IDENTIFICADORES, nunca como
   * valores, asi que no se pueden pasar por los parametros. Por eso
   * necesitan una allowlist: zod ya garantiza que las claves sean
   * conocidas, y este set las filtra otra vez.
   *
   * `saldo_actual` NO esta aqui, y es a proposito: es un campo que
   * CALCULA la base (notas menos abonos, mas el ajuste) y que ademas
   * esta protegido por un trigger que rechaza la escritura a mano. Lo
   * que la aplicacion escribe es `saldo_ajustado`, que es el delta
   * manual y si se guarda.
   */
  const permitidos = new Set([
    'codigo_cliente',
    'nombre',
    'establo',
    'especie_id',
    'estatus',
    'telefono',
    'email',
    'direccion',
    'saldo_ajustado',
  ]);
  const seguros = campos.filter((c) => permitidos.has(c));
  if (seguros.length === 0) return null;

  const asignaciones = seguros.map((campo, i) => `${String(campo)} = $${i + 2}`);

  const resultado = await consultarUno<{ id: string }>(
    cliente,
    `UPDATE clientes SET ${asignaciones.join(', ')}
      WHERE id = $1
      RETURNING id`,
    [id, ...seguros.map((c) => datos[c] ?? null)],
  );
  if (!resultado) return null;

  // Se relee la fila completa con sus JOIN en vez de confiar en el
  // RETURNING: el RETURNING de un UPDATE no puede traer `especie`,
  // `rfc` ni `razon_social` (viven en otras tablas), y ademas el saldo lo
  // recalcula un trigger, asi que el valor bueno es el de DESPUES del
  // UPDATE, no el de antes.
  return consultarUno<ClienteFila>(cliente, `SELECT ${CAMPOS} ${FROM_CLIENTES} WHERE c.id = $1`, [
    id,
  ]);
}

/**
 * Cuanto lo apunta a este cliente, por tipo de cosa.
 *
 * Lo usa el servicio para NO dejar borrar un cliente con historial, y para
 * decir QUE lo apunta. Sin esto, el borrado revienta con un 23503 que el
 * traductor de errores vuelve "hace referencia a algo que no existe", que
 * es falso: lo que existe es el historial del cliente.
 *
 * Cada cosa trae su nombre en singular y en plural, porque "nota de
 * remisión" en plural es "notas de remisión" y no "nota de remisións": la
 * 's' va en la palabra del medio, no al final.
 */
export async function contarUsos(
  cliente: PoolClient,
  id: number,
): Promise<{ singular: string; plural: string; total: number }[]> {
  const usos: { singular: string; plural: string; total: number }[] = [];

  const agrega = async (singular: string, plural: string, sql: string) => {
    const r = await consultarUno<{ total: string }>(cliente, sql, [id]);
    const total = Number(r?.total ?? 0);
    if (total > 0) usos.push({ singular, plural, total });
  };

  await agrega(
    'nota de remisión',
    'notas de remisión',
    'SELECT count(*)::TEXT AS total FROM notas_remision WHERE cliente_id = $1',
  );
  await agrega('pago', 'pagos', 'SELECT count(*)::TEXT AS total FROM pagos WHERE cliente_id = $1');
  await agrega(
    'factura',
    'facturas',
    'SELECT count(*)::TEXT AS total FROM facturas WHERE cliente_id = $1',
  );
  await agrega(
    'precio pactado',
    'precios pactados',
    'SELECT count(*)::TEXT AS total FROM precios_cliente WHERE cliente_id = $1',
  );
  await agrega(
    'movimiento de caja',
    'movimientos de caja',
    'SELECT count(*)::TEXT AS total FROM movimientos_financieros WHERE cliente_id = $1',
  );

  return usos;
}

export async function eliminar(cliente: PoolClient, id: number): Promise<boolean> {
  // `datos_fiscales_cliente` referencia a `clientes` SIN ON DELETE CASCADE,
  // asi que sin este DELETE el borrado se caeria con un 23503 en cuanto
  // algun cliente tuviera RFC, y saldria un 409 que dice "esta en uso" de
  // un registro que no usa nada.
  await cliente.query('DELETE FROM datos_fiscales_cliente WHERE cliente_id = $1', [id]);
  const resultado = await cliente.query('DELETE FROM clientes WHERE id = $1', [id]);
  return (resultado.rowCount ?? 0) > 0;
}

/**
 * Escribe o borra el RFC del cliente en `datos_fiscales_cliente`.
 *
 * Esa tabla guarda juntos el RFC y la razon social, con UNA fila por
 * cliente (indice unico). La razon social no se captura en la pantalla: si
 * no existe se guarda con el nombre del cliente, y si ya existe se queda
 * como esta (`DO UPDATE` solo cambia el rfc), porque reescribirla a
 * escondidas cambiaria lo que ya se facturo.
 *
 * `rfc = null` borra la fila entera. Es lo que manda el editor cuando el
 * campo queda vacio: sin RFC no hay dato fiscal que conservar.
 */
export async function escribirRfc(
  cliente: PoolClient,
  clienteId: number,
  rfc: string | null,
  nombre: string | null,
): Promise<void> {
  if (rfc === null) {
    await cliente.query('DELETE FROM datos_fiscales_cliente WHERE cliente_id = $1', [clienteId]);
    return;
  }

  await cliente.query(
    `INSERT INTO datos_fiscales_cliente (cliente_id, rfc, razon_social)
     VALUES ($1, $2, COALESCE($3::TEXT, (SELECT nombre FROM clientes WHERE id = $1)))
     ON CONFLICT (cliente_id) DO UPDATE SET rfc = EXCLUDED.rfc`,
    [clienteId, rfc, nombre],
  );
}

export async function existeCodigo(
  cliente: PoolClient,
  codigo: string,
  excluirId?: number,
): Promise<boolean> {
  const filas = await consultar<{ existe: boolean }>(
    cliente,
    `SELECT EXISTS (
       SELECT 1 FROM clientes
        WHERE codigo_cliente = $1 AND ($2::BIGINT IS NULL OR id <> $2)
     ) AS existe`,
    [codigo, excluirId ?? null],
  );
  return filas[0]?.existe === true;
}
