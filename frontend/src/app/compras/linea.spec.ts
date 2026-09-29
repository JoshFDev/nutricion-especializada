import { describe, expect, it } from 'vitest';
import {
  agregar,
  cambiarCantidad,
  cambiarKilos,
  kilosDeLinea,
  kilosDeLineas,
  lineaValida,
  lineaVacia,
  montoDeLinea,
  ponerPrecio,
  problemasDe,
  quitar,
  precioComoTextoSiEscrito,
  kilosComoTextoSiEditados,
  sinCostoEscrito,
  subtotalDeLinea,
  totalDeLineas,
  type LineaCompra,
} from './linea';
import type { ProductoOpcion } from './compras-api';

const LAC: ProductoOpcion = {
  id: 7,
  codigo: 'LAC',
  nombre: 'VIMILAC 400',
  presentacion_kg: 20,
  activo: true,
};
const DHP: ProductoOpcion = {
  id: 9,
  codigo: 'DHP',
  nombre: 'DHP-22',
  presentacion_kg: 25,
  activo: true,
};

/** Un renglon con cantidad y costo ya puestos, para las cuentas. */
const lista = (cantidad = 1, costo = 8.5): LineaCompra =>
  ponerPrecio(cambiarCantidad(lineaVacia(LAC), cantidad), costo);

describe('agregar renglones', () => {
  it('un producto nuevo se agrega', () => {
    expect(agregar([], lineaVacia(LAC))).toHaveLength(1);
  });

  it('el mismo producto NO se fusiona: dos lotes son dos filas', () => {
    // A diferencia del POS, aqui el proveedor puede vender el mismo producto
    // en dos lotes a distinto costo y el backend guarda las dos filas.
    const lineas = agregar(agregar([], lineaVacia(LAC)), lineaVacia(LAC));
    expect(lineas).toHaveLength(2);
  });

  it('cada linea tiene su propio uid', () => {
    expect(lineaVacia(LAC).uid).not.toBe(lineaVacia(LAC).uid);
  });

  it('quitar saca la fila por uid y no por producto', () => {
    const lineas = agregar(agregar([], lineaVacia(LAC)), lineaVacia(DHP));
    const restantes = quitar(lineas, lineas[0].uid);
    expect(restantes).toHaveLength(1);
    expect(restantes[0].producto_id).toBe(9);
  });
});

describe('la cantidad de bultos', () => {
  it('acepta un decimal', () => {
    expect(cambiarCantidad(lineaVacia(LAC), 3.5).cantidad_bultos).toBe(3.5);
  });

  it('cero vuelve a ser uno, no cero', () => {
    // `cantidad_bultos` rechaza el cero en el backend.
    expect(cambiarCantidad(lineaVacia(LAC), 0).cantidad_bultos).toBe(1);
  });

  it('un negativo tambien vuelve a uno', () => {
    expect(cambiarCantidad(lineaVacia(LAC), -5).cantidad_bultos).toBe(1);
  });

  it('lo que no es numero deja la cantidad como estaba', () => {
    expect(cambiarCantidad(cambiarCantidad(lineaVacia(LAC), 4), 'abc').cantidad_bultos).toBe(4);
  });
});

describe('los kilos por bulto', () => {
  it('empiezan en la presentacion del producto', () => {
    expect(lineaVacia(LAC).kg_bulto).toBe(20);
    expect(lineaVacia(LAC).kg_editado).toBe(false);
  });

  it('el cero NO se acepta, y deja los kilos como estaban', () => {
    expect(cambiarKilos(lineaVacia(LAC), 0).kg_bulto).toBe(20);
  });

  it('tocarlos los marca como editados', () => {
    expect(cambiarKilos(lineaVacia(LAC), 12.5).kg_editado).toBe(true);
  });

  it('ponerlos igual a la presentacion los deja sin editar', () => {
    expect(cambiarKilos(lineaVacia(LAC), 20).kg_editado).toBe(false);
  });
});

describe('el costo por kilo', () => {
  it('empieza vacio: lo resuelve el sistema', () => {
    expect(lineaVacia(LAC).precio_kg).toBeNull();
    expect(sinCostoEscrito(lineaVacia(LAC))).toBe(true);
  });

  it('un campo vacio lo vuelve a dejar sin costo', () => {
    expect(ponerPrecio(lista(), '').precio_kg).toBeNull();
  });

  it('el cero SI se guarda, porque una cortesia vale cero', () => {
    expect(ponerPrecio(lineaVacia(LAC), 0).precio_kg).toBe(0);
    expect(sinCostoEscrito(ponerPrecio(lineaVacia(LAC), 0))).toBe(false);
  });

  it('un negativo o algo ilegible se ignora', () => {
    expect(ponerPrecio(lista(1, 8.5), -1).precio_kg).toBe(8.5);
    expect(ponerPrecio(lista(1, 8.5), 'caro').precio_kg).toBe(8.5);
  });
});

describe('los subtotales y el total', () => {
  it('el subtotal es bultos por kilos por costo', () => {
    // 2 bultos de 20 kg a 8.50 = 340.00
    expect(subtotalDeLinea(lista(2))).toBe(340);
  });

  it('sin costo escrito el subtotal es cero, no NaN', () => {
    // El sistema no puede saber el costo desde el navegador.
    expect(subtotalDeLinea(lineaVacia(LAC))).toBe(0);
  });

  it('la compra suma sus renglones', () => {
    const otra = ponerPrecio(cambiarCantidad(lineaVacia(DHP), 1), 12);
    expect(totalDeLineas([lista(2), otra])).toBe(640);
  });

  it('el subtotal se ve con miles y con dos decimales', () => {
    expect(montoDeLinea(lista(100))).toBe('17,000.00');
  });

  it('los kilos de la compra son los que entran a la bodega', () => {
    expect(kilosDeLineas([lista(2)])).toBe(40);
    expect(kilosDeLinea(lista(3))).toBe('60.000');
  });
});

describe('que renglones se pueden mandar', () => {
  it('uno con cantidad y kilos se puede aunque no tenga costo', () => {
    // El costo lo resuelve el backend; si no hay, responde SIN_COSTO.
    expect(problemasDe(lineaVacia(LAC))).toEqual({});
    expect(lineaValida(lineaVacia(LAC))).toBe(true);
  });

  it('una cantidad descabellada se marca antes de mandarla', () => {
    const rota: LineaCompra = { ...lineaVacia(LAC), cantidad_bultos: 999_999_999 };
    expect(problemasDe(rota)['cantidad_bultos']).toBeDefined();
  });

  it('un costo con demasiados decimales se marca', () => {
    const rota: LineaCompra = { ...lineaVacia(LAC), precio_kg: 8.555 };
    expect(problemasDe(rota)['precio_kg']).toBeDefined();
  });
});

describe('lo que se manda de cada renglon', () => {
  it('el costo solo viaja si se escribio', () => {
    expect(precioComoTextoSiEscrito(lineaVacia(LAC))).toBeNull();
    expect(precioComoTextoSiEscrito(lista(1, 8.5))).toBe('8.5');
  });

  it('los kilos solo viajan si se tocaron', () => {
    expect(kilosComoTextoSiEditados(lineaVacia(LAC))).toBeNull();
    expect(kilosComoTextoSiEditados(cambiarKilos(lineaVacia(LAC), 25.5))).toBe('25.5');
  });
});
