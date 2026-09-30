import type { PoolClient } from 'pg';
import { contar, consultar, consultarUno } from '../../db/transaccion.js';
import { fechaComoTexto } from '../../core/valores.js';
import type { CrearTalonario, ListarFolios, ListarNotas } from './esquemas.js';
import type {
  ClienteImprimible,
  EstatusNota,
  FilaNota,
  FilaRenglon,
  Folio,
  Listado,
  NotaListada,
} from './modelo.js';

/**
 * SQL de notas de remision.
 *
 * Todos los valores van como parametro. Lo unico que se interpola en el
 * texto son nombres de columna, de tabla y de funcion escritos aqui mismo.
 *
 * Lo que este repositorio NO hace, y es lo importante: nada de esto
 * duplica lo que ya hace la base. El folio se quema solo (`fn_controlar_folio`),
 * el subtotal se recalcula solo (`fn_recalcular_subtotal_nota`), el
 * inventario entra y sale solo (`fn_sincronizar_inventario_venta`) y el
 * saldo del cliente se recalcula solo (`fn_actualizar_saldo_cliente`).
 * Reescribir eso aqui seria una segunda implementacion de la misma regla,
 * y las dos se desincronizan en cuanto una cambia.
 */

/**
 * La cabecera con los nombres que la pantalla necesita.
 *
 * `cliente` y `vendedor` van en el SELECT y no se resuelven aparte porque
 * una lista de notas sin nombre de cliente es una tabla de numeros: quien
 * la mira esta buscando "las de Don Chema", no "las del cliente 7".
 */
const COLUMNAS_NOTA = `
  n.id, n.folio_id, n.cliente_id, n.vendedor_id, n.fecha,
  n.direccion_entrega, n.subtotal, n.estatus, n.motivo_cancelacion,
  n.creado_en, n.actualizado_en,
  f.folio_numero, f.serie,
  c.nombre AS cliente_nombre,
  v.nombre AS vendedor_nombre
`;

const FROM_NOTA = `
  FROM notas_remision n
  JOIN folios f       ON f.id = n.folio_id
  JOIN clientes c     ON c.id = n.cliente_id
  LEFT JOIN usuarios v ON v.id = n.vendedor_id
`;

const COLUMNAS_RENGLON = `
  d.id, d.nota_id, d.producto_id, d.almacen_id,
  d.cantidad_bultos, d.kg_bulto, d.precio_unit_kg, d.subtotal,
  pr.codigo AS producto_codigo, pr.nombre AS producto_nombre,
  a.nombre  AS almacen_nombre
`;

const FROM_RENGLON = `
  FROM nota_remision_detalle d
  JOIN productos pr ON pr.id = d.producto_id
  JOIN almacenes  a  ON a.id = d.almacen_id
`;

/**
 * `orden(0, 'fecha', 'DESC')` y cosas asi, para no repetir el mismo
 * `ORDER BY` con los mismos indices en cinco consultas.
 */
const orden = (campo: string, direccion: 'ASC' | 'DESC'): string =>
  `ORDER BY n.${campo} ${direccion}, n.id ${direccion}`;

