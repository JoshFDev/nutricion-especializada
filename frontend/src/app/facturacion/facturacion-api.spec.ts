import { describe, expect, it } from 'vitest';
import {
  MAX_NOTAS_POR_FACTURA,
  candidatasDe,
  cuerpoDeEstatus,
  cuerpoDeFactura,
  cuantasElegidas,
  estatusComoTexto,
  estatusNotaComoTexto,
  montoDeNotas,
  puedePasarA,
  problemaDeMotivo,
  type EstatusNota,
  type Listado,
  type NotaListada,
  type NotaPorFacturar,
} from './facturacion-api';

/**
 * El cuerpo de la factura y las reglas de la pantalla.
 *
 * Lo que mas importa que este cubierto: que el cuerpo NO lleve `monto_total`
 * (el esquema es `strict` y el total lo calcula el servidor sumando los
 * subtotales) y que solo vayan las notas marcadas. Lo demas son las
 * transiciones de estatus, que aqui no son una regla de negocio sino la
 * decision de que botones se ven: el backend sigue siendo el que manda.
 */

function nota(over: Partial<NotaPorFacturar> = {}): NotaPorFacturar {
  return {
    nota_id: 1,
    folio: 'A-1001',
    fecha: '2026-09-28',
    subtotal: 1000,
    estatus: 'pendiente',
    elegida: true,
    ...over,
  };
}

/**
 * Una respuesta de `GET /api/notas-remision`: `datos` son las que llegaron y
 * `total` las que hay. Se pueden separar a proposito, que es lo que pasa en
 * cuanto un cliente pasa de 200 notas de un mismo estatus.
 */
function respuesta(estatus: EstatusNota, fechas: string[], total: number): Listado<NotaListada> {
  return {
    datos: fechas.map((fecha, i) => ({
      id: i + 1,
      folio: `A-10${i + 1}`,
      cliente_id: 7,
      cliente: 'Refaccionaria',
      vendedor: null,
      fecha,
      subtotal: 1000,
      estatus,
      renglones: 1,
    })),
    total,
    limite: 200,
    offset: 0,
  };
}

describe('el cuerpo de la factura', () => {
  it('lleva solo las notas marcadas', () => {
    const cuerpo = cuerpoDeFactura(7, '', '', [
      nota({ nota_id: 1 }),
      nota({ nota_id: 2, elegida: false }),
      nota({ nota_id: 3 }),
    ]);
    expect(cuerpo.notas).toEqual([1, 3]);
  });

  it('nunca manda el monto total: lo calcula el servidor', () => {
    const cuerpo = cuerpoDeFactura(7, '', '', [nota()]);
    expect(cuerpo).not.toHaveProperty('monto_total');
  });

  it('sin notas marcadas no se manda nada: el esquema pide al menos una', () => {
    expect(() => cuerpoDeFactura(7, '', '', [nota({ elegida: false })])).toThrow();
    expect(() => cuerpoDeFactura(7, '', '', [])).toThrow();
  });

  it('la forma de pago vacia es null, no un texto en blanco', () => {
    expect(cuerpoDeFactura(7, '', '   ', [nota()]).metodo_pago).toBeNull();
  });

  it('la forma de pago se manda recortada', () => {
    expect(cuerpoDeFactura(7, '', '  03  ', [nota()]).metodo_pago).toBe('03');
  });

  it('la fecha vacia se omite y la de hoy la pone el backend', () => {
    expect(cuerpoDeFactura(7, '', '', [nota()]).fecha).toBeUndefined();
    expect(cuerpoDeFactura(7, '2026-09-28', '', [nota()]).fecha).toBe('2026-09-28');
  });
});

describe('el preview del total', () => {
  it('suma solo las notas marcadas', () => {
    const total = montoDeNotas([
      nota({ nota_id: 1, subtotal: 1000 }),
      nota({ nota_id: 2, subtotal: 500, elegida: false }),
      nota({ nota_id: 3, subtotal: 250.5 }),
    ]);
    expect(total).toBe(1250.5);
  });

  it('cuenta cuantas van, que es lo que dice el boton', () => {
    expect(cuantasElegidas([nota(), nota({ elegida: false }), nota({ nota_id: 3 })])).toBe(2);
  });
});

