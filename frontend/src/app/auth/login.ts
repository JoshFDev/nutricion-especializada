import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { errorLegible } from '../nucleo/api';
import { Sesion } from '../nucleo/sesion';

/**
 * La pantalla de login.
 *
 * Lo unico no obvio aqui es que el boton se bloquea mientras la peticion
 * viaja: sin eso, el doble clic en un mostrador manda dos logins y el
 * segundo se come el error del primero (y el primero puede invalidar la
 * sesion del segundo, porque el backend invalida la anterior). Es un boton,
 * no una pantalla, pero es el que hace dano.
 *
 * El campo de contrasena se envia al backend y no se valida aqui: la regla
 * de la contrasena la aplica el servidor (ver `auth/esquemas.ts`), y
 * duplicarla en el front da la sensacion de que la regla es la del navegador.
 */
@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly ruta = inject(ActivatedRoute);
  private readonly sesion = inject(Sesion);

  /**
   * El acceso directo de desarrollo.
   *
   * `environment.produccion` vale `true` en el archivo de produccion y
   * `false` en el de desarrollo (los dos se说不te intercambian con
   * `fileReplacements` en `angular.json`), asi que este boton se dibuja
   * unicamente con `ng serve`.
   *
   * Y aun si el build de desarrollo acabara en un servidor por error, el
   * boton no serviria de nada: el backend monta esa ruta solo con
   * `NODE_ENV=development` (ver `app.ts` y `auth/rutas-dev.ts`), y en
   * produccion responde 404. El candado de verdad esta ahi; esto solo
   * esconde el boton.
   */
  readonly esDesarrollo = !environment.produccion;

  readonly form = this.fb.nonNullable.group({
    correo: ['', [Validators.required, Validators.email]],
    contrasena: ['', [Validators.required]],
  });

  /** El error de la API, ya en texto para pintar. */
  readonly error = signal<string | null>(null);
  readonly enviando = signal(false);

  /** Se muestra solo si el backend dijo que si. */
  readonly avisoSesionCerrada = signal(false);

  constructor() {
    // Si venia porque se le cayo la sesion, se dice. Una pantalla de login
    // en blanco sin explicacion hace pensar que la app fallo.
    this.avisoSesionCerrada.set(this.sesion.sesionPerdida());
  }

  /** Marca un campo como tocado, para que el error salga al salir de el. */
  tocado(campo: 'correo' | 'contrasena'): boolean {
    const control = this.form.controls[campo];
    return control.touched && control.invalid;
  }

  async entrar(): Promise<void> {
    this.error.set(null);
    this.enviando.set(true);
    this.form.markAllAsTouched();

    if (this.form.invalid) {
      this.enviando.set(false);
      return;
    }

    const { correo, contrasena } = this.form.getRawValue();

    try {
      const usuario = await this.sesion.entrar(correo.trim(), contrasena);
      this.enviando.set(false);
      await this.irAdondeCorresponde(usuario.debeCambiarContrasena);
    } catch (e) {
      this.enviando.set(false);
      this.error.set(errorLegible(e).mensaje);
    }
  }

  /**
   * El acceso directo de desarrollo va por `Sesion.entrarComo`, no por una
   * peticion suelta aqui: asi el token termina en `localStorage` por el
   * mismo camino que el login normal. Si esta pantalla lo guardara por su
   * cuenta habria dos lugares que saben como se guarda una sesion, y el que
   * se olvide de uno deja la app en un estado que no se puede reproducir.
   */
  async entrarComoAdministrador(): Promise<void> {
    this.error.set(null);
    this.enviando.set(true);
    try {
      const usuario = await this.sesion.entrarComo('Administrador');
      this.enviando.set(false);
      // El backend limpia el pendiente de contrasena de este usuario, asi
      // que aqui nunca se cae en la pantalla de cambiar la contrasena.
      await this.irAdondeCorresponde(usuario.debeCambiarContrasena);
    } catch (e) {
      this.enviando.set(false);
      this.error.set(errorLegible(e).mensaje);
    }
  }

  /**
   * A donde se va despues de entrar.
   *
   * Tres casos, en este orden:
   *
   * 1. El backend dice que la contrasena caducada (`debeCambiarContrasena`).
   *    Aunque venga un `returnUrl`, no se respeta: cambiar la contrasena es
   *    lo unico que se puede hacer, y la guarda lo va a exigir de todos
   *    modos. Saltarse ese salto da un rebote y una pantalla en blanco.
   * 2. Hay un `returnUrl` de una ruta por la que la persona venia cuando se
   *    le cayo la sesion.
   * 3. Si no, a la raiz, y de ahi `guardaInicio` la manda a su primer
   *    modulo.
   */
  private async irAdondeCorresponde(debeCambiar: boolean): Promise<void> {
    if (debeCambiar) {
      await this.router.navigate(['/cambiar-contrasena']);
      return;
    }

    const returnUrl = this.ruta.snapshot.queryParamMap.get('returnUrl');
    // Solo se acepta algo que empiece por `/` y NO por `//`: un
    // `returnUrl=https://otro-sitio` devuelto por el servidor (o puesto a
    // mano en la barra de direcciones) convertiria el login en un
    // redirigidor abierto.
    const seguro = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//');
    await this.router.navigateByUrl(seguro ? returnUrl : '/');
  }
}
