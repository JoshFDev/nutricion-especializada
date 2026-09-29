import { describe, expect, it } from 'vitest';
import { cuerpoDeProveedor, type FormaProveedor } from './proveedores-api';

/**
 * El cuerpo del proveedor: lo que se manda al backend.
 *
 * Es la prueba de que la pantalla no normaliza distinto que el esquema de
 * `proveedores/esquemas.ts`. Lo que se comprueba aqui es lo que el esquema NO
 * hace: el nombre se limpia de los bordes (el backend no lo transforma) y los
 * opcionales en blanco viajan como `null`, que es como los guarda la base.
 *
 * Y lo que NO se manda tambien es parte del contrato: `saldo_actual` y
 * `activo` no aparecen en `CuerpoProveedor` porque el primero lo recalcula la
 * base y el segundo solo se puede cambiar por su cuenta (ver
 * `ProveedoresApi.alternarActivo`).
 */

function forma(parcial: Partial<FormaProveedor> = {}): FormaProveedor {
  return {
    nombre: 'Forrajeros del Norte',
    contacto: '',
    telefono: '',
    ...parcial,
  };
}

describe('el cuerpo del proveedor', () => {
  it('el nombre se manda limpio de los bordes', () => {
    // El nombre es la llave: es como lo busca el operador al capturar una
    // compra. "Forrajeros del Norte " y "Forrajeros del Norte" tienen que ser
    // el mismo proveedor, no dos.
    const cuerpo = cuerpoDeProveedor(forma({ nombre: '  Forrajeros del Norte  ' }));
    expect(cuerpo.nombre).toBe('Forrajeros del Norte');
  });

  it('NO mayusculiza el nombre, a diferencia del codigo de clientes', () => {
    // El esquema de `clientes/esquemas.ts` sube el codigo a mayusculas; el de
    // proveedores no toca el nombre, y convertirlo aqui dejaria el listado
    // refrescado mostrando un nombre distinto al que se tecleo.
    const cuerpo = cuerpoDeProveedor(forma({ nombre: 'forrajeros del norte' }));
    expect(cuerpo.nombre).toBe('forrajeros del norte');
  });

  it('los opcionales en blanco son null, no strings vacios', () => {
    const cuerpo = cuerpoDeProveedor(forma());
    expect(cuerpo.contacto).toBeNull();
    expect(cuerpo.telefono).toBeNull();
  });

  it('un opcional con texto se limpia pero no se vuelve null', () => {
    const cuerpo = cuerpoDeProveedor(
      forma({ contacto: '  Laura Mendez ', telefono: '  (614) 123-4567  ' }),
    );
    expect(cuerpo.contacto).toBe('Laura Mendez');
    expect(cuerpo.telefono).toBe('(614) 123-4567');
  });

  it('solo lleva los tres campos del esquema, ni saldo ni activo', () => {
    // Si se metiera `saldo_actual` o `activo` aqui, el `strict` del POST
    // los rechazaria con un 400. Esta prueba falla en cuanto alguien los
    // anade, que es justo cuando conviene enterarse.
    expect(Object.keys(cuerpoDeProveedor(forma())).sort()).toEqual([
      'contacto',
      'nombre',
      'telefono',
    ]);
  });
});
