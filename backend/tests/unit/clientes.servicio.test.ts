import { describe, expect, it } from 'vitest';
import { Conflicto, NoEncontrado } from '../../src/core/errores.js';
import { crearClienteEsquema } from '../../src/modules/clientes/esquemas.js';
import * as clientes from '../../src/modules/clientes/servicio.js';
import { falsoCliente } from './ayuda/falsoCliente.js';

/**
 * Reglas de negocio del modulo de clientes, sin base de datos.
 *
 * El foco NO es el SQL (eso lo comprueban las pruebas de integracion
 * contra Postgres de verdad) sino las DECISIONES: que un duplicado sea
 * 409 y no 500, que un id inexistente sea 404 y no un null silencioso.
 */

const FILA = {
  id: 5,
  codigo_cliente: 'C-001',
  nombre: 'Granja El Roble',
  establo: 'Establo 1',
  especie_id: null,
  especie: null,
  estatus: 'Activo',
  telefono: null,
  direccion: null,
  saldo_actual: '1500.50',
  creado_en: new Date('2026-01-15T10:00:00Z'),
  actualizado_en: new Date('2026-01-15T10:00:00Z'),
};

const LISTA = { limite: 50, offset: 0 };

/**
 * Los datos de entrada se pasan por el esquema de Zod antes de llegar al
 * servicio, igual que hace el controlador. No es solo por el tipo: al
 * atravesar el esquema se aplican los valores por defecto (estatus
 * 'Activo') y las transformaciones (los opcionales quedan en null), que
 * es justo el objeto que el servicio espera recibir.
 */
const nuevoCliente = (datos: Record<string, unknown>) => crearClienteEsquema.parse(datos);

describe('listar', () => {
  it('devuelve los datos con la paginacion', async () => {
    const db = falsoCliente()
      .responder([FILA])
      .responder([{ total: 1 }]);

    const r = await clientes.listar(db.cliente, LISTA);

    expect(r.datos).toHaveLength(1);
    expect(r.paginacion).toEqual({ limite: 50, offset: 0, total: 1 });
  });

  it('devuelve una lista vacia sin fallar', async () => {
    const db = falsoCliente()
      .responder([])
      .responder([{ total: 0 }]);

    const r = await clientes.listar(db.cliente, LISTA);

    expect(r.datos).toEqual([]);
    expect(r.paginacion.total).toBe(0);
  });

  it('el saldo llega como numero, no como texto', async () => {
    const db = falsoCliente()
      .responder([FILA])
      .responder([{ total: 1 }]);

    const r = await clientes.listar(db.cliente, LISTA);

    // numeric viene como string desde pg para no perder precision. Si se
    // deja asi, el frontend tiene que hacer parseFloat en cada campo.
    // Ojo: el nombre publico sigue en snake_case (saldo_actual), lo que
    // cambia es el TIPO, de string a number.
    expect(r.datos[0]?.saldo_actual).toBe(1500.5);
    expect(typeof r.datos[0]?.saldo_actual).toBe('number');
  });

  it('los parametros del filtro SIEMPRE viajan parametrizados', async () => {
    const db = falsoCliente()
      .responder([])
      .responder([{ total: 0 }]);

    await clientes.listar(db.cliente, { ...LISTA, buscar: "'; DROP TABLE clientes; --" });

    const conFiltro = db.consultas[0];
    // El texto malicioso debe estar en los valores, jamas pegado en el
    // SQL. Esta es la prueba de que no hay concatenacion.
    expect(conFiltro?.sql).not.toContain('DROP TABLE');
    expect(conFiltro?.valores).toContain("%'; DROP TABLE clientes; --%");
  });
});

