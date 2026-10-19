import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ActivatedRouteSnapshot, CanActivateFn, RouterStateSnapshot } from '@angular/router';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { API } from './api';
import { guardaSesion, guardaSinSesion } from './guarda-sesion';
import { Sesion } from './sesion';

/**
 * Las guardas son donde mas facil es dejar un ciclo de redirecciones: devuelven
 * un `UrlTree` y el router vuelve a preguntar, y si el destino es la misma ruta
 * en la que estan paradas, ninguna navegacion termina jamas y la pagina queda
 * en blanco. Por eso se prueban con el router de verdad y con la sesion de
 * verdad (con la conexion simulada), no con un mock de un metodo.
 */
describe('las guardas de sesion', () => {
  let http: HttpTestingController;

  const perfil = {
    id: 7,
    nombre: 'Cajera',
    email: 'cajera@ejemplo.mx',
    puesto: 'Cajero',
    debeCambiarContrasena: false,
    permisos: ['notas.ver'],
    roles: ['cajero'],
  };

  /**
   * Correr la guarda dentro del contexto de inyeccion, como hace el router.
   *
   * Devuelve `unknown` y no `boolean | UrlTree`: el contrato de una guarda
   * trae ademas `RedirectCommand` y observables, y apretarlo aqui obligaria a
   * reimplementar ese contrato en la prueba.
   */
  function correr(guarda: CanActivateFn, url: string): Promise<unknown> {
    return Promise.resolve(
      TestBed.runInInjectionContext(() =>
        guarda({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
      ),
    );
  }

  /** La URL a la que apunta un `UrlTree`, o falla si no lo es. */
  function destino(resultado: unknown): string {
    expect(resultado).toBeInstanceOf(UrlTree);
    return TestBed.inject(Router).serializeUrl(resultado as UrlTree);
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  describe('guardaSesion', () => {
    it('sin credencial manda al inicio de sesion', async () => {
      const resultado = await correr(guardaSesion, '/notas');

      expect(destino(resultado)).toContain('/login');
      // De ahi se puede volver, asi que el lugar del que venia se respeta.
      expect(destino(resultado)).toContain('returnUrl');
    });

    it('sin credencial no arrastra a la pantalla de cambio de contrasena', async () => {
      // `/cambiar-contrasena` TAMBIEN lleva esta guarda. Si el `returnUrl` de
      // esa ruta se guardara, entrar daria `/login?returnUrl=/cambiar-contrasena`
      // y se encadenarian las dos pantallas.
      const resultado = await correr(guardaSesion, '/cambiar-contrasena');

      expect(destino(resultado)).not.toContain('returnUrl');
    });

    it('deja pasar a quien no tiene ninguna bandera pendiente', async () => {
      localStorage.setItem('ne.token', 'token-opaco-123');

      const promesa = correr(guardaSesion, '/notas');
      http.expectOne(`${API}/auth/yo`).flush(perfil);

      expect(await promesa).toBe(true);
    });

    it('con la bandera de cambio puesta, redirige a la pantalla de cambio', async () => {
      localStorage.setItem('ne.token', 'token-opaco-123');

      const promesa = correr(guardaSesion, '/notas');
      http
        .expectOne(`${API}/auth/yo`)
        .flush({ ...perfil, debeCambiarContrasena: true });

      expect(destino(await promesa)).toBe('/cambiar-contrasena');
    });

    it('con la bandera puesta, deja pasar cuando YA esta en la pantalla de cambio', async () => {
      // LA REGRESION: la ruta `/cambiar-contrasena` se protege con esta misma
      // guarda. Si aqui se devolviera un `UrlTree` hacia esa misma URL, el
      // router reprogramaria la navegacion, la guarda correria otra vez y asi
      // infinitamente: ninguna ruta llegaria a activarse, la pagina quedaria en
      // blanco y el bucle se comeria la CPU. Afectaba a todo usuario nuevo,
      // porque el sistema los crea con la bandera puesta.
      localStorage.setItem('ne.token', 'token-opaco-123');

      const promesa = correr(guardaSesion, '/cambiar-contrasena');
      http
        .expectOne(`${API}/auth/yo`)
        .flush({ ...perfil, debeCambiarContrasena: true });

      expect(await promesa).toBe(true);
    });

    it('si el sistema no responde, va a la pantalla de conexion y no al login', async () => {
      // «No se pudo preguntar» es distinto de «no tienes sesion»: mandarlo al
      // inicio de sesion con una credencial buena haria que la persona
      // reescribiera la contraseña sin motivo.
      localStorage.setItem('ne.token', 'token-opaco-123');

      const promesa = correr(guardaSesion, '/notas');
      http
        .expectOne(`${API}/auth/yo`)
        .flush('no hay servidor', { status: 503, statusText: 'Service Unavailable' });

      expect(destino(await promesa)).toBe('/sin-conexion');
    });
  });

  describe('guardaSinSesion', () => {
    it('deja entrar al inicio de sesion a quien no tiene credencial', async () => {
      expect(await correr(guardaSinSesion, '/login')).toBe(true);
    });

    it('deja el inicio de sesion quieto si hay credencial pero sin perfil cargado', async () => {
      // Sin perfil no se puede decidir nada todavía: el menú se pinta solo.
      localStorage.setItem('ne.token', 'token-opaco-123');

      expect(await correr(guardaSinSesion, '/login')).toBe(true);
    });

    it('con sesion y la bandera puesta, manda a la pantalla de cambio', async () => {
      // Esto es lo que pasa al recargar `/login` con la sesión puesta. El
      // destino lo vuelve a mirar `guardaSesion`, así que la cadena solo
      // termina si esa guarda deja pasar cuando ya está en el destino.
      localStorage.setItem('ne.token', 'token-opaco-123');
      const cargado = TestBed.inject(Sesion).asegurarPerfil();
      http
        .expectOne(`${API}/auth/yo`)
        .flush({ ...perfil, debeCambiarContrasena: true });
      await cargado;

      expect(destino(await correr(guardaSinSesion, '/login'))).toBe(
        '/cambiar-contrasena',
      );
    });

    it('con sesion en regla, saca del inicio de sesion hacia el inicio', async () => {
      localStorage.setItem('ne.token', 'token-opaco-123');
      const cargado = TestBed.inject(Sesion).asegurarPerfil();
      http.expectOne(`${API}/auth/yo`).flush(perfil);
      await cargado;

      expect(destino(await correr(guardaSinSesion, '/login'))).toBe('/');
    });
  });
});
