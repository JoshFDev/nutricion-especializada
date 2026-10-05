import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  type TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../nucleo/api';
import { ClientesApi, cuerpoDeCliente, type FormaCliente } from './clientes-api';

/**
 * El cuerpo del cliente: lo que se manda al backend.
 *
 * Es la prueba de que la pantalla no normaliza distinto que el esquema de
 * `clientes/esquemas.ts`: el codigo arriba en mayusculas y limpio, y los
 * opcionales vacios como `null` (la base prefiere "sin dato" a un string
 * de espacios).
 */

function forma(parcial: Partial<FormaCliente> = {}): FormaCliente {
  return {
    codigo_cliente: 'CL01',
    nombre: 'Rancho La Escondida',
    establo: '',
    especie_id: '',
    estatus: 'Activo',
    telefono: '',
    direccion: '',
    ...parcial,
  };
}

describe('el cuerpo del cliente', () => {
  it('lleva el codigo en mayusculas y sin espacios', () => {
    const cuerpo = cuerpoDeCliente(forma({ codigo_cliente: '  cl01  ' }));
    expect(cuerpo.codigo_cliente).toBe('CL01');
  });

  it('el nombre se manda limpio', () => {
    const cuerpo = cuerpoDeCliente(forma({ nombre: '  Rancho   ' }));
    expect(cuerpo.nombre).toBe('Rancho');
  });

  it('los opcionales en blanco son null, no strings vacios', () => {
    const cuerpo = cuerpoDeCliente(forma());
    expect(cuerpo.establo).toBeNull();
    expect(cuerpo.especie_id).toBeNull();
    expect(cuerpo.telefono).toBeNull();
    expect(cuerpo.direccion).toBeNull();
  });

  it('la especie elegida va como numero', () => {
    const cuerpo = cuerpoDeCliente(forma({ especie_id: '3' }));
    expect(cuerpo.especie_id).toBe(3);
  });

  it('respeta el estatus', () => {
    const cuerpo = cuerpoDeCliente(forma({ estatus: 'Inactivo' }));
    expect(cuerpo.estatus).toBe('Inactivo');
  });

  it('un opcional con texto se limpia pero no se vuelve null', () => {
    const cuerpo = cuerpoDeCliente(forma({ telefono: '  (614) 123-4567  ' }));
    expect(cuerpo.telefono).toBe('(614) 123-4567');
  });
});

/**
 * La ruta de exportar.
 *
 * Es lo unico de esta API que necesita el HTTP de verdad simulado, y se
 * prueba por dos razones concretas: que pegue a `/exportar` y NO a
 * `/clientes` (que devolveria JSON, no un archivo), y que NO mande
 * `limite`/`offset`. Mandarlos haria que el excel saliera con solo la pagina
 * que se esta viendo, que es justo lo que el operador no pide cuando exporta.
 */
describe('ClientesApi.exportarExcel', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);

    // jsdom no sabe crear una URL de objeto, y la que trae vitest espera un
    // Blob de su propio mundo. Con la descarga falseada lo que se prueba es
    // la PETICION —la ruta y los filtros—, que es lo que esta pantalla
    // decide; el nombre del archivo lo prueba `nucleo/api.spec.ts`.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
  });

  afterEach(() => {
    http.verify();
    vi.restoreAllMocks();
  });

  /** La peticion de la exportacion, ya respondida con un blob. */
  async function pedir(
    api: ClientesApi,
    filtro: Parameters<ClientesApi['exportarExcel']>[0],
  ): Promise<TestRequest> {
    const promesa = api.exportarExcel(filtro);
    const peticion = http.expectOne((req) => req.url.includes('/exportar'));
    peticion.flush(new Blob(['xlsx']));
    await promesa;
    return peticion;
  }

  it('pega a /api/clientes/exportar', async () => {
    const peticion = await pedir(TestBed.inject(ClientesApi), {});

    expect(peticion.request.method).toBe('GET');
    expect(peticion.request.url).toBe(`${API}/clientes/exportar`);
    expect(peticion.request.responseType).toBe('blob');
  });

  it('no manda limite ni offset, para que salga el listado entero', async () => {
    const peticion = await pedir(TestBed.inject(ClientesApi), { buscar: 'rancho' });

    expect(peticion.request.params.has('limite')).toBe(false);
    expect(peticion.request.params.has('offset')).toBe(false);
    expect(peticion.request.params.get('buscar')).toBe('rancho');
  });

  it('manda el filtro de estatus tal cual', async () => {
    // El desplegable tiene un "Todos" que no es un estatus, y la pantalla lo
    // traduce a `undefined` antes de llamar: aqui solo se comprueba que lo que
    // llega se pone tal cual, sin inventarse un `estatus=todos`.
    const api = TestBed.inject(ClientesApi);

    expect((await pedir(api, { estatus: 'Inactivo' })).request.params.get('estatus')).toBe(
      'Inactivo',
    );
    expect((await pedir(api, {})).request.params.has('estatus')).toBe(false);
  });
});
