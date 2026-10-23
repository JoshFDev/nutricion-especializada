import { describe, expect, it } from 'vitest';
import * as repo from '../../src/modules/facturacion/repositorio.js';
import { falsoCliente } from './ayuda/falsoCliente.js';

/**
 * El candado de la nota al facturar.
 *
 * No se prueba aqui el servicio entero: lo que tiene que quedar fijado es
 * que la consulta que lee la nota la bloquee. Sin el `FOR UPDATE`, dos
 * peticiones simultaneas pueden leer la misma nota libre y crear dos
 * facturas para la misma venta.
 */
describe('facturacion.repositorio.notaParaFactura', () => {
  it('bloquea la fila de la nota hasta el final de la transaccion', async () => {
    const db = falsoCliente().responder([
      {
        id: '7',
        cliente_id: '3',
        subtotal: '1250.00',
        estatus: 'pendiente',
        serie: 'A',
        folio_numero: 42,
      },
    ]);

    const nota = await repo.notaParaFactura(db.cliente, 7);

    expect(nota?.folio).toBe('A-42');
    expect(db.consultas[0]?.sql).toMatch(/FOR UPDATE OF n/);
  });
});
