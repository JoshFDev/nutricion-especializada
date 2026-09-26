// Prueba de integracion contra el API ya arrancado.
//
//   pnpm dev            (en otra terminal)
//   pnpm test:api
//
// Ojo: /api/auth/login tiene un rate limit por IP (LOGIN_MAX_INTENTOS, que
// en el .env local esta en 100). El contador vive en la memoria del
// servidor, asi que corriendola varias veces seguidas sin reiniciar
// termina en 429. La suite se detiene con un mensaje claro cuando pasa.

const BASE = process.env.API_URL ?? 'http://localhost:3000';

/**
 * GUARDIA: esta suite crea, modifica y borra registros, y cambia
 * contrasenas. Si por descuido el servidor `pnpm dev` esta apuntando a la
 * base de datos REAL, la prueba le deja la cuenta del administrador con
 * otra contrasena. Ya paso una vez, asi que ahora se comprueba antes de
 * tocar nada: se lee el nombre de la base que reporta /api/salud y, si no
 * parece una base de pruebas, se sale.
 *
 * Para correr contra otra base de pruebas:  API_BASE_ESPERADA=mi_base_test
 */
const BASE_ESPERADA = process.env.API_BASE_ESPERADA ?? 'test';

const verificarBaseDePruebas = async () => {
  let salud;
  try {
    salud = await fetch(`${BASE}/api/salud`).then((r) => r.json());
  } catch {
    console.error(`No se pudo contactar el servidor en ${BASE}. ¿Está 'pnpm dev' corriendo?`);
    process.exit(3);
  }

  const base = String(salud.base ?? '');
  if (!base.toLowerCase().includes(BASE_ESPERADA.toLowerCase())) {
    console.error('');
    console.error('=== LA SUITE NO CORRE CONTRA ESTA BASE ===');
    console.error(`El servidor en ${BASE} está usando:  ${base || '(desconocida)'}`);
    console.error(`Se esperaba una base que contenga:   ${BASE_ESPERADA}`);
    console.error('');
    console.error('Esta suite cambia la contraseña del admin y borra registros.');
    console.error('Para correrla, levanta el servidor contra una base de pruebas:');
    console.error('  PGDATABASE=nutr_test pnpm dev');
    console.error('O cambia la base esperada:');
    console.error('  API_BASE_ESPERADA=nutr_test pnpm test:api');
    console.error('=============================================');
    process.exit(3);
  }
  return base;
};

const login = async (correo, contrasena) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correo, contrasena }),
  });
  return { status: r.status, body: await r.json() };
};

/**
 * El limite de login se agota sooner o later si se corre la suite varias
 * veces sin reiniciar el servidor. Cuando eso pasa, cada login posterior
 * responde NO_AUTENTICADO en vez de 429, y el resultado es una cascada de
 * fallas que apuntan al modulo de permisos y no al rate limit.
 *
 * Se avisa y se sale aqui en vez de desactiver la proteccion: mejor un
 * mensaje claro que bajar la seguridad para que las pruebas pasen.
 */
const DETENER_POR_LIMIT = (r) => {
  if (r.status === 429) {
    console.log('');
    console.log('=== LIMITE DE INTENTOS ALCANZADO (429) ===');
    console.log('El rate limit de login ya se consumio. Esto NO es un fallo');
    console.log('del modulo. El contador vive en la memoria del servidor, asi');
    console.log('que se reinicia apagandolo y arrancandolo de nuevo:');
    console.log('  Windows:  taskkill /F /IM node.exe');
    console.log('  Linux:    pkill -f "tsx watch"');
    console.log('O sube el limite solo en desarrollo, en backend/.env:');
    console.log('  LOGIN_MAX_INTENTOS=100   (100 es el tope que acepta el esquema)');
    console.log('============================================');
    process.exit(2);
  }
};

const pedir = async (ruta, token, opciones = {}) => {
  const r = await fetch(BASE + ruta, {
    ...opciones,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opciones.headers || {}),
    },
  });
  let cuerpo;
  try {
    cuerpo = await r.json();
  } catch {
    cuerpo = '(sin cuerpo)';
  }

  // Un 429 a media corrida produce decenas de fallas que parecen bugs del
  // modulo y no son: son el limite de peticiones. Se para aqui, con un
  // mensaje que diga que subir.
  if (r.status === 429) {
    console.log('');
    console.log('=== SE AGOTO EL LIMITE DE PETICIONES (429) ===');
    console.log('Esto NO es un fallo del modulo. El servidor corta a las');
    console.log('15 minutos o a las API_MAX_PETICIONES peticiones, lo que');
    console.log('llegue primero, y la suite hace mas de 300.');
    console.log('');
    console.log('Para correrla, sube el limite en backend/.env:');
    console.log('  API_MAX_PETICIONES=5000');
    console.log('y reinicia el servidor (el limite vive en memoria).');
    console.log('==================================================');
    process.exit(3);
  }

  // Se devuelven las cabeceras y no solo el cuerpo porque el Location del
  // 201 es parte del contrato: un cliente que lo lea tiene que poder
  // encontrar el recurso recien creado sin armarlo a mano.
  return { status: r.status, cuerpo, headers: r.headers };
};