const construirFiltro = (q: ListarNotas) => {
  const valores: unknown[] = [];
  const condiciones: string[] = [];

  if (q.cliente_id !== undefined) {
    valores.push(q.cliente_id);
    condiciones.push(`n.cliente_id = $${valores.length}`);
  }

  if (q.vendedor_id !== undefined) {
    valores.push(q.vendedor_id);
    condiciones.push(`n.vendedor_id = $${valores.length}`);
  }

  if (q.estatus !== undefined) {
    valores.push(q.estatus);
    condiciones.push(`n.estatus = $${valores.length}`);
  }

  if (q.periodo === 'hoy') {
    // `CURRENT_DATE` y no una fecha que mande el frontend. Ver
    // `periodosEsquema` en `esquemas.ts`: la fecha de la nota la decide la
    // base, asi que el filtro tiene que decidirla la misma base o al final
    // del dia la nota que se acaba de capturar no aparece donde se capturo.
    condiciones.push('n.fecha = CURRENT_DATE');
  } else if (q.periodo === 'ultimos_7') {
    // Siete dias INCLUDING hoy: son hoy y los seis anteriores. Con
    // `INTERVAL '7 days'` seria hoy y siete, y el nombre del filtro diria
    // una cosa y el listado otra.
    condiciones.push("n.fecha >= CURRENT_DATE - INTERVAL '6 days'");
  }

  if (q.desde !== undefined) {
    valores.push(q.desde);
    condiciones.push(`n.fecha >= $${valores.length}::date`);
  }

  if (q.hasta !== undefined) {
    valores.push(q.hasta);
    condiciones.push(`n.fecha <= $${valores.length}::date`);
  }

  // El folio completo ("A-1001") y el nombre del cliente. Se busca con
  // ILIKE y no con `=`: el operador escribe "1001" sin la serie la mitad
  // de las veces, y exigirle la serie exacta lo hace escribir "A-1001" a mano.
  if (q.buscar !== undefined) {
    valores.push(`%${q.buscar}%`);
    condiciones.push(
      `(f.folio_numero::TEXT ILIKE $${valores.length}
        OR CONCAT(f.serie, '-', f.folio_numero) ILIKE $${valores.length}
        OR c.nombre ILIKE $${valores.length})`,
    );
  }

  return {
    valores,
    donde: condiciones.length > 0 ? `WHERE ${condiciones.join('\n    AND ')}` : '',
  };
};

export async function listar(cliente: PoolClient, q: ListarNotas): Promise<Listado<NotaListada>> {
  const { valores, donde } = construirFiltro(q);

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total
     FROM notas_remision n
     JOIN folios f   ON f.id = n.folio_id
     JOIN clientes c ON c.id = n.cliente_id
     ${donde}`,
    valores,
  );

  /**
   * `count(*)::TEXT` y no `count(*)`: `contar()` hace `Number()`, y con
   * mas de 2^53 notas eso no es un numero, es una aproximacion. Aqui
   * todavia no, pero el mismo helper se usa en `total` de todos los
   * listados y conviene que la cuenta venga exacta.
   */
  const filas = await consultar<{
    id: string;
    folio_numero: number;
    serie: string;
    cliente_id: string;
    cliente_nombre: string;
    vendedor_nombre: string | null;
    fecha: string;
    subtotal: string;
    estatus: EstatusNota;
    renglones: string;
  }>(
    cliente,
    `SELECT n.id, n.cliente_id, n.fecha, n.subtotal, n.estatus,
            f.folio_numero, f.serie,
            c.nombre AS cliente_nombre,
            v.nombre AS vendedor_nombre,
            (SELECT count(*) FROM nota_remision_detalle d WHERE d.nota_id = n.id)::TEXT AS renglones
     ${FROM_NOTA}
     ${donde}
     ${orden('fecha', 'DESC')}
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      folio: `${f.serie}-${f.folio_numero}`,
      cliente_id: Number(f.cliente_id),
      cliente: f.cliente_nombre,
      vendedor: f.vendedor_nombre,
      fecha: fechaComoTexto(f.fecha),
      subtotal: Number(f.subtotal),
      estatus: f.estatus,
      renglones: Number(f.renglones),
    })),
    total: Number(total),
    limite: q.limite,
    offset: q.offset,
  };
}

export async function consultarNota(cliente: PoolClient, id: number): Promise<FilaNota | null> {
  return consultarUno<FilaNota>(cliente, `SELECT ${COLUMNAS_NOTA} ${FROM_NOTA} WHERE n.id = $1`, [
    id,
  ]);
}

/**
 * Los datos del cliente que salen impresos en el PDF.
 *
 * Consulta aparte y no una columna mas de `COLUMNAS_NOTA` a proposito: el
 * nombre del cliente viaja ya en la cabecera, y unir tambien su telefono,
 * establo y datos fiscales a las consultas de pantalla cargaria tres tablas
 * mas (especies y datos_fiscales_cliente) en cada listado de notas para
 * datos que el listado no usa. Esto solo se ejecuta cuando alguien pide
 * el PDF.
 *
 * `datos_fiscales_cliente` entra por LEFT JOIN porque es opcional: un
 * cliente que nunca ha pedido factura no tiene fila, y una remision sin RFC
 * es una remision valida, no un error.
 */
