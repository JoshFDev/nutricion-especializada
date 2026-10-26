import pg from 'pg';
import type { Configuracion } from './configuracion.js';

/**
 * Crea la cuenta dueña/administradora la primera vez que se abre la app.
 *
 * Una instalación nueva llega con las migraciones y los roles, pero sin
 * usuarios: sin esto nadie podría entrar y el cliente se quedaría mirando una
 * pantalla de login que no acepta nada.
 *
 * Sólo se crea si la tabla está vacía. En instalaciones que ya tienen gente
 * no se toca nada: la cuenta no se duplica ni se resetea en cada arranque.
 */
export async function crearAdminInicial(
  config: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  },
  admin: Configuracion['admin'],
): Promise<{ creada: boolean }> {
  const cliente = new pg.Client({ ...config, client_encoding: 'UTF8' });
  await cliente.connect();

  try {
    await cliente.query('SET search_path TO pos, public');

    const conteo = await cliente.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM usuarios',
    );
    if ((conteo.rows[0]?.total ?? 0) > 0) {
      return { creada: false };
    }

    await cliente.query('BEGIN');
    try {
      const insertado = await cliente.query<{ id: number }>(
        `INSERT INTO usuarios
           (nombre, apellido_paterno, apellido_materno, rfc, email,
            fecha_contratacion, puesto, contrasena, es_dueno,
            debe_cambiar_contrasena)
         VALUES ($1, $2, NULL, $3, $4, CURRENT_DATE, $5,
                 crypt($6, gen_salt('bf', 12)), TRUE, TRUE)
         RETURNING id`,
        [
          admin.nombre,
          admin.apellidoPaterno,
          admin.rfc,
          admin.email,
          admin.puesto,
          admin.contrasena,
        ],
      );

      const usuarioId = insertado.rows[0]?.id;
      if (!usuarioId) throw new Error('No se pudo crear la cuenta de administrador');

      await cliente.query(
        `INSERT INTO usuarios_roles (usuario_id, rol_id)
         SELECT $1, id FROM roles WHERE nombre = 'Administrador'
         ON CONFLICT DO NOTHING`,
        [usuarioId],
      );

      await cliente.query('COMMIT');
      console.log(`[admin] Cuenta inicial creada para ${admin.email}`);
      return { creada: true };
    } catch (error) {
      await cliente.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    await cliente.end();
  }
}