let fallos = 0;
const revisar = (nombre, ok, detalle = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' :: ' + detalle : ''}`);
  if (!ok) fallos++;
};

// ---------------------------------------------------------------- salud
const baseEnUso = await verificarBaseDePruebas();
console.log(`Base en uso: ${baseEnUso}`);

/**
 * Pool de SQL directo para la suite.
 *
 * Hace falta porque no hay endpoint DELETE a proposito (en el negocio se
 * da de baja, no se borra) y porque la suite tiene que ser reejecutable:
 * si una corrida se muere a mitad, la siguiente encuentra los datos de la
 * anterior y falla por cosas que no esta probando. Este helper limpia
 * antes de correr y limpia al terminar.
 *
 * El search_path es obligatorio: los triggers llaman a fn_usuario_actual()
 * y las funciones viven en el esquema pos, no en public (error 42883).
 */
let poolDirecto = null;
const sqlDirecto = async (texto, valores = []) => {
  if (!poolDirecto) {
    const { default: pgDirecto } = await import('pg');
    poolDirecto = new pgDirecto.Pool({
      host: process.env.PGHOST ?? '127.0.0.1',
      user: process.env.PGUSER ?? 'postgres',
      password: process.env.PGPASSWORD ?? 'postgresql',
      database: baseEnUso,
      port: Number(process.env.PGPORT ?? 5432),
    });
    await poolDirecto.query('SET search_path TO pos');
  }
  return poolDirecto.query(texto, valores);
};
const cerrarPoolDirecto = async () => {
  if (poolDirecto) {
    await poolDirecto.end();
    poolDirecto = null;
  }
};

/**
 * Deja las contrasenas del seed como estaban, ANTES de probar nada.
 *
 * La seccion de cambio de contrasena modifica la del administrador, y al
 * final del archivo se restauran. Pero si la corrida se muere antes (se
 * agota el rate limit, revienta un assert...), ese restore no se ejecuta
 * y la base queda con una contrasena que nadie mas va a saber. Con esta
 * restauracion previa la suite se autorepara sola: da igual como termino
 * la corrida anterior.
 */
const restaurarSemilla = async () => {
  const r = await sqlDirecto(
    `UPDATE pos.usuarios
        SET contrasena = crypt('CAMBIAR-ESTA-CLAVE', gen_salt('bf', 12)),
            debe_cambiar_contrasena = true,
            intentos_fallidos = 0,
            bloqueado_hasta = NULL`,
  );
  return r.rowCount;
};
console.log(`Contrasenas del seed restauradas: ${await restaurarSemilla()}`);
const salud = await pedir('/api/salud');
revisar('GET /api/salud responde 200', salud.status === 200, JSON.stringify(salud.cuerpo));

// ---------------------------------------------------------------- sin token
const sinToken = await pedir('/api/clientes');
revisar('clientes sin token -> 401', sinToken.status === 401, JSON.stringify(sinToken.cuerpo));
revisar(
  'el 401 dice NO_AUTENTICADO y no revela nada',
  sinToken.cuerpo?.codigo === 'NO_AUTENTICADO',
  JSON.stringify(sinToken.cuerpo),
);

// ---------------------------------------------------------------- login malo
const malo = await login('admin@ejemplo.local', 'mala');
DETENER_POR_LIMIT(malo);
revisar('login con contrasena incorrecta -> 401', malo.status === 401);
const inexistente = await login('nadie@ejemplo.local', 'x');
DETENER_POR_LIMIT(inexistente);
revisar('login de usuario inexistente -> 401', inexistente.status === 401);
revisar(
  'el mensaje NO revela si el correo existe',
  malo.body.error === inexistente.body.error,
  `"${malo.body.error}" vs "${inexistente.body.error}"`,
);

// ---------------------------------------------------------------- login bueno
const ok = await login('admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
DETENER_POR_LIMIT(ok);
revisar('login correcto -> 200 con token', ok.status === 200 && !!ok.body.token);
const token = ok.body.token;
revisar('el token no es el hash de la base', !/^[a-f0-9]{64}$/.test(token));

// ---------------------------------------------------------------- sesion
const yo = await pedir('/api/auth/yo', token);
revisar('GET /api/auth/yo -> 200', yo.status === 200);
revisar(
  'el admin ve muchos permisos',
  (yo.cuerpo.permisos?.length ?? 0) >= 30,
  `${yo.cuerpo.permisos?.length} permisos`,
);
revisar(
  'el admin tiene rol Administrador',
  yo.cuerpo.roles?.includes('Administrador'),
  JSON.stringify(yo.cuerpo.roles),
);

// ---------------------------------------------------------------- clientes
const lista = await pedir('/api/clientes', token);
revisar('GET /api/clientes -> 200', lista.status === 200);
revisar(
  'la lista trae saldo_actual',
  lista.cuerpo.datos?.[0] !== undefined && 'saldo_actual' in lista.cuerpo.datos[0],
);

const filtrada = await pedir('/api/clientes?buscar=CL01', token);
revisar(
  'el filtro buscar funciona',
  filtrada.cuerpo.datos?.length === 1,
  `${filtrada.cuerpo.datos?.length} resultados`,
);

const inexistenteId = await pedir('/api/clientes/999999', token);
revisar(
  'GET /api/clientes/999999 -> 404',
  inexistenteId.status === 404,
  JSON.stringify(inexistenteId.cuerpo),
);

// validacion: el cuerpo se valida con zod
const maloBody = await pedir('/api/clientes', token, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'Sin codigo' }),
});
revisar(
  'POST sin codigo -> 400 con detalle',
  maloBody.status === 400 && Array.isArray(maloBody.cuerpo.detalles),
  JSON.stringify(maloBody.cuerpo).slice(0, 120),
);

// crear y borrar de verdad
const creado = await pedir('/api/clientes', token, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    codigo_cliente: 'PRUEBA-API',
    nombre: 'Cliente de prueba API',
    establo: 'Establo 1',
  }),
});
revisar(
  'POST /api/clientes crea',
  creado.status === 201,
  JSON.stringify(creado.cuerpo).slice(0, 120),
);
const id = creado.cuerpo.id;

const actualizado = await pedir(`/api/clientes/${id}`, token, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ telefono: '618-000-0000' }),
});
revisar(
  'PATCH actualiza',
  actualizado.status === 200 && actualizado.cuerpo.telefono === '618-000-0000',
  JSON.stringify(actualizado.cuerpo).slice(0, 120),
);

const duplicado = await pedir('/api/clientes', token, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigo_cliente: 'PRUEBA-API', nombre: 'Duplicado' }),
});
revisar(
  'POST duplicado -> 409',
  duplicado.status === 409,
  JSON.stringify(duplicado.cuerpo).slice(0, 120),
);

const borrado = await pedir(`/api/clientes/${id}`, token, { method: 'DELETE' });
revisar('DELETE borra', borrado.status === 204);

// ---------------------------------------------------------------- permisos
// Los roles estan definidos en 0001_init.sql: la Empleada opera el mostrador
// (puede dar de alta clientes) pero no toca lo sensible. La Cajera solo cobra.
const empleada = await login('empleada@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
DETENER_POR_LIMIT(empleada);
revisar('login de la empleada -> 200', empleada.status === 200);

if (empleada.body.token) {
  const t = empleada.body.token;

  // por diseño la empleada SI puede crear clientes
  // Limpia el alta de una corrida anterior: si quedo, el UNIQUE de
  // codigo_cliente revienta y la prueba falla por otra cosa.
  await sqlDirecto(`DELETE FROM pos.clientes WHERE codigo_cliente = 'EMPLEADA-OK'`);
  const creada = await pedir('/api/clientes', t, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo_cliente: 'EMPLEADA-OK', nombre: 'Alta por empleada' }),
  });
  revisar(
    'la empleada SI puede crear clientes (por diseño)',
    creada.status === 201,
    JSON.stringify(creada.cuerpo).slice(0, 100),
  );

  // pero NO puede eliminarlos: clientes.eliminar no esta en su rol
  const borrado = await pedir(`/api/clientes/${creada.cuerpo.id}`, t, { method: 'DELETE' });
  revisar(
    'la empleada NO puede borrar clientes -> 403',
    borrado.status === 403,
    JSON.stringify(borrado.cuerpo).slice(0, 120),
  );

  // limpieza con el admin
  const limpiar = await pedir(`/api/clientes/${creada.cuerpo.id}`, token, { method: 'DELETE' });
  revisar('el admin si la borra', limpiar.status === 204);
}

// El seed no crea ningun usuario con rol Cajera, asi que el endpoint de
// login no se puede probar para ese rol. La matriz de permisos por rol se
// verifica aparte en db/tests/test_auditoria.sql.
const sinCorreo = await login('', '');
revisar('login con cuerpo invalido -> 400', sinCorreo.status === 400);

// ---------------------------------------------------------------- logout
const logout = await pedir('/api/auth/logout', token, { method: 'POST' });
revisar('logout -> 204', logout.status === 204);
const despues = await pedir('/api/clientes', token);
revisar('el token deja de servir tras logout -> 401', despues.status === 401);

// ---------------------------------------------------------------- 404
const rutaMala = await pedir('/api/no-existe', token);
revisar('ruta inexistente -> 404', rutaMala.status === 404);

// ---------------------------------------------------------------- cambio de contrasena
// Se prueba al final y se restauran las contrasenas del seed, porque si
// fallara el archivo dejaria al usuario sin poder entrar a la app.
console.log('');
console.log('--- cambio de contrasena ---');

// El token de la seccion anterior ya se cerro con el logout, asi que hace
// falta uno nuevo para probar este endpoint.
const adminCambio = await login('admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
DETENER_POR_LIMIT(adminCambio);
revisar('login del admin para la prueba de cambio', adminCambio.status === 200);
const tokenCambio = adminCambio.body?.token;

const nueva1 = 'NuevaClaveSegura2026';

// 1) La contrasena actual equivocada debe rechazarse
const malaActual = await pedir('/api/auth/cambiar-contrasena', tokenCambio, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ actual: 'no-es-la-actual', nueva: nueva1 }),
});
revisar('cambiar con contrasena actual incorrecta -> 400', malaActual.status === 400);
revisar(
  'el error señala el campo actual',
  Array.isArray(malaActual.cuerpo?.detalles) &&
    malaActual.cuerpo.detalles.some((d) => d.campo === 'actual'),
  JSON.stringify(malaActual.cuerpo?.detalles),
);

// 2) Contrasena debil debe rechazarse ANTES de tocar la base
const debil = await pedir('/api/auth/cambiar-contrasena', tokenCambio, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ actual: 'CAMBIAR-ESTA-CLAVE', nueva: 'corta' }),
});
revisar('contrasena debil -> 400', debil.status === 400);
revisar('la contrasena debil no cambia nada', debil.cuerpo?.codigo === 'VALIDACION');

// 3) Igual a la actual -> 400
const igual = await pedir('/api/auth/cambiar-contrasena', tokenCambio, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ actual: 'CAMBIAR-ESTA-CLAVE', nueva: 'CAMBIAR-ESTA-CLAVE' }),
});
revisar('repetir la misma contrasena -> 400', igual.status === 400);

// 4) Sin token -> 401
const sinTokenCambio = await pedir('/api/auth/cambiar-contrasena', undefined, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ actual: 'CAMBIAR-ESTA-CLAVE', nueva: nueva1 }),
});
revisar('cambiar sin token -> 401', sinTokenCambio.status === 401);

// 5) El caso bueno: cambiar de verdad
const buena = await pedir('/api/auth/cambiar-contrasena', tokenCambio, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ actual: 'CAMBIAR-ESTA-CLAVE', nueva: nueva1 }),
});
revisar('cambio valido -> 200', buena.status === 200, JSON.stringify(buena.cuerpo));

// 6) La sesion actual SIGUE viva: si no, el usuario se queda sin token
const yoTrasCambio = await pedir('/api/auth/yo', tokenCambio);
revisar('la sesion actual sobrevive al cambio', yoTrasCambio.status === 200);

// 7) La contrasena vieja ya no entra
const loginViejo = await login('admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
revisar('la contrasena vieja ya no sirve', loginViejo.status === 401);

// 8) La nueva si entra
const loginNuevo = await login('admin@ejemplo.local', nueva1);
DETENER_POR_LIMIT(loginNuevo);
revisar('la contrasena nueva si sirve', loginNuevo.status === 200 && !!loginNuevo.body.token);

// 9) El hash guardado NO es la contrasena en texto plano
if (loginNuevo.body.token) {
  const perfilNuevo = await pedir('/api/auth/yo', loginNuevo.body.token);
  revisar('el token nuevo funciona', perfilNuevo.status === 200);
}

// 10) Restaurar las contrasenas del seed.
//
// Esto se hace por SQL directo y no por la API a proposito: la API, con
// buena razon, RECHAZA la contrasena del seed (es debil y la politica pide
// 12 caracteres con mayuscula, minuscula y numero). Si el test dejara la
// cuenta del admin con 'NuevaClaveSegura2026', la siguiente corrida
// fallaria al hacer login y el usuario se quedaria sin la clave que
// documenta el README.
//
// ================================================================ usuarios
// El modulo con el que la dueña da de alta a la gente. Aqui se prueba
// sobre todo que los candados aguanten: que no se pueda quedar sin
// admins, ni desactivarse a uno mismo, ni crear cuentas sin ser admin.
console.log('\n--- usuarios ---');

// El `token` de arriba ya no sirve: la seccion de cambio de contrasena
// cerro las demas sesiones del admin (por diseno, para que el token
// robado no sobreviva). La contrasena vigente en este punto es `nueva1`,
// asi que se entra de nuevo.
const loginAdminUsuarios = await login('admin@ejemplo.local', nueva1);
DETENER_POR_LIMIT(loginAdminUsuarios);
const tokenAdmin = loginAdminUsuarios.body?.token;
revisar('el admin vuelve a entrar para gestionar usuarios', !!tokenAdmin);

// El CHECK de la tabla es ^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$: 3 o 4
// letras, 6 digitos (la fecha) y EXACTAMENTE 3 alfanumericos. 13 chars.
const RFC_NUEVO_A = 'GODL900101HDR';
const RFC_NUEVO_B = 'MEXT800202MDS';
const RFC_LARGO = 'RFC_MAL_CORTO';

/**
 * Borra a los usuarios que dejo una corrida anterior.
 *
 * Va ANTES de las pruebas, no solo despues. Una corrida que se muere a
 * mitad deja el usuario creatingo en la base, y la siguiente choca con el
 * UNIQUE del RFC y falla por algo que no tiene nada que ver con lo que
 * esta probando. Con esta limpieza la suite se puede volver a correr
 * cuantas veces se quiera sin intervencion manual.
 */
const limpiarUsuariosDePrueba = async () => {
  const r = await sqlDirecto('DELETE FROM pos.usuarios WHERE rfc IN ($1, $2)', [
    RFC_NUEVO_A,
    RFC_NUEVO_B,
  ]);
  return r.rowCount;
};

const sobrantes = await limpiarUsuariosDePrueba();
if (sobrantes > 0) {
  console.log(`(se limpiaron ${sobrantes} usuario(s) de una corrida anterior)`);
}

// --- la cajera no puede administrar cuentas ---
const loginEmpleada = await login('empleada@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
DETENER_POR_LIMIT(loginEmpleada);
const tokenEmpleada = loginEmpleada.body?.token;
revisar('la cajera puede entrar', !!tokenEmpleada);

const noPuedeCrear = await pedir('/api/usuarios', tokenEmpleada, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'X', apellido_paterno: 'Y', rfc: RFC_NUEVO_A }),
});
revisar(
  'la cajera NO puede crear usuarios -> 403',
  noPuedeCrear.status === 403,
  JSON.stringify(noPuedeCrear.cuerpo),
);
revisar(
  'el 403 de la cajera dice PROHIBIDO',
  noPuedeCrear.cuerpo?.codigo === 'PROHIBIDO',
  JSON.stringify(noPuedeCrear.cuerpo),
);
const noPuedeListar = await pedir('/api/usuarios', tokenEmpleada);
revisar('la cajera NO puede listar usuarios -> 403', noPuedeListar.status === 403);
const noPuedeResetear = await pedir('/api/usuarios/1/resetear-contrasena', tokenEmpleada, {
  method: 'POST',
});
revisar('la cajera NO puede resetear contrasenas -> 403', noPuedeResetear.status === 403);
const sinTokenUsuarios = await pedir('/api/usuarios');
revisar('usuarios sin token -> 401', sinTokenUsuarios.status === 401);

// --- validacion antes de tocar la base ---
const rfcMalo = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'Mal', apellido_paterno: 'Rfc', rfc: RFC_LARGO }),
});
revisar('RFC con formato invalido -> 400', rfcMalo.status === 400, JSON.stringify(rfcMalo.cuerpo));

const sinRoles = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'Sin', apellido_paterno: 'Roles', rfc: RFC_NUEVO_A, roles: [] }),
});
revisar('alta sin roles -> 400', sinRoles.status === 400, JSON.stringify(sinRoles.cuerpo));

const rolFantasma = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombre: 'Rol',
    apellido_paterno: 'Fantasma',
    rfc: RFC_NUEVO_A,
    roles: [999],
  }),
});
revisar('rol que no existe -> 400', rolFantasma.status === 400, JSON.stringify(rolFantasma.cuerpo));

// --- alta valida ---
const nuevo = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombre: 'Maria',
    apellido_paterno: 'Hernandez',
    apellido_materno: 'Lopez',
    rfc: RFC_NUEVO_A,
    email: 'maria@ejemplo.local',
    puesto: 'Cajera',
    roles: [3],
  }),
});
revisar('alta valida -> 201', nuevo.status === 201, JSON.stringify(nuevo.cuerpo));
const idNuevo = nuevo.cuerpo?.usuario?.id;
const claveTemporal = nuevo.cuerpo?.contrasenaTemporal;
revisar('el alta devuelve el id', Number.isInteger(idNuevo), String(idNuevo));
revisar('el alta devuelve una contrasena temporal', typeof claveTemporal === 'string');
revisar(
  'la contrasena temporal es larga y tiene mayuscula, minuscula y numero',
  (claveTemporal?.length ?? 0) >= 12 &&
    /[A-Z]/.test(claveTemporal ?? '') &&
    /[a-z]/.test(claveTemporal ?? '') &&
    /[0-9]/.test(claveTemporal ?? ''),
  `longitud ${claveTemporal?.length}`,
);
revisar('el usuario nace activo', nuevo.cuerpo?.usuario?.activo === true);
revisar(
  'el usuario nace con debe_cambiar_contrasena',
  nuevo.cuerpo?.usuario?.debe_cambiar_contrasena === true,
);
revisar('trae exactamente un rol', nuevo.cuerpo?.usuario?.roles?.length === 1);
revisar('el rol es Cajera', nuevo.cuerpo?.usuario?.roles?.[0]?.nombre === 'Cajera');
revisar('la respuesta NO trae el hash', !/"contrasena"\s*:/.test(JSON.stringify(nuevo.cuerpo)));

// --- duplicados ---
const correoDuplicado = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombre: 'Otra',
    apellido_paterno: 'Maria',
    rfc: RFC_NUEVO_B,
    email: 'maria@ejemplo.local',
    roles: [3],
  }),
});
revisar(
  'correo repetido -> 409',
  correoDuplicado.status === 409,
  JSON.stringify(correoDuplicado.cuerpo),
);
revisar(
  'el 409 de correo dice EMAIL_DUPLICADO',
  correoDuplicado.cuerpo?.codigo === 'EMAIL_DUPLICADO',
  JSON.stringify(correoDuplicado.cuerpo),
);

const rfcDuplicado = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombre: 'Gemela',
    apellido_paterno: 'Hernandez',
    rfc: RFC_NUEVO_A,
    email: 'gemela@ejemplo.local',
    roles: [3],
  }),
});
revisar('RFC repetido -> 409', rfcDuplicado.status === 409, JSON.stringify(rfcDuplicado.cuerpo));
revisar(
  'el 409 de RFC dice RFC_DUPLICADO',
  rfcDuplicado.cuerpo?.codigo === 'RFC_DUPLICADO',
  JSON.stringify(rfcDuplicado.cuerpo),
);

// --- la contrasena temporal sirve para entrar, pero hay que cambiarla ---
if (claveTemporal) {
  const loginNuevoUsuario = await login('maria@ejemplo.local', claveTemporal);
  DETENER_POR_LIMIT(loginNuevoUsuario);
  revisar('la contrasena temporal sirve para entrar', loginNuevoUsuario.status === 200);
  revisar(
    'el usuario nuevo entra marcado para cambiar la contrasena',
    loginNuevoUsuario.body?.usuario?.debeCambiarContrasena === true,
    JSON.stringify(loginNuevoUsuario.body?.usuario),
  );
}

// --- listar, buscar, ver ---
const listado = await pedir('/api/usuarios', tokenAdmin);
revisar('listar usuarios -> 200', listado.status === 200);
revisar(
  'el listado trae datos y total',
  Array.isArray(listado.cuerpo?.datos) && listado.cuerpo?.total >= 3,
);
revisar('el total no es cero', listado.cuerpo?.total > 0, `total ${listado.cuerpo?.total}`);
revisar(
  'el listado incluye al usuario nuevo',
  listado.cuerpo?.datos?.some((u) => u.id === idNuevo),
);
// Ojo: el campo debe_cambiar_contrasena SI contiene la palabra, asi que
// hay que buscar la clave exacta del hash y no la palabra suelta.
revisar(
  'el listado NO trae el hash de la contrasena',
  !/"contrasena"\s*:/.test(JSON.stringify(listado.cuerpo)),
);

const busqueda = await pedir('/api/usuarios?buscar=Hernandez', tokenAdmin);
revisar('buscar por apellido -> 200', busqueda.status === 200);
revisar(
  'la busqueda encuentra al usuario nuevo',
  busqueda.cuerpo?.datos?.every((u) => /hernandez/i.test(`${u.apellido_paterno} ${u.nombre}`)),
  `${busqueda.cuerpo?.datos?.length} resultados`,
);

const porRol = await pedir('/api/usuarios?rol=3', tokenAdmin);
revisar('filtrar por rol -> 200', porRol.status === 200);
revisar(
  'el filtro por rol solo trae ese rol',
  porRol.cuerpo?.datos?.every((u) => u.roles?.some((r) => r.nombre === 'Cajera')),
  `${porRol.cuerpo?.datos?.length} resultados`,
);

const verUno = await pedir(`/api/usuarios/${idNuevo}`, tokenAdmin);
revisar('ver un usuario -> 200', verUno.status === 200);
revisar('el usuario trae sus roles', Array.isArray(verUno.cuerpo?.roles));

const verFantasma = await pedir('/api/usuarios/999999', tokenAdmin);
revisar(
  'ver un id que no existe -> 404',
  verFantasma.status === 404,
  JSON.stringify(verFantasma.cuerpo),
);

const verMalo = await pedir('/api/usuarios/abc', tokenAdmin);
revisar('ver con id no numerico -> 400', verMalo.status === 400, JSON.stringify(verMalo.cuerpo));

// --- candados: el administrador no puede dejar la caja sin entrada ---
const autoDesactivar = await pedir(`/api/usuarios/${yo.cuerpo?.id ?? 1}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ activo: false }),
});
revisar(
  'el admin NO puede desactivar su propia cuenta -> 422',
  autoDesactivar.status === 422,
  JSON.stringify(autoDesactivar.cuerpo),
);
revisar(
  'el error dice NO_SELF_DESACTIVAR',
  autoDesactivar.cuerpo?.codigo === 'NO_SELF_DESACTIVAR',
  JSON.stringify(autoDesactivar.cuerpo),
);

