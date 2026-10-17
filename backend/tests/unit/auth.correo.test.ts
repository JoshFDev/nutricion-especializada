import { describe, expect, it } from 'vitest';
import { LOGO_CID } from '../../src/core/correo-marca.js';
import { htmlRecuperacion } from '../../src/modules/auth/correo.js';

/**
 * El HTML del correo de recuperacion, sin abrir SMTP.
 *
 * Lo que importa aqui es que la clave viaje dentro del correo y que el logo
 * vaya incrustado: son las dos cosas que la persona ve y que un cambio de
 * maquetacion podria romper sin que ninguna prueba de servicio lo note.
 */
describe('htmlRecuperacion', () => {
  it('trae el logo incrustado y la contrasena temporal', () => {
    const html = htmlRecuperacion('Ana', 'Ab3#xY9');
    expect(html).toContain(`cid:${LOGO_CID}`);
    expect(html).toContain('Ab3#xY9');
    expect(html).toContain('Ana');
    expect(html).toContain('Iniciar sesión');
  });

  it('escapa el nombre', () => {
    const html = htmlRecuperacion('<b>Ana</b>', 'Ab3#xY9');
    expect(html).not.toContain('<b>Ana</b>');
    expect(html).toContain('&lt;b&gt;Ana&lt;/b&gt;');
  });
});
