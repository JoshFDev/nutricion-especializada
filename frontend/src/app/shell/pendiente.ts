import { Component, input } from '@angular/core';

/**
 * La pantalla de un modulo que todavia no existe.
 *
 * Existe para que el shell se pueda ver completo antes de que haya una sola
 * pantalla de negocio, y sobre todo para que las rutas del menu sean REALES
 * desde el primer dia: un menu con entradas que dan 404 se vive un rato
 * ("ya lo hare") y se vive mal, porque parece que la app esta rota.
 *
 * Cuando un modulo tenga pantalla, lo unico que hay que cambiar es el
 * `loadComponent` de su entrada en `app.routes.ts`; el menu, el permiso y
 * la ruta no se tocan. Ver `nucleo/menu.ts`.
 *
 * Los dos `input` los llena solo `withComponentInputBinding` con el `data`
 * de la ruta, por eso no hay que pedir el `ActivatedRoute`.
 */
@Component({
  selector: 'app-pendiente',
  template: `
    <section class="vacio">
      <h1>{{ etiqueta() }}</h1>
      <p>{{ pendiente() }}</p>
      <p class="nota">
        Esta pantalla todavia no esta hecha. El menu, el permiso y la ruta ya funcionan: lo que
        falta es la pantalla.
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
      color: var(--texto-tenue);
    }
  `,
})
export class Pendiente {
  readonly etiqueta = input.required<string>();
  readonly pendiente = input.required<string>();
}
