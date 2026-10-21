import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { API, errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';

/**
 * El cambio de contraseña obligatorio.
 *
 * A esta pantalla se llega solo cuando el sistema dice que la contraseña
 * caducó (`debe_cambiar_contrasena`), y desde ahí no se sale hasta que se
 * cambie: `guardaSesion` manda aquí cualquier otra ruta. El botón de salir sí
 * está disponible, para que alguien a quien el cambio no le sale no se quede
 * encerrado.
 *
 * Lo que se hace aquí y no en un servicio con nombre propio es la llamada: es
 * la única petición de la aplicación que no va a un módulo del sistema, así
 * que no vale la pena abrirle un archivo de servicio de tres líneas.
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

  readonly form = this.fb.nonNullable.group(
    {
      actual: ['', [Validators.required]],
      nueva: [
        '',
        [
          Validators.required,
          // Las mismas reglas que el sistema, y solo para no mandar a rechazar
          // lo que el navegador ya puede decir. La regla que vale es la del
          // sistema: si alguien la evade haciendo la petición a mano, allá se le
          // para.
          Validators.minLength(12),
          Validators.maxLength(200),
          Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/),
        ],
      ],
      repetir: ['', [Validators.required]],
    },
    {
      /**
       * La nueva tiene que ser DISTINTA de la actual.
       *
       * Es una regla del grupo y no del control, porque depende de los dos
       * campos a la vez. El sistema la pide (si no, la contraseña "nueva"
       * seria la misma de antes y no habria cambiado nada), asi que el
       * navegador tambien la pide: si no, la persona se lleva un 422 sin
       * saber por que.
       */
      validators: [
        (grupo) =>
          grupo.get('actual')?.value !== '' &&
          grupo.get('nueva')?.value === grupo.get('actual')?.value
            ? { distinta: true }
            : null,
      ],
    },
  );

  readonly error = signal<string | null>(null);
  /** El error pegado a un campo, cuando el sistema lo señaló con nombre. */
  readonly errorActual = signal<string | null>(null);
  /** El error pegado al campo de la contraseña nueva. */
  readonly errorNueva = signal<string | null>(null);
  readonly exito = signal<string | null>(null);
  readonly enviando = signal(false);

  /** Qué tan lejos está la nueva contraseña de las reglas. */
  readonly reglas = {
    largo: () => this.form.controls.nueva.value.length >= 12,
    minuscula: () => /[a-z]/.test(this.form.controls.nueva.value),
    mayuscula: () => /[A-Z]/.test(this.form.controls.nueva.value),
    numero: () => /\d/.test(this.form.controls.nueva.value),
    distinta: () => this.form.controls.nueva.value !== this.form.controls.actual.value,
  };

  /**
   * Si las dos tecleadas no son iguales, es casi siempre un tecleo mal, no una
   * intención. Va antes de mandar nada.
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
    this.errorActual.set(null);
    this.errorNueva.set(null);
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

      // El sistema deja viva ESTA sesión a propósito y ya puso la bandera en
      // false en la base. Hay que replicarlo aquí o la guarda que obliga a
      // cambiar la contraseña vuelve a apuntar a esta pantalla y la persona se
      // queda dando vueltas.
      this.sesion.marcarContrasenaCambiada();
      this.enviando.set(false);

      // «0 sesiones» suena a que no pasó nada, así que no se dice nada.
      const otras = respuesta.sesionesCerradas;
      this.exito.set(
        otras > 0
          ? `Contraseña cambiada. Se cerraron ${otras} sesión${
              otras === 1 ? '' : 'es'
            } abierta${otras === 1 ? '' : 's'} en otros equipos.`
          : 'Contraseña cambiada.',
      );

      // Salta al inicio a los tres segundos. Con un temporizador y no con
      // `setTimeout` suelto para poder cancelarlo si la persona se queda.
      setTimeout(() => void this.router.navigate(['/']), 2500);
    } catch (e) {
      this.enviando.set(false);

      // El caso normal de aquí es que la contraseña ACTUAL esté mal, y el
      // sistema lo reporta como validación del campo `actual`. Se pega al campo
      // y no arriba, porque un error flotando sin saber de qué se trata hace
      // que la persona cambie la nueva otra vez.
      const legible = errorLegible(e);
      const deActual = legible.detalles.find((d) => d.campo === 'actual');
      if (deActual) {
        this.errorActual.set(deActual.problema);
        return;
      }
      /**
       * Y lo mismo con la NUEVA.
       *
       * El sistema valida la nueva con dos reglas que el navegador no
       * comprueba: que no sea mas larga de 200 caracteres y que sea
       * DISTINTA de la actual. Sin esto, la persona que escribe la misma
       * contrasena recibia un 422 con el texto generico "Revisa los
       * datos enviados", sin saber cual de los dos campos era el
       * problema, y lo repetia.
       */
      const deNueva = legible.detalles.find((d) => d.campo === 'nueva');
      if (deNueva) {
        this.errorNueva.set(deNueva.problema);
        return;
      }
      this.error.set(legible.mensaje);
    }
  }

  async salir(): Promise<void> {
    // Igual que en el marco: sin esperar al sistema, para que la salida no se
    // quede colgada viendo a la pantalla.
    this.sesion.salir();
    await this.router.navigate(['/login']);
  }
}
