import { app } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Configuracion {
  admin: {
    nombre: string;
    apellidoPaterno: string;
    email: string;
    rfc: string;
    puesto: string;
    contrasena: string;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
}

/**
 * Valores de respaldo.
 *
 * El archivo real se genera con `scripts/preparar-configuracion.mjs` y viaja
 * como `resources/configuracion.json`. Si por alguna razón no está, la app
 * sigue arrancando: crea la cuenta de administrador y deja el SMTP apuntando
 * a localhost (sin recuperación por correo) en vez de no abrir.
 */
const POR_DEFECTO: Configuracion = {
  admin: {
    nombre: 'Joshua',
    apellidoPaterno: 'Administrador',
    email: 'nutricionespecializada899@gmail.com',
    rfc: 'XAXX010101000',
    puesto: 'Administrador',
    contrasena: 'Nutricion2026!',
  },
  smtp: {
    host: 'localhost',
    port: 25,
    secure: false,
    user: '',
    pass: '',
    from: 'Nutrición Especializada <no-reply@localhost>',
  },
};

let cache: Configuracion | null = null;

export function leerConfiguracion(): Configuracion {
  if (cache) return cache;

  const ruta = app.isPackaged
    ? join(process.resourcesPath, 'configuracion.json')
    : join(app.getAppPath(), 'configuracion.local.json');

  try {
    const crudo = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<Configuracion>;
    cache = {
      admin: { ...POR_DEFECTO.admin, ...crudo.admin },
      smtp: { ...POR_DEFECTO.smtp, ...crudo.smtp },
    };
    console.log(`[config] Cargada desde ${ruta}`);
  } catch (error) {
    console.warn(`[config] No se pudo leer ${ruta}; se usan valores por defecto`, error);
    cache = POR_DEFECTO;
  }

  return cache;
}
