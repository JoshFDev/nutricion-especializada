import { describe, expect, it } from 'vitest';
import {
  ETIQUETA_EVENTO,
  ETIQUETA_OPERACION,
  cambiosDeFila,
  campoLegible,
  eventoSospechoso,
  fechaLegible,
  rangoDelMes,
  rangoIncoherente,
  tablaLegible,
  tipoCuentaLegible,
  tipoInventarioLegible,
  tipoPrecioLegible,
  valorLegible,
  type Cambio,
  type EventoAcceso,
} from './auditoria-api';

/** Como van los cambios: `[campo, antes, nuevo]`. */
function comoTexto(cambios: Cambio[]): string[] {
  return cambios.map((cambio) => `${cambio.campo}: ${cambio.antes} -> ${cambio.nuevo}`);
}

// ------------------------------------------------------------- ver un valor

describe('un valor del JSON del trigger', () => {
  it('el null y el undefined salen como un guion, no como "null"', () => {
    expect(valorLegible(null)).toBe('—');
    expect(valorLegible(undefined)).toBe('—');
  });

  it('los booleanos en palabras', () => {
    // La regla automática guarda `true`/`false` y se pintan mejor asi que en ingles.
    expect(valorLegible(true)).toBe('sí');
    expect(valorLegible(false)).toBe('no');
  });

  it('el texto vacio se distingue del null', () => {
    // Un campo que se vacio y un campo que se puso en null son cosas
    // distintas, y en la bitacora se ve que paso.
    expect(valorLegible('')).toBe('(vacío)');
  });

  it('los numeros y los textos se dejan tal cual', () => {
    expect(valorLegible(42)).toBe('42');
    expect(valorLegible('Cajera')).toBe('Cajera');
  });

  it('las listas se unen, y una lista vacia es un guion', () => {
    expect(valorLegible([1, 2, 3])).toBe('1, 2, 3');
    expect(valorLegible([])).toBe('—');
  });

  it('un objeto que no se sabe que es se muestra como JSON', () => {
    expect(valorLegible({ a: 1 })).toBe('{"a":1}');
  });
});

// --------------------------------------------------------- los campos que se movieron

describe('los campos que se movieron', () => {
  it('solo lista los que cambian, no los cien que quedaron igual', () => {
    const cambios = cambiosDeFila(
      { nombre: 'Ana', puesto: 'Cajera' },
      { nombre: 'Ana', puesto: 'Empleada' },
    );
    expect(comoTexto(cambios)).toEqual(['puesto: Cajera -> Empleada']);
  });

  it('marca el campo como nuevo cuando no existia antes', () => {
    // Un INSERT es todo nuevo, y `undefined -> valor` es como se ve.
    const cambios = cambiosDeFila(null, { nombre: 'Ana' });
    expect(cambios).toHaveLength(1);
    expect(cambios[0].campo).toBe('nombre');
    expect(cambios[0].antes).toBe('—');
    expect(cambios[0].nuevo).toBe('Ana');
    expect(cambios[0].lado).toBe('antes');
  });

  it('marca el campo como que desaparecio cuando ya no esta en el registro', () => {
    const cambios = cambiosDeFila({ puesto: 'Cajera' }, {});
    expect(cambios[0].lado).toBe('despues');
    expect(cambios[0].nuevo).toBe('—');
  });

  it('un cambio de verdad no lleva `lado`', () => {
    const cambios = cambiosDeFila({ puesto: 'Cajera' }, { puesto: 'Empleada' });
    expect(cambios[0].lado).toBeUndefined();
  });

  it('ve `null` contra cadena vacia como el cambio que es', () => {
    // Un `null` y un `''` son valores distintos en JS: si se compararan en
    // crudo, vaciar un campo no se veria en la bitacora.
    const cambios = cambiosDeFila({ puesto: 'Cajera' }, { puesto: '' });
    expect(comoTexto(cambios)).toEqual(['puesto: Cajera -> (vacío)']);
  });

  it('ve un numero que cambio de valor aunque los dos sean string', () => {
    // La base devuelve `NUMERIC` como texto, asi que dos cantidades
    // distintas llegan como '10.00' y '10.50' y no como 10 y 10.5.
    const cambios = cambiosDeFila({ monto: '10.00' }, { monto: '10.50' });
    expect(cambios).toHaveLength(1);
  });

  it('recorre los campos en el orden del registro nuevo, no en el del viejo', () => {
    // La regla automática manda los datos y la base no garantiza el orden de sus
    // llaves, asi que la unica referencia estable es el registro nuevo.
    const cambios = cambiosDeFila(
      { puesto: 'Cajera', nombre: 'Ana' },
      { nombre: 'Ana Maria', puesto: 'Empleada' },
    );
    expect(cambios.map((cambio) => cambio.campo)).toEqual(['nombre', 'puesto']);
  });

  it('devuelve la lista vacia cuando no se movio nada', () => {
    expect(cambiosDeFila({ a: 1 }, { a: 1 })).toEqual([]);
  });

  it('no explota si los dos lados vienen en null', () => {
    expect(cambiosDeFila(null, null)).toEqual([]);
  });
});

// ------------------------------------------------------------------ los eventos

