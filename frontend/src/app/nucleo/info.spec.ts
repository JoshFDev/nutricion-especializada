import { describe, expect, it } from 'vitest';
import { INFO_SISTEMA } from './info';

/**
 * La ficha de la aplicacion que sale en "Acerca de".
 *
 * Se prueba poco y a proposito: son datos que la persona edita a mano. Lo unico
 * que vale la pena cuidar es que la version tenga la forma que todo el mundo
 * espera (`1.2.3`), porque es lo primero que se dicta por telefono cuando hay
 * que dar soporte, y un "v1" o un "1.0" se leen distinto en cada quien.
 */
describe('la ficha del sistema', () => {
  it('la version tiene la forma numero.numero.numero', () => {
    expect(INFO_SISTEMA.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('trae nombre, empresa y una linea de descripcion', () => {
    expect(INFO_SISTEMA.nombre.trim().length).toBeGreaterThan(0);
    expect(INFO_SISTEMA.empresa.trim().length).toBeGreaterThan(0);
    expect(INFO_SISTEMA.descripcion.trim().length).toBeGreaterThan(0);
  });
});
