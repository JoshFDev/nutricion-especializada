import { Component, inject } from '@angular/core';
import { Sesion } from '../nucleo/sesion';

/**
 * El caso de un rol sin ningun modulo.
 *
 * Es raro pero real: alguien con un rol recien creado, o al que le quitaron
 * todo. La app no puede dejarlo en un menu vacio sin explicacion, porque
 * desde adentro parece que la app fallo.
 */
@Component({
  selector: 'app-sin-modulos',
  template: `
    <section class="vacio">
      <h1>No tienes ningun modulo abierto</h1>
      <p>
        Tu usuario <strong>{{ nombre() }}</strong> si puede entrar, pero su rol no tiene ningun
        modulo asignado todavia.
      </p>
      <p class="nota">
        Un administrador tiene que abrirte algo en <em>Usuarios y roles</em>. En cuanto lo haga,
        recarga la pagina y el menu aparece solo: la app vuelve a preguntar los permisos cada vez
        que se abre.
      </p>
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

    .nota {
      font-size: 0.875rem;
    }
  `,
})
export class SinModulos {
  private readonly sesion = inject(Sesion);

  readonly nombre = (): string => this.sesion.perfil()?.nombre ?? '';
}