describe('los eventos de acceso', () => {
  const eventos = Object.keys(ETIQUETA_EVENTO) as EventoAcceso[];

  it('tiene una etiqueta para cada evento que acepta el sistema', () => {
    // Si el sistema agrega un evento y esta tabla no, se pinta `undefined`.
    expect(eventos).toHaveLength(9);
    for (const evento of eventos) {
      expect(ETIQUETA_EVENTO[evento], evento).toBeTruthy();
    }
  });

  it('marca los tres que aparecen cuando alguien que no debe esta entrando', () => {
    expect(eventoSospechoso('login_fallido')).toBe(true);
    expect(eventoSospechoso('acceso_denegado')).toBe(true);
    expect(eventoSospechoso('bloqueo')).toBe(true);
  });

  it('no marca lo de todos los dias', () => {
    expect(eventoSospechoso('login_exitoso')).toBe(false);
    expect(eventoSospechoso('logout')).toBe(false);
    expect(eventoSospechoso('cambio_contrasena')).toBe(false);
  });
});

describe('las operaciones', () => {
  it('traduce las tres de SQL', () => {
    expect(ETIQUETA_OPERACION.INSERT).toBe('Alta');
    expect(ETIQUETA_OPERACION.UPDATE).toBe('Cambio');
    expect(ETIQUETA_OPERACION.DELETE).toBe('Baja');
  });
});

// ------------------------------------------------------- los codigos en palabras

describe('los codigos de la base, en palabras', () => {
  it('el tipo de inventario dice que paso, no como se llama la columna', () => {
    // `salida_venta` era la queja: quien revisa la bitacora no tiene por que
    // saber que eso es una venta.
    expect(tipoInventarioLegible('salida_venta')).toBe('Venta');
    expect(tipoInventarioLegible('entrada_compra')).toBe('Compra');
    expect(tipoInventarioLegible('ajuste_positivo')).toBe('Ajuste que sube');
    expect(tipoInventarioLegible('ajuste_negativo')).toBe('Ajuste que baja');
    expect(tipoInventarioLegible('merma')).toBe('Merma');
  });

  it('un tipo de inventario que nadie tradujo no se enseña en crudo', () => {
    // El sistema puede ganar un tipo manana; la pantalla no puede quedarse
    // enseñando `devolucion_cliente` con guion bajo.
    expect(tipoInventarioLegible('devolucion_cliente')).toBe('Devolucion cliente');
  });

  it('el tipo de precio son los mismos tres nombres del filtro', () => {
    expect(tipoPrecioLegible('cliente')).toBe('Precio de cliente');
    expect(tipoPrecioLegible('publico')).toBe('Precio de lista');
    expect(tipoPrecioLegible('costo')).toBe('Costo');
  });

  it('el tipo de cuenta', () => {
    expect(tipoCuentaLegible('efectivo')).toBe('Efectivo');
    expect(tipoCuentaLegible('banco')).toBe('Banco');
  });

  it('la tabla del log se nombra como la pantalla que la llena', () => {
    expect(tablaLegible('inventario_movimientos')).toBe('Inventario');
    expect(tablaLegible('notas_remision')).toBe('Notas de remisión');
    expect(tablaLegible('factura_nota')).toBe('Facturas y notas');
  });

  it('una tabla desconocida se humana, no se pierde', () => {
    expect(tablaLegible('otra_tabla')).toBe('Otra tabla');
  });

  it('el campo del detalle se lee, y el id avisa que es un numero', () => {
    // `precio_anterior` con guion bajo era el otro extremo del problema: el
    // detalle enseñaba los nombres de las columnas tal cual.
    expect(campoLegible('precio_anterior')).toBe('Precio anterior');
    expect(campoLegible('motivo_cancelacion')).toBe('Motivo de cancelación');
    expect(campoLegible('creado_en')).toBe('Cuándo se creó');
    expect(campoLegible('producto_id')).toBe('Producto (número)');
    expect(campoLegible('campo_raro')).toBe('Campo raro');
  });
});

// -------------------------------------------------------------------- las fechas

describe('las fechas', () => {
  it('se muestran con dia y hora, y sin la T del ISO', () => {
    expect(fechaLegible('2026-06-01T14:35:02.000Z')).toBe('2026-06-01 14:35');
  });

  it('el rango por omision es el mes que va, del dia 1 a hoy', () => {
    // Una bitacora sin rango son miles de renglones, y la primera pregunta
    // de quien la abre es que paso hoy.
    const hoy = new Date(2026, 5, 1);
    expect(rangoDelMes(hoy)).toEqual({ desde: '2026-06-01', hasta: '2026-06-01' });
  });

  it('el ultimo dia del mes se arma bien, sin saltarse el dia', () => {
    const hoy = new Date(2026, 11, 31);
    expect(rangoDelMes(hoy)).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
  });
});

describe('el rango incoherente', () => {
  it('avisa cuando el desde es posterior al hasta', () => {
    expect(rangoIncoherente('2026-06-10', '2026-06-01')).toBe(true);
  });

  it('deja pasar el mismo dia en los dos extremos', () => {
    // El sistema compara como texto, asi que el mismo dia es coherente.
    expect(rangoIncoherente('2026-06-01', '2026-06-01')).toBe(false);
  });

  it('deja pasar los rangos abiertos', () => {
    expect(rangoIncoherente(undefined, '2026-06-01')).toBe(false);
    expect(rangoIncoherente('2026-06-01', undefined)).toBe(false);
    expect(rangoIncoherente(undefined, undefined)).toBe(false);
  });
});
