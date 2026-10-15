import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * La raíz.
 *
 * No tiene ni una línea de plantilla propia: lo único que hay es el hueco
 * donde el enrutador mete la pantalla que toque. Todo lo demás (el marco, el
 * inicio de sesión) son rutas, y por eso recargar en `/notas` no pierde nada.
 *
 * El `display: block` va aquí y no en una regla de `styles.scss` por una
 * razón muy concreta. Un elemento desconocido (`app-root`) es `display:
 * inline`, y un inline que envuelve un bloque deja el espacio de la línea
 * debajo: el documento mide unos 4px más que la pantalla y entonces el
 * scroll de la página reaparece, que es justo lo que el marco está haciendo
 * para que no pase. Es la misma razón por la que las pantallas llevan
 * `:host { display: block }` en su scss.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
  styles: ':host { display: block; height: 100%; }',
})
export class App {}
