import { animate, query, stagger, style, transition, trigger } from '@angular/animations';
import { signal, type Signal } from '@angular/core';

/**
 * Contador de recargas de una tabla.
 *
 * Existe por lo que NO hay que animar la primera vez.
 *
 * El trigger va con `transition(':increment')`, que solo dispara cuando el
 * valor cambia de un numero a otro mayor. Antes era `* => *`, que tambien
 * dispara en el primer render: al entrar a una pantalla nueva el `tbody`
 * aparecia de cero, las 25-50 filas entraban escalonadas otra vez encima del
 * cambio de pagina, y eso es justo lo que se veía como un salto.
 *
 * Con el contador las filas entran animadas SOLO cuando cambian los datos
 * (pagina, filtro, busqueda, un alta o un borrado). Entrar a la pantalla las
 * deja pintadas de una, y el cambio de pagina lo lleva la transicion de
 * `withViewTransitions`.
 *
 * El uso es siempre el mismo: declararlo, marcar en el unico sitio donde se
 * escriben las filas, y enlazarlo en la tabla.
 */
export class Recarga {
  private readonly n = signal(0);

  /** El valor que se enlaza al trigger. */
  readonly valor: Signal<number> = this.n.asReadonly();

  /** Suma uno: hay filas nuevas que pintar. */
  marcar(): void {
    this.n.update((v) => v + 1);
  }
}

/**
 * La cascada de entrada de las filas de una tabla.
 *
 * Se enlaza a `Recarga.valor()`, no a las filas: enlazarla a las filas haria
 * que cambiar el contenido de una fila contase como recarga.
 *
 * El escalonado va corto a proposito. Con `stagger(50)` una tabla de 50 filas
 * tardaba mas de dos segundos y medio en terminar de entrar, y durante todo
 * ese tiempo las filas seguian cayendo: eso se lee como lentitud, no como
 * suavidad. Con 18 ms y 220 ms la entrada se siente rapida sin llegar a ser
 * un salto seco.
 *
 * No hay animacion de salida. La de antes (`stagger(50)` con 200 ms por fila)
 * hacia que Angular esperara a terminar de sacar 50 filas antes de poner las
 * nuevas, y en una pantalla con dos tablas eso se nota como pagina trabada.
 * Las filas viejas desaparecen y las nuevas entran; la tabla cambia de golpe,
 * que es lo que se espera al cambiar de pagina o de filtro.
 */
export const filasAnimation = trigger('filasAnimation', [
  transition(':increment', [
    query(
      ':enter',
      [
        style({ opacity: 0, transform: 'translateY(6px)' }),
        stagger(18, [
          animate('220ms cubic-bezier(0.2, 0, 0, 1)', style({ opacity: 1, transform: 'none' })),
        ]),
      ],
      { optional: true },
    ),
  ]),
]);
