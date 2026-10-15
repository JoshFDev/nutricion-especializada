import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { errorLegible } from '../nucleo/api';
import { leerFondo } from '../nucleo/fondo-login';
import { Sesion } from '../nucleo/sesion';

/**
 * La pantalla de inicio de sesión.
 *
 * Lo único no obvio aquí es que el botón se bloquea mientras la petición
 * viaja: sin eso, el doble clic en un mostrador manda dos inicios de sesión y
 * el segundo se come el error del primero (y el primero puede invalidar la
 * sesión del segundo, porque el sistema invalida la anterior). Es un botón,
 * no una pantalla, pero es el que hace daño.
 *
 * El campo de contraseña se manda al sistema y no se valida aquí: la regla de
 * la contraseña la aplica el sistema (ver `auth/esquemas.ts`), y duplicarla en
 * la pantalla da la sensación de que la regla es la del navegador.
 */
/**
 * Cuánto se espera, como mínimo, con el botón en «Entrando...».
 *
 * Existe porque el sistema puede contestar en 60 ms y, a esa velocidad, el
 * spinner aparece un cuadro y desaparece. Eso no se lee como «ha ido rápido»,
 * se lee como «ha fallado el botón», y la gente acaba pulsando otra vez. Un
 * mínimo de carga es lo que evita ese parpadeo.
 *
 * OJO con el valor. Lo que se pedía aquí eran 3 segundos, y se puede poner en
 * la constante de abajo, pero 3 s no mejora la experiencia: la empeora. Todo
 * lo que pasa de ~1 s empieza a leerse como «está lento» (Google y Microsoft
 * miden esto en sus estudios de rendimiento percibido), y en un mostrador
 * donde se entra muchas veces al día son 3 segundos por entrada que no hacen
 * nada.
 *
 * Si lo que se quiere es que el spinner no parpadee, con 500 ms está más que
 * cubierto, y se nota la respuesta real. Por eso el valor es 500 y no 3000.
 * Si aun así se quiere ver siempre los 3 s, es cambiar este número, y nada
 * más.
 */
