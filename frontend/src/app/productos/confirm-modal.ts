import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  template: `
    @if (visible()) {
      <!--
        El velo es un boton y no un div con click. Con el div el modal solo se
        cerraba con el raton: no habia nada que tabular, ni nada que contestara
        al teclado. Con el boton, ademas de cerrarse con un clic, se cierra
        tabulando hasta el y pulsando Return o espacio, que es lo que se espera
        de un velo.
        se espera de un velo.

        Va antes del modal en el DOM y con aria-label porque es lo unico
        enfocable antes de llegar a los botones del dialogo, asi que es por donde
        arranca el recorrido del teclado.
      -->
      <button type="button" class="overlay" aria-label="Cerrar" (click)="cerrar()"></button>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-titulo">
        <h3 id="confirm-titulo">{{ titulo() }}</h3>
        <p>{{ mensaje() }}</p>
        <div class="acciones">
          <button type="button" class="chico" (click)="cerrar()">Cancelar</button>
          <button
            type="button"
            class="primario"
            [class.peligro]="variante() === 'peligro'"
            [class.advertencia]="variante() === 'advertencia'"
            (click)="confirmar()"
          >
            {{ textoConfirmar() }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .overlay {
        position: fixed;
        inset: 0;
        padding: 0;
        background: rgba(0, 0, 0, 0.4);
        border: 0;
        z-index: 1000;
        animation: fadeIn 0.15s ease-out;
        cursor: default;
      }

      .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: var(--superficie);
        border: 1px solid var(--borde);
        border-radius: 8px;
        padding: 1.25rem;
        min-width: 320px;
        max-width: 400px;
        z-index: 1001;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
        animation: slideUp 0.2s ease-out;
      }

      h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        font-weight: 600;
        color: var(--texto);
      }

      p {
        margin: 0 0 1.25rem;
        color: var(--texto-suave);
        line-height: 1.5;
      }

      .acciones {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      button {
        padding: 0.5rem 1rem;
        font: inherit;
        border-radius: 6px;
        cursor: pointer;
        transition:
          background-color 0.15s,
          border-color 0.15s,
          color 0.15s;
      }

      button.chico {
        color: var(--texto);
        background: var(--superficie);
        border: 1px solid var(--borde);
      }

      button.chico:hover {
        background: var(--fondo);
      }

      /* Botón primario base - blanco/transparente hasta hover */
      button.primario {
        color: var(--texto);
        background: transparent;
        border: 1px solid var(--borde);
      }

      button.primario:hover {
        background: var(--fondo);
      }

      /* Variante advertencia (amarillo) - para dar de baja */
      button.primario.advertencia {
        color: var(--advertencia-texto);
        border-color: var(--advertencia);
      }

      button.primario.advertencia:hover {
        background: var(--advertencia);
        color: var(--sobre-advertencia);
      }

      /* Variante peligro (rojo) - para eliminar */
      button.primario.peligro {
        color: var(--peligro-texto);
        border-color: var(--peligro);
      }

      button.primario.peligro:hover {
        background: var(--peligro);
        color: var(--sobre-peligro);
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translate(-50%, -40%);
        }
        to {
          opacity: 1;
          transform: translate(-50%, -50%);
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmModal {
  visible = signal(false);
  titulo = signal('Confirmar');
  mensaje = signal('');
  textoConfirmar = signal('Confirmar');
  variante = signal<'peligro' | 'advertencia' | 'normal'>('normal');

  private resolveFn: ((value: boolean) => void) | null = null;

  abrir(opciones: {
    titulo?: string;
    mensaje: string;
    textoConfirmar?: string;
    variante?: 'peligro' | 'advertencia' | 'normal';
  }): Promise<boolean> {
    this.titulo.set(opciones.titulo ?? 'Confirmar');
    this.mensaje.set(opciones.mensaje);
    this.textoConfirmar.set(opciones.textoConfirmar ?? 'Confirmar');
    this.variante.set(opciones.variante ?? 'normal');
    this.visible.set(true);

    return new Promise((resolve) => {
      this.resolveFn = resolve;
    });
  }

  confirmar(): void {
    this.visible.set(false);
    if (this.resolveFn) {
      this.resolveFn(true);
      this.resolveFn = null;
    }
  }

  cerrar(): void {
    this.visible.set(false);
    if (this.resolveFn) {
      this.resolveFn(false);
      this.resolveFn = null;
    }
  }
}
