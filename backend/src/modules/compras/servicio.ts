import type { PoolClient } from 'pg';
import { consultarUno, enTransaccionDe } from '../../db/transaccion.js';
import { Conflicto, ErrorValidacion, NoEncontrado, ReglaNegocio } from '../../core/errores.js';
import type { Compra, CompraListada, Listado, RenglonCompra } from './modelo.js';
import { mapearCompra, mapearRenglonCompra } from './modelo.js';
import type { CrearCompra, ListarCompras, RenglonCompra as RenglonEntrada } from './esquemas.js';
import * as repo from './repositorio.js';

/**
 * Reglas de compras.
 *
 * La base ya mueve el inventario, recalcula el total, deja el kg por bulto
 * y revierte todo al cancelar. Lo que no puede saber ella es de quien es
 * cada renglon, y eso lo sabe el servicio.
 */

/** Como queda un renglon con el precio ya resuelto. */
interface RenglonListo {
  producto_id: number;
  almacen_id: number;
  cantidad_bultos: string;
  kg_bulto: string | null;
  precio_kg: string;
}

export async function listar(
  cliente: PoolClient,
  q: ListarCompras,
): Promise<Listado<CompraListada>> {
  return repo.listar(cliente, q);
}

export async function consultar(cliente: PoolClient, id: number): Promise<Compra> {
  return leer(cliente, id);
}

export async function crear(cliente: PoolClient, d: CrearCompra): Promise<Compra> {
  return enTransaccionDe(cliente, async (c) => {
    const prov = await repo.proveedorExiste(c, d.proveedor_id);
    if (!prov.existe) {
      throw new ErrorValidacion(`El proveedor ${d.proveedor_id} no existe`, [
        { campo: 'proveedor_id', problema: `El proveedor ${d.proveedor_id} no existe` },
      ]);
    }
    // 409 y no 422: el proveedor esta dado de baja, que es un ESTADO, no un
    // dato que venga mal. Es la misma distincion que aplica en pagos con
    // NOTA_YA_COBRADA, y el motivo va en el mensaje para que la pantalla no
    // tenga que adivinar por que no se puede comprar.
    if (!prov.activo) {
      throw new Conflicto('PROVEEDOR_INACTIVO', 'No se puede comprar a un proveedor dado de baja', {
        proveedor_id: d.proveedor_id,
      });
    }

    const fecha = d.fecha ?? (await hoyEnLaBase(c));
    const renglones = await prepararRenglones(c, d.proveedor_id, fecha, d.renglones);

    // El INSERT de la cabecera no dispara nada de inventario: los
    // movimientos salen de los renglones, en `trg_inventario_compra`. El
    // orden importa por `monto_total`, que ese mismo trigger recalcula con
    // un UPDATE a `compras`; si se mandaran los renglones primero, el
    // UPDATE no encontraria la compra todavia.
    const compraId = await repo.insertarCabecera(c, { ...d, fecha });

    for (const r of renglones) {
      await repo.insertarRenglon(c, { compra_id: compraId, ...r });
    }

    return leer(c, compraId);
  });
}

/**
 * Cancelar una compra.
 *
 * Unica operacion que mueve una compra ya escrita, y existe porque una
 * compra mal capturada (el producto equivocado, el almacen equivocado) se
 * deshace, no se borra. El documento queda con estatus 'cancelada' y su
 * motivo, y el trigger `fn_revertir_inventario_por_cancelacion_compra`
 * devuelve los bultos a la bodega.
 */
export async function cancelar(cliente: PoolClient, id: number, motivo: string): Promise<Compra> {
  return enTransaccionDe(cliente, async (c) => {
    const antes = await repo.consultarCompra(c, id);
    if (!antes) throw new NoEncontrado('Esa compra no existe');

    if (antes.estatus === 'cancelada') {
      throw new Conflicto('COMPRA_YA_CANCELADA', 'Esta compra ya estaba cancelada', {
        id,
        motivo: antes.motivo_cancelacion,
      });
    }

    // Cancelar una compra a la que ya se le pago devuelve el almacen, pero
    // el dinero ya salio y no hay un modulo de pagos a proveedores que lo
    // regrese: el saldo del proveedor pasaria a credito sin que nadie lo
    // pidiera. El estatus lo mantiene `fn_actualizar_estatus_compra` a
    // partir de `pagos_proveedor`, asi que 'parcial' o 'pagada' significa
    // que hay al menos un pago registrado. Cuando exista ese modulo, la
    // cancelacion tiene que pasar por la devolucion, no por aqui.
    if (antes.estatus === 'parcial' || antes.estatus === 'pagada') {
      throw new Conflicto(
        'COMPRA_CON_PAGO',
        'Esta compra ya tiene pagos registrados: primero hay que devolver el dinero al proveedor',
        { id, estatus: antes.estatus },
      );
    }

    const ok = await repo.cancelar(c, id, motivo);
    if (!ok) throw new Conflicto('COMPRA_YA_CANCELADA', 'Esta compra ya estaba cancelada', { id });

    return leer(c, id);
  });
}