const ESPERA_MINIMA_MS = 500;

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
   * `environment.produccion` vale `true` en el archivo de producción y `false`
   * en el de desarrollo (los dos se intercambian con `fileReplacements` en
   * `angular.json`), así que este botón se dibuja únicamente con `ng serve`.
   *
   * Y aun si la compilación de desarrollo se publicara por error, el botón no
   * serviría de nada: el sistema monta esa ruta solo con
   * `NODE_ENV=development` (ver `app.ts` y `auth/rutas-dev.ts`), y en
   * producción responde 404. El candado de verdad está ahí; esto solo esconde
   * el botón.
   */
  readonly esDesarrollo = !environment.produccion;

  readonly form = this.fb.nonNullable.group({
    correo: ['', [Validators.required, Validators.email]],
    contrasena: ['', [Validators.required]],
  });

  /**
   * El fondo, ya envuelto en `url()`.
   *
   * Se lee UNA vez, al construir el componente, y como propiedad normal y no
   * como `signal`. Suena raro, pero es lo que evita el destello: si fuera un
   * `signal` que arranca vacío, el primer dibujo tendría el fondo por defecto
   * y al siguiente cuadro saltaría al de la preferencia. Con esto ya nace con
   * el valor final y no hay nada que reemplace.
   *
   * La fuente de verdad de la preferencia vive en el sistema (columna
   * `usuarios.fondo_login`); esta es la copia local, porque aquí todavía no
   * hay sesión de la cual leerla. Ver `nucleo/fondo-login.ts`.
   */
  readonly imagenFondo = `url('${leerFondo()}')`;

  /** El error del servicio, ya en texto para pintar. */
  readonly error = signal<string | null>(null);
  readonly enviando = signal(false);

  /**
   * Si la contraseña se está viendo.
   *
   * Arranca en `false` siempre: aunque la última vez se quedara a la vista, un
   * campo de contraseña en claro esperando a que alguien escriba en él es la
   * peor forma de tenerla guardada en la pantalla de un mostrador.
   *
   * El botón que lo cambia solo cambia el atributo `type` del campo, así que
   * el valor, el cursor y el estado del formulario se quedan como estaban: no
   * se reconstruye el campo y no se pierde lo que ya estaba escrito.
   */
  readonly verContrasena = signal(false);

  alternarContrasena(): void {
    this.verContrasena.update((visible) => !visible);
  }

  /** Se muestra solo si el sistema dijo que sí. */
  readonly avisoSesionCerrada = signal(false);

  constructor() {
    // Si venía porque se le cayó la sesión, se dice. Una pantalla de inicio de
    // sesión en blanco sin explicación hace pensar que la aplicación falló.
    this.avisoSesionCerrada.set(this.sesion.sesionPerdida());
  }

  /** Marca un campo como tocado, para que el error salga al salir de él. */
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
    const arranque = Date.now();

    try {
      const usuario = await this.sesion.entrar(correo.trim(), contrasena);
      await this.esperarElMinimo(arranque);
      // `enviando` se queda en `true` a propósito: si se apagara aquí, el botón
      // volvería a decir «Entrar» un instante antes de que la ruta cambie, y se
      // vería un rebote en un sitio donde ya no se puede volver a pulsar.
      await this.irAdondeCorresponde(usuario.debeCambiarContrasena);
    } catch (e) {
      await this.esperarElMinimo(arranque);
      this.enviando.set(false);
      this.error.set(errorLegible(e).mensaje);
    }
  }

  /**
   * El acceso directo de desarrollo va por `Sesion.entrarComo`, no por una
   * petición suelta aquí: así la credencial termina en `localStorage` por el
   * mismo camino que el inicio de sesión normal. Si esta pantalla lo guardara
   * por su cuenta habría dos lugares que saben cómo se guarda una sesión, y el
   * que se olvide de uno deja la aplicación en un estado que no se puede
   * reproducir.
   */
  async entrarComoAdministrador(): Promise<void> {
    this.error.set(null);
    this.enviando.set(true);
    const arranque = Date.now();
    try {
      const usuario = await this.sesion.entrarComo('Administrador');
      await this.esperarElMinimo(arranque);
      // El sistema limpia el pendiente de contraseña de este usuario, así que
      // aquí nunca se cae en la pantalla de cambiar la contraseña.
      await this.irAdondeCorresponde(usuario.debeCambiarContrasena);
    } catch (e) {
      await this.esperarElMinimo(arranque);
      this.enviando.set(false);
      this.error.set(errorLegible(e).mensaje);
    }
  }

  /**
   * No apaga el spinner antes de que haya pasado `ESPERA_MINIMA_MS` desde el
   * clic.
   *
   * Se mide contra el momento del clic y no contra el de la respuesta, y esa
   * diferencia es todo el truco: si el sistema tarda 1.2 s no se espera nada
   * (ya se cumplió el mínimo) y si tarda 40 ms se espera lo que falte. Nunca
   * se alarga la espera real, solo se evita el parpadeo.
   *
   * `setTimeout` no es un temporizador de precisión: devuelve antes o después
   * de lo pedido. Por eso se mide el tiempo real con `Date.now()` en vez de
   * encadenar un `setTimeout(3000)`: encadenarlo daría 3000 + lo que tarde el
   * sistema, o sea hasta 6 segundos en una red mala.
   */
  private async esperarElMinimo(arranque: number): Promise<void> {
    const faltan = ESPERA_MINIMA_MS - (Date.now() - arranque);
    if (faltan > 0) {
      await new Promise<void>((resolver) => setTimeout(resolver, faltan));
    }
  }

  /**
   * A dónde se va después de entrar.
   *
   * Tres casos, en este orden:
   *
   * 1. El sistema dice que la contraseña caducó (`debeCambiarContrasena`).
   *    Aunque venga un `returnUrl`, no se respeta: cambiar la contraseña es
   *    lo único que se puede hacer, y la guarda lo va a exigir de todos
   *    modos. Saltarse ese salto da un rebote y una pantalla en blanco.
   * 2. Hay un `returnUrl` de una ruta por la que la persona venía cuando se
   *    le cayó la sesión.
   * 3. Si no, a la raíz, y de ahí `guardaInicio` la manda a su primer
   *    módulo.
   */
  private async irAdondeCorresponde(debeCambiar: boolean): Promise<void> {
    if (debeCambiar) {
      await this.router.navigate(['/cambiar-contrasena']);
      return;
    }

    const returnUrl = this.ruta.snapshot.queryParamMap.get('returnUrl');
    // Solo se acepta algo que empiece por `/` y NO por `//`: un
    // `returnUrl=https://otro-sitio` devuelto por el sistema (o puesto a
    // mano en la barra de direcciones) convertiría el inicio de sesión en un
    // redirigidor abierto.
    const seguro = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//');
    await this.router.navigateByUrl(seguro ? returnUrl : '/');
  }
}
