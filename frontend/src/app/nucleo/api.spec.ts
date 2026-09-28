import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';
import { errorLegible } from './api';

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
