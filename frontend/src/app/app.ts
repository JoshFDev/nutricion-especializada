import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * La raiz.
 *
 * No tiene ni una linea de plantilla propia: lo unico que hay es el hueco
 * donde el router mete la pantalla que toque. Todo lo demas (el shell, el
 * login) son rutas, y por eso recargar en `/notas` no pierde nada.
 *
 * El `display: block` va aqui y no en una regla de `styles.scss` por una
 * razon muy concreta. Un elemento desconocido (`app-root`) es `display:
 * inline`, y un inline que envuelve un bloque deja el espacio de la linea
 * debajo: el documento mide unos 4px mas que la pantalla y entonces el
 * scroll de la pagina reaparece, que es justo lo que el marco esta haciendo
 * para que no pase. Es la misma razon por la que las pantallas llevan
 * `:host { display: block }` en su scss.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
  styles: ':host { display: block; height: 100%; }',
})
export class App {}
