import type { PoolClient } from 'pg';
import { consultar, consultarUno, contar } from '../../db/transaccion.js';
import type {
  ActualizarCliente,
  CrearCliente,
  ListarClientes,
} from './esquemas.js';
import type { ClienteFila, NotaResumenFila } from './modelo.js';

/**
 * Capa de datos: aqui vive el SQL y SOLO SQL.
 *
 * No conoce Express ni los errores de la aplicacion. Si una consulta
 * viola una restriccion, deja que Postgres lance y que el traductor de
 * errores de la capa superior la traduzca.
 */

const CAMPOS = `c.id, c.codigo_cliente, c.nombre, c.establo, c.especie_id,
                e.nombre AS especie, c.estatus, c.telefono, c.direccion,
                c.saldo_actual, c.creado_en, c.actualizado_en`;

const FROM_CLIENTES = `FROM clientes c
                       LEFT JOIN especies e ON e.id = c.especie_id`;

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
      `(c.nombre ILIKE $${valores.length} OR c.codigo_cliente ILIKE $${valores.length})`,
    );
  }
  if (q.estatus) {
    valores.push(q.estatus);
    condiciones.push(`c.estatus = $${valores.length}`);
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
    `SELECT count(*)::int AS total FROM clientes c ${donde}`,
    valores,
  );

  return { filas, total };
}

export async function obtenerPorId(
  cliente: PoolClient,
  id: number,
): Promise<ClienteFila | null> {
  return consultarUno<ClienteFila>(
    cliente,
    `SELECT ${CAMPOS} ${FROM_CLIENTES} WHERE c.id = $1`,
    [id],
  );
}

export async function listarNotas(cliente: PoolClient, clienteId: number): Promise<NotaResumenFila[]> {
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
                           estatus, telefono, direccion)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, codigo_cliente, nombre, establo, especie_id, estatus,
               telefono, direccion, saldo_actual, creado_en, actualizado_en`,
    [
      datos.codigo_cliente,
      datos.nombre,
      datos.establo ?? null,
      datos.especie_id ?? null,
      datos.estatus,
      datos.telefono ?? null,
      datos.direccion ?? null,
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
   * conocidas, y este set las filtra otra vez. Lo que se busca es que no
   * se pueda colar `saldo_actual`, que tiene un trigger que lo recalcula
   * y quedaria mal si alguien lo escribiera directo.
   */
  const permitidos = new Set([
    'codigo_cliente',
    'nombre',
    'establo',
    'especie_id',
    'estatus',
    'telefono',
    'direccion',
  ]);
  const seguros = campos.filter((c) => permitidos.has(c));
  if (seguros.length === 0) return null;

  const asignaciones = seguros.map((campo, i) => `${String(campo)} = $${i + 2}`);

  return consultarUno<ClienteFila>(
    cliente,
    `UPDATE clientes SET ${asignaciones.join(', ')}
      WHERE id = $1
      RETURNING id, codigo_cliente, nombre, establo, especie_id, estatus,
                telefono, direccion, saldo_actual, creado_en, actualizado_en`,
    [id, ...seguros.map((c) => datos[c] ?? null)],
  );
}

export async function eliminar(cliente: PoolClient, id: number): Promise<boolean> {
  const resultado = await cliente.query('DELETE FROM clientes WHERE id = $1', [id]);
  return (resultado.rowCount ?? 0) > 0;
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