describe('obtener', () => {
  it('lanza 404 si el cliente no existe', async () => {
    const db = falsoCliente().responder([]);

    await expect(clientes.obtener(db.cliente, 999)).rejects.toBeInstanceOf(NoEncontrado);
  });

  it('trae el cliente con sus notas de remision', async () => {
    const db = falsoCliente()
      .responder([FILA])
      .responder([
        {
          id: 1,
          serie: 'A',
          folio_numero: 10,
          fecha: new Date('2026-02-01T12:00:00Z'),
          estatus: 'liquidada',
          subtotal: '800.00',
          pagado: '800.00',
        },
      ]);

    const r = await clientes.obtener(db.cliente, 5);

    expect(r.id).toBe(5);
    expect(r.notas).toHaveLength(1);
    expect(r.notas[0]?.saldo).toBe(0);
  });

  it('una nota sin pagos queda con el saldo completo', async () => {
    const db = falsoCliente()
      .responder([FILA])
      .responder([
        {
          id: 2,
          serie: 'A',
          folio_numero: 11,
          fecha: new Date('2026-02-02T12:00:00Z'),
          estatus: 'pendiente',
          subtotal: '300.00',
          pagado: '0',
        },
      ]);

    const r = await clientes.obtener(db.cliente, 5);

    expect(r.notas[0]?.saldo).toBe(300);
  });
});

describe('crear', () => {
  it('lanza 409 si el codigo ya existe', async () => {
    const db = falsoCliente().responder([{ existe: true }]);

    await expect(
      clientes.crear(db.cliente, nuevoCliente({ codigo_cliente: 'C-001', nombre: 'Otra granja' })),
    ).rejects.toBeInstanceOf(Conflicto);
  });

  it('no intenta el INSERT cuando el codigo esta duplicado', async () => {
    const db = falsoCliente().responder([{ existe: true }]);

    await clientes
      .crear(db.cliente, nuevoCliente({ codigo_cliente: 'C-001', nombre: 'Otra' }))
      .catch(() => undefined);

    // Si despues del chequeo hiciera el INSERT, la base lo rebotaria
    // con 23505. Es mejor no intentarlo y dar un mensaje claro.
    expect(db.consultas.some((c) => c.sql.includes('INSERT INTO clientes'))).toBe(false);
  });

  it('inserta y devuelve el cliente creado', async () => {
    const db = falsoCliente()
      .responder([{ existe: false }])
      .responder([FILA]);

    const r = await clientes.crear(
      db.cliente,
      nuevoCliente({ codigo_cliente: 'C-002', nombre: 'Granja Nueva' }),
    );

    expect(r.id).toBe(5);
    expect(r.nombre).toBe('Granja El Roble');
    expect(db.consultas.some((c) => c.sql.includes('datos_fiscales_cliente'))).toBe(false);
  });

  it('con rfc escribe el dato fiscal y lo devuelve en la respuesta', async () => {
    const db = falsoCliente()
      .responder([{ existe: false }])
      .responder([{ id: '5' }])
      .responder([])
      .responder([{ ...FILA, rfc: 'XAXX010101000', razon_social: 'Granja Nueva' }]);

    const r = await clientes.crear(
      db.cliente,
      nuevoCliente({ codigo_cliente: 'C-002', nombre: 'Granja Nueva', rfc: 'xaxx010101000' }),
    );

    // El INSERT de `clientes` no trae el rfc de vuelta (es otra tabla),
    // asi que la respuesta solo puede traerlo si hubo un releo.
    expect(r.rfc).toBe('XAXX010101000');

    const escritura = db.consultas.find((c) =>
      c.sql.includes('INSERT INTO datos_fiscales_cliente'),
    );
    expect(escritura?.sql).toContain('INSERT INTO datos_fiscales_cliente');
    // La razon social no se captura: se guarda con el nombre del cliente.
    expect(escritura?.valores).toEqual([5, 'XAXX010101000', 'Granja Nueva']);
  });
});

