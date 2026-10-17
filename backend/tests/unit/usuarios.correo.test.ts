import { describe, expect, it } from 'vitest';
import { adjuntoLogo, LOGO_CID } from '../../src/core/correo-marca.js';
import { htmlCuentaCreada } from '../../src/modules/usuarios/correo.js';

/**
 * Pruebas del correo de alta.
 *
 * Todo lo que aqui se revisa es el HTML, no el envio: `htmlCuentaCreada` es
 * puro y no toca SMTP. Ver que el logo y la contrasena salen adentro vale mas
 * que verificar que `sendMail` fue llamado, porque lo primero es lo que la
 * persona ve y lo segundo solo prueba que se conecto un socket.
 */
describe('htmlCuentaCreada', () => {
  const base = {
    nombre: 'Maria Lopez',
    correo: 'maria@example.com',
    contrasenaTemporal: 'Ab3x',
  };

  it('trae el logo incrustado por cid', () => {
    const html = htmlCuentaCreada(base);
    expect(html).toContain(`cid:${LOGO_CID}`);
    expect(html).toContain('<!doctype html>');
  });

  it('trae la contrasena temporal y el correo del nuevo usuario', () => {
    const html = htmlCuentaCreada(base);
    expect(html).toContain('Ab3x');
    expect(html).toContain('maria@example.com');
    expect(html).toContain('Maria Lopez');
    expect(html).toContain('cambiar');
  });

  it('si la clave la escribio el administrador no la suelta en el correo', () => {
    const html = htmlCuentaCreada({ ...base, contrasenaTemporal: null });
    expect(html).not.toContain('Contraseña temporal');
    expect(html).toContain('entregó quien creó la cuenta');
    expect(html).toContain('maria@example.com');
  });

  it('escapa lo que viene de la persona', () => {
    const html = htmlCuentaCreada({
      ...base,
      nombre: '<img src=x>',
      correo: 'a&b@example.com',
    });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('a&amp;b@example.com');
  });
});

describe('adjuntoLogo', () => {
  it('lee el PNG del disco y lo pone como inline', async () => {
    const adjunto = await adjuntoLogo();
    expect(adjunto.cid).toBe(LOGO_CID);
    expect(adjunto.contentDisposition).toBe('inline');
    expect(Buffer.isBuffer(adjunto.content)).toBe(true);
    // Firma PNG: que traiga el logo de verdad y no un archivo vacio.
    expect((adjunto.content as Buffer).subarray(0, 4).toString('hex')).toBe('89504e47');
  });
});
