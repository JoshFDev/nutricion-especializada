import { describe, expect, it } from 'vitest';
import { ALMACEN_ID, cuerpoDeCompra, estatusComoTexto, type ProductoOpcion } from './compras-api';
import { cambiarCantidad, cambiarKilos, lineaVacia, ponerPrecio, type LineaCompra } from './linea';

/**
 * El cuerpo de la compra: lo que se manda al backend.
 *
 * Lo importante no es el `POST` sino lo que este cuerpo NO lleva. El esquema
 * del alta es `strict`: mandar `subtotal` (GENERATED) o `estatus` (lo mueven
 * los pagos) da un 400 con un mensaje en ingles que no le dice nada a quien
 * esta capturando la compra.
 */

/** Un producto del seed: LAC, 20 kg el bulto. */
const LAC: ProductoOpcion = {
  id: 7,
  codigo: 'LAC',
  nombre: 'VIMILAC 400',
  presentacion_kg: 20,
  activo: true,
};

/** Un renglon listo: un bulto, con el kg del producto y sin costo escrito. */
function linea(cantidad = 1): LineaCompra {
  return cambiarCantidad(lineaVacia(LAC), cantidad);
}

describe('el cuerpo de la compra', () => {
  it('lleva el proveedor y los renglones', () => {
    const cuerpo = cuerpoDeCompra(3, [linea(2)]);
    expect(cuerpo.proveedor_id).toBe(3);
    expect(cuerpo.renglones).toHaveLength(1);
  });

  it('NO lleva subtotal ni estatus: son de la base y del pago', () => {
    const texto = JSON.stringify(cuerpoDeCompra(3, [linea()]));
    expect(texto).not.toContain('subtotal');
    expect(texto).not.toContain('estatus');
  });

  it('NO lleva el id del renglon: en el alta todavia no existe', () => {
    expect(cuerpoDeCompra(3, [linea()]).renglones[0]).not.toHaveProperty('id');
  });

  it('los bultos van como texto, con dos decimales', () => {
    const cuerpo = cuerpoDeCompra(3, [linea(8.5)]);
    expect(cuerpo.renglones[0].cantidad_bultos).toBe('8.5');
    expect(typeof cuerpo.renglones[0].cantidad_bultos).toBe('string');
  });

  it('sin costo escrito, el renglon NO lleva precio_kg', () => {
    // Si no va, lo resuelve el backend con el ultimo costo del proveedor en
    // la fecha de la compra, que es el dato bueno.
    expect(cuerpoDeCompra(3, [linea()]).renglones[0]).not.toHaveProperty('precio_kg');
  });

  it('el costo escrito se manda con dos decimales', () => {
    const conCosto = ponerPrecio(linea(), 8.5);
    expect(cuerpoDeCompra(3, [conCosto]).renglones[0].precio_kg).toBe('8.5');
  });

  it('un costo de cero se manda, porque una cortesia vale cero', () => {
    // Distinto de "no lo escribi": el `precioKg` del backend acepta 0.
    const conCero = ponerPrecio(linea(), 0);
    expect(conCero.precio_kg).toBe(0);
    expect(cuerpoDeCompra(3, [conCero]).renglones[0].precio_kg).toBe('0');
  });

  it('los kilos solo van si la persona los toco', () => {
    expect(cuerpoDeCompra(3, [linea()]).renglones[0]).not.toHaveProperty('kg_bulto');
  });

  it('los kilos tocados van con tres decimales', () => {
    const tocada = cambiarKilos(linea(), 25.5);
    expect(cuerpoDeCompra(3, [tocada]).renglones[0].kg_bulto).toBe('25.5');
  });

  it('el almacen es el que recibe la mercancia y se dice cual es', () => {
    // No hay endpoint de almacenes todavia; el dia que haya mas de una
    // bodega, esta constante es lo primero que hay que tocar.
    expect(cuerpoDeCompra(3, [linea()]).renglones[0].almacen_id).toBe(ALMACEN_ID);
  });

  it('el folio vacio no se manda, y con texto se limpia', () => {
    expect(cuerpoDeCompra(3, [linea()])).not.toHaveProperty('folio_proveedor');
    expect(cuerpoDeCompra(3, [linea()], '   ')).not.toHaveProperty('folio_proveedor');
    expect(cuerpoDeCompra(3, [linea()], '  A-123  ').folio_proveedor).toBe('A-123');
  });

  it('la fecha vacia no se manda, para que la ponga la base', () => {
    expect(cuerpoDeCompra(3, [linea()], null, '')).not.toHaveProperty('fecha');
  });

  it('la fecha del documento si se manda, y una mal formada no', () => {
    expect(cuerpoDeCompra(3, [linea()], null, '2026-09-01').fecha).toBe('2026-09-01');
    // Un input de fecha a medias no debe viajar como un 422 de un campo que
    // en pantalla se ve bien.
    expect(cuerpoDeCompra(3, [linea()], null, '01/09/2026')).not.toHaveProperty('fecha');
  });

  it('una compra sin renglones no sale: el backend pide al menos uno', () => {
    expect(() => cuerpoDeCompra(3, [])).toThrow(/al menos un renglon/);
  });
});

describe('el estatus en palabras', () => {
  it('cada estatus tiene su texto', () => {
    expect(estatusComoTexto('pendiente')).toBe('Por pagar');
    expect(estatusComoTexto('parcial')).toBe('Pago parcial');
    expect(estatusComoTexto('pagada')).toBe('Pagada');
    expect(estatusComoTexto('cancelada')).toBe('Cancelada');
  });
});
