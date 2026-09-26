import { Router } from 'express';
import { validarBody } from '../../core/validacion.js';
import { requiereSesion } from '../../middleware/permisos.js';
import { cambiarContrasenaEsquema, loginEsquema } from './esquemas.js';
import * as controlador from './controlador.js';

export const rutasAuth = Router();

/**
 * El login es la UNICA ruta sin requiereSesion, obviamente. El resto de
 * este archivo exige sesion viva.
 */
rutasAuth.post('/login', validarBody(loginEsquema), controlador.login);

rutasAuth.get('/yo', requiereSesion, controlador.perfil);

rutasAuth.post('/logout', requiereSesion, controlador.logout);

/**
 * Cambio de contrasena. Exige sesion viva Y la contrasena actual, y deja
 * la sesion actual funcionando para que el usuario no se quede sin token
 * a media operacion.
 */
rutasAuth.post(
  '/cambiar-contrasena',
  requiereSesion,
  validarBody(cambiarContrasenaEsquema),
  controlador.cambiarContrasena,
);
