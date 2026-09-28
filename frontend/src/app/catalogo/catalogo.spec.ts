import { describe, expect, it } from 'vitest';
import { cuerpoDeCatalogo, permisoDe, rutaDe } from './catalogo-api';

/**
 * Las diferencias entre especies y categorias, en un solo lugar.
 *
 * El resto del modulo es compartido; lo que no puede desincronizarse entre
 * las dos tablas es la URL y el prefijo de permiso, porque si un lado
 * cambia y el otro no, una de las dos pantallas deja de hablar con el
 * backend. Estas funciones son las UNICAS que saben la diferencia, y por
 * eso se prueban aqui y no en la pantalla.
 */

describe('la ruta de cada recurso', () => {
  it('categorias va a categorias-producto, su unica diferencia', () => {
    // El backend monta /api/categorias-producto y /api/especies
    // (`catalogo/controlador.ts`, `rutaDe`). Es el unico lugar donde el
    // nombre no es obvio.
    expect(rutaDe('categorias')).toBe('categorias-producto');
    expect(rutaDe('especies')).toBe('especies');
  });

  it('el permiso lleva el prefijo del recurso', () => {
    for (const accion of ['crear', 'editar', 'eliminar'] as const) {
      expect(permisoDe('categorias', accion)).toBe(`categorias.${accion}`);
      expect(permisoDe('especies', accion)).toBe(`especies.${accion}`);
    }
  });

  it('el cuerpo del catalogo solo lleva el nombre, limpio', () => {
    expect(cuerpoDeCatalogo('  Bovino  ')).toEqual({ nombre: 'Bovino' });
  });
});
