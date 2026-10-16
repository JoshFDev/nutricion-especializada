import { describe, expect, it } from 'vitest';
import { ATAJOS } from './ayuda';

/**
 * Los atajos que la Ayuda le muestra a la gente.
 *
 * Son datos y no una pantalla, asi que lo que se cuida aqui es que la lista
 * no se degrade: un renglon sin teclas o sin accion se pintaria en blanco, y
 * dos renglones con la misma accion se verian como un error de captura.
 */
describe('los atajos de la ayuda', () => {
  it('cada atajo trae al menos una tecla y una accion', () => {
    for (const atajo of ATAJOS) {
      expect(atajo.teclas.length, atajo.accion).toBeGreaterThan(0);
      expect(atajo.accion.trim().length, atajo.teclas.join('+')).toBeGreaterThan(0);
    }
  });

  it('no hay dos atajos con la misma accion', () => {
    const acciones = ATAJOS.map((atajo) => atajo.accion);
    expect(new Set(acciones).size).toBe(acciones.length);
  });

  it('ninguna tecla viene vacia ni con espacios de sobra', () => {
    for (const atajo of ATAJOS) {
      for (const tecla of atajo.teclas) {
        expect(tecla.length).toBeGreaterThan(0);
        expect(tecla).toBe(tecla.trim());
      }
    }
  });
});
