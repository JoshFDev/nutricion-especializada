import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * La raiz.
 *
 * No tiene ni una linea de plantilla propia: lo unico que hay es el hueco
 * donde el router mete la pantalla que toque. Todo lo demas (el shell, el
 * login) son rutas, y por eso recargar en `/notas` no pierde nada.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
