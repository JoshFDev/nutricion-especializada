import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Catalogo } from '../catalogo/catalogo';

/**
 * La pantalla de Categorias.
 *
 * Un wrapper sobre `Catalogo` con el recurso ya cerrado. Igual que el
 * backend construye las dos rutas del catalogo con la misma fabrica
 * (`construir(clave)` en `catalogo/rutas.ts`), las dos pantallas del menu
 * cargan este wrapper o el de especies, y lo que de verdad hace falta
 * (listado, editor, borrado) vive en `catalogo/`.
 */
@Component({
  selector: 'app-categorias',
  imports: [Catalogo],
  template: `<app-catalogo
    recurso="categorias"
    titulo="Categorias"
    singular="Categoría"
    descripcion="Los grupos con los que se ordenan los productos, para encontrarlos de un vistazo. Conviene darlas de alta primero: el formulario de /productos las ofrece para elegir."
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Categorias {}