describe('actualizar', () => {
  it('lanza 404 si no existe', async () => {
    // Una sola respuesta: al no venir codigo_cliente, el servicio se
    // salta el chequeo de duplicado y va directo al UPDATE.
    const db = falsoCliente().responder([]);

    await expect(
      clientes.actualizar(db.cliente, 999, { nombre: 'Nuevo nombre' }),
    ).rejects.toBeInstanceOf(NoEncontrado);
  });

  it('rechaza cambiar el codigo a uno que ya usa otro cliente', async () => {
    const db = falsoCliente().responder([{ existe: true }]);

    await expect(
      clientes.actualizar(db.cliente, 5, { codigo_cliente: 'C-999' }),
    ).rejects.toBeInstanceOf(Conflicto);
  });

  it('permite guardar el mismo codigo del propio cliente', async () => {
    const db = falsoCliente()
      .responder([{ existe: false }])
      .responder([FILA]);

    const r = await clientes.actualizar(db.cliente, 5, { codigo_cliente: 'C-001' });

    // Si el chequeo no excluyera el id actual, un cliente no podria
    // guardar su propio codigo sin cambiarlo.
    expect(r.id).toBe(5);
  });

  it('un PATCH que solo trae rfc no lo manda al 404', async () => {
    // El UPDATE no toca ninguna columna de `clientes` y no devuelve fila:
    // sin este releo, "no cambio nada" se confundiria con "no existe".
    const db = falsoCliente()
      .responder([FILA])
      .responder([])
      .responder([{ ...FILA, rfc: 'XAXX010101000', razon_social: 'Granja El Roble' }]);

    const r = await clientes.actualizar(db.cliente, 5, { rfc: 'XAXX010101000' });

    expect(r.rfc).toBe('XAXX010101000');
    const escritura = db.consultas.find((c) =>
      c.sql.includes('INSERT INTO datos_fiscales_cliente'),
    );
    expect(escritura?.sql).toContain('INSERT INTO datos_fiscales_cliente');
    // La razon social que ya existia se conserva: solo se cambia el rfc.
    expect(escritura?.sql).toContain('DO UPDATE SET rfc = EXCLUDED.rfc');
  });

  it('un rfc en null borra el dato fiscal', async () => {
    const db = falsoCliente()
      .responder([FILA])
      .responder([])
      .responder([{ ...FILA, rfc: null, razon_social: null }]);

    const r = await clientes.actualizar(db.cliente, 5, { rfc: null });

    expect(r.rfc).toBeNull();
    expect(db.consultas.some((c) => c.sql.includes('DELETE FROM datos_fiscales_cliente'))).toBe(
      true,
    );
  });

  it('con rfc inexistente no escribe en datos fiscales', async () => {
    // Si el cliente no existe, el rfc no se puede colar en una tabla que
    // exige que su fila de clientes exista.
    const db = falsoCliente().responder([]);

    await expect(
      clientes.actualizar(db.cliente, 999, { rfc: 'XAXX010101000' }),
    ).rejects.toBeInstanceOf(NoEncontrado);
    expect(db.consultas.some((c) => c.sql.includes('INSERT INTO datos_fiscales_cliente'))).toBe(
      false,
    );
  });
});

describe('eliminar', () => {
  it('lanza 404 si no habia nada que borrar', async () => {
    // Dos consultas: primero datos fiscales y despues el cliente.
    const db = falsoCliente().responderConCambios(0).responderConCambios(0);

    await expect(clientes.eliminar(db.cliente, 999)).rejects.toBeInstanceOf(NoEncontrado);
  });

  it('no falla si si habia', async () => {
    const db = falsoCliente().responderConCambios(0).responderConCambios(1);

    await expect(clientes.eliminar(db.cliente, 5)).resolves.toBeUndefined();
  });

  it('borra los datos fiscales ANTES del cliente', async () => {
    // La FK de `datos_fiscales_cliente` no trae ON DELETE CASCADE: si el
    // dato fiscal se borrara despues (o no se borrara), un cliente con rfc
    // no se podria eliminar y saldria un 409 de "esta en uso".
    const db = falsoCliente().responderConCambios(1).responderConCambios(1);

    await clientes.eliminar(db.cliente, 5);

    expect(db.consultas[0]?.sql).toContain('DELETE FROM datos_fiscales_cliente');
    expect(db.consultas[1]?.sql).toContain('DELETE FROM clientes');
  });
});
