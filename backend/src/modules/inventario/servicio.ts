import type { PoolClient } from 'pg';
import { enTransaccionDe } from '../../db/transaccion.js';
import { ErrorValidacion, NoEncontrado, ReglaNegocio } from '../../core/errores.js';
import type { CrearMovimiento, ListarExistencia, ListarMovimientos } from './esquemas.js';
import type { Existencia, Listado, Movimiento } from './modelo.js';
import * as repo from './repositorio.js';

/**
 * Inventario: la existencia, y ahora los movimientos manuales.
 *
 * La existencia se sigue leyendo igual: una compra entra 40 bultos y el
 * operador tiene que poder VERLOS, no creer que entraron porque el sistema
 * lo dijo.
 *
 * Ajustar y mermar ya tienen sus endpoints. La base hace lo pesado — antes y
 * despues en `auditoria_inventario`, la alerta de stock negativo, la "foto"
 * semanal — y aqui solo queda lo que la base no puede saber: que el producto
 * y el almacen existan, y que solo se borren los manuales. Los movimientos
 * de COMPRA y VENTA no se borran: los escribe el trigger de su documento, y
 * borrarlos a mano desfasaría el stock de una compra o una nota que siguen
 * vivas.
 */

export async function listarExistencia(
  cliente: PoolClient,
  q: ListarExistencia,
): Promise<Listado<Existencia>> {
  return repo.listarExistencia(cliente, q);
}

/** El kardex de un producto y almacen, con compras, ventas, ajustes y mermas. */
export async function listarMovimientos(
  cliente: PoolClient,
  q: ListarMovimientos,
): Promise<Listado<Movimiento>> {
  return repo.listarMovimientos(cliente, q);
}

export async function crearMovimiento(
  cliente: PoolClient,
  d: CrearMovimiento,
): Promise<Movimiento> {
  return enTransaccionDe(cliente, async (c) => {
    // El mensaje con el nombre del campo, no un 23503 a la cara del operador.
    if (!(await repo.productoExiste(c, d.producto_id))) {
      throw new ErrorValidacion(`El producto ${d.producto_id} no existe`, [
        { campo: 'producto_id', problema: `El producto ${d.producto_id} no existe` },
      ]);
    }
    if (!(await repo.almacenExiste(c, d.almacen_id))) {
      throw new ErrorValidacion(`El almacen ${d.almacen_id} no existe`, [
        { campo: 'almacen_id', problema: `El almacen ${d.almacen_id} no existe` },
      ]);
    }

    // Un ajuste que baja mas de lo que hay deja el stock en negativo. Como
    // las ventas, se PERMITE (avisa, no bloquea): una merma de 5 bultos
    // cuando el conteo dice 3 es real y hay que poder capturarla; bloquearla
    // haria que el operador inventara otra cosa para que el sistema dejara.
    const id = await repo.crearMovimiento(c, d);

    // Se relee y no se arma con lo enviado: la fecha la puso la base.
    const fila = await repo.consultarMovimiento(c, id);
    if (!fila) throw new Error('El INSERT de movimiento no devolvio fila');
    return repo.mapearMovimiento(fila);
  });
}

export async function eliminarMovimiento(cliente: PoolClient, id: number): Promise<void> {
  await enTransaccionDe(cliente, async (c) => {
    const fila = await repo.consultarMovimiento(c, id);
    if (!fila) throw new NoEncontrado('Ese movimiento no existe');

    if (fila.referencia_tabla !== null) {
      throw new ReglaNegocio(
        'MOVIMIENTO_NO_MANUAL',
        'Ese movimiento lo generó una compra o una venta y no se puede borrar',
        { id },
      );
    }

    const ok = await repo.borrarMovimientoManual(c, id);
    if (!ok) throw new NoEncontrado('Ese movimiento no existe');
  });
}
