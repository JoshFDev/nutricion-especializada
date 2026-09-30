import { describe, expect, it } from 'vitest';
import {
  agregar,
  cambiarCantidad,
  cambiarKilos,
  conDisponible,
  conPrecio,
  kgComoTextoSiHayQueMandarlo,
  kilosDeLinea,
  kilosDeLineas,
  lineaDeRenglon,
  lineaValida,
  lineaVacia,
  montoDeLinea,
  origenComoTexto,
  problemasDe,
  quitar,
  restanteDe,
  totalDeLinea,
  totalDeLineas,
  vaciar,
  type Linea,
} from './linea';
import type { PrecioEfectivo, Producto, RenglonNota } from './notas-api';

const LAC: Producto = {
  id: 7,
  codigo: 'LAC',
  nombre: 'VIMILAC 400',
  presentacion_kg: 20,
  activo: true,
};
const DHP: Producto = { id: 9, codigo: 'DHP', nombre: 'DHP-22', presentacion_kg: 25, activo: true };

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

const lista = (cantidad = 1): Linea =>
  cambiarCantidad(conPrecio(lineaVacia(LAC), PRECIO), cantidad);

describe('agregar renglones', () => {
  it('un producto nuevo se agrega', () => {
    expect(agregar([], lista())).toHaveLength(1);
  });

  it('el mismo producto SUMA en vez de duplicar la fila', () => {
    // El operador no va a buscar si ya lo habia puesto, y dos renglones
    // del mismo producto en la nota se ven como un error.
    const lineas = agregar(agregar([], lista(2)), lista(3));
    expect(lineas).toHaveLength(1);
    expect(lineas[0].cantidad_bultos).toBe(5);
  });

  it('al fusionar se queda con el precio que ya estaba resuelto', () => {
    const lineas = agregar(agregar([], lista()), lista());
    expect(lineas[0].precio_unit_kg).toBe(8.5);
    expect(lineas[0].precio_origen).toBe('cliente');
  });

  it('cada linea tiene su propio uid, aunque sean del mismo producto', () => {
    // El @for de Angular se queja de claves repetidas, y dos lineas del
    // mismo producto necesitan poder distinguirse.
    const primera = lineaVacia(LAC);
    const segunda = lineaVacia(LAC);
    expect(primera.uid).not.toBe(segunda.uid);
  });

  it('quitar saca la fila por uid y no por producto', () => {
    const otra = cambiarCantidad(conPrecio(lineaVacia(DHP), PRECIO), 1);
    const lineas = agregar(agregar([], lista()), otra);
    expect(quitar(lineas, lineas[0].uid)).toHaveLength(1);
    expect(quitar(lineas, lineas[0].uid)[0].producto_id).toBe(9);
  });

  it('vaciar deja la lista vacia', () => {
    expect(vaciar([lista()])).toEqual([]);
  });
});

describe('la cantidad de bultos', () => {
  it('acepta un numero', () => {
    expect(cambiarCantidad(lista(), 3).cantidad_bultos).toBe(3);
  });

  it('cero vuelve a ser uno, no cero', () => {
    // `cantidad_bultos` es un `decimal(...)` del backend y RECHAZA el cero
    // con un 422. Una linea en cero es una linea que no se puede cobrar.
    expect(cambiarCantidad(lista(), 0).cantidad_bultos).toBe(1);
  });

  it('un negativo tambien vuelve a ser uno', () => {
    expect(cambiarCantidad(lista(), -5).cantidad_bultos).toBe(1);
  });

  it('lo que no es numero deja la cantidad como estaba', () => {
    // Distinto del cero: si no se puede leer, no se adivina.
    expect(cambiarCantidad(lista(4), 'abc').cantidad_bultos).toBe(4);
  });

  it('un decimal se trunca: los bultos son unidades, no peso', () => {
    // "3.8" bultos no existen: trunca a 3 en vez de redondear a 4, porque
    // redondear inventa un bulto que nadie cargo entero.
    expect(cambiarCantidad(lista(), '3.8').cantidad_bultos).toBe(3);
  });
});

describe('lo que hay del producto', () => {
  it('sin disponible no dice cuantos quedan', () => {
    expect(restanteDe(lista(2))).toBeNull();
  });

  it('el restante es el disponible menos lo escrito', () => {
    const linea = conDisponible(lista(2), 8);
    expect(restanteDe(linea)).toBe(6);
  });

  it('si se pide mas de lo que hay, en vez de restante hay un faltante', () => {
    expect(restanteDe(conDisponible(lista(10), 6))).toBe(-4);
  });
});

describe('los kilos por bulto', () => {
  it('empiezan en la presentacion del producto', () => {
    expect(lineaVacia(LAC).kg_bulto).toBe(20);
    expect(lineaVacia(LAC).kg_editado).toBe(false);
  });

  it('el cero NO se acepta, y deja los kilos como estaban', () => {
    // `kg_bulto` es `decimal(7, 3, 'kg_bulto')` en el backend y exige
    // `> 0`: un cero llega como un 422, con la nota ya capturada.
    expect(cambiarKilos(lista(), 0).kg_bulto).toBe(20);
  });

  it('un negativo tampoco', () => {
    expect(cambiarKilos(lista(), -1).kg_bulto).toBe(20);
  });

  it('un numero que no se puede leer deja los kilos como estaban', () => {
    expect(cambiarKilos(lista(), 'pesado').kg_bulto).toBe(20);
  });

  it('tocarlos los marca como editados', () => {
    expect(cambiarKilos(lista(), 12.5).kg_editado).toBe(true);
  });

  it('ponerlos igual a la presentacion los deja sin editar', () => {
    expect(cambiarKilos(lista(), 20).kg_editado).toBe(false);
  });
});

