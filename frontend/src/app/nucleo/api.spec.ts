import { HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { descargarExcel, errorLegible } from './api';

/**
 * `errorLegible` es lo que decide que se le muestra a la persona cuando algo
 * sale mal, y sus tres casos (respuesta de la API, servidor caido, error
 * propio) se distinguen por cosas que no se ven a ojo en la pantalla.
 */
describe('errorLegible', () => {
  it('usa el codigo y el mensaje que manda la API', () => {
    // Esta es la forma real del backend (ver middleware/errores.ts). Lo que
    // decide la app es el CODIGO; el mensaje solo se muestra.
    const error = new HttpErrorResponse({
      status: 409,
      error: { codigo: 'CLIENTE_DUPLICADO', error: 'Ya existe un cliente con ese codigo' },
    });

    const legible = errorLegible(error);

    expect(legible.codigo).toBe('CLIENTE_DUPLICADO');
    expect(legible.mensaje).toBe('Ya existe un cliente con ese codigo');
  });

  it('saca los detalles de validacion para pegarlos junto al campo', () => {
    const error = new HttpErrorResponse({
      status: 400,
      error: {
        codigo: 'VALIDACION',
        error: 'Los datos enviados no son validos',
        detalles: [{ campo: 'correo', problema: 'El correo no tiene formato valido' }],
      },
    });

    const legible = errorLegible(error);

    expect(legible.codigo).toBe('VALIDACION');
    expect(legible.detalles).toEqual([
      { campo: 'correo', problema: 'El correo no tiene formato valido' },
    ]);
  });

  it('avisa que no hay servidor cuando la peticion no salio', () => {
    // Status 0 es el "no se pudo contactar", y es lo que sale cuando el
    // backend esta caido o el origen no esta permitido. El mensaje tiene que
    // nombrar las dos causas, porque se confunden entre si. El COMO se
    // arregla (el nombre de la variable) lo dice la pantalla
    // `SinConexion`, que es donde se llega a resolver el problema de
    // verdad; aqui no se echa jerga a la gente que esta en el mostrador.
    const legible = errorLegible(new HttpErrorResponse({ status: 0 }));

    expect(legible.codigo).toBe('SIN_SERVIDOR');
    expect(legible.mensaje).toContain('backend');
    expect(legible.mensaje).toContain('origen');
  });

  it('no ensena el texto crudo del servidor cuando no es un error de la app', () => {
    // Un 502 de nginx trae HTML. Si eso se pinta tal cual, la persona ve una
    // pagina de error del servidor en medio de la app.
    const error = new HttpErrorResponse({ status: 502, error: '<html>Bad Gateway</html>' });

    const legible = errorLegible(error);

    expect(legible.codigo).toBe('ERROR_SERVIDOR');
    expect(legible.mensaje).not.toContain('<html>');
  });

  it('ignora detalles que no son de campo', () => {
    // Las reglas de negocio mandan `detalles` con otras formas. No se
    // inventan: lo que no sea `{campo, problema}` se descarta, y el mensaje
    // general ya dice lo suficiente.
    const error = new HttpErrorResponse({
      status: 422,
      error: {
        codigo: 'NOTA_CANCELADA',
        error: 'La nota esta cancelada',
        detalles: [{ motivo: 'prueba' }, null, 'texto'],
      },
    });

    expect(errorLegible(error).detalles).toEqual([]);
  });

  it('aguanta un error que ni siquiera es de la API', () => {
    const legible = errorLegible(new Error('esto se rompio en el navegador'));

    expect(legible.codigo).toBe('ERROR_INESPERADO');
    expect(legible.mensaje).toBeTruthy();
  });
});

/**
 * `descargarExcel` es lo que hace que el archivo que baja se llame como debe.
 *
 * El backend manda el nombre en `content-disposition` (con la fecha, para que
 * dos exportaciones del mismo día no se pisen), pero un proxy puede comerse esa
 * cabecera, y por eso hay un nombre por defecto. Lo que NO puede pasar es que
 * el archivo se quede con el nombre sin su extension y que el navegador no lo
 * abra por unrecognized format.
 */
describe('descargarExcel', () => {
  /** Los enlaces que se pulsaron, para mirar el nombre que se les puso. */
  let descargas: HTMLAnchorElement[] = [];

  function respuesta(conCabecera?: string): HttpResponse<Blob> {
    return new HttpResponse({
      body: new Blob(['xlsx']),
      headers: conCabecera
        ? new HttpHeaders({ 'content-disposition': conCabecera })
        : new HttpHeaders(),
    });
  }

  beforeEach(() => {
    descargas = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      descargas.push(this);
    });
    // jsdom no trae las dos de `URL`, y sin ellas no hay forma de probar la
    // descarga sin que salga el "Not implemented" de la navegacion.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:mock', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('usa el nombre que manda el backend, con su fecha', () => {
    descargarExcel(respuesta('attachment; filename="clientes-2026-10-05.xlsx"'), 'clientes.xlsx');

    expect(descargas).toHaveLength(1);
    expect(descargas[0].download).toBe('clientes-2026-10-05.xlsx');
  });

  it('cae al nombre por defecto si no llega la cabecera', () => {
    // Es lo que pasa detras de un proxy que se come `content-disposition`:
    // sin nombre por defecto el archivo se llama por la URL y el navegador
    // no sabe que es un xlsx.
    descargarExcel(respuesta(), 'clientes.xlsx');

    expect(descargas[0].download).toBe('clientes.xlsx');
  });

  it('cae al nombre por defecto si la cabecera no trae filename', () => {
    descargarExcel(respuesta('attachment'), 'proveedores.xlsx');

    expect(descargas[0].download).toBe('proveedores.xlsx');
  });
});