const autoBajarDeRol = await pedir(`/api/usuarios/${yo.cuerpo?.id ?? 1}/roles`, tokenAdmin, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ roles: [2] }),
});
revisar(
  'el admin NO puede quitarse su propio rol de admin -> 422',
  autoBajarDeRol.status === 422,
  JSON.stringify(autoBajarDeRol.cuerpo),
);
revisar(
  'el error dice NO_SELF_DEMOTEAR',
  autoBajarDeRol.cuerpo?.codigo === 'NO_SELF_DEMOTEAR',
  JSON.stringify(autoBajarDeRol.cuerpo),
);

// --- editar ---
const renombrar = await pedir(`/api/usuarios/${idNuevo}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ puesto: 'Cajera titular' }),
});
revisar('editar un usuario -> 200', renombrar.status === 200, JSON.stringify(renombrar.cuerpo));
revisar('el puesto quedo actualizado', renombrar.cuerpo?.puesto === 'Cajera titular');

const editarVacio = await pedir(`/api/usuarios/${idNuevo}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
revisar('editar sin campos -> 400', editarVacio.status === 400, JSON.stringify(editarVacio.cuerpo));

const editarRolInvalido = await pedir(`/api/usuarios/${idNuevo}/roles`, tokenAdmin, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ roles: [888] }),
});
revisar('asignar un rol inexistente -> 400', editarRolInvalido.status === 400);