describe('los totales', () => {
  it('el total de la linea es bultos por kilos por precio', () => {
    // 2 bultos de 20 kg a 8.50 = 340.00
    expect(totalDeLinea(lista(2))).toBe(340);
  });

  it('un renglon sin precio no suma nada, no sea NaN', () => {
    expect(totalDeLinea(lineaVacia(LAC))).toBe(0);
  });

  it('la nota suma sus renglones', () => {
    const otra = cambiarCantidad(
      conPrecio(lineaVacia(DHP), { ...PRECIO, producto_id: 9, precio_kg: 12 }),
      1,
    );
    const lineas = agregar([lista(2)], otra);
    // 2 x 20 x 8.50 = 340.00, y 1 x 25 x 12.00 = 300.00
    expect(totalDeLineas(lineas)).toBe(640);
  });

  it('el total se ve con miles y con dos decimales', () => {
    expect(montoDeLinea(lista(100))).toBe('17,000.00');
  });

  it('los kilos de la nota son los que se entregan y se descuentan', () => {
    expect(kilosDeLineas([lista(2)])).toBe(40);
  });

  it('los kilos de una linea salen con tres decimales', () => {
    expect(kilosDeLinea(lista(3))).toBe('60.000');
  });
});

describe('el origen del precio', () => {
  it('el del cliente se dice, porque es la pregunta que se hace el operador', () => {
    expect(origenComoTexto(lista())).toBe('precio de cliente');
  });

  it('el de lista se dice tambien', () => {
    expect(origenComoTexto(conPrecio(lista(), { ...PRECIO, origen: 'publico' }))).toBe(
      'precio de lista',
    );
  });

  it('el de la nota se dice, para una devolucion que se esta corrigiendo', () => {
    // El precio se tomo del renglon y no se volvio a preguntar, asi que
    // decir "precio de lista" ahi seria mentir.
    expect(origenComoTexto({ ...lista(), precio_origen: 'nota' })).toBe('precio de la nota');
  });

  it('sin precio se dice, no se disimula', () => {
    expect(origenComoTexto(lineaVacia(LAC))).toBe('sin precio');
  });
});

describe('que renglones se pueden mandar', () => {
  it('uno con precio y cantidad se puede', () => {
    expect(problemasDe(lista())).toEqual({});
    expect(lineaValida(lista())).toBe(true);
  });

  it('uno sin precio no se puede, y el backend lo rechazaria con SIN_PRECIO', () => {
    expect(problemasDe(lineaVacia(LAC))['precio_unit_kg']).toContain('precio vigente');
  });

  it('una cantidad descabellada se marca antes de mandarla', () => {
    // El backend valida hasta 8 cifras enteras; aqui se avisa.
    expect(problemasDe(cambiarCantidad(lista(), 999_999_999))['cantidad_bultos']).toBeDefined();
  });
});

describe('un renglon que viene de la nota', () => {
  /** El renglon que devuelve `GET /:id` para la nota 5. */
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

  it('copia el renglon: producto, bultos, kilos, precio y bodega', () => {
    const linea = lineaDeRenglon(renglon);
    expect(linea.producto_id).toBe(7);
    expect(linea.cantidad_bultos).toBe(3);
    expect(linea.kg_bulto).toBe(25.5);
    expect(linea.precio_unit_kg).toBe(8.5);
    expect(linea.renglon_id).toBe(41);
    expect(linea.almacen_id).toBe(2);
  });

  it('arranca sin que los kilos esten marcados como editados', () => {
    // Los kilos de 25.5 no son los de la presentacion (20), pero al traer
    // el renglon_id ya se mandan; el flag de "los toco a mano" es solo del alta.
    expect(lineaDeRenglon(renglon).kg_editado).toBe(false);
  });

  it('el precio se dice como el de la nota, no se vuelve a preguntar', () => {
    expect(lineaDeRenglon(renglon).precio_origen).toBe('nota');
  });
});

describe('si hay que mandar los kilos por bulto', () => {
  it('en el alta, sin tocarlos, no se mandan: los rellena la base', () => {
    expect(kgComoTextoSiHayQueMandarlo(lista())).toBeNull();
  });

  it('en el alta, tocados, se mandan con tres decimales', () => {
    expect(kgComoTextoSiHayQueMandarlo(cambiarKilos(lista(), 25.5))).toBe('25.5');
  });

  it('en la EDICION se mandan SIEMPRE, aunque no se hayan tocado', () => {
    // La diferencia con el alta: el trigger `fn_default_kg_bulto` vuelve a
    // la presentacion del producto cualquier renglon que llegue sin kilos,
    // y una nota que vendio bultos de 25.5 se convertiria en bultos de 25.
    const deNota = lineaDeRenglon({
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
    });
    expect(kgComoTextoSiHayQueMandarlo(deNota)).toBe('25.5');
  });
});