export async function consultarClienteImprimible(
  cliente: PoolClient,
  clienteId: number,
): Promise<ClienteImprimible | null> {
  const fila = await consultarUno<{
    nombre: string;
    codigo_cliente: string | null;
    telefono: string | null;
    direccion: string | null;
    establo: string | null;
    especie: string | null;
    rfc: string | null;
    razon_social: string | null;
  }>(
    cliente,
    `SELECT c.nombre,
            c.codigo_cliente, c.telefono, c.direccion, c.establo,
            e.nombre AS especie,
            f.rfc, f.razon_social
       FROM clientes c
       LEFT JOIN especies e               ON e.id = c.especie_id
       LEFT JOIN datos_fiscales_cliente f ON f.cliente_id = c.id
      WHERE c.id = $1`,
    [clienteId],
  );
  if (!fila) return null;

  return {
    nombre: fila.nombre,
    codigo: fila.codigo_cliente,
    telefono: fila.telefono,
    direccion: fila.direccion,
    establo: fila.establo,
    especie: fila.especie,
    rfc: fila.rfc,
    razon_social: fila.razon_social,
  };
}

/**
 * Renglones de la nota, del mas reciente al mas viejo.
 *
 * El orden es por id y no por producto: el detalle de una nota es un
 * documento que se lee como se capturo, y reordenar renglones cada vez que
 * uno cambia haria que la fila que estas editando se moviera sola debajo
 * del cursor.
 */
export async function listarRenglones(cliente: PoolClient, notaId: number): Promise<FilaRenglon[]> {
  return consultar<FilaRenglon>(
    cliente,
    `SELECT ${COLUMNAS_RENGLON} ${FROM_RENGLON} WHERE d.nota_id = $1 ORDER BY d.id`,
    [notaId],
  );
}

/**
 * El folio disponible mas bajo de la serie.
 *
 * Se elige el mas bajo y no el mas alto a propósito: si hay huecos (un
 * folio cancelado, uno devuelto), el talonario se llena en orden y un
 * hueco se nota cuando se busca, en vez de dejar un numero perdido en
 * medio de la numeracion que nadie recuerda.
 *
 * `FOR UPDATE` porque dos cajas cobrando a la vez leen el mismo folio
 * disponible. Sin el candado, las dos ven el 1002, las dos lo insertan y
 * una se come un 23505 de `notas_remision_folio_id_key`; con el, la
 * segunda espera a que la primera confirme y ya no lo ve disponible.
 *
 * El trigger `fn_controlar_folio` hace la validacion final y quema el
 * folio. Esto no lo reemplaza: solo evita que dos peticiones compitan por
 * el mismo numero.
 */
export async function tomarFolioDisponible(cliente: PoolClient, serie: string): Promise<number> {
  const fila = await consultarUno<{ id: string }>(
    cliente,
    `SELECT id
     FROM folios
     WHERE serie = $1 AND estatus = 'disponible'
     ORDER BY folio_numero
     LIMIT 1
     FOR UPDATE`,
    [serie],
  );
  return fila ? Number(fila.id) : 0;
}

