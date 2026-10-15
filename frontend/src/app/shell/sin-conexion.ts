import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Sesion } from '../nucleo/sesion';

/**
 * Se llegó aquí con una sesión que parece buena, pero el sistema no responde.
 *
 * `guardaSesion` manda a esta pantalla cuando `asegurarPerfil` falla, y casi
 * siempre es que el sistema está caído o que el origen de esta página no está
 * permitido. Un mensaje en blanco obligaría a adivinar, así que se ofrece
 * reintentar y no "cerrar sesión": si solo era que el sistema se estaba
 * reiniciando, la persona sigue dentro de la app y lo único que necesita es
 * un reintento.
 *
 * Nota para quien desarrolla: los detalles de cómo resolverlo (que el sistema
 * esté encendido y que el origen de esta página esté permitido en el sistema)
 * van abajo, en comentarios, y no se le muestran a quien usa el mostrador.
 */
@Component({
  selector: 'app-sin-conexion',
  template: `
    <main class="pantalla">
      <section class="tarjeta">
        <h1>No hay conexión</h1>
        <p>
          {{ mensaje() }}
        </p>
        <!--
          Para quien desarrolla: si esto sale en desarrollo, revisa que el
          sistema esté encendido (el que corre en esta computadora) y que el origen de esta
          página esté permitido en la configuración del sistema.
        -->
        <button type="button" (click)="reintentar()">Intentar de nuevo</button>
      </section>
    </main>
  `,
  styles: `
    .pantalla {
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 1.5rem;
      background: var(--fondo);
    }

    .tarjeta {
      max-width: 30rem;
      background: var(--superficie);
      border: 1px solid var(--borde);
      border-radius: 0.75rem;
      padding: 2rem 1.75rem;
    }

    h1 {
      margin: 0 0 0.75rem;
      font-size: 1.25rem;
    }

    p {
      color: var(--texto-suave);
      font-size: 0.9375rem;
    }

    button {
      width: 100%;
      padding: 0.6875rem;
      font: inherit;
      font-weight: 600;
      color: var(--sobre-acento);
      background: var(--acento);
      border: 0;
      border-radius: 0.5rem;
      cursor: pointer;
    }
  `,
})
export class SinConexion {
  private readonly router = inject(Router);
  private readonly sesion = inject(Sesion);

  readonly mensaje = (): string =>
    this.sesion.hayToken()
      ? 'Tu sesión sigue iniciada, pero no pudimos comprobar la conexión.'
      : 'No hay conexión con el sistema.';

  /**
   * Reintenta desde la pantalla de inicio, que es la que vuelve a preguntar
   * los permisos. La sesión sigue en su sitio: si el sistema ya responde, la
   * persona entra sola y no tiene que volver a escribir su contraseña.
   */
  async reintentar(): Promise<void> {
    await this.router.navigate(['/']);
  }
}
