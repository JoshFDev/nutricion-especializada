import { describe, expect, it } from 'vitest';
import { ALMACEN_ID, SERIE, cuerpoDeNota } from './notas-api';
import { cambiarCantidad, cambiarKilos, conPrecio, lineaVacia, type Linea } from './linea';
import type { PrecioEfectivo, Producto } from './notas-api';

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
  it('lleva el cliente, la serie y los renglones', () => {
    const cuerpo = cuerpoDeNota(3, [lineaLista(2)]);
    expect(cuerpo.cliente_id).toBe(3);
    expect(cuerpo.serie).toBe(SERIE);
    expect(cuerpo.renglones).toHaveLength(1);
  });

  it('NO lleva subtotal: es una columna GENERATED y el esquema es strict', () => {
    // Mandarla da un 400 con un texto en ingles sobre "cannot insert into
    // column", que es el error mas confuso de toda la API.
    const cuerpo = cuerpoDeNota(3, [lineaLista()]);
    expect(cuerpo.renglones[0]).not.toHaveProperty('subtotal');
    expect(JSON.stringify(cuerpo)).not.toContain('subtotal');
  });

  it('NO lleva el precio, aunque la pantalla ya lo sepa', () => {
    // El backend resuelve el precio en la fecha de la nota si no le
    // llega, y esa es la regla. Mandarlo desde aqui abriria la puerta a
    // que un JSON con precio 0.01 cobre un peso.
    const linea = lineaLista();
    expect(linea.precio_unit_kg).toBe(8.5);
    const cuerpo = cuerpoDeNota(3, [linea]);
    expect(cuerpo.renglones[0]).not.toHaveProperty('precio_unit_kg');
  });

  it('NO lleva la fecha, para que la ponga la base y no el navegador', () => {
    const cuerpo = cuerpoDeNota(3, [lineaLista()]);
    expect(cuerpo).not.toHaveProperty('fecha');
  });

  it('NO lleva el id del renglon: en el alta todavia no existe', () => {
    const cuerpo = cuerpoDeNota(3, [lineaLista()]);
    expect(cuerpo.renglones[0]).not.toHaveProperty('id');
  });

  it('los bultos van como texto, con dos decimales', () => {
    // El backend acepta numero o texto y lo normaliza a texto antes de
    // validar. Mandar texto quita de en medio el double.
    const cuerpo = cuerpoDeNota(3, [lineaLista(8.5)]);
    expect(cuerpo.renglones[0].cantidad_bultos).toBe('8.5');
    expect(typeof cuerpo.renglones[0].cantidad_bultos).toBe('string');
  });

  it('los kilos solo van si la persona los toco', () => {
    // Si no van, los rellena `fn_default_kg_bulto` con la presentacion real
    // del producto, que es mejor dato que el que el navegador recuerda.
    const sinTocar = cuerpoDeNota(3, [lineaLista()]);
    expect(sinTocar.renglones[0]).not.toHaveProperty('kg_bulto');
  });

  it('los kilos tocados van con tres decimales', () => {
    const linea = cambiarKilos(lineaLista(), 25.5);
    const cuerpo = cuerpoDeNota(3, [linea]);
    expect(cuerpo.renglones[0].kg_bulto).toBe('25.5');
  });

  it('poner los kilos igual a la presentacion es no haberlos tocado', () => {
    // Escribir 20 en un producto de 20 kg no es una override: es lo mismo
    // que no escribir nada, y si se mandaria se mandaria como override.
    const linea = cambiarKilos(lineaLista(), 20);
    expect(linea.kg_editado).toBe(false);
    expect(cuerpoDeNota(3, [linea]).renglones[0]).not.toHaveProperty('kg_bulto');
  });

  it('el almacen es el unico que va escrito a mano, y se dice cual es', () => {
    // No hay endpoint de almacenes todavia. El dia que haya mas de una
    // bodega, esta constante es lo primero que hay que tocar.
    const cuerpo = cuerpoDeNota(3, [lineaLista()]);
    expect(cuerpo.renglones[0].almacen_id).toBe(ALMACEN_ID);
  });

  it('la direccion vacia no se manda, y con espacios se limpia', () => {
    expect(cuerpoDeNota(3, [lineaLista()])).not.toHaveProperty('direccion_entrega');
    expect(cuerpoDeNota(3, [lineaLista()], '   ')).not.toHaveProperty('direccion_entrega');
    expect(cuerpoDeNota(3, [lineaLista()], '  Calle 5  ').direccion_entrega).toBe('Calle 5');
  });

  it('una nota sin renglones no sale: el backend pide al menos uno', () => {
    // Se comprueba aqui y no con un boton apagado, porque el boton se
    // desarma solo con signals y esto no.
    expect(() => cuerpoDeNota(3, [])).toThrow(/al menos un renglon/);
  });

  it('los renglones se mandan en el orden en que se ven', () => {
    const otro: Producto = { ...LAC, id: 9, codigo: 'DHP', nombre: 'DHP-22', presentacion_kg: 25 };
    const cuerpo = cuerpoDeNota(3, [
      lineaLista(1),
      cambiarCantidad(conPrecio(lineaVacia(otro), { ...PRECIO, producto_id: 9, precio_kg: 12 }), 3),
    ]);
    expect(cuerpo.renglones.map((r) => r.producto_id)).toEqual([7, 9]);
  });
});
