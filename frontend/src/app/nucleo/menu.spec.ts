import { describe, expect, it } from 'vitest';
import { MENU, MODULOS, menuPara, primerModulo, rutaDeInicio } from './menu';

/**
 * El menu es lo unico que decide que se ve en la app, asi que sus reglas se
 * prueban aqui y no en la pantalla del shell.
 */
describe('el catalogo de modulos', () => {
  it('cada modulo tiene un permiso con la forma que espera el backend', () => {
    for (const modulo of MODULOS) {
      expect(modulo.permiso, modulo.ruta).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });

  it('no hay dos modulos con la misma ruta', () => {
    // Las rutas se generan de esta tabla. Un repetido no da error de
    // compilacion: la segunda ruta simplemente nunca se alcanza, y el menu
    // ofrece dos entradas que llevan al mismo lado.
    const rutas = MODULOS.map((m) => m.ruta);
    expect(new Set(rutas).size).toBe(rutas.length);
  });

  it('no hay dos modulos con el mismo permiso', () => {
    // Un permiso repetido significa que el mismo rol abre dos modulos o
    // que hay una copia que se quiso quitar y no se quito.
    const permisos = MODULOS.map((m) => m.permiso);
    expect(new Set(permisos).size).toBe(permisos.length);
  });

  it('la pantalla que declara el modulo existe de verdad', async () => {
    // `carga` es un import dinamico escrito a mano en la tabla. Un typo en
    // la ruta no da error de compilacion: la pantalla esta lazy, y el
    // modulo revienta AL HACER CLIC en el menu, con la persona parada en el
    // mostrador. Esto lo truena aqui.
    for (const modulo of MODULOS) {
      if (modulo.carga === undefined) continue;
      const cargado = await modulo.carga();
      expect(cargado, modulo.ruta).toBeDefined();
    }
  });

  it('notas ya no es una pantalla pendiente', () => {
    // El primer modulo de verdad. Si esto falla, el menu volvio a ofrecer
    // el aviso de "pantalla pendiente" en el mostrador.
    const notas = MODULOS.find((m) => m.ruta === 'notas');
    expect(notas?.carga).toBeDefined();
  });

  it('todo permiso del menu es de ver, no de escribir', () => {
    // El menu es la lista de lo que se ABRE. Que el permiso sea de ver
    // hace que el boton de una pantalla y su entrada en el menu se estables
    // con la misma regla: si el menu usara `notas.crear`, un rol que solo
    // puede capturar no veria el modulo donde se captura.
    for (const modulo of MODULOS) {
      expect(modulo.permiso.endsWith('.ver'), modulo.ruta).toBe(true);
    }
  });
});

describe('menuPara', () => {
  it('deja solo los modulos que la persona puede ver', () => {
    const menu = menuPara(new Set(['notas.ver', 'clientes.ver']));
    const rutas = menu.flatMap((grupo) => grupo.modulos.map((m) => m.ruta));

    expect(rutas).toEqual(['notas', 'clientes']);
  });

  it('quita los grupos que se quedan sin nada', () => {
    // La cajera no tiene nada de Sistema ni de Catalogo. Dejar un "SISTEMA"
    // vacio en el menu hace dudar de si algo fallo.
    const menu = menuPara(new Set(['notas.ver']));
    expect(menu.map((g) => g.titulo)).toEqual(['Mostrador']);
  });

  it('conserva el orden del catalogo, no el de la lista de permisos', () => {
    // El orden del menu es una decision de la persona que usa la app: lo
    // de todos los dias arriba. Si se respeta el `Set` que llega de la API
    // (cuyo orden no es ninguno), el menu se reacomoda solo.
    const menu = menuPara(new Set(['auditoria.ver', 'notas.ver', 'caja.ver']));
    expect(menu.flatMap((g) => g.modulos.map((m) => m.ruta))).toEqual([
      'notas',
      'caja',
      'auditoria',
    ]);
  });

  it('con un rol sin permisos no devuelve ningun grupo', () => {
    expect(menuPara(new Set())).toEqual([]);
  });
});

describe('primerModulo', () => {
  it('es el primero del catalogo que la persona tiene', () => {
    expect(primerModulo(new Set(['pagos.ver', 'notas.ver']))?.ruta).toBe('notas');
  });

  it('no inventa uno si no tiene ninguno', () => {
    // Sin esto, alguien sin permisos caeria en una ruta que no existe.
    expect(primerModulo(new Set(['caja.eliminar']))).toBeNull();
    expect(rutaDeInicio(new Set())).toBeNull();
  });

  it('da la ruta con la barra inicial', () => {
    expect(rutaDeInicio(new Set(['clientes.ver']))).toBe('/clientes');
  });
});

describe('el catalogo', () => {
  it('tiene los quince modulos del backend', () => {
    // Es un candado, no una descripcion: si el backend gana un modulo y
    // este archivo no, el modulo nuevo es invisible en la app y nadie se
    // da cuenta hasta que alguien lo pide. Son los quince routers de
    // negocio que monta `app.ts`, sin `salud` ni `auth`.
    expect(MODULOS).toHaveLength(15);
    expect(MENU.length).toBeGreaterThan(1);
  });
});
