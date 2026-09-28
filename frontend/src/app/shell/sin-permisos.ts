import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { rutaDeInicio } from '../nucleo/menu';
import { Sesion } from '../nucleo/sesion';

/**
 * Se pidio un modulo al que el rol no llega.
 *
 * Llego aqui escribiendo la URL a mano, o porque el permiso se quito entre
 * que se dibujo el menu y que se hizo clic. Se da el enlace de vuelta al
 * inicio en vez de un 403 seco, porque 403 aqui no significa que la app
 * fallo sino que el camino no era ese.
 *
 * El menu tampoco lo ofrece (esta filtrado), asi que esto casi nunca se ve.
 */
@Component({
  selector: 'app-sin-permisos',
  imports: [RouterLink],
  template: `
    <section class="vacio">
      <h1>No tienes permiso para esa pantalla</h1>
      <p>
        Tu rol no incluye este modulo. El menu de la izquierda solo ensena lo que si puedes usar.
      </p>
      @if (inicio(); as ruta) {
        <p>
          <a [routerLink]="ruta">Volver a {{ ruta }}</a>
        </p>
      }
    </section>
  `,
  styles: `
    .vacio {
      max-width: 34rem;
    }

    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.25rem;
    }

    p {
      margin: 0 0 0.75rem;
      color: var(--texto-suave);
    }

    a {
      color: var(--acento);
    }
  `,
})
export class SinPermisos {
  private readonly sesion = inject(Sesion);

  /**
   * A donde volver. Si el rol no tiene ningun modulo, no hay a donde ir y
   * no se muestra el enlace: el mensaje se entiende solo y la pantalla
   * `SinModulos` ya esta esperando en el inicio.
   */
  readonly inicio = (): string | null =>
    rutaDeInicio(new Set(this.sesion.perfil()?.permisos ?? []));
}
