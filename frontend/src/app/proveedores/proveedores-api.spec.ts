import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  type TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API } from '../nucleo/api';
import { ProveedoresApi, cuerpoDeProveedor, type FormaProveedor } from './proveedores-api';

/**
 * El cuerpo del proveedor: lo que se manda al backend.
 *
 * Es la prueba de que la pantalla no normaliza distinto que el esquema de
 * `proveedores/esquemas.ts`. Lo que se comprueba aqui es lo que el esquema NO
 * hace: el nombre se limpia de los bordes (el backend no lo transforma) y los
 * opcionales en blanco viajan como `null`, que es como los guarda la base.
 *
 * Y lo que NO se manda tambien es parte del contrato: `saldo_actual` y
 * `activo` no aparecen en `CuerpoProveedor` porque el primero lo recalcula la
 * base y el segundo solo se puede cambiar por su cuenta (ver
 * `ProveedoresApi.alternarActivo`).
 */

function forma(parcial: Partial<FormaProveedor> = {}): FormaProveedor {
  return {
    nombre: 'Forrajeros del Norte',
    contacto: '',
    telefono: '',
    ...parcial,
  };
}

describe('el cuerpo del proveedor', () => {
  it('el nombre se manda limpio de los bordes', () => {
    // El nombre es la llave: es como lo busca el operador al capturar una
    // compra. "Forrajeros del Norte " y "Forrajeros del Norte" tienen que ser
    // el mismo proveedor, no dos.
    const cuerpo = cuerpoDeProveedor(forma({ nombre: '  Forrajeros del Norte  ' }));
    expect(cuerpo.nombre).toBe('Forrajeros del Norte');
  });

  it('NO mayusculiza el nombre, a diferencia del codigo de clientes', () => {
    // El esquema de `clientes/esquemas.ts` sube el codigo a mayusculas; el de
    // proveedores no toca el nombre, y convertirlo aqui dejaria el listado
    // refrescado mostrando un nombre distinto al que se tecleo.
    const cuerpo = cuerpoDeProveedor(forma({ nombre: 'forrajeros del norte' }));
    expect(cuerpo.nombre).toBe('forrajeros del norte');
  });

  it('los opcionales en blanco son null, no strings vacios', () => {
    const cuerpo = cuerpoDeProveedor(forma());
    expect(cuerpo.contacto).toBeNull();
    expect(cuerpo.telefono).toBeNull();
  });

  it('un opcional con texto se limpia pero no se vuelve null', () => {
    const cuerpo = cuerpoDeProveedor(
      forma({ contacto: '  Laura Mendez ', telefono: '  (614) 123-4567  ' }),
    );
    expect(cuerpo.contacto).toBe('Laura Mendez');
    expect(cuerpo.telefono).toBe('(614) 123-4567');
  });

  it('solo lleva los tres campos del esquema, ni saldo ni activo', () => {
    // Si se metiera `saldo_actual` o `activo` aqui, el `strict` del POST
    // los rechazaria con un 400. Esta prueba falla en cuanto alguien los
    // anade, que es justo cuando conviene enterarse.
    expect(Object.keys(cuerpoDeProveedor(forma())).sort()).toEqual([
      'contacto',
      'nombre',
      'telefono',
    ]);
  });
});

/**
 * La ruta de exportar.
 *
 * Es lo unico de esta API que necesita el HTTP de verdad simulado, y se
 * prueba por dos razones concretas: que pegue a `/exportar` y NO a
 * `/proveedores` (que devolveria JSON, no un archivo), y que NO mande
 * `limite`/`offset`. Mandarlos haria que el excel saliera con solo la pagina
 * que se esta viendo, que es justo lo que el operador no pide cuando exporta.
 */
describe('ProveedoresApi.exportarExcel', () => {
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
    api: ProveedoresApi,
    filtro: Parameters<ProveedoresApi['exportarExcel']>[0],
  ): Promise<TestRequest> {
    const promesa = api.exportarExcel(filtro);
    const peticion = http.expectOne((req) => req.url.includes('/exportar'));
    peticion.flush(new Blob(['xlsx']));
    await promesa;
    return peticion;
  }

  it('pega a /api/proveedores/exportar', async () => {
    const peticion = await pedir(TestBed.inject(ProveedoresApi), {});

    expect(peticion.request.method).toBe('GET');
    expect(peticion.request.url).toBe(`${API}/proveedores/exportar`);
    expect(peticion.request.responseType).toBe('blob');
  });

  it('no manda limite ni offset, para que salga el listado entero', async () => {
    const peticion = await pedir(TestBed.inject(ProveedoresApi), { buscar: 'forra' });

    expect(peticion.request.params.has('limite')).toBe(false);
    expect(peticion.request.params.has('offset')).toBe(false);
    expect(peticion.request.params.get('buscar')).toBe('forra');
  });

  it('traduce el filtro de estado a lo que el backend entiende', async () => {
    // El desplegable tiene tres opciones y el backend solo dos: "todos" es no
    // mandar el parametro, no mandar `activo=todos`.
    const api = TestBed.inject(ProveedoresApi);

    expect((await pedir(api, { activo: 'activos' })).request.params.get('activo')).toBe('true');
    expect((await pedir(api, { activo: 'inactivos' })).request.params.get('activo')).toBe('false');
    expect((await pedir(api, { activo: 'todos' })).request.params.has('activo')).toBe(false);
  });
});
