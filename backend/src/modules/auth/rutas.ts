import { Router } from 'express';
import { z } from 'zod';
import { generarToken, hashToken, requiereSesion } from '../../middleware/sesion.js';
import { ErrorHttp } from '../../middleware/errores.js';
import { env } from '../../config/entorno.js';

export const rutasAuth = Router();

const esquemaLogin = z.object({
  correo: z.email('El correo no tiene formato valido'),
  contrasena: z.string().min(1, 'La contrasena no puede ir vacia'),
});

/**
 * POST /api/auth/login
 *
 * La contrasena nunca sale de la base: se compara dentro de Postgres con
 * crypt(). Aqui solo se recibe el texto plano, se manda, y se descarta.
 */
rutasAuth.post('/login', async (req, res) => {
  const { correo, contrasena } = esquemaLogin.parse(req.body);

  const { rows } = await req.db.query(
    `SELECT u.id,
            u.nombre,
            u.email,
            u.activo,
            u.debe_cambiar_contrasena,
            (u.contrasena IS NOT NULL
             AND crypt($2, u.contrasena) = u.contrasena) AS contrasena_ok
       FROM usuarios u
      WHERE lower(u.email) = lower($1)`,
    [correo, contrasena],
  );

  const usuario = rows[0];

  // Mismo mensaje y mismo codigo para "no existe" y "contrasena mal": si no,
  // el endpoint sirve para averiguar que correos estan registrados.
  const credencialesOk = Boolean(usuario) && usuario.contrasena_ok === true;

  if (!credencialesOk || !usuario.activo) {
    await req.db.query(
      `INSERT INTO auditoria_accesos (usuario_id, usuario_intento, evento, ip, detalle)
       VALUES ($1, $2, 'login_fallido', $3, $4)`,
      [
        usuario?.id ?? null,
        correo,
        req.ip ?? null,
        usuario ? 'contrasena incorrecta' : 'usuario inexistente',
      ],
    );
    throw new ErrorHttp(401, 'Correo o contrasena incorrectos');
  }

  const token = generarToken();

  await req.db.query(
    `INSERT INTO sesiones (usuario_id, token_hash, ip, user_agent, expira_en)
     VALUES ($1, $2, $3, $4, now() + $5::interval)`,
    [usuario.id, hashToken(token), req.ip ?? null, req.get('user-agent') ?? null, env.JWT_EXPIRES_IN],
  );

  await req.db.query(
    `INSERT INTO auditoria_accesos (usuario_id, usuario_intento, evento, ip, detalle)
     VALUES ($1, $2, 'login_exitoso', $3, 'sesion iniciada')`,
    [usuario.id, correo, req.ip ?? null],
  );

  res.status(200).json({
    token,
    usuario: {
      id: Number(usuario.id),
      nombre: usuario.nombre,
      email: usuario.email,
      debeCambiarContrasena: usuario.debe_cambiar_contrasena,
    },
  });
});

/** GET /api/auth/yo: quien soy y que permisos tengo. */
rutasAuth.get('/yo', requiereSesion, async (req, res) => {
  const { rows } = await req.db.query(
    `SELECT u.id,
            u.nombre,
            u.email,
            u.puesto,
            u.debe_cambiar_contrasena,
            COALESCE(
              (SELECT json_agg(p.codigo ORDER BY p.codigo)
                 FROM permisos p
                 JOIN roles_permisos rp ON rp.permiso_id = p.id
                 JOIN usuarios_roles ur ON ur.rol_id = rp.rol_id
                WHERE ur.usuario_id = u.id),
              '[]'::json
            ) AS permisos,
            (SELECT json_agg(r.nombre ORDER BY r.nombre)
               FROM roles r
               JOIN usuarios_roles ur ON ur.rol_id = r.id
              WHERE ur.usuario_id = u.id) AS roles
       FROM usuarios u
      WHERE u.id = $1`,
    [req.sesion!.usuarioId],
  );
  res.json(rows[0]);
});

/** POST /api/auth/logout: invalida el token en la base. */
rutasAuth.post('/logout', requiereSesion, async (req, res) => {
  await req.db.query(
    `UPDATE sesiones
        SET cerrada_en = now(), cierre_motivo = 'logout'
      WHERE id = $1 AND cerrada_en IS NULL`,
    [req.sesion!.sesionId],
  );
  res.status(204).end();
});
