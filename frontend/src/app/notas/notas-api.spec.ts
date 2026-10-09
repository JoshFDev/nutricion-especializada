import { describe, expect, it } from 'vitest';
import { cuerpoDeEdicion, cuerpoDeNota } from './notas-api';
import {
  cambiarCantidad,
  cambiarKilos,
  conPrecio,
  lineaDeRenglon,
  lineaVacia,
  type Linea,
} from './linea';
import type { PrecioEfectivo, Producto, RenglonNota } from './notas-api';

/**
 * El cuerpo de la nota: lo que se manda al backend.
 *
 * Es la prueba mas importante del POS, y no por el `POST` sino por lo que
 * este cuerpo NO lleva. El esquema del alta es `strict` y dos de los tres
 * errores que se pueden mandar aqui son 400 con un mensaje en ingles que no
 * le dice nada a la persona que esta capturando la venta.
 */

/** Un producto del seed: LAC, 20 kg el bulto. */
const LAC: Producto = {
  id: 7,
  codigo: 'LAC',
  nombre: 'VIMILAC 400',
  presentacion_kg: 20,
  activo: true,
};

const PRECIO: PrecioEfectivo = {
  fecha: '2026-09-28',
  producto_id: 7,
  producto_codigo: 'LAC',
  producto_nombre: 'VIMILAC 400',
  vigente: true,
  origen: 'cliente',
  precio_id: 3,
  precio_kg: 8.5,
  vigente_desde: '2026-01-01',
  vigente_hasta: null,
};

/** Un renglon listo: producto, un bulto y el precio ya resuelto. */
function lineaLista(cantidad = 1): Linea {
  return cambiarCantidad(conPrecio(lineaVacia(LAC), PRECIO), cantidad);
}

