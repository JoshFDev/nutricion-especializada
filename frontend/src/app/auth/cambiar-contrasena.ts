import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { API, errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';

/**
 * El cambio de contrasena obligatorio.
 *
 * A esta pantalla se llega solo cuando el backend dice que la contrasena
 * caduco (`debe_cambiar_contrasena`), y desde ahi no se sale hasta que se
 * cambie: `guardaSesion` manda a aqui cualquier otra ruta. El boton de
 * salir si esta disponible, para que alguien a quien el cambio no le sale
 * no se quede encerrado.
 *
 * Lo que se hace aqui y no en un servicio con nombre propio es la llamada:
 * es la unica peticion de la app que no va a un modulo del backend, asi
 * que no vale la pena abrirle un archivo de servicio de tres lineas.
 */
@Component({
  selector: 'app-cambiar-contrasena',
  imports: [ReactiveFormsModule],
  templateUrl: './cambiar-contrasena.html',
  styleUrl: './cambiar-contrasena.scss',
})
export class CambiarContrasena {
  private readonly fb = inject(FormBuilder);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly sesion = inject(Sesion);

  readonly form = this.fb.nonNullable.group({
    actual: ['', [Validators.required]],
    nueva: [
      '',
      [
        Validators.required,
        // Las mismas reglas que el backend, y solo para no mandar a
        // rechazar al servidor lo que el navegador ya puede decir. La regla
        // que vale es la del servidor: si alguien la evade haciendo la
        // peticion a mano, alla se le para.
        Validators.minLength(12),
        Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/),
      ],
    ],
    repetir: ['', [Validators.required]],
  });

  readonly error = signal<string | null>(null);
  /** El error pegado a un campo, cuando el backend lo senalo con nombre. */
  readonly errorActual = signal<string | null>(null);
  readonly exito = signal<string | null>(null);
  readonly enviando = signal(false);

  /** Que tan lejos esta la nueva contrasena de las reglas. */
  readonly reglas = {
    largo: () => this.form.controls.nueva.value.length >= 12,
    minuscula: () => /[a-z]/.test(this.form.controls.nueva.value),
    mayuscula: () => /[A-Z]/.test(this.form.controls.nueva.value),
    numero: () => /\d/.test(this.form.controls.nueva.value),
    distinta: () => this.form.controls.nueva.value !== this.form.controls.actual.value,
  };

  /**
   * Si las dos tecleadas no son iguales, es casi siempre un tecleo mal, no
   * una intention. Va antes de mandar nada.
   */
  get repetirNoCoincide(): boolean {
    const control = this.form.controls.repetir;
    return (
      control.touched &&
      control.value.length > 0 &&
      control.value !== this.form.controls.nueva.value
    );
  }

  get nuevaCumple(): boolean {
    return Object.values(this.reglas).every((regla) => regla());
  }

  async cambiar(): Promise<void> {
    this.error.set(null);
    this.enviando.set(true);
    this.form.markAllAsTouched();

    if (this.form.invalid || this.repetirNoCoincide) {
      this.enviando.set(false);
      return;
    }

    const { actual, nueva } = this.form.getRawValue();

    try {
      const respuesta = await firstValueFrom(
        this.http.post<{ sesionesCerradas: number }>(`${API}/auth/cambiar-contrasena`, {
          actual,
          nueva,
        }),
      );

      // El backend deja viva ESTA sesion a proposito y ya puso la bandera
      // en false en la base. Hay que replicarlo aqui o la guarda que obliga
      // a cambiar la contrasena vuelve a apuntar a esta pantalla y la
      // persona se queda dando vueltas.
      this.sesion.marcarContrasenaCambiada();
      this.enviando.set(false);

      // "0 sesiones" suena a que no paso nada, asi que no se dice nada.
      const otras = respuesta.sesionesCerradas;
      this.exito.set(
        otras > 0
          ? `Contrasena cambiada. Se cerraron ${otras} sesion${
              otras === 1 ? '' : 'es'
            } abierta${otras === 1 ? '' : 's'} en otros equipos.`
          : 'Contrasena cambiada.',
      );

      // Al de tres segundos al inicio. Con un temporizador y no con
      // `setTimeout` suelto para poder cancelarlo si la persona se queda.
      setTimeout(() => void this.router.navigate(['/']), 2500);
    } catch (e) {
      this.enviando.set(false);

      // El caso normal de aqui es que la contrasena ACTUAL este mal, y el
      // backend lo reporta como validacion del campo `actual`. Se pega al
      // campo y no arriba, porque un error flotando sin saber de que se
      // trata hace que la persona cambie la nueva otra vez.
      const legible = errorLegible(e);
      const deActual = legible.detalles.find((d) => d.campo === 'actual');
      if (deActual) {
        this.errorActual.set(deActual.problema);
        return;
      }
      this.error.set(legible.mensaje);
    }
  }

  async salir(): Promise<void> {
    // Igual que en el shell: sin esperar al backend, para que la salida no
    // se quede colgada viendo a la pantalla.
    this.sesion.salir();
    await this.router.navigate(['/login']);
  }
}
