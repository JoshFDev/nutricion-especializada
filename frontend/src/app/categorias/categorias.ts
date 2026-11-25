import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Catalogo } from '../catalogo/catalogo';

/**
 * La pantalla de Categorias.
 *
 * Una envoltura sobre `Catalogo` con el recurso ya cerrado. Igual que el
 * sistema construye las dos rutas del catalogo con la misma fabrica
 * (`construir(clave)` en `catalogo/rutas.ts`), las dos pantallas del menu
 * cargan esta envoltura o la de especies, y lo que de verdad hace falta
 * (listado, editor, borrado) vive en `catalogo/`.
 */
@Component({
  selector: 'app-categorias',
  imports: [Catalogo],
  template: `<app-catalogo
    recurso="categorias"
    titulo="Categorias"
    singular="Categoría"
    descripcion="Los grupos con los que ordenamos los productos para encontrarlos más rápido. Conviene crearlos primero: después aparecen al dar de alta un producto."
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Categorias {}