describe('el cuerpo de la nota', () => {
  it('lleva el cliente y los renglones', () => {
    const cuerpo = cuerpoDeNota(3, [lineaLista(2)], 2);
    expect(cuerpo.cliente_id).toBe(3);
    expect(cuerpo.renglones).toHaveLength(1);
  });

  it('NO lleva la serie: la resuelve el backend con la serie activa', () => {
    // La serie la decide quien administra el talonario y se guarda en la
    // base (`serie_folio_activa`). Si el POS la mandara, un cajero podria
    // quemar folios de cualquier serie, y el esquema del alta es `strict`.
    const cuerpo = cuerpoDeNota(3, [lineaLista()], 2);
    expect(cuerpo).not.toHaveProperty('serie');
    expect(JSON.stringify(cuerpo)).not.toContain('serie');
  });

  it('NO lleva subtotal: es una columna GENERATED y el esquema es strict', () => {
    // Mandarla da un 400 con un texto en ingles sobre "cannot insert into
    // column", que es el error mas confuso de toda la API.
    const cuerpo = cuerpoDeNota(3, [lineaLista()], 2);
    expect(cuerpo.renglones[0]).not.toHaveProperty('subtotal');
    expect(JSON.stringify(cuerpo)).not.toContain('subtotal');
  });

  it('NO lleva el precio, aunque la pantalla ya lo sepa', () => {
    // El backend resuelve el precio en la fecha de la nota si no le
    // llega, y esa es la regla. Mandarlo desde aqui abriria la puerta a
    // que un JSON con precio 0.01 cobre un peso.
    const linea = lineaLista();
    expect(linea.precio_unit_kg).toBe(8.5);
    const cuerpo = cuerpoDeNota(3, [linea], 2);
    expect(cuerpo.renglones[0]).not.toHaveProperty('precio_unit_kg');
  });

  it('NO lleva la fecha, para que la ponga la base y no el navegador', () => {
    const cuerpo = cuerpoDeNota(3, [lineaLista()], 2);
    expect(cuerpo).not.toHaveProperty('fecha');
  });

  it('NO lleva el id del renglon: en el alta todavia no existe', () => {
    const cuerpo = cuerpoDeNota(3, [lineaLista()], 2);
    expect(cuerpo.renglones[0]).not.toHaveProperty('id');
  });

  it('los bultos van como texto y sin decimales', () => {
    // El backend acepta numero o texto y lo normaliza a texto antes de
    // validar. Mandar texto quita de en medio el double. Y son enteros: un
    // bulto es una unidad, no un peso, y `cambiarCantidad` trunca.
    const cuerpo = cuerpoDeNota(3, [lineaLista(8)], 2);
    expect(cuerpo.renglones[0].cantidad_bultos).toBe('8');
    expect(typeof cuerpo.renglones[0].cantidad_bultos).toBe('string');
  });

  it('los kilos solo van si la persona los toco', () => {
    // Si no van, los rellena `fn_default_kg_bulto` con la presentacion real
    // del producto, que es mejor dato que el que el navegador recuerda.
    const sinTocar = cuerpoDeNota(3, [lineaLista()], 2);
    expect(sinTocar.renglones[0]).not.toHaveProperty('kg_bulto');
  });

  it('los kilos tocados van con tres decimales', () => {
    const linea = cambiarKilos(lineaLista(), 25.5);
    const cuerpo = cuerpoDeNota(3, [linea], 2);
    expect(cuerpo.renglones[0].kg_bulto).toBe('25.5');
  });

  it('poner los kilos igual a la presentacion es no haberlos tocado', () => {
    // Escribir 20 en un producto de 20 kg no es una override: es lo mismo
    // que no escribir nada, y si se mandaria se mandaria como override.
    const linea = cambiarKilos(lineaLista(), 20);
    expect(linea.kg_editado).toBe(false);
    expect(cuerpoDeNota(3, [linea], 2).renglones[0]).not.toHaveProperty('kg_bulto');
  });

  it('la bodega va por parametro, no escrita a mano', () => {
    // La elige la pantalla de entre las que hay (`/api/almacenes`). Ya no hay
    // una constante: si el sistema se entrega con dos bodegas, esta prueba no
    // se toca porque escribio un numero desde el principio.
    const cuerpo = cuerpoDeNota(3, [lineaLista()], 2);
    expect(cuerpo.renglones[0].almacen_id).toBe(2);
  });

  it('la direccion vacia no se manda, y con espacios se limpia', () => {
    expect(cuerpoDeNota(3, [lineaLista()], 2)).not.toHaveProperty('direccion_entrega');
    expect(cuerpoDeNota(3, [lineaLista()], 2, '   ')).not.toHaveProperty('direccion_entrega');
    expect(cuerpoDeNota(3, [lineaLista()], 2, '  Calle 5  ').direccion_entrega).toBe('Calle 5');
  });

  it('una nota sin renglones no sale: el backend pide al menos uno', () => {
    // Se comprueba aqui y no con un boton apagado, porque el boton se
    // desarma solo con signals y esto no.
    expect(() => cuerpoDeNota(3, [], 2)).toThrow(/al menos un renglon/);
  });

  it('los renglones se mandan en el orden en que se ven', () => {
    const otro: Producto = { ...LAC, id: 9, codigo: 'DHP', nombre: 'DHP-22', presentacion_kg: 25 };
    const cuerpo = cuerpoDeNota(
      3,
      [
        lineaLista(1),
        cambiarCantidad(
          conPrecio(lineaVacia(otro), { ...PRECIO, producto_id: 9, precio_kg: 12 }),
          3,
        ),
      ],
      2,
    );
    expect(cuerpo.renglones.map((r) => r.producto_id)).toEqual([7, 9]);
  });
});

/**
 * El cuerpo de la EDICION: la devolucion.
 *
 * Es la prueba de que una correccion no reescribe la nota entera: los
 * renglones que ya estaban llevan su id para que el backend los actualice y
 * no los borre y recree (y con ellos sus movimientos de inventario).
 */