export async function insertarCabecera(
  cliente: PoolClient,
  d: {
    folio_id: number;
    cliente_id: number;
    vendedor_id: number;
    fecha: string;
    direccion_entrega: string | null;
  },
): Promise<number> {
  const fila = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO notas_remision (folio_id, cliente_id, vendedor_id, fecha, direccion_entrega)
     VALUES ($1, $2, $3, $4::date, $5)
     RETURNING id`,
    [d.folio_id, d.cliente_id, d.vendedor_id, d.fecha, d.direccion_entrega],
  );
  return Number(fila?.id ?? 0);
}

/**
 * Edita la cabecera. Sin `subtotal` y sin `estatus`.
 *
 * `subtotal` lo recalcula el trigger al tocar cualquier renglon, y
 * `estatus` lo mueven los pagos o la cancelacion. Escribirlos aqui abriria
 * la puerta a que el API dijera que una nota vale otra cosa de la que
 * dicen sus renglones.
 */
export async function actualizarCabecera(
  cliente: PoolClient,
  id: number,
  d: { cliente_id?: number; fecha?: string; direccion_entrega?: string | null },
): Promise<boolean> {
  const valores: unknown[] = [];
  const asignaciones: string[] = [];

  if (d.cliente_id !== undefined) {
    valores.push(d.cliente_id);
    asignaciones.push(`cliente_id = $${valores.length}`);
  }
  if (d.fecha !== undefined) {
    valores.push(d.fecha);
    asignaciones.push(`fecha = $${valores.length}::date`);
  }
  if (d.direccion_entrega !== undefined) {
    valores.push(d.direccion_entrega);
    asignaciones.push(`direccion_entrega = $${valores.length}`);
  }

  if (asignaciones.length === 0) return false;

  valores.push(id);
  const r = await consultar<{ id: string }>(
    cliente,
    `UPDATE notas_remision
        SET ${asignaciones.join(', ')}
      WHERE id = $${valores.length}
      RETURNING id`,
    valores,
  );
  return r.length > 0;
}

export async function insertarRenglon(
  cliente: PoolClient,
  d: {
    nota_id: number;
    producto_id: number;
    almacen_id: number;
    cantidad_bultos: string;
    kg_bulto: string | null;
    precio_unit_kg: string;
  },
): Promise<number> {
  const fila = await consultarUno<{ id: string }>(
    cliente,
    `INSERT INTO nota_remision_detalle
       (nota_id, producto_id, almacen_id, cantidad_bultos, kg_bulto, precio_unit_kg)
     VALUES ($1, $2, $3, $4, COALESCE($5::numeric, NULL), $6)
     RETURNING id`,
    [d.nota_id, d.producto_id, d.almacen_id, d.cantidad_bultos, d.kg_bulto, d.precio_unit_kg],
  );
  return Number(fila?.id ?? 0);
}

export async function actualizarRenglon(
  cliente: PoolClient,
  id: number,
  notaId: number,
  d: {
    producto_id: number;
    almacen_id: number;
    cantidad_bultos: string;
    kg_bulto: string | null;
    precio_unit_kg: string;
  },
): Promise<boolean> {
  const r = await consultar<{ id: string }>(
    cliente,
    `UPDATE nota_remision_detalle
        SET producto_id = $1, almacen_id = $2, cantidad_bultos = $3,
            kg_bulto = COALESCE($4::numeric, NULL), precio_unit_kg = $5
      WHERE id = $6 AND nota_id = $7
      RETURNING id`,
    [d.producto_id, d.almacen_id, d.cantidad_bultos, d.kg_bulto, d.precio_unit_kg, id, notaId],
  );
  return r.length > 0;
}

/**
 * Borrar un renglon.
 *
 * Es el unico DELETE del modulo y aun asi no es "borrar una nota": la nota
 * sigue, y el renglon disappears con su movimiento de inventario (el
 * trigger `trg_inventario_venta` lo borra en AFTER DELETE y el kardoex
 * queda como estaba antes de la correccion). Por eso se puede en una nota
 * que aun no esta pagada, y por eso el trigger de 0008 lo prohibe en una
 * que si lo esta.
 */
export async function borrarRenglon(
  cliente: PoolClient,
  id: number,
  notaId: number,
): Promise<boolean> {
  const r = await consultar<{ id: string }>(
    cliente,
    `DELETE FROM nota_remision_detalle WHERE id = $1 AND nota_id = $2 RETURNING id`,
    [id, notaId],
  );
  return r.length > 0;
}

/**
 * Existencia actual, producto en almacen.
 *
 * La misma formula que `fn_verificar_stock` (0001), a proposito: si el
 * servicio contara distinto que el trigger, habria dos verdades y la
 * alerta de stock negativo diria una cosa mientras el rechazo dice otra.
 *
 * `existencia()` trae tambien si el producto esta activo, para no hacer dos
 * consultas por renglon.
 */
export async function existencia(
  cliente: PoolClient,
  productoId: number,
  almacenId: number,
): Promise<{ existencia: number; productoActivo: boolean } | null> {
  const fila = await consultarUno<{ existencia: string; producto_activo: boolean }>(
    cliente,
    `SELECT pr.activo AS producto_activo,
            COALESCE((
              SELECT SUM(
                       CASE WHEN m.tipo IN ('entrada_compra','ajuste_positivo')
                            THEN m.cantidad_bultos
                            ELSE -m.cantidad_bultos END)
                FROM inventario_movimientos m
               WHERE m.producto_id = $1 AND m.almacen_id = $2
            ), 0)::TEXT AS existencia
     FROM productos pr
     WHERE pr.id = $1`,
    [productoId, almacenId],
  );
  if (!fila) return null;
  return { existencia: Number(fila.existencia), productoActivo: fila.producto_activo };
}

/**
 * Candado por producto y almacen, hasta que termine la transaccion.
 *
 * El chequeo de existencia es "leer la suma, compararla con lo que vas a
 * descontar", y entre una cosa y la otra cabe otra peticion. Dos cajas
 * vendiendo 10 bultos de un producto que tiene 12 las dos pasan el chequeo
 * y las dos escriben: 20 sales de un almacen con 12. El trigger
 * `fn_verificar_stock` no lo evita, porque solo genera una alerta.
 *
 * `pg_advisory_xact_lock` con dos claves seria lo mas limpio, pero
 * `producto_id` es BIGINT y la variante de dos argumentos toma int4, asi
 * que un producto con id de mas de 2 mil millones no cabria. Con una sola
 * clave hay que hashear, y `hashtext` es de 32 bits: la probabilidad de
 * que dos productos distintos compartan candado es bajisima, y cuando la
 * hay solo se serializan entre si, no se rompen. Eso si es un bug de
 * concurrencia; lo otro serian ventas que no cuadran.
 *
 * El candado dura hasta el COMMIT, que es justo lo que se necesita: se
 * toma antes de leer la existencia y se suelta al confirmar.
 */
export async function candearProductoAlmacen(
  cliente: PoolClient,
  productoId: number,
  almacenId: number,
): Promise<void> {
  await cliente.query('SELECT pg_advisory_xact_lock(hashtext($1)::BIGINT)', [
    `nota:${productoId}:${almacenId}`,
  ]);
}

export async function clienteExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const fila = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM clientes WHERE id = $1`,
    [id],
  );
  return fila !== null;
}