/**
 * Resuelve lo que falta de cada renglon: el precio de costo.
 *
 * El precio sale del ultimo costo vigente de ESE proveedor para ESE producto
 * en la FECHA DE LA COMPRA, no del de hoy. Si el renglon trae precio, se
 * respeta: el operador que escribe un costo distinto al del catalogo esta
 * haciendo un trato, y la compra guarda lo que se compro.
 *
 * Lo que no se acepta es que falte y no haya costo registrado. Un renglon a
 * costo cero en silencio falsearia el margen de todo el producto, y el
 * margen es justo para lo que se compra.
 *
 * `kg_bulto` se deja en NULL cuando no viene: lo rellena
 * `fn_default_kg_bulto` con `productos.presentacion_kg`. Mandar el valor
 * desde aqui seria una segunda implementacion de la misma regla, y las dos
 * se desincronizan en cuanto una cambia.
 */
async function prepararRenglones(
  cliente: PoolClient,
  proveedorId: number,
  fecha: string,
  renglones: RenglonEntrada[],
): Promise<RenglonListo[]> {
  const salida: RenglonListo[] = [];

  for (const r of renglones) {
    const prod = await repo.producto(cliente, r.producto_id);
    if (!prod) {
      throw new ErrorValidacion(`El producto ${r.producto_id} no existe`, [
        { campo: 'producto_id', problema: `El producto ${r.producto_id} no existe` },
      ]);
    }
    if (!prod.activo) {
      // Como el proveedor: un estado, no un dato invalido. 409.
      throw new Conflicto('PRODUCTO_INACTIVO', 'No se puede comprar un producto dado de baja', {
        producto_id: r.producto_id,
      });
    }
    if (!(await repo.almacenExiste(cliente, r.almacen_id))) {
      throw new ErrorValidacion(`El almacen ${r.almacen_id} no existe`, [
        { campo: 'almacen_id', problema: `El almacen ${r.almacen_id} no existe` },
      ]);
    }

    let precio = r.precio_kg;
    if (precio === undefined) {
      const vigente = await repo.costoVigente(cliente, proveedorId, r.producto_id, fecha);
      if (vigente === null) {
        throw new ReglaNegocio(
          'SIN_COSTO',
          'Ese producto no tiene costo registrado con este proveedor y no mandaste precio_kg',
          { producto_id: r.producto_id, proveedor_id: proveedorId, fecha },
        );
      }
      precio = vigente;
    }

    salida.push({
      producto_id: r.producto_id,
      almacen_id: r.almacen_id,
      cantidad_bultos: r.cantidad_bultos,
      kg_bulto: r.kg_bulto ?? null,
      precio_kg: precio,
    });
  }

  return salida;
}

/** "Hoy" lo decide la base, no Node: mismo criterio que en notas y pagos. */
async function hoyEnLaBase(cliente: PoolClient): Promise<string> {
  const f = await consultarUno<{ hoy: string }>(
    cliente,
    `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS hoy`,
  );
  return f?.hoy ?? '';
}

/**
 * Se relee al final, y no se arma con lo enviado, para que `monto_total` y
 * el estatus sean los que escribieron los triggers y no un numero que el
 * servicio calculo por su cuenta.
 */
async function leer(cliente: PoolClient, id: number): Promise<Compra> {
  const fila = await repo.consultarCompra(cliente, id);
  if (!fila) throw new NoEncontrado('Esa compra no existe');
  const renglones: RenglonCompra[] = (await repo.listarRenglones(cliente, id)).map(
    mapearRenglonCompra,
  );
  return mapearCompra(fila, renglones);
}