describe('el cuerpo de la edicion', () => {
  /** Un renglon de la nota 5, como lo devuelve `GET /:id`. */
  const renglon: RenglonNota = {
    id: 41,
    producto_id: 7,
    producto_codigo: 'LAC',
    producto_nombre: 'VIMILAC 400',
    almacen_id: 2,
    almacen: 'Bodega 2',
    cantidad_bultos: 3,
    kg_bulto: 25.5,
    precio_unit_kg: 8.5,
    subtotal: 650.25,
  };

  /** La nota se carga con `lineaDeRenglon`, como hace la pantalla. */
  const deNota = (): Linea => lineaDeRenglon(renglon);

  it('lleva el cliente y los renglones con su id, para que el backend actualice', () => {
    const cuerpo = cuerpoDeEdicion(3, [deNota()], 2, '');
    expect(cuerpo.cliente_id).toBe(3);
    expect(cuerpo.renglones).toHaveLength(1);
    expect(cuerpo.renglones[0].id).toBe(41);
  });

  it('la direccion vacia SI se manda: en la edicion se puede quitar', () => {
    // En el alta, vacia no se manda (no hay nada que quitar); en la edicion
    // va como `null` para que la nota pueda quedarse sin direccion.
    expect(cuerpoDeEdicion(3, [deNota()], 2, '').direccion_entrega).toBeNull();
    expect(cuerpoDeEdicion(3, [deNota()], 2, '   ').direccion_entrega).toBeNull();
    expect(cuerpoDeEdicion(3, [deNota()], 2, '  Calle 5  ').direccion_entrega).toBe('Calle 5');
  });

  it('el almacen sale del renglon, no de la bodega elegida', () => {
    // El producto puede haber salido de otra bodega, y mandarle el almacen
    // equivocado descuenta el stock del que no es. En la edicion, la bodega
    // elegida (aquí la 9) solo rellena los renglones NUEVOS (los que no
    // traen la suya): por eso el renglon existente conserva la suya (la 2).
    expect(cuerpoDeEdicion(3, [deNota()], 9, '').renglones[0].almacen_id).toBe(2);
  });

  it('los kilos se mandan SIEMPRE en la edicion', () => {
    // Sin el id no se distinguen de un renglon nuevo, y un renglon sin kilos
    // vuelve a la presentacion del producto (trigger `fn_default_kg_bulto`).
    const cuerpo = cuerpoDeEdicion(3, [deNota()], 2, '');
    expect(cuerpo.renglones[0].kg_bulto).toBe('25.5');
  });

  it('el precio no se manda: el backend conserva el del renglon', () => {
    const cuerpo = cuerpoDeEdicion(3, [deNota()], 2, '');
    expect(cuerpo.renglones[0]).not.toHaveProperty('precio_unit_kg');
  });

  it('un renglon nuevo (sin id, agregado por el buscador) se puede anadir a la nota', () => {
    // No todo es devolver: a la nota tambien se le puede anadir producto. El
    // renglon que entra por el buscador no tiene `renglon_id`, y ese es el
    // que se manda sin id para que el backend lo cree.
    const nuevo = conPrecio(lineaVacia({ ...LAC, id: 9, codigo: 'DHP', nombre: 'DHP-22' }), {
      ...PRECIO,
      producto_id: 9,
    });
    const cuerpo = cuerpoDeEdicion(3, [deNota(), nuevo], 2, '');
    expect(cuerpo.renglones[1]).not.toHaveProperty('id');
    expect(cuerpo.renglones[1].producto_id).toBe(9);
    // El renglon nuevo sale de la bodega elegida en la captura: no trae la suya.
    expect(cuerpo.renglones[1].almacen_id).toBe(2);
  });

  it('una edicion sin renglones no sale: eso es cancelar, con otro boton', () => {
    expect(() => cuerpoDeEdicion(3, [], 2, '')).toThrow(/al menos un renglon/);
  });
});
