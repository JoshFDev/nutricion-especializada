import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso, requiereSesion } from '../../middleware/sesion.js';
import { noEncontrado } from '../../middleware/errores.js';

export const rutasClientes = Router();

/**
 * Los nombres de columna NO se inventan: salen de la tabla `clientes` de
 * 0001_init.sql. Notar que no hay `rfc`, `email`, `limite_credito` ni
 * `activo`: el estatus va como texto ('Activo'/'Inactivo') y el saldo lo
 * mantiene un trigger.
 */
const esquemaCliente = z.object({
  codigo_cliente: z.string().trim().min(1, 'El codigo es obligatorio').max(40),
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  establo: z.string().trim().max(200).nullish(),
  especie_id: z.coerce.number().int().positive().nullish(),
  estatus: z.enum(['Activo', 'Inactivo']).default('Activo'),
  telefono: z.string().trim().max(40).nullish(),
  direccion: z.string().trim().max(400).nullish(),
});

const esquemaActualizacion = esquemaCliente.partial();

const columnas = `c.id, c.codigo_cliente, c.nombre, c.establo, c.especie_id,
                  e.nombre AS especie, c.estatus, c.telefono, c.direccion,
                  c.saldo_actual, c.creado_en, c.actualizado_en`;

/** GET /api/clientes?buscar=...&limite=...&offset=...&estatus=... */
rutasClientes.get('/', requiereSesion, async (req, res) => {
  const q = z
    .object({
      buscar: z.string().trim().min(1).optional(),
      estatus: z.enum(['Activo', 'Inactivo']).optional(),
      limite: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    })
    .parse(req.query);

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

  const filtro = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';
  valores.push(q.limite, q.offset);

  const { rows } = await req.db.query(
    `SELECT ${columnas}
       FROM clientes c
       LEFT JOIN especies e ON e.id = c.especie_id
       ${filtro}
      ORDER BY c.nombre
      LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
    valores,
  );

  // Cuantos hay en total con el mismo filtro, para la paginacion.
  const { rows: conteo } = await req.db.query(
    `SELECT count(*)::int AS total
       FROM clientes c
       ${condiciones.length > 0 ? filtro.replace(/c\./g, 'c.') : ''}`,
    valores.slice(0, valores.length - 2),
  );

  res.json({
    datos: rows,
    paginacion: { limite: q.limite, offset: q.offset, total: conteo[0]?.total ?? 0 },
  });
});

/** GET /api/clientes/:id — con su historial de notas de remisión. */
rutasClientes.get('/:id', requiereSesion, async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);

  const { rows } = await req.db.query(
    `SELECT ${columnas}
       FROM clientes c
       LEFT JOIN especies e ON e.id = c.especie_id
      WHERE c.id = $1`,
    [id],
  );

  const cliente = rows[0];
  if (!cliente) throw noEncontrado(`No existe el cliente ${id}`);

  const { rows: notas } = await req.db.query(
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
    [id],
  );

  res.json({
    ...cliente,
    notas: notas.map((n) => ({
      ...n,
      saldo: Number(n.subtotal) - Number(n.pagado),
    })),
  });
});

/** POST /api/clientes */
rutasClientes.post('/', requierePermiso('clientes.crear'), async (req, res) => {
  const datos = esquemaCliente.parse(req.body);
  const { rows } = await req.db.query(
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
  res.status(201).json(rows[0]);
});

/** PATCH /api/clientes/:id */
rutasClientes.patch('/:id', requierePermiso('clientes.editar'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const datos = esquemaActualizacion.parse(req.body);

  const campos = Object.keys(datos) as (keyof typeof datos)[];
  if (campos.length === 0) {
    throw noEncontrado('No enviaste ningun campo para actualizar');
  }

  // Los nombres de columna se citan como identificadores, nunca como
  // valores. Que vengan de un zod con allowlist es lo que impide que un
  // cliente puts "saldo_actual=0" y se salte el trigger del saldo.
  const asignaciones = campos.map((campo, i) => `${String(campo)} = $${i + 2}`);
  const { rows } = await req.db.query(
    `UPDATE clientes SET ${asignaciones.join(', ')}
      WHERE id = $1
      RETURNING id, codigo_cliente, nombre, establo, especie_id, estatus,
                telefono, direccion, saldo_actual, creado_en, actualizado_en`,
    [id, ...campos.map((c) => datos[c] ?? null)],
  );

  if (rows.length === 0) throw noEncontrado(`No existe el cliente ${id}`);
  res.json(rows[0]);
});

/** DELETE /api/clientes/:id */
rutasClientes.delete('/:id', requierePermiso('clientes.eliminar'), async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const { rowCount } = await req.db.query('DELETE FROM clientes WHERE id = $1', [id]);
  if (rowCount === 0) throw noEncontrado(`No existe el cliente ${id}`);
  res.status(204).end();
});
