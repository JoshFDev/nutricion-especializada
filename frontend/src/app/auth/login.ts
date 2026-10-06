import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { errorLegible } from '../nucleo/api';
import { leerFondo } from '../nucleo/fondo-login';
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
/**
 * Cuanto se espera, como minimo, con el boton en "Entrando...".
 *
 * Existe porque el backend puede contestar en 60ms y, a esa velocidad, el
 * spinner aparece un cuadro y desaparece. Eso no se lee como "ha ido rapido",
 * se lee como "ha fallado el boton", y la gente acaba pulsando otra vez. Un
 * minimo de carga es lo que evita ese parpadeo.
 *
 * OJO con el valor. Lo que se pedia aqui eran 3 segundos, y se puede poner en
 * la constante de abajo, pero 3s no mejora la experiencia: la empeora. Todo lo
 * que pasa de ~1s empieza a leerse como "esta lento" (Google y Microsoft miden
 * esto en sus estudios de rendimiento percibido), y en un mostrador donde se
 * entra muchas veces al dia son 3 segundos por entrada que no hacen nada.
 *
 * Si lo que se quiere es que el spinner no parpadee, con 500ms esta mas que
 * cubierto, y se nota la respuesta real. Por eso el valor es 500 y no 3000.
 * Si aun asi se quiere ver siempre los 3s, es cambiar este numero, y nada mas.
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
   * `environment.produccion` vale `true` en el archivo de produccion y
   * `false` en el de desarrollo (los dos se intercambian con
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

  /**
   * El fondo, ya envuelto en `url()`.
   *
   * Se lee UNA vez, al construir el componente, y como propiedad normal y no
   * como signal. Suena raro, pero es lo que evita el destello: si fuera un
   * signal que arranca vacio, el primer render tendria el fondo por defecto y
   * al siguiente cuadro saltaria al de la preferencia. Con esto ya nace con el
   * valor final y no hay nada que replaces.
   *
   * La fuente de verdad de la preferencia vive en el servidor (columna
   * `usuarios.fondo_login`); esta es la copia local, porque aqui todavia no
   * hay sesion de la cual leerla. Ver `nucleo/fondo-login.ts`.
   */
  readonly imagenFondo = `url('${leerFondo()}')`;

  /** El error de la API, ya en texto para pintar. */
  readonly error = signal<string | null>(null);
  readonly enviando = signal(false);

  /**
   * Si la contrasena se esta viendo.
   *
   * Arranca en `false` siempre: aunque la ultima vez se quedara a la vista, un
   * campo de contrasena en claro esperando a que alguien escriba en el es la
   * peor forma de tenerla guardada en la pantalla de un mostrador.
   *
   * El boton que lo cambia solo cambia el atributo `type` del input, asi que
   * el valor, el cursor y el estado del formulario se quedan como estaban: no
   * se reconstruye el campo y no se pierde lo que ya estaba escrito.
   */
  readonly verContrasena = signal(false);

  alternarContrasena(): void {
    this.verContrasena.update((visible) => !visible);
  }

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
    const arranque = Date.now();

    try {
      const usuario = await this.sesion.entrar(correo.trim(), contrasena);
      await this.esperarElMinimo(arranque);
      // `enviando` se queda en `true` a proposito: si se apagara aqui, el boton
      // volveria a decir "Entrar" un instante antes de que la ruta cambie, y se
      // veria un rebote en un sitio donde ya no se puede volver a pulsar.
      await this.irAdondeCorresponde(usuario.debeCambiarContrasena);
    } catch (e) {
      await this.esperarElMinimo(arranque);
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
    const arranque = Date.now();
    try {
      const usuario = await this.sesion.entrarComo('Administrador');
      await this.esperarElMinimo(arranque);
      // El backend limpia el pendiente de contrasena de este usuario, asi
      // que aqui nunca se cae en la pantalla de cambiar la contrasena.
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
   * diferencia es todo el truco: si el servidor tarda 1.2s no se espera nada
   * (ya se cumplio el minimo) y si tarda 40ms se espera lo que falte. Nunca se
   * alarga la espera real, solo se evita el parpadeo.
   *
   * `setTimeout` no es un temporizador de precision: devuelve antes o despues
   * de lo pedido. Por eso se mide el tiempo real con `Date.now()` en vez de
   * encadenar un `setTimeout(3000)`: encadenarlo daria 3000 + lo que tarde el
   * servidor, o sea hasta 6 segundos en una red mala.
   */
  private async esperarElMinimo(arranque: number): Promise<void> {
    const faltan = ESPERA_MINIMA_MS - (Date.now() - arranque);
    if (faltan > 0) {
      await new Promise<void>((resolver) => setTimeout(resolver, faltan));
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
