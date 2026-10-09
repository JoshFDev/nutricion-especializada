import { ChangeDetectionStrategy, Component } from '@angular/core';
import { Catalogo } from '../catalogo/catalogo';

/**
 * La pantalla de Almacenes.
 *
 * Un wrapper sobre `Catalogo` con el recurso ya cerrado. El backend
 * construye las tres rutas del catalogo con la misma fabrica
 * (`construir(clave)` en `catalogo/rutas.ts`), y aqui la pantalla hace lo
 * mismo: la ruta del menu carga este wrapper, igual que los de especies y
 * categorias, y el de verdad (listado, editor, borrado) vive en
 * `catalogo/`, no en tres copias casi iguales.
 *
 * Es la pantalla que le quita la bodega de encima a compras: el alta de
 * compras usa el almacen que hay, y si no hay ninguno la bodega se crea
 * aqui (una sola vez) en vez de con SQL a mano.
 */
@Component({
  selector: 'app-almacenes',
  imports: [Catalogo],
  template: `<app-catalogo
    recurso="almacenes"
    titulo="Almacenes"
    singular="Almacén"
    genero="m"
    descripcion="Las bodegas donde entra la mercancía. La crea el administrador una sola vez y el alta de compras la usa automáticamente; mientras haya al menos una, compras funciona."
  />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Almacenes {}