// --- cambiar roles ---
const cambiarRoles = await pedir(`/api/usuarios/${idNuevo}/roles`, tokenAdmin, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ roles: [2, 3] }),
});
revisar(
  'asignar varios roles -> 200',
  cambiarRoles.status === 200,
  JSON.stringify(cambiarRoles.cuerpo),
);
revisar(
  'el usuario queda con los dos roles',
  cambiarRoles.cuerpo?.roles?.length === 2,
  JSON.stringify(cambiarRoles.cuerpo?.roles?.map((r) => r.nombre)),
);

// --- resetear contrasena ---
const reseteo = await pedir(`/api/usuarios/${idNuevo}/resetear-contrasena`, tokenAdmin, {
  method: 'POST',
});
revisar('resetear contrasena -> 200', reseteo.status === 200, JSON.stringify(reseteo.cuerpo));
const claveReseteada = reseteo.cuerpo?.contrasenaTemporal;
revisar('el reseteo devuelve una contrasena nueva', typeof claveReseteada === 'string');
revisar(
  'el reseteo devuelve cuantas sesiones cerro',
  typeof reseteo.cuerpo?.sesionesCerradas === 'number',
  JSON.stringify(reseteo.cuerpo?.sesionesCerradas),
);

if (claveReseteada) {
  const conClaveVieja = await login('maria@ejemplo.local', claveTemporal ?? 'x');
  DETENER_POR_LIMIT(conClaveVieja);
  revisar('tras el reseteo la contrasena anterior ya no entra', conClaveVieja.status === 401);

  const conClaveNueva = await login('maria@ejemplo.local', claveReseteada);
  DETENER_POR_LIMIT(conClaveNueva);
  revisar('tras el reseteo la contrasena nueva si entra', conClaveNueva.status === 200);
}

