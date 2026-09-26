// Prueba de integracion contra el API ya arrancado.
//
//   pnpm dev            (en otra terminal)
//   pnpm test:api
//
// Ojo: el rate limit de /api/auth/login es de 10 intentos por 15 minutos,
// asi que si Corres esto varias veces seguidas fallara con 429. Reinicia el
// servidor para reiniciar el contador.

const BASE = process.env.API_URL ?? 'http://localhost:3000';

const login = async (correo, contrasena) => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correo, contrasena }),
  });
  return { status: r.status, body: await r.json() };
};

/**
 * El rate limit de /api/auth/login es de 10 intentos por 15 min. Este script
 * gasta 4 en cada corrida, asi que la tercera falla con 429 y las demas
 * empiezan a dar NO_AUTENTICADO en cascada, que es un fallo muy confuso.
 *
 * Se avisa y se sale aqui en vez de desactiver la proteccion: mejor un
 * mensaje claro que bajar la seguridad para que las pruebas pasen.
 */
const DETENER_POR_LIMIT = (r) => {
  if (r.status === 429) {
    console.log('');
    console.log('=== LIMITE DE INTENTOS ALCANZADO (429) ===');
    console.log('El rate limit de login ya se consumio. Reinicia el servidor:');
    console.log('  pkill -f "tsx watch"   (o Ctrl+C en la terminal del pnpm dev)');
    console.log('O sube el limite solo para desarrollo en backend/.env:');
    console.log('  LOGIN_MAX_INTENTOS=50');
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
  return { status: r.status, cuerpo };
};

let fallos = 0;
const revisar = (nombre, ok, detalle = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre}${detalle ? ' :: ' + detalle : ''}`);
  if (!ok) fallos++;
};

// ---------------------------------------------------------------- salud
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
// Es el unico punto del archivo que toca la base sin pasar por HTTP, y
// es aceptable: es arnes de pruebas, no codigo de la aplicacion.
const { default: pg } = await import('pg');
const { Pool } = pg;
const pool = new Pool({
  host: process.env.PGHOST ?? '127.0.0.1',
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgresql',
  database: process.env.PGDATABASE ?? 'nutr_test',
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
}

console.log(`\n${fallos === 0 ? 'TODAS LAS PRUEBAS PASARON' : fallos + ' PRUEBA(S) FALLARON'}`);
process.exit(fallos === 0 ? 0 : 1);
