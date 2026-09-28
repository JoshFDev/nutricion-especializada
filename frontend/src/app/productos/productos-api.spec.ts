import { describe, expect, it } from 'vitest';
import { cuerpoDeProducto, type FormaProducto } from './productos-api';

/**
 * El cuerpo del producto: lo que se manda al backend.
 *
 * Ojo donde NO normaliza: el codigo NO se mayusculiza (el esquema de
 * `productos/esquemas.ts` no lo transforma, a diferencia del de clientes),
 * y `presentacion_kg` va como string porque el esquema lo valida como texto
 * (`presentacionKg` lo normaliza a string y luego aplica la regex).
 */

function forma(parcial: Partial<FormaProducto> = {}): FormaProducto {
  return {
    codigo: 'alimento15',
    nombre: 'Alimento Balanceado',
    presentacion_kg: '15.000',
    categoria_id: '',
    especie_id: '',
    ...parcial,
  };
}

describe('el cuerpo del producto', () => {
  it('manda el codigo tal cual, sin mayusculizar ni recortar', () => {
    const cuerpo = cuerpoDeProducto(forma({ codigo: '  alimento15 ' }));
    expect(cuerpo.codigo).toBe('alimento15');
  });

  it('la presentacion viaja como string, no como numero', () => {
    const cuerpo = cuerpoDeProducto(forma({ presentacion_kg: '25.000' }));
    expect(cuerpo.presentacion_kg).toBe('25.000');
  });

  it('los selects vacios son null, no strings vacios', () => {
    const cuerpo = cuerpoDeProducto(forma());
    expect(cuerpo.categoria_id).toBeNull();
    expect(cuerpo.especie_id).toBeNull();
  });

  it('la categoria y especie elegidas van como numeros', () => {
    const cuerpo = cuerpoDeProducto(forma({ categoria_id: '2', especie_id: '1' }));
    expect(cuerpo.categoria_id).toBe(2);
    expect(cuerpo.especie_id).toBe(1);
  });
});
