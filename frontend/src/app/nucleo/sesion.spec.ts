import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { API } from './api';
import { Sesion } from './sesion';

/**
 * La sesion es la pieza de la que depende todo lo demas (el menu, las
 * guardas, el boton de salir), asi que se prueba con el HTTP de verdad
 * simulado: lo que interesa es que se guarde y se borre el token en los
 * momentos justos, no que se llame a un metodo.
 */
describe('Sesion', () => {
  let http: HttpTestingController;

  const perfil = {
    id: 7,
    nombre: 'Cajera',
    email: 'cajera@ejemplo.mx',
    puesto: 'Cajero',
    debeCambiarContrasena: false,
    permisos: ['notas.ver', 'clientes.ver'],
    roles: ['cajero'],
  };

  const token = 'token-opaco-123';

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Si una prueba se olvida de responder una peticion, esto avisa en vez
    // de dejar la peticion colgada hasta el final de la suite.
    http.verify();
    localStorage.clear();
  });

  it('arranca sin sesion y sin pregunta nada', () => {
    const sesion = TestBed.inject(Sesion);

    expect(sesion.hayToken()).toBe(false);
    expect(sesion.perfil()).toBeNull();
    // `http.verify()` en el `afterEach` falla si aqui se colara una
    // peticion: sin token no hay nada que preguntar.
  });

  it('guarda el token al entrar y lo vuelve a sacar al cargar la pagina', async () => {
    const sesion = TestBed.inject(Sesion);

    const promesa = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesa;

    expect(sesion.hayToken()).toBe(true);
    expect(localStorage.getItem('ne.token')).toBe(token);

    // La sesion nueva (lo que pasa al recargar) se arma desde lo guardado.
    const recargada = TestBed.inject(Sesion);
    expect(recargada.hayToken()).toBe(true);
  });

  it('no guarda nada si el login falla', async () => {
    const sesion = TestBed.inject(Sesion);

    const promesa = sesion.entrar('cajera@ejemplo.mx', 'malaclave');
    http
      .expectOne(`${API}/auth/login`)
      .flush(
        { codigo: 'CREDENCIALES', error: 'Correo o contrasena incorrectos' },
        { status: 401, statusText: 'Unauthorized' },
      );

    await expect(promesa).rejects.toBeTruthy();
    expect(sesion.hayToken()).toBe(false);
    expect(localStorage.getItem('ne.token')).toBeNull();
  });

  it('no guarda el perfil del login, porque no trae los permisos', async () => {
    // La respuesta del login trae el usuario pero NO la lista de permisos.
    // Guardarla haria que `asegurarPerfil` saliera temprano con la lista
    // vacia y el menu no tendria nada.
    const sesion = TestBed.inject(Sesion);

    const promesa = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesa;

    expect(sesion.perfil()).toBeNull();
  });

  it('carga el perfil una sola vez, aunque se pregunte varias veces', async () => {
    const sesion = TestBed.inject(Sesion);

    const promesaLogin = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesaLogin;

    const primera = sesion.asegurarPerfil();
    http.expectOne(`${API}/auth/yo`).flush(perfil);
    expect(await primera).toEqual(perfil);

    // La segunda vez ya no pregunta: el perfil esta en memoria y volver a
    // pedirlo es una peticion que no aporta nada.
    expect(await sesion.asegurarPerfil()).toEqual(perfil);
  });

  it('responde si puede hacer algo con lo que dice el perfil', async () => {
    const sesion = TestBed.inject(Sesion);

    const promesaLogin = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesaLogin;

    const promesa = sesion.asegurarPerfil();
    http.expectOne(`${API}/auth/yo`).flush(perfil);
    await promesa;

    expect(sesion.puede('notas.ver')).toBe(true);
    expect(sesion.puede('caja.eliminar')).toBe(false);
  });

  it('expirar borra el token sin preguntar nada al backend', async () => {
    // El token con el que se responde 401 ya no vale para nada, asi que
    // mandar `/auth/logout` con el seria una peticion que falla sola.
    const sesion = TestBed.inject(Sesion);
    const promesa = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesa;

    sesion.expirar();

    expect(sesion.hayToken()).toBe(false);
    expect(localStorage.getItem('ne.token')).toBeNull();
    expect(sesion.sesionPerdida()).toBe(true);
  });

  it('salir borra la sesion en el acto y aun asi avisa al backend', async () => {
    // La limpieza NO espera al logout. Si esperara, la navegacion a
    // `/login` saldria despues del viaje de ida y vuelta al servidor y la
    // pantalla se quedaria quieta viendolo — peor aun si el token ya estaba
    // muerto y el 401 disparaba una segunda navegacion encima.
    const sesion = TestBed.inject(Sesion);
    const promesa = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesa;

    sesion.salir();

    // Limpio ANTES de que el logout conteste...
    expect(sesion.hayToken()).toBe(false);
    expect(localStorage.getItem('ne.token')).toBeNull();

    // ...pero la peticion salio igual y queda ahi, en segundo plano.
    http.expectOne(`${API}/auth/logout`).flush({});
  });

  it('el error del logout no rompe nada: la sesion ya estaba limpia', async () => {
    // Quedarse "dentro" sin sesion solo produce un 401 en cada clic, y el
    // usuario no puede hacer nada con eso. El rechazo se traga dentro de
    // `salir` (fire and forget), asi que ni siquiera se escapa.
    const sesion = TestBed.inject(Sesion);
    const promesa = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({ token, usuario: perfil });
    await promesa;

    sesion.salir();
    http
      .expectOne(`${API}/auth/logout`)
      .flush('no hay servidor', { status: 500, statusText: 'Error' });

    expect(sesion.hayToken()).toBe(false);
    expect(localStorage.getItem('ne.token')).toBeNull();
    expect(sesion.sesionPerdida()).toBe(false);
  });

  it('salir sin token no le pregunta nada al backend', () => {
    // `http.verify()` del `afterEach` seria el que falte si saliera una
    // peticion: sin token no hay sesion que cerrar del lado del servidor.
    const sesion = TestBed.inject(Sesion);

    sesion.salir();

    expect(sesion.hayToken()).toBe(false);
  });

  it('marcar la contrasena cambiada quita la bandera local', async () => {
    // El backend ya la puso en `false` en la base y dejo viva esta sesion.
    // Si la copia local no se actualiza, la guarda vuelve a apuntar a la
    // pantalla de cambio y la persona se queda en un ciclo.
    const sesion = TestBed.inject(Sesion);
    const promesaLogin = sesion.entrar('cajera@ejemplo.mx', 'secreta123');
    http.expectOne(`${API}/auth/login`).flush({
      token,
      usuario: { ...perfil, debeCambiarContrasena: true },
    });
    await promesaLogin;

    const promesa = sesion.asegurarPerfil();
    http.expectOne(`${API}/auth/yo`).flush({ ...perfil, debeCambiarContrasena: true });
    await promesa;

    expect(sesion.perfil()?.debeCambiarContrasena).toBe(true);

    sesion.marcarContrasenaCambiada();

    expect(sesion.perfil()?.debeCambiarContrasena).toBe(false);
  });
});