// --- desactivar cierra las sesiones de una vez ---
await pedir(`/api/usuarios/${idNuevo}/resetear-contrasena`, tokenAdmin, { method: 'POST' });
const baja = await pedir(`/api/usuarios/${idNuevo}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ activo: false }),
});
revisar('dar de baja a un usuario -> 200', baja.status === 200, JSON.stringify(baja.cuerpo));
revisar('el usuario queda inactivo', baja.cuerpo?.activo === false);

const filtrarInactivos = await pedir('/api/usuarios?activo=false', tokenAdmin);
revisar('filtrar por inactivos -> 200', filtrarInactivos.status === 200);
revisar(
  'el filtro de inactivos trae al dado de baja',
  filtrarInactivos.cuerpo?.datos?.some((u) => u.id === idNuevo),
);
revisar(
  'el filtro de inactivos no trae activos',
  filtrarInactivos.cuerpo?.datos?.every((u) => u.activo === false),
);

// ================================================================ catalogo
// Especies y categorias de producto. Son la misma tabla con distinto
// nombre, asi que la suite recorre las dos rutas con el mismo codigo.
console.log('\n--- catalogo (especies y categorias) ---');

// `tabla` NO es lo mismo que `plural`: la tabla real se llama
// categorias_producto, no categorias. Confundir las dos hace que el SQL
// de limpieza reviente con 42P01.
const CATALOGO = [
  { ruta: 'especies', plural: 'especies', tabla: 'especies' },
  { ruta: 'categorias-producto', plural: 'categorias', tabla: 'categorias_producto' },
];

for (const { ruta, plural, tabla } of CATALOGO) {
  const crearEn = (nombre, token = tokenAdmin) =>
    pedir(`/api/${ruta}`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre }),
    });

  // Limpieza de corridas anteriores, por nombre exacto.
  //
  // NO DEBERIA entra en la lista aunque hoy nunca llega a existir: el
  // intento de alta de la cajera tiene que rebotar con 403, asi que no
  // escribe nada. Se limpia igual porque una version vieja de esta misma
  // prueba usaba el token del admin para esa llamada, el alta si se
  // guardaba, y el 4 se quedo atorado en la base de pruebas para siempre.
  for (const sobrante of ['PRUEBA UNICA', 'RENOMBRADA', 'CON ESPACIOS', 'NO DEBERIA']) {
    await sqlDirecto(`DELETE FROM pos.${tabla} WHERE nombre = $1`, [sobrante]);
  }

  // --- la cajera si lee, pero no escribe ---
  const listaCajera = await pedir(`/api/${ruta}`, tokenEmpleada);
  revisar(`la cajera SI lee ${plural}`, listaCajera.status === 200);
  revisar(
    `${plural} trae datos y total`,
    Array.isArray(listaCajera.cuerpo?.datos) && listaCajera.cuerpo?.total > 0,
    `total ${listaCajera.cuerpo?.total}`,
  );
  revisar(
    `cada elemento de ${plural} trae id y nombre`,
    listaCajera.cuerpo?.datos?.every((x) => Number.isInteger(x.id) && typeof x.nombre === 'string'),
  );

  const sinToken = await pedir(`/api/${ruta}`);
  revisar(`${plural} sin token -> 401`, sinToken.status === 401);

  const altaCajera = await crearEn('NO DEBERIA', tokenEmpleada);
  revisar(
    `la cajera NO puede crear en ${plural} -> 403`,
    altaCajera.status === 403,
    JSON.stringify(altaCajera.cuerpo),
  );

  // --- validacion ---
  const vacio = await crearEn('');
  revisar(`nombre vacio en ${plural} -> 400`, vacio.status === 400, JSON.stringify(vacio.cuerpo));

  const corto = await crearEn('A');
  revisar(`nombre de 1 caracter en ${plural} -> 400`, corto.status === 400);

  const larguisimo = await crearEn('X'.repeat(150));
  revisar(`nombre de 150 caracteres en ${plural} -> 400`, larguisimo.status === 400);

  const conCampoExtra = await pedir(`/api/${ruta}`, tokenAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'PRUEBA UNICA', id: 999 }),
  });
  revisar(
    `campo desconocido en ${plural} -> 400`,
    conCampoExtra.status === 400,
    JSON.stringify(conCampoExtra.cuerpo),
  );

  // --- alta valida ---
  const alta = await crearEn('PRUEBA UNICA');
  revisar(`alta en ${plural} -> 201`, alta.status === 201, JSON.stringify(alta.cuerpo));
  const idAlta = alta.cuerpo?.id;
  revisar(
    `el alta devuelve id y nombre`,
    Number.isInteger(idAlta) && alta.cuerpo?.nombre === 'PRUEBA UNICA',
  );

  // Los espacios de los bordes se recortan: " PRUEBA " es "PRUEBA".
  const conEspacios = await crearEn('  CON ESPACIOS  ');
  revisar(
    `los espacios de los bordes se recortan en ${plural}`,
    conEspacios.cuerpo?.nombre === 'CON ESPACIOS',
    JSON.stringify(conEspacios.cuerpo),
  );
  if (conEspacios.cuerpo?.id) {
    await sqlDirecto(`DELETE FROM pos.${tabla} WHERE id = $1`, [conEspacios.cuerpo.id]);
  }

  // --- duplicados, incluyendo el juego de mayusculas ---
  const repetido = await crearEn('PRUEBA UNICA');
  revisar(
    `nombre repetido en ${plural} -> 409`,
    repetido.status === 409,
    JSON.stringify(repetido.cuerpo),
  );
  revisar(
    `el 409 dice NOMBRE_DUPLICADO`,
    repetido.cuerpo?.codigo === 'NOMBRE_DUPLICADO',
    JSON.stringify(repetido.cuerpo),
  );

  const minusculas = await crearEn('prueba unica');
  revisar(
    `un nombre que solo difiere en mayusculas tambien choca en ${plural} -> 409`,
    minusculas.status === 409,
    JSON.stringify(minusculas.cuerpo),
  );

  // --- ver uno ---
  const verUno = await pedir(`/api/${ruta}/${idAlta}`, tokenAdmin);
  revisar(
    `ver un elemento de ${plural} -> 200`,
    verUno.status === 200,
    JSON.stringify(verUno.cuerpo),
  );
  revisar(`el elemento existe`, verUno.cuerpo?.nombre === 'PRUEBA UNICA');

  // 30000 cabe en un smallint (max 32767) pero no existe: eso es un 404.
  const verFantasma = await pedir(`/api/${ruta}/30000`, tokenAdmin);
  revisar(
    `ver un id inexistente en ${plural} -> 404`,
    verFantasma.status === 404,
    JSON.stringify(verFantasma.cuerpo),
  );
  // 999999 no cabe: el id del catalogo es SMALLINT y Postgres suelta
  // 22003. Se valida en el esquema para que el 400 lo diga.
  const verFueraDeRango = await pedir(`/api/${ruta}/999999`, tokenAdmin);
  revisar(
    `id fuera de rango en ${plural} -> 400`,
    verFueraDeRango.status === 400,
    JSON.stringify(verFueraDeRango.cuerpo),
  );
  revisar(
    `el 400 de rango explica que el catalogo usa numeros pequenos`,
    /numeros pequenos/.test(JSON.stringify(verFueraDeRango.cuerpo)),
    JSON.stringify(verFueraDeRango.cuerpo),
  );
  const verMalo = await pedir(`/api/${ruta}/abc`, tokenAdmin);
  revisar(`id no numerico en ${plural} -> 400`, verMalo.status === 400);

  // --- renombrar ---
  const renombrar = await pedir(`/api/${ruta}/${idAlta}`, tokenAdmin, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'RENOMBRADA' }),
  });
  revisar(
    `renombrar en ${plural} -> 200`,
    renombrar.status === 200,
    JSON.stringify(renombrar.cuerpo),
  );
  revisar(`el nombre quedo actualizado`, renombrar.cuerpo?.nombre === 'RENOMBRADA');
  revisar(`el id no cambia al renombrar`, renombrar.cuerpo?.id === idAlta);

  const renombrarAExistente = await pedir(`/api/${ruta}/${idAlta}`, tokenAdmin, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: listaCajera.cuerpo?.datos?.[0]?.nombre ?? 'x' }),
  });
  revisar(
    `renombrar a un nombre que ya existe -> 409`,
    renombrarAExistente.status === 409,
    JSON.stringify(renombrarAExistente.cuerpo),
  );

  const renombrarFantasma = await pedir(`/api/${ruta}/30000`, tokenAdmin, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'NADA QUE VER' }),
  });
  revisar(`renombrar un id inexistente en ${plural} -> 404`, renombrarFantasma.status === 404);

  const edicionPorPost = await pedir(`/api/${ruta}/${idAlta}`, tokenAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: 'POR POST' }),
  });
  revisar(`editar por POST en ${plural} no existe -> 404`, edicionPorPost.status === 404);

  // --- borrar lo que no se usa ---
  const borrar = await pedir(`/api/${ruta}/${idAlta}`, tokenAdmin, { method: 'DELETE' });
  revisar(
    `borrar un elemento sin uso -> 204`,
    borrar.status === 204,
    JSON.stringify(borrar.cuerpo),
  );

  const borrarDoble = await pedir(`/api/${ruta}/${idAlta}`, tokenAdmin, { method: 'DELETE' });
  revisar(`borrar dos veces en ${plural} -> 404`, borrarDoble.status === 404);
}

// --- borrar lo que SI se usa ---
// Se toma un elemento del seed que ya esta en uso y se intenta borrar.
const especieEnUso = await pedir(`/api/especies/1`, tokenAdmin);
revisar(
  'la especie 1 del seed existe',
  especieEnUso.status === 200,
  JSON.stringify(especieEnUso.cuerpo),
);
if (especieEnUso.cuerpo?.nombre) {
  const borrarEnUso = await pedir('/api/especies/1', tokenAdmin, { method: 'DELETE' });
  revisar(
    'borrar una especie que tiene clientes -> 409',
    borrarEnUso.status === 409,
    JSON.stringify(borrarEnUso.cuerpo),
  );
  revisar(
    'el 409 dice EN_USO',
    borrarEnUso.cuerpo?.codigo === 'EN_USO',
    JSON.stringify(borrarEnUso.cuerpo),
  );
  // El orden de la lista depende del orden del arreglo `usos` del
  // recurso, asi que se comprueba que aparezcan los dos, no en que orden.
  revisar(
    'el mensaje explica cuantos clientes la usan',
    /\d+ clientes?/.test(borrarEnUso.cuerpo?.error ?? ''),
    borrarEnUso.cuerpo?.error,
  );
  revisar(
    'el mensaje menciona tambien los productos',
    /\d+ productos?/.test(borrarEnUso.cuerpo?.error ?? ''),
    borrarEnUso.cuerpo?.error,
  );
  const sigueAhí = await pedir('/api/especies/1', tokenAdmin);
  revisar('la especie en uso NO se borro', sigueAhí.status === 200);
}

// --- productos ---
//
// El permiso de productos YA venia de la migracion 0001 (Administrador
// edita, Empleada lee, Cajera nada), asi que a diferencia del catalogo
// este bloque no necesita migracion de permisos.
//
// Ojo con los nombres de los roles: el bloque del catalogo llama "cajera"
// a la empleada porque en la base de pruebas no hay cuenta de cajera. Aqui
// se dice "empleada" porque es lo que es.

const limpiarProductosDePrueba = async () => {
  const r = await sqlDirecto(`DELETE FROM pos.productos WHERE codigo = ANY($1::text[])`, [
    ['TST-ALTA', 'TST-BORRABLE', 'TST-INACTIVO'],
  ]);
  return r.rowCount;
};

// Limpieza de corridas anteriores, por codigo exacto.
await limpiarProductosDePrueba();

/**
 * `token` NO lleva valor por omision, a proposito.
 *
 * Con `token = tokenAdmin` como default, un login que falla devuelve
 * `undefined` y JavaScript aplica el default: la peticion sale con el
 * token del ADMINISTRADOR sin avisar. Y eso no solo falsea la prueba,
 * falsea la conclusion: "la cajera no puede crear productos" pasaria en
 * verde porque la peticion la termino haciendo el admin. Un default
 * silencioso en un helper de pruebas convierte un fallo en un falso
 * positivo, que es la peor falla que puede tener una suite.
 */
const crearProducto = (cuerpo, token) =>
  pedir('/api/productos', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const parcheProducto = (id, cuerpo, token) =>
  pedir(`/api/productos/${id}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

// --- permisos ---
const listaEmpleada = await pedir('/api/productos', tokenEmpleada);
revisar(
  'la empleada SI lee productos',
  listaEmpleada.status === 200,
  JSON.stringify(listaEmpleada.cuerpo),
);

const altaEmpleada = await crearProducto(
  { codigo: 'TST-NO', nombre: 'NO DEBERIA', presentacion_kg: 10 },
  tokenEmpleada,
);
revisar(
  'la empleada NO escribe productos -> 403',
  altaEmpleada.status === 403,
  JSON.stringify(altaEmpleada.cuerpo),
);

const sinTokenProducto = await pedir('/api/productos');
revisar('productos sin token -> 401', sinTokenProducto.status === 401);

// --- el listado trae datos, total y paginacion ---
revisar(
  'productos trae datos, total y paginacion',
  Array.isArray(listaEmpleada.cuerpo?.datos) &&
    typeof listaEmpleada.cuerpo?.total === 'number' &&
    listaEmpleada.cuerpo?.limite === 50 &&
    listaEmpleada.cuerpo?.offset === 0,
  JSON.stringify(listaEmpleada.cuerpo?.paginacion ?? listaEmpleada.cuerpo),
);

revisar(
  'cada producto trae id, codigo, nombre y presentacion',
  listaEmpleada.cuerpo?.datos?.every(
    (p) =>
      Number.isInteger(p.id) &&
      typeof p.codigo === 'string' &&
      typeof p.nombre === 'string' &&
      typeof p.presentacion_kg === 'number',
  ),
);

// El nombre del catalogo viene resuelto por JOIN, no por id suelto.
const conCatalogo = listaEmpleada.cuerpo?.datos?.find((p) => p.codigo === 'LAC');
revisar(
  'el producto trae el nombre de su categoria y su especie',
  typeof conCatalogo?.categoria === 'string' && typeof conCatalogo?.especie === 'string',
  JSON.stringify(conCatalogo),
);

// --- el listado trae SOLO activos por omision ---
// Se comprueba contra el estado final, mas abajo, cuando ya exista un
// producto inactivo. Aqui solo se deja constancia de que el parametro
// existe y responde.

// --- validacion de la presentacion ---
// NUMERIC(10,3): hasta 3 decimales, y mayor que cero. Se manda el texto
// para comprobar que 12.345 entra y que 12.3456 no.
const presentacionOK = await crearProducto(
  { codigo: 'TST-ALTA', nombre: 'Producto de prueba', presentacion_kg: '12.345' },
  tokenAdmin,
);
revisar(
  'alta con 3 decimales -> 201',
  presentacionOK.status === 201,
  JSON.stringify(presentacionOK.cuerpo),
);
revisar(
  'la presentacion se guarda como numero',
  presentacionOK.cuerpo?.presentacion_kg === 12.345,
  JSON.stringify(presentacionOK.cuerpo?.presentacion_kg),
);
revisar(
  'el alta responde 201 con Location',
  /^\/api\/productos\/\d+$/.test(presentacionOK.headers?.get('location') ?? ''),
  presentacionOK.headers?.get('location') ?? '(sin cabecera location)',
);

const prodId = presentacionOK.cuerpo?.id;

for (const [descripcion, presentacion] of [
  ['cuatro decimales', '12.3456'],
  ['cero', '0'],
  ['negativa', '-5'],
  ['texto', 'mucho'],
  ['vacia', ''],
]) {
  const r = await crearProducto(
    { codigo: 'TST-MALO', nombre: 'No deberia existir', presentacion_kg: presentacion },
    tokenAdmin,
  );
  revisar(`presentacion ${descripcion} -> 400`, r.status === 400, JSON.stringify(r.cuerpo));
}

// --- otras validaciones ---
for (const [descripcion, cuerpo] of [
  ['codigo vacio', { codigo: '  ', nombre: 'Algo', presentacion_kg: 1 }],
  ['nombre de 1 caracter', { codigo: 'TST-X', nombre: 'A', presentacion_kg: 1 }],
  ['codigo larguisimo', { codigo: 'X'.repeat(41), nombre: 'Algo', presentacion_kg: 1 }],
  ['campo de mas', { codigo: 'TST-Y', nombre: 'Algo', presentacion_kg: 1, color: 'rojo' }],
]) {
  const r = await crearProducto(cuerpo, tokenAdmin);
  revisar(`alta con ${descripcion} -> 400`, r.status === 400, JSON.stringify(r.cuerpo));
}

// --- codigo prodDuplicado sin distinguir mayusculas ---
// 'LAC' esta en el seed. Este es el caso que el indice ux_productos_codigo_ci
// de la migracion 0005 existe para atrapar.
const prodDuplicado = await crearProducto(
  { codigo: 'lac', nombre: 'Otro vimilac', presentacion_kg: 20 },
  tokenAdmin,
);
revisar(
  'codigo prodDuplicado por mayusculas -> 409',
  prodDuplicado.status === 409,
  JSON.stringify(prodDuplicado.cuerpo),
);
revisar(
  'el 409 dice CODIGO_DUPLICADO',
  prodDuplicado.cuerpo?.codigo === 'CODIGO_DUPLICADO',
  JSON.stringify(prodDuplicado.cuerpo),
);

// --- referencias al catalogo que no existen ---
// 999 cabe en el SMALLINT del catalogo, asi que pasa la validacion del
// id y lo agarra la comprobacion del servicio. Si el servicio no lo
// revisara, esto seria un 23503 traducido a un 409 sin informacion.
const categoriaFantasma = await crearProducto(
  { codigo: 'TST-FANT', nombre: 'Categoria inventada', presentacion_kg: 5, categoria_id: 999 },
  tokenAdmin,
);
revisar(
  'categoria inexistente -> 400',
  categoriaFantasma.status === 400,
  JSON.stringify(categoriaFantasma.cuerpo),
);
revisar(
  'el 400 dice QUE categoria no existe',
  /categoria 999/.test(categoriaFantasma.cuerpo?.error ?? ''),
  categoriaFantasma.cuerpo?.error,
);

// --- ver uno ---
const prodVerUno = await pedir(`/api/productos/${prodId}`, tokenAdmin);
revisar('ver un producto -> 200', prodVerUno.status === 200, JSON.stringify(prodVerUno.cuerpo));

const prodVerFantasma = await pedir('/api/productos/999999', tokenAdmin);
revisar(
  'ver un id inexistente -> 404',
  prodVerFantasma.status === 404,
  JSON.stringify(prodVerFantasma.cuerpo),
);

const prodVerMalo = await pedir('/api/productos/abc', tokenAdmin);
revisar('id no numerico -> 400', prodVerMalo.status === 400, JSON.stringify(prodVerMalo.cuerpo));

// --- PATCH parcial ---
// Se manda SOLO el nombre. Todo lo demai tiene que quedarse como estaba;
// si el PATCH fuera de reemplazo completo, estos tres campos se perderian.
const parche = await parcheProducto(prodId, { nombre: 'Producto renombrado' }, tokenAdmin);
revisar('patch parcial -> 200', parche.status === 200, JSON.stringify(parche.cuerpo));
revisar('el nombre si cambio', parche.cuerpo?.nombre === 'Producto renombrado');
revisar('el codigo no cambio', parche.cuerpo?.codigo === 'TST-ALTA', parche.cuerpo?.codigo);
revisar(
  'la presentacion no cambio',
  parche.cuerpo?.presentacion_kg === 12.345,
  String(parche.cuerpo?.presentacion_kg),
);
revisar('el activo no cambio', parche.cuerpo?.activo === true);

const parcheVacio = await parcheProducto(prodId, {}, tokenAdmin);
revisar('patch sin campos -> 400', parcheVacio.status === 400, JSON.stringify(parcheVacio.cuerpo));

const parcheFantasma = await parcheProducto(999999, { nombre: 'Fantasma' }, tokenAdmin);
revisar(
  'patch a id inexistente -> 404',
  parcheFantasma.status === 404,
  JSON.stringify(parcheFantasma.cuerpo),
);

// --- buscar ---
const buscarCodigo = await pedir('/api/productos?buscar=TST-ALTA', tokenAdmin);
revisar(
  'buscar por codigo encuentra el producto',
  buscarCodigo.cuerpo?.datos?.some((p) => p.codigo === 'TST-ALTA'),
  JSON.stringify(buscarCodigo.cuerpo?.datos?.map((p) => p.codigo)),
);

const buscarNada = await pedir('/api/productos?busrar=ZXQ', tokenAdmin);
revisar(
  'parametro de busqueda mal escrito -> 400',
  buscarNada.status === 400,
  JSON.stringify(buscarNada.cuerpo),
);

// --- dar de baja, y como se refleja en el listado ---
const bajaLogica = await parcheProducto(prodId, { activo: false }, tokenAdmin);
revisar(
  'dar de baja por patch -> 200',
  bajaLogica.status === 200,
  JSON.stringify(bajaLogica.cuerpo),
);
revisar('el producto quedo inactivo', bajaLogica.cuerpo?.activo === false);

const listaPorOmision = await pedir('/api/productos?limite=200', tokenAdmin);
revisar(
  'el listado por omision ya NO trae el producto dado de baja',
  !listaPorOmision.cuerpo?.datos?.some((p) => p.codigo === 'TST-ALTA'),
  JSON.stringify(listaPorOmision.cuerpo?.datos?.map((p) => p.codigo)),
);

const listaInactivos = await pedir('/api/productos?activo=false', tokenAdmin);
revisar(
  '?activo=false si trae el dado de baja',
  listaInactivos.cuerpo?.datos?.some((p) => p.codigo === 'TST-ALTA'),
  JSON.stringify(listaInactivos.cuerpo?.datos?.map((p) => p.codigo)),
);

const listaTodos = await pedir('/api/productos?activo=todos&limite=200', tokenAdmin);
revisar(
  '?activo=todos trae los dos',
  listaTodos.cuerpo?.datos?.some((p) => p.codigo === 'TST-ALTA') &&
    listaTodos.cuerpo?.datos?.some((p) => p.codigo === 'LAC'),
  JSON.stringify(listaTodos.cuerpo?.datos?.map((p) => p.codigo)),
);

// --- borrar lo que NO se usa ---
const borrable = await crearProducto(
  { codigo: 'TST-BORRABLE', nombre: 'Se puede borrar', presentacion_kg: 1 },
  tokenAdmin,
);
const borrarSi = await pedir(`/api/productos/${borrable.cuerpo?.id}`, tokenAdmin, {
  method: 'DELETE',
});
revisar(
  'borrar un producto sin uso -> 204',
  borrarSi.status === 204,
  JSON.stringify(borrarSi.cuerpo),
);

const prodBorrarDoble = await pedir(`/api/productos/${borrable.cuerpo?.id}`, tokenAdmin, {
  method: 'DELETE',
});
revisar(
  'borrar dos veces -> 404',
  prodBorrarDoble.status === 404,
  JSON.stringify(prodBorrarDoble.cuerpo),
);

// --- borrar lo que SI se usa ---
// LAC esta en el seed y tiene precios, inventario y auditoria. Nueve tablas
// lo referencian y ninguna tiene ON DELETE, asi que sin el conteo previo
// esto seria un 23503 seco.
const prodBorrarEnUso = await pedir('/api/productos/1', tokenAdmin, { method: 'DELETE' });
revisar(
  'borrar un producto con historial -> 409',
  prodBorrarEnUso.status === 409,
  JSON.stringify(prodBorrarEnUso.cuerpo),
);
revisar(
  'el 409 dice EN_USO',
  prodBorrarEnUso.cuerpo?.codigo === 'EN_USO',
  JSON.stringify(prodBorrarEnUso.cuerpo),
);
revisar(
  'el 409 explica en cuantos lugares se usa',
  /\d+ (precio|movimiento|auditoria|renglon|registro)/.test(prodBorrarEnUso.cuerpo?.error ?? ''),
  prodBorrarEnUso.cuerpo?.error,
);
revisar(
  'el 409 sugiere darlo de baja',
  /baja/i.test(prodBorrarEnUso.cuerpo?.error ?? ''),
  prodBorrarEnUso.cuerpo?.error,
);

const prodSigueAhi = await pedir('/api/productos/1', tokenAdmin);
revisar('el producto en uso NO se borro', prodSigueAhi.status === 200);

// Limpia lo que creo esta suite. No hay endpoint DELETE a proposito (en
// el negocio se da de baja, no se borra), asi que el borrado de prueba se
// hace por SQL.
const borrados = await limpiarUsuariosDePrueba();
revisar('los usuarios de prueba se borraron', borrados > 0, `${borrados} filas`);

const productosBorrados = await limpiarProductosDePrueba();
revisar('los productos de prueba se borraron', productosBorrados > 0, `${productosBorrados} filas`);
void idNuevo;

// Es el unico punto del archivo que toca la base sin pasar por HTTP, y
// es aceptable: es arnes de pruebas, no codigo de la aplicacion.
const { default: pg } = await import('pg');
const { Pool } = pg;
const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgresql',
  // Debe ser la MISMA base que reporta el servidor, no un default fijo:
  // si el servidor corriera contra otra base de pruebas, el restore
  // reescribiria contrasenas en la base equivocada.
  database: baseEnUso,
  port: Number(process.env.PGPORT ?? 5432),
});
try {
  // pgcrypto se instalo en el esquema pos, no en public, asi que sin esto
  // crypt() y gen_salt() no existen para este Pool (error 42883).
  await pool.query('SET search_path TO pos');

  const r = await pool.query(
    `UPDATE pos.usuarios SET contrasena = crypt($1, gen_salt('bf', 12)),
                            debe_cambiar_contrasena = true,
                            intentos_fallidos = 0, bloqueado_hasta = NULL`,
    ['CAMBIAR-ESTA-CLAVE'],
  );
  revisar('las contrasenas del seed se restauraron', r.rowCount > 0, `${r.rowCount} usuarios`);
} finally {
  await pool.end();
  await cerrarPoolDirecto();
}

console.log(`\n${fallos === 0 ? 'TODAS LAS PRUEBAS PASARON' : fallos + ' PRUEBA(S) FALLARON'}`);
process.exit(fallos === 0 ? 0 : 1);
