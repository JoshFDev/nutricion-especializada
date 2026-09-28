import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Sesion } from '../nucleo/sesion';

/**
 * Se llego aqui con un token que parece bueno pero el backend no responde.
 *
 * `guardaSesion` manda a esta pantalla cuando `asegurarPerfil` revienta, y
 * casi siempre es que el backend esta caido o que el origen no esta en
 * `CORS_ORIGINS`. Un 500 de la API o un "no se pudo conectar" pelado
 * obligan a adivinar, y esa adivinanza se hace en la guardia de las ocho
 * de la manana.
 *
 * Se ofrece volver a intentar y no "cerrar sesion" a secas: si es que el
 * servidor estaba reiniciando, la persona sigue dentro de la app y lo unico
 * que necesita es un reintento.
 */
@Component({
  selector: 'app-sin-conexion',
  template: `
    <main class="pantalla">
      <section class="tarjeta">
        <h1>No hay comunicacion con el servidor</h1>
        <p>
          {{ mensaje() }}
        </p>
        <ul>
          <li>
            El backend esta encendido (en desarrollo, <code>pnpm dev</code> dentro de
            <code>backend/</code>).
          </li>
          <li>El origen de esta pagina esta en <code>CORS_ORIGINS</code> del backend.</li>
        </ul>
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

    p,
    li {
      color: var(--texto-suave);
      font-size: 0.9375rem;
    }

    ul {
      padding-left: 1.25rem;
      margin: 0 0 1.25rem;
    }

    code {
      font-size: 0.875em;
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
      ? 'Tu sesion sigue guardada, pero no se pudo preguntar si continua viva.'
      : 'No se pudo contactar al servidor.';

  /**
   * Reintenta desde la ruta de inicio, que es la que vuelve a preguntar los
   * permisos. El token sigue en su sitio: si el servidor ya contesto, la
   * persona entra sola y no tiene que volver a escribir su contrasena.
   */
  async reintentar(): Promise<void> {
    await this.router.navigate(['/']);
  }
}
