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

const pedir = async (ruta, token, opciones = {}) => {
  const r = await fetch(BASE + ruta, {
    ...opciones,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opciones.headers || {}) },
  });
  let cuerpo;
  try { cuerpo = await r.json(); } catch { cuerpo = '(sin cuerpo)'; }
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
revisar('clientes sin token -> 401', sinToken.status === 401, JSON.stringify(salud.cuerpo));

// ---------------------------------------------------------------- login malo
const malo = await login('admin@ejemplo.local', 'mala');
revisar('login con contrasena incorrecta -> 401', malo.status === 401);
const inexistente = await login('nadie@ejemplo.local', 'x');
revisar('login de usuario inexistente -> 401', inexistente.status === 401);
revisar(
  'el mensaje NO revela si el correo existe',
  malo.body.error === inexistente.body.error,
  `"${malo.body.error}" vs "${inexistente.body.error}"`,
);

// ---------------------------------------------------------------- login bueno
const ok = await login('admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
revisar('login correcto -> 200 con token', ok.status === 200 && !!ok.body.token);
const token = ok.body.token;
revisar('el token no es el hash de la base', !/^[a-f0-9]{64}$/.test(token));

// ---------------------------------------------------------------- sesion
const yo = await pedir('/api/auth/yo', token);
revisar('GET /api/auth/yo -> 200', yo.status === 200);
revisar('el admin ve muchos permisos', (yo.cuerpo.permisos?.length ?? 0) >= 30, `${yo.cuerpo.permisos?.length} permisos`);
revisar('el admin tiene rol Administrador', yo.cuerpo.roles?.includes('Administrador'), JSON.stringify(yo.cuerpo.roles));

// ---------------------------------------------------------------- clientes
const lista = await pedir('/api/clientes', token);
revisar('GET /api/clientes -> 200', lista.status === 200);
revisar('la lista trae saldo_actual', lista.cuerpo.datos?.[0] !== undefined && 'saldo_actual' in lista.cuerpo.datos[0]);

const filtrada = await pedir('/api/clientes?buscar=CL01', token);
revisar('el filtro buscar funciona', filtrada.cuerpo.datos?.length === 1, `${filtrada.cuerpo.datos?.length} resultados`);

const inexistenteId = await pedir('/api/clientes/999999', token);
revisar('GET /api/clientes/999999 -> 404', inexistenteId.status === 404, JSON.stringify(inexistenteId.cuerpo));

// validacion: el cuerpo se valida con zod
const maloBody = await pedir('/api/clientes', token, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'Sin codigo' }),
});
revisar('POST sin codigo -> 400 con detalle', maloBody.status === 400 && Array.isArray(maloBody.cuerpo.detalles), JSON.stringify(maloBody.cuerpo).slice(0, 120));

// crear y borrar de verdad
const creado = await pedir('/api/clientes', token, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigo_cliente: 'PRUEBA-API', nombre: 'Cliente de prueba API', establo: 'Establo 1' }),
});
revisar('POST /api/clientes crea', creado.status === 201, JSON.stringify(creado.cuerpo).slice(0, 120));
const id = creado.cuerpo.id;

const actualizado = await pedir(`/api/clientes/${id}`, token, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ telefono: '618-000-0000' }),
});
revisar('PATCH actualiza', actualizado.status === 200 && actualizado.cuerpo.telefono === '618-000-0000', JSON.stringify(actualizado.cuerpo).slice(0,120));

const duplicado = await pedir('/api/clientes', token, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigo_cliente: 'PRUEBA-API', nombre: 'Duplicado' }),
});
revisar('POST duplicado -> 409', duplicado.status === 409, JSON.stringify(duplicado.cuerpo).slice(0, 120));

const borrado = await pedir(`/api/clientes/${id}`, token, { method: 'DELETE' });
revisar('DELETE borra', borrado.status === 204);

// ---------------------------------------------------------------- permisos
// Los roles estan definidos en 0001_init.sql: la Empleada opera el mostrador
// (puede dar de alta clientes) pero no toca lo sensible. La Cajera solo cobra.
const empleada = await login('empleada@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
revisar('login de la empleada -> 200', empleada.status === 200);

if (empleada.body.token) {
  const t = empleada.body.token;

  // por diseño la empleada SI puede crear clientes
  const creada = await pedir('/api/clientes', t, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codigo_cliente: 'EMPLEADA-OK', nombre: 'Alta por empleada' }),
  });
  revisar('la empleada SI puede crear clientes (por diseño)', creada.status === 201, JSON.stringify(creada.cuerpo).slice(0, 100));

  // pero NO puede eliminarlos: clientes.eliminar no esta en su rol
  const borrado = await pedir(`/api/clientes/${creada.cuerpo.id}`, t, { method: 'DELETE' });
  revisar('la empleada NO puede borrar clientes -> 403', borrado.status === 403, JSON.stringify(borrado.cuerpo).slice(0, 120));

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

console.log(`\n${fallos === 0 ? 'TODAS LAS PRUEBAS PASARON' : fallos + ' PRUEBA(S) FALLARON'}`);
process.exit(fallos === 0 ? 0 : 1);