export async function almacenExiste(cliente: PoolClient, id: number): Promise<boolean> {
  const fila = await consultarUno<{ ok: boolean }>(
    cliente,
    `SELECT TRUE AS ok FROM almacenes WHERE id = $1`,
    [id],
  );
  return fila !== null;
}

/** El estado de la nota, para las reglas de edicion. */
export async function estatusDe(cliente: PoolClient, id: number): Promise<EstatusNota | null> {
  const fila = await consultarUno<{ estatus: EstatusNota }>(
    cliente,
    `SELECT estatus FROM notas_remision WHERE id = $1`,
    [id],
  );
  return fila?.estatus ?? null;
}

export async function cancelar(cliente: PoolClient, id: number, motivo: string): Promise<boolean> {
  const r = await consultar<{ id: string }>(
    cliente,
    `UPDATE notas_remision
        SET estatus = 'cancelada', motivo_cancelacion = $2
      WHERE id = $1 AND estatus <> 'cancelada'
      RETURNING id`,
    [id, motivo],
  );
  return r.length > 0;
}

// =====================================================================
// FOLIOS
// =====================================================================

const COLUMNAS_FOLIO = `
  f.id, f.serie, f.folio_numero, f.estatus, n.id AS nota_id
`;

export async function listarFolios(cliente: PoolClient, q: ListarFolios): Promise<Listado<Folio>> {
  const valores: unknown[] = [];
  const condiciones: string[] = [];
  if (q.serie !== undefined) {
    valores.push(q.serie);
    condiciones.push(`f.serie = $${valores.length}`);
  }
  if (q.estatus !== undefined) {
    valores.push(q.estatus);
    condiciones.push(`f.estatus = $${valores.length}`);
  }
  const donde = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

  const total = await contar(
    cliente,
    `SELECT count(*)::TEXT AS total FROM folios f ${donde}`,
    valores,
  );

  const filas = await consultar<{
    id: string;
    serie: string;
    folio_numero: number;
    estatus: 'disponible' | 'usado' | 'cancelado';
    nota_id: string | null;
  }>(
    cliente,
    `SELECT ${COLUMNAS_FOLIO}
     FROM folios f
     LEFT JOIN notas_remision n ON n.folio_id = f.id
     ${donde}
     ORDER BY f.serie, f.folio_numero
     LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, q.limite, q.offset],
  );

  return {
    datos: filas.map((f) => ({
      id: Number(f.id),
      serie: f.serie,
      folio_numero: f.folio_numero,
      completo: `${f.serie}-${f.folio_numero}`,
      estatus: f.estatus,
      nota_id: f.nota_id === null ? null : Number(f.nota_id),
    })),
    total: Number(total),
    limite: q.limite,
    offset: q.offset,
  };
}

/**
 * Que folios del rango pedido ya existen.
 *
 * Se pregunta antes de insertar para poder decir "el 1002 ya existe" en
 * lugar de reventar con un 23505 de clave primaria. Un `ON CONFLICT DO
 * NOTHING` lo resolveria, pero el mensaje de error es el que leen los
 * que van a capturar las mil notas, y "ya existen 3 de los 500" dice mucho
 * mas que "duplicate key".
 */
export async function foliosExistentesEnRango(
  cliente: PoolClient,
  serie: string,
  desde: number,
  hasta: number,
): Promise<number[]> {
  const filas = await consultar<{ folio_numero: number }>(
    cliente,
    `SELECT folio_numero FROM folios
     WHERE serie = $1 AND folio_numero BETWEEN $2 AND $3
     ORDER BY folio_numero`,
    [serie, desde, hasta],
  );
  return filas.map((f) => f.folio_numero);
}

export async function insertarFolios(cliente: PoolClient, d: CrearTalonario): Promise<number> {
  /**
   * generate_series en vez de un INSERT por numero: 5000 folios son 5000
   * viajes de ida y vuelta si se hace en JS, y el limite de 1mb de
   * Express no aplica pero el tiempo de espera si.
   *
   * `ON CONFLICT DO NOTHING` es lo que hace esto idempotente y le da lo que
   * el Administrador pidio: cargar un rango que pisa folios que ya existen
   * inserta los que faltan y no el error 23505. Sin esto, recargar el
   * talonario del 2001 al 2010 cuando ya existe el 2005 reventaba con un
   * duplicate key, y la API no tiene forma de decir "de estos 10, 6 ya
   * estaban".
   *
   * El conteo va en un SELECT sobre el RETURNING, no con `RETURNING 1`:
   * eso trae UNA fila por folio insertado, y leer la primera con
   * `consultarUno` devolvia `creados: 1` sin importar cuantos se
   * hubieran creado. El administrador que carga 500 folios recibia la
   * respuesta de que se habia creado uno.
   */
  const r = await consultarUno<{ total: string }>(
    cliente,
    `WITH nuevos AS (
       SELECT generate_series($2::int, $3::int) AS folio_numero
     ), insertados AS (
       INSERT INTO folios (serie, folio_numero, estatus)
       SELECT $1, folio_numero, 'disponible' FROM nuevos
       ON CONFLICT (serie, folio_numero) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::TEXT AS total FROM insertados`,
    [d.serie, d.desde, d.hasta],
  );
  return Number(r?.total ?? 0);
}