describe('las transiciones de estatus', () => {
  it('una solicitada se puede emitir o cancelar', () => {
    expect(puedePasarA('solicitada', 'emitida')).toBe(true);
    expect(puedePasarA('solicitada', 'cancelada')).toBe(true);
  });

  it('una emitida ya no se emite, solo se cancela', () => {
    expect(puedePasarA('emitida', 'emitida')).toBe(false);
    expect(puedePasarA('emitida', 'cancelada')).toBe(true);
  });

  it('una cancelada no sale de ahi: se pide otra', () => {
    expect(puedePasarA('cancelada', 'solicitada')).toBe(false);
    expect(puedePasarA('cancelada', 'emitida')).toBe(false);
    expect(puedePasarA('cancelada', 'cancelada')).toBe(false);
  });
});

describe('el motivo de la cancelacion', () => {
  it('hace falta, y el backend tambien lo pide', () => {
    expect(problemaDeMotivo('')).not.toBeNull();
    expect(problemaDeMotivo('   ')).not.toBeNull();
    expect(problemaDeMotivo('Se emitió mal el CFDI')).toBeNull();
  });

  it('viaja recortado, y vacio es null', () => {
    expect(cuerpoDeEstatus('cancelada', '  error en el RFC  ').motivo).toBe('error en el RFC');
    expect(cuerpoDeEstatus('emitida', '').motivo).toBeNull();
  });
});

describe('el tope de notas por factura', () => {
  it('es el mismo 200 que pone el esquema, para no ofrecer mas de lo que se puede', () => {
    expect(MAX_NOTAS_POR_FACTURA).toBe(200);
  });

  it('una factura con el tope completo se puede mandar', () => {
    const notas = Array.from({ length: MAX_NOTAS_POR_FACTURA }, (_, i) =>
      nota({ nota_id: i + 1, elegida: true }),
    );
    expect(cuerpoDeFactura(7, '', '', notas).notas).toHaveLength(MAX_NOTAS_POR_FACTURA);
  });
});

describe('las notas que se ofrecen para facturar', () => {
  it('junta los tres estatus en orden de fecha, y el folio desempata', () => {
    const r = candidatasDe([
      respuesta('pendiente', ['2026-09-20', '2026-09-28'], 2),
      respuesta('parcial', ['2026-09-15'], 1),
      respuesta('pagada', ['2026-09-28'], 1),
    ]);
    expect(r.total).toBe(4);
    expect(r.notas.map((n) => n.fecha)).toEqual([
      '2026-09-15',
      '2026-09-20',
      '2026-09-28',
      '2026-09-28',
    ]);
    expect(r.notas.every((n) => n.elegida === false)).toBe(true);
  });

  it('el total es la suma de los tres, no el numero que llego', () => {
    /**
     * Un cliente con 900 notas: cada consulta se topa en 200 y llegan 600
     * filas. Contar las que llegaron daria 600, y la pantalla avisaria "se
     * muestran 200 de 600" de un cliente que tiene 900. El aviso de que
     * faltan notas es lo unico que impide marcar 200 a ciegas.
     */
    const r = candidatasDe([
      respuesta('pendiente', ['2026-09-01'], 500),
      respuesta('parcial', ['2026-09-02'], 300),
      respuesta('pagada', ['2026-09-03'], 100),
    ]);
    expect(r.total).toBe(900);
  });

  it('nunca ofrece mas de 200, aunque el total diga que hay mas', () => {
    const muchas = Array.from(
      { length: MAX_NOTAS_POR_FACTURA },
      (_, i) => `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
    );
    const r = candidatasDe([respuesta('pendiente', muchas, 5000)]);
    expect(r.notas).toHaveLength(MAX_NOTAS_POR_FACTURA);
    expect(r.total).toBe(5000);
  });

  it('lo que no se puede facturar no se ofrece: la cancelada no llega aqui', () => {
    /**
     * La CANCELADA se filtra en la consulta, no despues. Si se filtrara
     * aqui, el `total` de esa respuesta ya traeria la cancelada y el aviso
     * "de N" contaria mercancia que salio.
     */
    const r = candidatasDe([respuesta('pendiente', ['2026-09-01'], 1)]);
    expect(r.notas.map((n) => n.estatus)).toEqual(['pendiente']);
  });
});

describe('los textos de la tabla', () => {
  it('el estatus de la factura se escribe con mayuscula', () => {
    expect(estatusComoTexto('solicitada')).toBe('Solicitada');
    expect(estatusComoTexto('emitida')).toBe('Emitida');
    expect(estatusComoTexto('cancelada')).toBe('Cancelada');
  });

  it('el de la nota pide otra palabra: "parcial" solo no dice que paso', () => {
    expect(estatusNotaComoTexto('pendiente')).toBe('Por pagar');
    expect(estatusNotaComoTexto('parcial')).toBe('Pago parcial');
    expect(estatusNotaComoTexto('pagada')).toBe('Pagada');
  });
});
