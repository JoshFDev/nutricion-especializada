import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Catalogo } from '../catalogo/catalogo';

/**
 * La pantalla de Especies.
 *
 * Un wrapper sobre `Catalogo` con el recurso ya cerrado. El backend
 * construye las dos rutas del catalogo con la misma fabrica
 * (`construir(clave)` en `catalogo/rutas.ts`), y aqui la pantalla hace lo
 * mismo: las dos rutas del menu cargan este wrapper o el de categorias, y
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
    descripcion="La clasificación del producto que complementa a la categoría. Conviene darlas de alta primero: el formulario de /productos las ofrece para elegir."
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Especies {}
