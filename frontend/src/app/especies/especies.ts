import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Catalogo } from '../catalogo/catalogo';

/**
 * La pantalla de Especies.
 *
 * Una envoltura sobre `Catalogo` con el recurso ya cerrado. El sistema
 * construye las dos rutas del catalogo con la misma fabrica
 * (`construir(clave)` en `catalogo/rutas.ts`), y aqui la pantalla hace lo
 * mismo: las dos rutas del menu cargan esta envoltura o la de categorias, y
 * el de verdad (listado, editor, borrado) vive en `catalogo/`, no en dos
 * copias casi iguales.
 */
@Component({
  selector: 'app-especies',
  imports: [Catalogo],
  template: `<app-catalogo
    recurso="especies"
    titulo="Especies"
    singular="Especie"
    descripcion="El tipo de animal o cliente, que ayuda a poner el precio. Conviene crearlos primero: después aparecen al dar de alta un producto."
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Especies {}
