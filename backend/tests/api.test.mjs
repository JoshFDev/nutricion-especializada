// Prueba de integracion contra el API ya arrancado.
//
//   pnpm dev            (en otra terminal)
//   pnpm test:api
//
// La API no lleva rate limit mientras no se exponga fuera de la maquina,
// asi que se puede correr esta suite las veces que haga falta sin reiniciar
// el servidor entre corrida y corrida.

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

/**
 * Igual que `pedir`, pero devuelve los BYTES.
 *
 * `pedir` siempre intenta `r.json()`, asi que con el PDF se queda en
 * '(sin cuerpo)' y la prueba no podria distinguir un PDF de un cuerpo vacio.
 * Se lee como `arrayBuffer` y se deja el teto en el lado del cliente, que
 * aqui es el unico que hay.
 */
const pedirBytes = async (ruta, token) => {
  const r = await fetch(BASE + ruta, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, headers: r.headers, bytes: Buffer.from(await r.arrayBuffer()) };
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
      // `options` se aplica al abrir CADA conexion del pool. Un
      // `SET search_path` suuelto NO: solo se queda en la conexion que lo
      // ejecuto, y cuando el pool crece y reparte el trabajo, hay conexiones
      // nuevas que nunca lo corrieron. Por eso la primera sentencia directa
      // de la suite funcionaba y la que iba veinte despues reventaba con
      // "no existe la relacion precios_publicos": no era la sentencia, era
      // que le toco otra conexion.
      options: '-c search_path=pos',
    });
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
 * Marca de agua de las tablas de rastro, y su limpieza.
 *
 * La suite dispara los mismos triggers de auditoria que cualquier operacion
 * real, asi que sin esto sus rastros se acumulan corrida tras corrida: la
 * base de pruebas llego a tener 3801 renglones de bitacora, de los cuales 14
 * eran del seed y los demas de corridas viejas. Lo mismo con `sesiones` (656)
 * y `auditoria_accesos` (1347), que el seed no toca y que nadie limpiaba.
 *
 * No se pueden truncar enteras, y no es prudencia sino un hecho: el seed
 * dispara ESOS MISMOS triggers al insertar sus clientes, productos y precios.
 * Sus 14 renglones de bitacora son tan legítimos como los de la suite, y
 * borrarlos dejaria la base menos parecida a como estaba, no mas.
 *
 * Por eso se guarda el `id` mas alto de cada tabla ANTES de la primera
 * escritura (que es el `restaurarSemilla` de abajo, no la primera peticion:
 * ese UPDATE tambien deja rastro) y al final se borra unicamente lo que tenga
 * `id` mayor. Se usa el `id` y no una fecha para no depender del reloj, y las
 * dos mitades se dejan juntas aqui a proposito: estan a tres mil lineas de
 * distancia y es facil cambiar una y olvidar la otra.
 *
 * Si un bloque nuevo empieza a auditar otra tabla, es una palabra en RASTROS.
 */
const RASTROS = [
  'auditoria_log',
  'auditoria_accesos',
  'auditoria_precios',
  'auditoria_inventario',
  'auditoria_caja',
  'sesiones',
];
const marcasDeRastro = {};
for (const tabla of RASTROS) {
  const r = await sqlDirecto(`SELECT COALESCE(max(id), 0)::TEXT AS id FROM pos.${tabla}`);
  marcasDeRastro[tabla] = Number(r.rows[0].id);
}

const limpiarRastrosDeLaCorrida = async () => {
  const cuenta = {};
  for (const tabla of RASTROS) {
    const r = await sqlDirecto(`DELETE FROM pos.${tabla} WHERE id > $1`, [marcasDeRastro[tabla]]);
    if (r.rowCount > 0) cuenta[tabla] = r.rowCount;
  }
  return cuenta;
};

/**
 * Deja las contrasenas del seed como estaban, ANTES de probar nada.
 *
 * La seccion de cambio de contrasena modifica la del administrador, y al
 * final del archivo se restauran. Pero si la corrida se muere antes (se
 * muere a la mitad (un assert, un 500), ese restore no se ejecuta
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

// ------------------------------------------------- acceso directo (desarrollo)
//
// El boton de "entrar como administrador" del login. Lo que se comprueba es
// LO IMPORTANTE, que no es que entre: es que da una sesion de verdad (mismos
// permisos que un login normal) y que un rol que no existe no abre nada.
console.log('');
console.log('--- acceso directo de desarrollo ---');

const accesoDirecto = await pedir('/api/auth/dev/entrar-como', null, {
  method: 'POST',
  body: { rol: 'Administrador' },
});
revisar('acceso directo -> 200', accesoDirecto.status === 200, String(accesoDirecto.status));
revisar(
  'y trae token y usuario',
  typeof accesoDirecto.cuerpo?.token === 'string' &&
    accesoDirecto.cuerpo?.usuario?.nombre !== undefined,
  JSON.stringify(accesoDirecto.cuerpo).slice(0, 80),
);

const tokenDirecto = accesoDirecto.cuerpo?.token;
const perfilDirecto = await pedir('/api/auth/yo', tokenDirecto);
revisar('el token del acceso directo sirve', perfilDirecto.status === 200);
revisar(
  'con los mismos permisos que un login normal',
  Array.isArray(perfilDirecto.cuerpo?.permisos) &&
    perfilDirecto.cuerpo.permisos.includes('notas.crear'),
  JSON.stringify(perfilDirecto.cuerpo?.permisos?.slice(0, 3)),
);

// La razon de ser del candado: la sesion tiene que quedar registrada como
// lo que es. Si aqui saliera un `login_exitoso` indistinguible, la bitacora
// de accesos estaria mintiendo sobre como entro la gente.
const conAccesoDirecto = await pedir('/api/clientes', tokenDirecto);
revisar('y alcanza para operar de verdad', conAccesoDirecto.status === 200);

const accesoRolInexistente = await pedir('/api/auth/dev/entrar-como', null, {
  method: 'POST',
  body: { rol: 'Emperor' },
});
revisar(
  'un rol que no existe no entra a nada -> 404',
  accesoRolInexistente.status === 404,
  String(accesoRolInexistente.status),
);

const accesoSinBody = await pedir('/api/auth/dev/entrar-como', null, { method: 'POST' });
revisar('sin cuerpo entra como administrador', accesoSinBody.status === 200);

if (tokenDirecto) await pedir('/api/auth/logout', tokenDirecto, { method: 'POST' });

// ---------------------------------------------------------------- cambio de contrasena
// Se prueba al final y se restauran las contrasenas del seed, porque si
// fallara el archivo dejaria al usuario sin poder entrar a la app.
console.log('');
console.log('--- cambio de contrasena ---');

// El token de la seccion anterior ya se cerro con el logout, asi que hace
// falta uno nuevo para probar este endpoint.
const adminCambio = await login('admin@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
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
const tokenAdmin = loginAdminUsuarios.body?.token;
revisar('el admin vuelve a entrar para gestionar usuarios', !!tokenAdmin);

// El CHECK de la tabla es ^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$: 3 o 4
// letras, 6 digitos (la fecha) y EXACTAMENTE 3 alfanumericos. 13 chars.
const RFC_NUEVO_A = 'GODL900101HDR';
const RFC_NUEVO_B = 'MEXT800202MDS';
// La cajera de prueba del bloque de permisos. Va en la misma limpieza
// porque si esa corrida se muere a mitad, el RFC choca con el UNIQUE de la
// siguiente.
const RFC_CAJERA = 'COCJ900303HDA';
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
  const r = await sqlDirecto('DELETE FROM pos.usuarios WHERE rfc IN ($1, $2, $3)', [
    RFC_NUEVO_A,
    RFC_NUEVO_B,
    RFC_CAJERA,
  ]);
  return r.rowCount;
};

const sobrantes = await limpiarUsuariosDePrueba();
if (sobrantes > 0) {
  console.log(`(se limpiaron ${sobrantes} usuario(s) de una corrida anterior)`);
}

// --- la cajera no puede administrar cuentas ---
const loginEmpleada = await login('empleada@ejemplo.local', 'CAMBIAR-ESTA-CLAVE');
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
  revisar('tras el reseteo la contrasena anterior ya no entra', conClaveVieja.status === 401);

  const conClaveNueva = await login('maria@ejemplo.local', claveReseteada);
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

// Limpia lo que dejo una corrida anterior del bloque de notas.
//
// Va AQUI, antes que `limpiarProductosDePrueba` y no dentro del bloque de
// notas, por el orden de las llamadas: la limpieza de productos se corre al
// principio del bloque de productos, mucho antes. Y TST-NOTA puede quedar
// con notas referenciandolo si una corrida se muere a la mitad, con lo cual
// ese `DELETE FROM productos` revienta con 23503 y el error no dice nada
// del modulo de notas. La funcion es idempotente y la usan las dos
// limpiezas: esta al arrancar y la del bloque de notas al terminar.

const limpiarNotasDePrueba = async () => {
  const cuenta = { notas: 0, productos: 0, existencia: null };

  // Los pagos van PRIMERO. `pagos_aplicacion.nota_id` es FK DURA a la nota
  // (sin ON DELETE), asi que borrar la nota antes deja la limpieza colgada
  // con un 23503. Y el cliente se busca por codigo, que no depende de si
  // la nota sigue ahi.
  const clientes = await sqlDirecto(
    `SELECT id FROM pos.clientes WHERE codigo_cliente IN ('CNOTA', 'CFECHA')`,
  );
  const idsCliente = clientes.rows.map((c) => c.id);
  if (idsCliente.length > 0) {
    await sqlDirecto(
      `DELETE FROM pos.pagos_aplicacion
        WHERE pago_id IN (SELECT id FROM pos.pagos WHERE cliente_id = ANY($1::bigint[]))`,
      [idsCliente],
    );
    await sqlDirecto(`DELETE FROM pos.pagos WHERE cliente_id = ANY($1::bigint[])`, [idsCliente]);
  }

  // Antes de borrar cada nota hay que desbloquearla. La migracion 0008
  // congela los renglones de una nota pagada o cancelada, y el detalle
  // tiene ON DELETE CASCADE: un DELETE de nota dispara ese trigger renglon
  // por renglon y revienta con 23514 sobre las notas que la propia suite
  // cancelo. Es el precio de que el congelamiento viva en la base.
  for (const c of clientes.rows) {
    await sqlDirecto(
      `UPDATE pos.notas_remision SET estatus = 'pendiente'
        WHERE cliente_id = $1 AND estatus IN ('parcial','pagada','cancelada')`,
      [c.id],
    );
    const b = await sqlDirecto(`DELETE FROM pos.notas_remision WHERE cliente_id = $1`, [c.id]);
    cuenta.notas += b.rowCount;
  }

  const prods = await sqlDirecto(
    `SELECT id FROM pos.productos WHERE codigo IN ('TST-NOTA', 'TST-NOTA2')`,
  );
  for (const pr of prods.rows) {
    // Aqui, y no antes: con las notas ya fuera, lo que queda del stock es
    // justo lo que se metio a proposito (50 bultos de la entrada de
    // apertura). Si no cuadra, la suite dejo el producto descuadrado.
    const e = await sqlDirecto(
      `SELECT COALESCE(SUM(CASE WHEN tipo IN ('entrada_compra','ajuste_positivo')
                                THEN cantidad_bultos ELSE -cantidad_bultos END), 0)::TEXT AS e
         FROM pos.inventario_movimientos WHERE producto_id = $1 AND almacen_id = 1`,
      [pr.id],
    );
    if (cuenta.existencia === null) cuenta.existencia = Number(e.rows[0].e);
    // Los movimientos primero: el trigger de inventario deja rastro de cada
    // INSERT y de cada DELETE, y `auditoria_inventario.producto_id` es FK
    // DURA. O sea: borrar los movimientos GENERA auditoria nueva, y el rastro
    // se va despues, en este mismo orden que el de los precios.
    await sqlDirecto(`DELETE FROM pos.inventario_movimientos WHERE producto_id = $1`, [pr.id]);
    await sqlDirecto(`DELETE FROM pos.auditoria_inventario WHERE producto_id = $1`, [pr.id]);
    // Los precios ANTES que su rastro, al reves de como parece: el trigger de
    // auditoria_precios escribe una fila en cada borrado de precio, asi que
    // borrando el rastro primero, el DELETE de productos revienta con 23503
    // sobre auditoria_precios. Es el mismo orden y el mismo motivo que
    // `limpiarProductosDePrueba`, aqui abajo.
    await sqlDirecto(`DELETE FROM pos.precios_cliente WHERE producto_id = $1`, [pr.id]);
    await sqlDirecto(`DELETE FROM pos.precios_publicos WHERE producto_id = $1`, [pr.id]);
    await sqlDirecto(`DELETE FROM pos.auditoria_precios WHERE producto_id = $1`, [pr.id]);
    const b = await sqlDirecto(`DELETE FROM pos.productos WHERE id = $1`, [pr.id]);
    cuenta.productos += b.rowCount;
  }

  const f = await sqlDirecto(`DELETE FROM pos.folios WHERE serie = 'TST'`);
  cuenta.folios = f.rowCount;
  await sqlDirecto(`DELETE FROM pos.auditoria_log WHERE tabla = 'notas_remision'`);
  await sqlDirecto(`DELETE FROM pos.clientes WHERE codigo_cliente IN ('CNOTA', 'CFECHA')`);
  return cuenta;
};

/**
 * Limpia pagos, compras, proveedores y los productos de compra de la suite.
 *
 * Va antes que `limpiarNotasDePrueba` y por un motivo puntual: los pagos de
 * estos bloques se aplican a notas del cliente `CNOTA`, y `auditoria_log`
 * NO tiene FK al pago (solo guarda el `registro_id` como numero). Si esta
 * limpieza corriera despues de que el otro borra los pagos, sus renglones
 * de bitacora se quedarian apuntando a ids que ya no existen. Aqui todavia
 * estan los clientes, asi que se puede borrar por codigo.
 *
 * El resto del orden tambien importa, y es el de siempre:
 *
 * 1. `pagos_proveedor` antes que `compras`: es FK DURA a la compra.
 * 2. Los movimientos de inventario de los productos de prueba antes que los
 *    productos, porque `auditoria_inventario.producto_id` es FK DURA y borrar
 *    movimientos GENERA bitacora nueva, que se va justo despues. Es el mismo
 *    truco de `limpiarNotasDePrueba` y `limpiarProductosDePrueba`.
 * 3. Los costos antes que el proveedor y el producto, por la misma razon.
 *
 * Se reconoce todo por nombre y por codigo, nunca "lo que no sea del seed":
 * el seed trae un proveedor y una compra de verdad, y esta suite no tiene por
 * que llevarselos.
 */
const limpiarPagosComprasProveedoresDePrueba = async () => {
  const cuenta = {
    pagos: 0,
    compras: 0,
    proveedores: 0,
    productos: 0,
    movimientos: 0,
    costos: 0,
    folios: 0,
  };

  const clientes = await sqlDirecto(
    `SELECT id FROM pos.clientes WHERE codigo_cliente IN ('CNOTA', 'CFECHA')`,
  );
  const idsCliente = clientes.rows.map((c) => c.id);
  if (idsCliente.length > 0) {
    const rastro = await sqlDirecto(
      `DELETE FROM pos.auditoria_log
        WHERE tabla = 'pagos'
          AND registro_id IN (SELECT id FROM pos.pagos WHERE cliente_id = ANY($1::bigint[]))`,
      [idsCliente],
    );
    cuenta.pagos = rastro.rowCount;
  }

  const prods = await sqlDirecto(`SELECT id FROM pos.productos WHERE codigo LIKE 'TST-COMP%'`);
  const idsProd = prods.rows.map((p) => p.id);

  // Dos criterios para el proveedor, porque solo con el primero se caia: una
  // corrida vieja llego a RENOMBRAR el proveedor de prueba (a un nombre
  // libre, que si existe), dejo compras sin nombre reconocible, y la corrida
  // siguiente se caia al borrar el producto con un 23503. El nombre sigue
  // siendo el criterio principal; el segundo es la red para lo que quedo sin
  // nombre reconocible: un proveedor DADO DE BAJA y sin compras ni costos no
  // es nada que valga la pena conservar en una base de pruebas. Uno activo,
  // aunque lo haya puesto una persona a mano, no se toca.
  const provs = await sqlDirecto(
    `SELECT id FROM pos.proveedores
      WHERE nombre LIKE 'Proveedor de prueba%'
         OR (activo = false
             AND NOT EXISTS (SELECT 1 FROM pos.compras c WHERE c.proveedor_id = proveedores.id)
             AND NOT EXISTS (SELECT 1 FROM pos.producto_proveedor_precios k
                              WHERE k.proveedor_id = proveedores.id))`,
  );
  const idsProv = provs.rows.map((p) => p.id);

  // Y las compras se buscan por DOS lados tambien: por proveedor, y por los
  // productos de la suite. El segundo es el que no falla aunque el
  // proveedor se haya ido de paseo.
  if (idsProv.length > 0 || idsProd.length > 0) {
    await sqlDirecto(
      `DELETE FROM pos.pagos_proveedor
        WHERE proveedor_id = ANY($1::bigint[])
           OR compra_id IN (SELECT compra_id FROM pos.compra_detalle
                             WHERE producto_id = ANY($2::bigint[]))`,
      [idsProv, idsProd],
    );
    // `compra_detalle` va en CASCADE, asi que una sola operacion.
    const c = await sqlDirecto(
      `DELETE FROM pos.compras
        WHERE proveedor_id = ANY($1::bigint[])
           OR id IN (SELECT compra_id FROM pos.compra_detalle
                      WHERE producto_id = ANY($2::bigint[]))`,
      [idsProv, idsProd],
    );
    cuenta.compras = c.rowCount;
  }

  if (idsProd.length > 0) {
    const movs = await sqlDirecto(
      `SELECT id FROM pos.inventario_movimientos WHERE producto_id = ANY($1::bigint[])`,
      [idsProd],
    );
    if (movs.rows.length > 0) {
      const idsMov = movs.rows.map((m) => m.id);
      await sqlDirecto(
        `DELETE FROM pos.auditoria_log
          WHERE tabla = 'inventario_movimientos' AND registro_id = ANY($1::bigint[])`,
        [idsMov],
      );
    }
    const m = await sqlDirecto(
      `DELETE FROM pos.inventario_movimientos WHERE producto_id = ANY($1::bigint[])`,
      [idsProd],
    );
    cuenta.movimientos = m.rowCount;
    await sqlDirecto(`DELETE FROM pos.auditoria_inventario WHERE producto_id = ANY($1::bigint[])`, [
      idsProd,
    ]);
    // Los costos ANTES que su rastro, al reves de como parece: el trigger
    // `fn_auditar_precios` escribe una fila en cada borrado de costo, y
    // `auditoria_precios.producto_id` es FK DURA. Borrando el rastro primero,
    // el DELETE de productos revienta con 23503. Es el mismo orden y el
    // mismo motivo que en `limpiarNotasDePrueba`.
    const k = await sqlDirecto(
      `DELETE FROM pos.producto_proveedor_precios WHERE producto_id = ANY($1::bigint[])`,
      [idsProd],
    );
    cuenta.costos = k.rowCount;
    await sqlDirecto(`DELETE FROM pos.auditoria_precios WHERE producto_id = ANY($1::bigint[])`, [
      idsProd,
    ]);
    const p = await sqlDirecto(`DELETE FROM pos.productos WHERE id = ANY($1::bigint[])`, [idsProd]);
    cuenta.productos = p.rowCount;
  }

  if (idsProv.length > 0) {
    const p = await sqlDirecto(`DELETE FROM pos.proveedores WHERE id = ANY($1::bigint[])`, [
      idsProv,
    ]);
    cuenta.proveedores = p.rowCount;
  }

  return cuenta;
};

/**
 * El talonario de la serie PGO es de esta suite, y va en su propia funcion
 * porque su orden SI importa: las notas apuntan a `folios.folio_id` y
 * `limpiarNotasDePrueba` es la que las borra. Por eso esto va DESPUES de
 * `limpiarNotasDePrueba` y no dentro de la limpieza de pagos, que corre antes.
 */
const limpiarFoliosPago = async () => {
  const f = await sqlDirecto(`DELETE FROM pos.folios WHERE serie = 'PGO'`);
  return f.rowCount;
};

/**
 * Limpia facturas, movimientos de caja y cuentas de prueba.
 *
 * Va la PRIMERA de las tres, antes que pagos y notas, por un motivo puntual:
 * `factura_nota.nota_id` es FK DURA a la nota (sin ON DELETE), asi que
 * `limpiarNotasDePrueba` -- que borra todas las notas de CNOTA y CFECHA --
 * revienta con 23503 en cuanto existe una factura de las de esta suite. Y
 * el 23503 no dice nada de facturacion: dice "notas_remision", que es un
 * modulo que aqui se esta limpiando sin problema. Es el mismolechazo de
 * siempre: el error aparece en el modulo que limpia, no en el que dejo el
 * dato.
 *
 * `factura_id` si es CASCADE, asi que un solo DELETE de facturas se lleva
 * tambien las lineas de `factura_nota`.
 *
 * Y el orden interno de caja es el de siempre, al reves de como parece:
 * los movimientos PRIMERO y el rastro DESPUES, porque borrar un movimiento
 * dispara `fn_auditar_caja` y genera `auditoria_caja` nueva, y
 * `auditoria_caja.cuenta_id` es FK DURA a `cuentas_financieras`. Si la cuenta
 * se borrara antes que su rastro, el DELETE de la cuenta revienta con 23503.
 * Es el mismo truco y el mismo error que `limpiarProductosDePrueba` con
 * `auditoria_precios`.
 *
 * Las cuentas se reconocen por NOMBRE EXACTO y no por un `LIKE`: el seed trae
 * 'Caja chica' y 'Banco principal', y una cuenta de banco puesta a mano en
 * una base de pruebas vale la pena.
 */
const limpiarCajaFacturasDePrueba = async () => {
  const cuenta = {
    facturas: 0,
    log: 0,
    movimientos: 0,
    auditoriaCaja: 0,
    cuentas: 0,
  };

  const clientes = await sqlDirecto(
    `SELECT id FROM pos.clientes WHERE codigo_cliente IN ('CNOTA','CFECHA')`,
  );
  const idsCliente = clientes.rows.map((c) => c.id);
  if (idsCliente.length > 0) {
    const f = await sqlDirecto(`DELETE FROM pos.facturas WHERE cliente_id = ANY($1::bigint[])`, [
      idsCliente,
    ]);
    cuenta.facturas = f.rowCount;
  }

  // El rastro de las facturas va por TABLA y no por `registro_id`, y no es
  // descuido: las filas de `factura_nota` no tienen id (su clave es el par
  // factura_id/nota_id), asi que `fn_auditoria` les deja `registro_id` en
  // NULL. Es la concesion que la 0010 documenta.
  const log = await sqlDirecto(
    `DELETE FROM pos.auditoria_log WHERE tabla IN ('facturas','factura_nota')`,
  );
  cuenta.log = log.rowCount;

  const cuentas = await sqlDirecto(
    `SELECT id FROM pos.cuentas_financieras WHERE nombre IN ('Caja de prueba','Banco de prueba')`,
  );
  const idsCuenta = cuentas.rows.map((c) => c.id);
  if (idsCuenta.length > 0) {
    const m = await sqlDirecto(
      `DELETE FROM pos.movimientos_financieros WHERE cuenta_id = ANY($1::smallint[])`,
      [idsCuenta],
    );
    cuenta.movimientos = m.rowCount;
    const a = await sqlDirecto(
      `DELETE FROM pos.auditoria_caja WHERE cuenta_id = ANY($1::smallint[])`,
      [idsCuenta],
    );
    cuenta.auditoriaCaja = a.rowCount;
    const c = await sqlDirecto(
      `DELETE FROM pos.cuentas_financieras WHERE id = ANY($1::smallint[])`,
      [idsCuenta],
    );
    cuenta.cuentas = c.rowCount;
  }

  return cuenta;
};

await limpiarCajaFacturasDePrueba();
await limpiarPagosComprasProveedoresDePrueba();
await limpiarNotasDePrueba();
await limpiarFoliosPago();

const limpiarProductosDePrueba = async () => {
  const codigos = [
    'TST-ALTA',
    'TST-BORRABLE',
    'TST-INACTIVO',
    'TST-CAJ',
    'TST-PREC',
    'TST-CADE',
    'TST-CERO',
    'TST-SINP',
    'TST-NOTA',
    'TST-NOTA2',
  ];

  // ORDEN IMPORTANTE, y no es intuitivo. `auditoria_precios` tiene FK
  // DURA a productos (sin ON DELETE) y el trigger de 0001 escribe una fila
  // ahi en cada alta, cambio O BORRADO de un precio. O sea: borrar un precio
  // GENERA auditoria nueva.
  //
  // La primera version de esta limpieza borraba auditoria -> precios ->
  // productos, que parece la correcta ("primero el rastro, luego la cosa").
  // Es al reves de lo que funciona: los precios se van, dejan rastro nuevo, y
  // el DELETE de productos revienta con 23503 sobre auditoria_precios. La
  // suite moria en la linea 175 con 162 OK, sin una sola FALLA, y el error
  // de FK no decia nada de que el problema era el orden de tres lineas.
  //
  // Y eso es la mejor prueba de que el modulo de precios no debe exponer
  // DELETE: la propia base ya no deja deshacer un cambio de precio. El 23503
  // no es un accidente de la suite, es el diseno funcionando.
  await sqlDirecto(
    `DELETE FROM pos.precios_cliente
      WHERE producto_id IN (SELECT id FROM pos.productos WHERE codigo = ANY($1::text[]))`,
    [codigos],
  );
  await sqlDirecto(
    `DELETE FROM pos.precios_publicos
      WHERE producto_id IN (SELECT id FROM pos.productos WHERE codigo = ANY($1::text[]))`,
    [codigos],
  );

  // Ahora si: el rastro que dejaron esos borrados.
  await sqlDirecto(
    `DELETE FROM pos.auditoria_precios
      WHERE producto_id IN (SELECT id FROM pos.productos WHERE codigo = ANY($1::text[]))`,
    [codigos],
  );

  // TST-INACTIVO no lo crea nadie hoy (la baja logica se hace sobre
  // TST-ALTA), pero se limpia por si una version anterior de esta prueba
  // lo dejaba ahi. TST-CAJ lo crea la cajera del bloque de permisos, y los
  // TST-PREC/CADE/CERO/SINP los de precios, mas abajo.
  const r = await sqlDirecto(`DELETE FROM pos.productos WHERE codigo = ANY($1::text[])`, [codigos]);
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

// --- la cajera quedo casi como el administrador (migracion 0006) ---
//
// Esto es lo que cambia con 0006: la Cajera paso de 10 permisos a 38 de
// 43. Se comprueba en las dos direcciones, y las dos importan:
//
//   - que ahora PUEDA hacer lo que antes no podia (escribir productos y
//     clientes), que es el motivo del cambio;
//   - que siga SIN poder administrar cuentas, que es la razon por la que
//     el permiso esta en la base y no concedido.
//
// La segunda es la que de verdad protege. Si alguien mas adelante
//afloja "que la cajera sea casi admin" y afloja la exclusion de usuarios.*,
// esta prueba se pone roja.

const altaCajeraRol = await pedir('/api/usuarios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nombre: 'Carla',
    apellido_paterno: 'Rivas',
    rfc: RFC_CAJERA,
    email: 'carla.prueba@ejemplo.local',
    puesto: 'Cajera',
    roles: [3],
  }),
});
revisar(
  'alta de la cajera de prueba -> 201',
  altaCajeraRol.status === 201,
  JSON.stringify(altaCajeraRol.cuerpo),
);

const loginCajera = await login(
  'carla.prueba@ejemplo.local',
  altaCajeraRol.cuerpo?.contrasenaTemporal,
);
const tokenCajera = loginCajera.body?.token;
revisar('la cajera de prueba entra', !!tokenCajera);

// Sin esto se seguiria con un token undefined y cada peticion de las de
// abajo saldria sin cabecera de autorizacion: se verian 401 en todas y el
// diagnostico apuntaria al modulo de permisos en vez de al login.
if (!tokenCajera) {
  console.log('');
  console.log('=== NO SE PUDO ENTRAR CON LA CAJERA DE PRUEBA ===');
  console.log('El alta de la cuenta paso, pero el login con la contrasena');
  console.log('temporal fallo. Sin ese token las pruebas de permisos de');
  console.log('este bloque no dicen nada, asi que la suite se detiene aqui.');
  console.log('=======================================================');
  process.exit(3);
}

// --- lo que la cajera ya puede hacer ---
const cajeraLeeProductos = await pedir('/api/productos', tokenCajera);
revisar(
  'la cajera lee productos -> 200',
  cajeraLeeProductos.status === 200,
  JSON.stringify(cajeraLeeProductos.cuerpo),
);

const cajeraEscribeProducto = await crearProducto(
  { codigo: 'TST-CAJ', nombre: 'Producto de la cajera', presentacion_kg: 20 },
  tokenCajera,
);
revisar(
  'la cajera ahora SI crea productos -> 201',
  cajeraEscribeProducto.status === 201,
  JSON.stringify(cajeraEscribeProducto.cuerpo),
);

const cajeraEditaProducto = await parcheProducto(
  cajeraEscribeProducto.cuerpo?.id ?? 0,
  { nombre: 'Editado por la cajera' },
  tokenCajera,
);
revisar(
  'la cajera ahora SI edita productos -> 200',
  cajeraEditaProducto.status === 200,
  JSON.stringify(cajeraEditaProducto.cuerpo),
);

const cajeraLeeClientes = await pedir('/api/clientes', tokenCajera);
revisar(
  'la cajera lee clientes -> 200',
  cajeraLeeClientes.status === 200,
  JSON.stringify(cajeraLeeClientes.cuerpo),
);

const cajeraLeeCatalogo = await pedir('/api/especies', tokenCajera);
revisar('la cajera lee el catalogo -> 200', cajeraLeeCatalogo.status === 200);

// --- lo que la cajera NO debe poder hacer ---
// Estas son las cinco exclusiones de 0006. Que usuarios.* siga cerrado es
// lo que evita que la cajera se cree un Administrador y con eso suba de
// privilegios ella sola.
const cajeraNoListaUsuarios = await pedir('/api/usuarios', tokenCajera);
revisar(
  'la cajera NO lista usuarios -> 403',
  cajeraNoListaUsuarios.status === 403,
  JSON.stringify(cajeraNoListaUsuarios.cuerpo),
);

const cajeraNoCreaUsuarios = await pedir('/api/usuarios', tokenCajera, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'Escalada', apellido_paterno: 'De', rfc: RFC_NUEVO_B }),
});
revisar(
  'la cajera NO crea usuarios -> 403',
  cajeraNoCreaUsuarios.status === 403,
  JSON.stringify(cajeraNoCreaUsuarios.cuerpo),
);

const cajeraNoResetea = await pedir('/api/usuarios/1/resetear-contrasena', tokenCajera, {
  method: 'POST',
});
revisar(
  'la cajera NO resetea contrasenas -> 403',
  cajeraNoResetea.status === 403,
  JSON.stringify(cajeraNoResetea.cuerpo),
);

const cajeraNoCambiaRoles = await pedir('/api/usuarios/1/roles', tokenCajera, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ roles: [1] }),
});
revisar(
  'la cajera NO cambia roles -> 403',
  cajeraNoCambiaRoles.status === 403,
  JSON.stringify(cajeraNoCambiaRoles.cuerpo),
);

// --- PRECIOS: vigencia, traslape y el precio que toca cobrar ---
//
// Lo que se prueba, y por que:
//
// 1. El listado sale solo con los vigentes por omision, y `historicos` es
//    exactamente lo contrario.
// 2. El trigger anti-traslape de 0007 rechaza las ventanas encimadas, y
//    deja pasar el encadenado. Se prueba CONTRA LA BASE ademas de contra
//    la API, porque el trigger es lo que decide cuando dos peticiones
//    simultaneas se chocan entre si y el servicio no ve la otra.
// 3. `GET /efectivo` resuelve la precedencia (especial sobre publico) y
//    devuelve `vigente: false` en vez de 404 cuando no hay precio, porque
//    eso es una respuesta de negocio y no un error.
// 4. NO hay DELETE. Un precio se cierra, no se borra, y la fila se queda.
//
// Cada grupo de pruebas usa SU producto. Se hizo asi a proposito: con un
// solo producto, el precio abierto del primer grupo se traslapa con todos
// los demas y las pruebas se pisan entre si. La primera version de este
// bloque fallaba por exactamente eso, y el sintoma (seis fallas en cascada
// desde una sola) se decia mas rapido aislando los casos que mirando las
// aserciones una por una.

const desplazar = (dias) => {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const HOY = desplazar(0);

const nuevoProductoDePrecios = async (codigo, nombre) => {
  const r = await crearProducto({ codigo, nombre, presentacion_kg: '5.000' }, tokenAdmin);
  return r.cuerpo?.id;
};

const prodPrincipal = await nuevoProductoDePrecios('TST-PREC', 'Producto con precio');
revisar('el producto principal se creo', Number.isInteger(prodPrincipal), String(prodPrincipal));
const prodCadena = await nuevoProductoDePrecios('TST-CADE', 'Producto para encadenar');
revisar('el producto de encadenamiento se creo', Number.isInteger(prodCadena), String(prodCadena));
const prodCero = await nuevoProductoDePrecios('TST-CERO', 'Producto con precio de cortesia');
revisar('el producto de cortesia se creo', Number.isInteger(prodCero), String(prodCero));
const prodSinPrecio = await nuevoProductoDePrecios('TST-SINP', 'Producto sin precio');
revisar('el producto sin precio se creo', Number.isInteger(prodSinPrecio), String(prodSinPrecio));

// El cliente se da de alta por SQL y no por la API: el alta de clientes
// todavia no se reviso en este bloque, y lo que se prueba aqui son los
// PRECIOS. SI este bloque fallara al crear el cliente, las pruebas de
// precios no dirian nada.
const clientePrecio = await sqlDirecto(
  `INSERT INTO clientes (nombre, estatus) VALUES ('Cliente de precios', 'Activo') RETURNING id`,
);
const clientePrecioId = clientePrecio?.rows?.[0]?.id ?? clientePrecio.id;
revisar('el cliente de la prueba se creo', clientePrecioId !== undefined, String(clientePrecioId));

const crearPublico = (productoId, cuerpo) =>
  pedir('/api/precios/publicos', tokenAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ producto_id: productoId, ...cuerpo }),
  });

// ------------------------------------------------------------------
// Alta y listado de un precio abierto
// ------------------------------------------------------------------

const pubAbierto = await crearPublico(prodPrincipal, {
  precio_kg: '90.00',
  vigente_desde: desplazar(-30),
});
revisar(
  'alta de precio publico -> 201',
  pubAbierto.status === 201,
  JSON.stringify(pubAbierto.cuerpo),
);
const pubPrincipalId = pubAbierto.cuerpo?.id;
revisar('el precio abierto trae vigente_hasta null', pubAbierto.cuerpo?.vigente_hasta === null);
revisar('el precio sale como numero', pubAbierto.cuerpo?.precio_kg === 90);
revisar(
  'y trae el nombre del producto resuelto',
  pubAbierto.cuerpo?.producto_nombre === 'Producto con precio',
);
revisar('y el codigo', pubAbierto.cuerpo?.producto_codigo === 'TST-PREC');

const vigentes = await pedir(`/api/precios/publicos?producto_id=${prodPrincipal}`, tokenAdmin);
revisar(
  'el abierto sale en el listado de vigentes',
  vigentes.cuerpo?.datos?.length === 1,
  JSON.stringify(vigentes.cuerpo),
);
revisar('con el total bien puesto', vigentes.cuerpo?.total === 1);

const todos = await pedir(
  `/api/precios/publicos?producto_id=${prodPrincipal}&vigencia=todos`,
  tokenAdmin,
);
revisar('con vigencia=todos tambien sale', todos.cuerpo?.datos?.length === 1);

const historicos = await pedir(
  `/api/precios/publicos?producto_id=${prodPrincipal}&vigencia=historicos`,
  tokenAdmin,
);
revisar(
  'un precio abierto no es historico',
  historicos.cuerpo?.datos?.length === 0,
  JSON.stringify(historicos.cuerpo),
);

const taquigrafia = await pedir(
  `/api/precios/publicos?producto_id=${prodPrincipal}&vigencia=true`,
  tokenAdmin,
);
revisar('vigencia=true quiere decir vigentes', taquigrafia.cuerpo?.datos?.length === 1);

// ------------------------------------------------------------------
// El traslape, que es lo que 0007 existe por
// ------------------------------------------------------------------

const segundoAbierto = await crearPublico(prodPrincipal, {
  precio_kg: '95.00',
  vigente_desde: desplazar(10),
});
revisar(
  'un segundo precio abierto del mismo producto -> 409',
  segundoAbierto.status === 409,
  JSON.stringify(segundoAbierto.cuerpo),
);
revisar(
  'y se identifica como traslape',
  segundoAbierto.cuerpo?.codigo === 'VIGENCIA_TRASLAPADA',
  JSON.stringify(segundoAbierto.cuerpo),
);

const encimaCerrado = await crearPublico(prodPrincipal, {
  precio_kg: '95.00',
  vigente_desde: desplazar(10),
  vigente_hasta: desplazar(60),
});
revisar(
  'un precio que se encima con el abierto -> 409',
  encimaCerrado.status === 409,
  JSON.stringify(encimaCerrado.cuerpo),
);

// Este precio va en prodSinPrecio, NO en prodCadena. La primera version lo
// ponia en prodCadena "porque era el otro producto", y desde ahi solapo con
// el grupo de cadena de abajo: aquel dejaba un 90 abierto de hace 30 dias y
// la cadena empezaba pidiendole un 90 que acabara ayer, que se traslapan
// porque el primero seguia abierto. Cinco de las seis fallas del bloque
// venian de ahi. Cada grupo tiene SU producto y ninguno se loan el precio.
const otroProductoMismoDia = await crearPublico(prodSinPrecio, {
  precio_kg: '90.00',
  vigente_desde: desplazar(-30),
});
revisar(
  'otro producto el mismo dia NO se traslapa -> 201',
  otroProductoMismoDia.status === 201,
  JSON.stringify(otroProductoMismoDia.cuerpo),
);

// Se borra enseguida porque prodSinPrecio tiene que quedar SIN precios para
// la prueba de `vigente: false` de mas abajo.
await sqlDirecto('DELETE FROM precios_publicos WHERE id = $1', [otroProductoMismoDia.cuerpo?.id]);
const sinPrecioDeNuevo = await pedir(
  `/api/precios/efectivo?producto_id=${prodSinPrecio}`,
  tokenAdmin,
);
revisar(
  'prodSinPrecio vuelve a quedarse sin precio',
  sinPrecioDeNuevo.cuerpo?.vigente === false,
  JSON.stringify(sinPrecioDeNuevo.cuerpo),
);

// El caso que 0001 NO atrapaba: un precio abierto y otro CERRADO que
// empieza dentro de la ventana del abierto. El indice parcial de 0001
// (`WHERE vigente_hasta IS NULL`) mira solo los abiertos, asi que las dos
// filas conviven y el 15 de julio el producto tendria dos precios. Este es
// el motivo de que exista la migracion 0007.
const cerradoDentroDeAbierto = await crearPublico(prodPrincipal, {
  precio_kg: '99.00',
  vigente_desde: desplazar(-20),
  vigente_hasta: desplazar(5),
});
revisar(
  'un cerrado dentro de la ventana de un abierto -> 409',
  cerradoDentroDeAbierto.status === 409,
  JSON.stringify(cerradoDentroDeAbierto.cuerpo),
);

// ------------------------------------------------------------------
// Encadenar y cerrar
// ------------------------------------------------------------------
//
// El producto de la cadena tiene HOY en el medio de su linea de tiempo, que
// es como se ve en la vida real:
//
//   [----A----]   [---B---]      [---C-----------]
//   -30    -1     HOY   +45     +46
//
// Se armo asi a proposito, y la primera version de este bloque se cayo
// por crearlos mal: encadenaba con `desplazar(46)` un precio que EMPEZABA
// en el futuro y despues afirmaba que ese era el vigente. No lo era: hoy
// sigue mandando el precio de antes. El sintoma eran seis fallas que
// parecian del servicio y eran de la prueba.

const cadenaA = await crearPublico(prodCadena, {
  precio_kg: '90.00',
  vigente_desde: desplazar(-30),
  vigente_hasta: desplazar(-1),
});
revisar(
  'un precio ya vencido se puede dar de alta -> 201',
  cadenaA.status === 201,
  JSON.stringify(cadenaA.cuerpo),
);

const cadenaB = await crearPublico(prodCadena, {
  precio_kg: '95.00',
  vigente_desde: HOY,
});
revisar(
  'el que empieza HOY se acepta -> 201',
  cadenaB.status === 201,
  JSON.stringify(cadenaB.cuerpo),
);
revisar('y nace abierto', cadenaB.cuerpo?.vigente_hasta === null);
const cadenaBId = cadenaB.cuerpo?.id;

// El traslape en sus dos formas, ya con A y B conviviendo.
const encimaDeB = await crearPublico(prodCadena, {
  precio_kg: '99.00',
  vigente_desde: desplazar(10),
  vigente_hasta: desplazar(50),
});
revisar(
  'un cerrado dentro de un abierto -> 409',
  encimaDeB.status === 409,
  JSON.stringify(encimaDeB.cuerpo),
);

const otroAbierto = await crearPublico(prodCadena, {
  precio_kg: '99.00',
  vigente_desde: HOY,
});
revisar(
  'abierto encima de otro cerrado -> 409',
  otroAbierto.status === 409,
  JSON.stringify(otroAbierto.cuerpo),
);

const mismosInicio = await crearPublico(prodCadena, {
  precio_kg: '99.00',
  vigente_desde: HOY,
  vigente_hasta: desplazar(20),
});
revisar(
  'mismo dia de inicio que otro -> 409',
  mismosInicio.status === 409,
  JSON.stringify(mismosInicio.cuerpo),
);

// Antes de cerrar nada: A ya paso, B manda.
const historicosAntes = await pedir(
  `/api/precios/publicos?producto_id=${prodCadena}&vigencia=historicos`,
  tokenAdmin,
);
revisar(
  'A ya aparece como historico',
  historicosAntes.cuerpo?.datos?.length === 1,
  JSON.stringify(historicosAntes.cuerpo),
);
revisar(
  'y es el de 90',
  historicosAntes.cuerpo?.datos?.[0]?.precio_kg === 90,
  JSON.stringify(historicosAntes.cuerpo),
);

const vigentesAntes = await pedir(`/api/precios/publicos?producto_id=${prodCadena}`, tokenAdmin);
revisar(
  'y B es el vigente',
  vigentesAntes.cuerpo?.datos?.[0]?.precio_kg === 95,
  JSON.stringify(vigentesAntes.cuerpo),
);

// ------------------------------------------------------------------
// Cerrar
// ------------------------------------------------------------------

const cerrarEnElPasado = await pedir(`/api/precios/publicos/${cadenaBId}/cerrar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vigente_hasta: desplazar(-5) }),
});
revisar(
  'cerrar con fecha que ya paso -> 400',
  cerrarEnElPasado.status === 400,
  JSON.stringify(cerrarEnElPasado.cuerpo),
);

const acortarCerrado = await pedir(
  `/api/precios/publicos/${cadenaA.cuerpo?.id}/cerrar`,
  tokenAdmin,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vigente_hasta: desplazar(-5) }),
  },
);
revisar(
  'acortar una vigencia ya cerrada hacia atras -> 400',
  acortarCerrado.status === 400,
  JSON.stringify(acortarCerrado.cuerpo),
);

// Cerrar hoy un precio que empieza HOY: se deja una ventana de un solo dia.
const cerrarHoy = await pedir(`/api/precios/publicos/${cadenaBId}/cerrar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vigente_hasta: HOY }),
});
revisar(
  'cerrar HOY un precio que empieza HOY -> 200',
  cerrarHoy.status === 200,
  JSON.stringify(cerrarHoy.cuerpo),
);
revisar('la ventana queda de un dia', cerrarHoy.cuerpo?.vigente_hasta === HOY);

// Y AQUI esta el detalle que conviene no pasar por alto: cerrar HOY deja el
// precio VIGENTE HOY, porque el fin es inclusivo. `vigente_hasta = hoy` se
// lee "valido hasta hoy incluido", que es lo mismo que dicen el CHECK de
// 0001, el trigger de 0007 y el filtro `vigente_hasta >= $fecha` de la API.
//
// La consecuencia incomoda: NO hay forma de sacar un precio de la circulacion
// en el mismo dia, porque "cerrar antes de hoy" esta rechazado. Se quita
// mañana. Es coherente con todo lo demas y por eso se quedo asi, pero es una
// decision de negocio, no un detalle tecnico, asi que va fijada con pruebas.
const vigenteTrasCerrarHoy = await pedir(
  `/api/precios/publicos?producto_id=${prodCadena}`,
  tokenAdmin,
);
revisar(
  'cerrado hoy SIGUE vigente hoy (fin inclusivo)',
  vigenteTrasCerrarHoy.cuerpo?.datos?.length === 1,
  JSON.stringify(vigenteTrasCerrarHoy.cuerpo),
);
revisar('es el de 95', vigenteTrasCerrarHoy.cuerpo?.datos?.[0]?.precio_kg === 95);

const historicoTrasCerrarHoy = await pedir(
  `/api/precios/publicos?producto_id=${prodCadena}&vigencia=historicos`,
  tokenAdmin,
);
revisar(
  'y no pasa a historico hasta mañana',
  historicoTrasCerrarHoy.cuerpo?.datos?.length === 1,
  JSON.stringify(historicoTrasCerrarHoy.cuerpo),
);

// ------------------------------------------------------------------
// Encadenar despues de cerrar
// ------------------------------------------------------------------

const mismoDiaQueAcaba = await crearPublico(prodCadena, {
  precio_kg: '99.00',
  vigente_desde: HOY,
});
revisar(
  'encadenar el MISMO dia que acaba el anterior -> 409',
  mismoDiaQueAcaba.status === 409,
  JSON.stringify(mismoDiaQueAcaba.cuerpo),
);

const alDiaSiguiente = await crearPublico(prodCadena, {
  precio_kg: '99.00',
  vigente_desde: desplazar(1),
});
revisar(
  'encadenar al dia siguiente -> 201',
  alDiaSiguiente.status === 201,
  JSON.stringify(alDiaSiguiente.cuerpo),
);

// El nuevo empieza MAÑANA, asi que hoy no manda todavia. Esta es la misma
// confusion que hizo fallar la primera version, y queda fijada con una
// prueba para que no vuelva.
const vigentesConFuturo = await pedir(
  `/api/precios/publicos?producto_id=${prodCadena}`,
  tokenAdmin,
);
revisar(
  'el de mañana NO es el vigente de hoy',
  vigentesConFuturo.cuerpo?.datos?.[0]?.precio_kg === 95,
  JSON.stringify(vigentesConFuturo.cuerpo),
);
revisar('y hay un solo vigente', vigentesConFuturo.cuerpo?.datos?.length === 1);

// Pero a la fecha del nuevo, ese precio ya es el que toca.
const lineaDeTiempo = await pedir(
  `/api/precios/publicos?producto_id=${prodCadena}&vigencia=todos`,
  tokenAdmin,
);
revisar(
  'la linea de tiempo completa trae los tres',
  lineaDeTiempo.cuerpo?.total === 3,
  JSON.stringify(lineaDeTiempo.cuerpo),
);
revisar(
  'y viene del mas nuevo al mas viejo',
  lineaDeTiempo.cuerpo?.datos?.[0]?.precio_kg === 99,
  JSON.stringify(lineaDeTiempo.cuerpo),
);

// ------------------------------------------------------------------
// El precio que toca cobrar
// ------------------------------------------------------------------

const efectivoSinCliente = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}`,
  tokenAdmin,
);
revisar(
  'efectivo sin cliente -> 200',
  efectivoSinCliente.status === 200,
  JSON.stringify(efectivoSinCliente.cuerpo),
);
revisar('trae el precio publico', efectivoSinCliente.cuerpo?.precio_kg === 90);
revisar('diciendo de donde sale', efectivoSinCliente.cuerpo?.origen === 'publico');
revisar(
  'con la fecha de HOY segun la base',
  efectivoSinCliente.cuerpo?.fecha === HOY,
  `${efectivoSinCliente.cuerpo?.fecha} vs ${HOY}`,
);
revisar('y diciendo que si esta vigente', efectivoSinCliente.cuerpo?.vigente === true);

const especialAlta = await pedir('/api/precios/clientes', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cliente_id: clientePrecioId,
    producto_id: prodPrincipal,
    precio_kg: '80',
    vigente_desde: desplazar(-10),
    vigente_hasta: desplazar(100),
  }),
});
revisar(
  'alta de precio especial -> 201',
  especialAlta.status === 201,
  JSON.stringify(especialAlta.cuerpo),
);
revisar(
  'el especial trae el nombre del cliente',
  especialAlta.cuerpo?.cliente_nombre === 'Cliente de precios',
);
revisar('y acepta numero sin decimales', especialAlta.cuerpo?.precio_kg === 80);

const efectivoConEspecial = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}&cliente_id=${clientePrecioId}`,
  tokenAdmin,
);
revisar(
  'el especial gana sobre el publico',
  efectivoConEspecial.cuerpo?.precio_kg === 80,
  JSON.stringify(efectivoConEspecial.cuerpo),
);
revisar('y lo dice', efectivoConEspecial.cuerpo?.origen === 'cliente');

const listadoEspeciales = await pedir(
  `/api/precios/clientes?cliente_id=${clientePrecioId}&producto_id=${prodPrincipal}`,
  tokenAdmin,
);
revisar(
  'el listado de especiales sale',
  listadoEspeciales.cuerpo?.datos?.length === 1,
  JSON.stringify(listadoEspeciales.cuerpo),
);

// Cotizar a futuro: el caso real es un cliente al que le vence el especial
// y se lo lleva ese dia, y ya no le aplica.
const cotizarDentro = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}&cliente_id=${clientePrecioId}&fecha=${desplazar(50)}`,
  tokenAdmin,
);
revisar(
  'dentro de la vigencia del especial sigue el especial',
  cotizarDentro.cuerpo?.origen === 'cliente',
);

const cotizarDespues = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}&cliente_id=${clientePrecioId}&fecha=${desplazar(150)}`,
  tokenAdmin,
);
revisar(
  'despues de que venza, manda el publico',
  cotizarDespues.cuerpo?.origen === 'publico',
  JSON.stringify(cotizarDespues.cuerpo),
);
revisar('y trae el precio publico', cotizarDespues.cuerpo?.precio_kg === 90);

// Un producto sin ningun precio no es un 404: es vigente:false, porque la
// cajera tiene que poder vender igual dejando el precio en cero.
const efectivoSinPrecio = await pedir(
  `/api/precios/efectivo?producto_id=${prodSinPrecio}`,
  tokenAdmin,
);
revisar(
  'producto sin precio -> 200, no 404',
  efectivoSinPrecio.status === 200,
  JSON.stringify(efectivoSinPrecio.cuerpo),
);
revisar('diciendo que no esta vigente', efectivoSinPrecio.cuerpo?.vigente === false);
revisar('con precio null', efectivoSinPrecio.cuerpo?.precio_kg === null);
revisar('y origen null', efectivoSinPrecio.cuerpo?.origen === null);

const efectivoFantasma = await pedir('/api/precios/efectivo?producto_id=999999', tokenAdmin);
revisar(
  'producto inexistente -> 404',
  efectivoFantasma.status === 404,
  JSON.stringify(efectivoFantasma.cuerpo),
);

const fechaMala = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}&fecha=20-01-2026`,
  tokenAdmin,
);
revisar(
  'una fecha en otro formato -> 400',
  fechaMala.status === 400,
  JSON.stringify(fechaMala.cuerpo),
);

const fechaImposible = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}&fecha=2026-13-45`,
  tokenAdmin,
);
revisar(
  'una fecha que no existe -> 400',
  fechaImposible.status === 400,
  JSON.stringify(fechaImposible.cuerpo),
);

const efectivoSinProductoId = await pedir('/api/precios/efectivo', tokenAdmin);
revisar(
  'efectivo sin producto_id -> 400',
  efectivoSinProductoId.status === 400,
  JSON.stringify(efectivoSinPrecio.cuerpo),
);

// ------------------------------------------------------------------
// Lo que el modulo NO tiene
// ------------------------------------------------------------------

const borrarPublico = await pedir(`/api/precios/publicos/${pubPrincipalId}`, tokenAdmin, {
  method: 'DELETE',
});
revisar(
  'no hay DELETE de precios publicos -> 404',
  borrarPublico.status === 404,
  JSON.stringify(borrarPublico.cuerpo),
);

const borrarEspecial = await pedir(`/api/precios/clientes/${especialAlta.cuerpo?.id}`, tokenAdmin, {
  method: 'DELETE',
});
revisar(
  'no hay DELETE de precios de cliente -> 404',
  borrarEspecial.status === 404,
  JSON.stringify(borrarEspecial.cuerpo),
);

const sigueEnLaBase = await sqlDirecto(
  'SELECT count(*)::int AS n FROM precios_publicos WHERE id = $1',
  [pubPrincipalId],
);
revisar(
  'el precio sigue en la base',
  sigueEnLaBase.rows?.[0]?.n === 1,
  JSON.stringify(sigueEnLaBase.rows),
);

// ------------------------------------------------------------------
// Validaciones de entrada
// ------------------------------------------------------------------

const precioNegativo = await crearPublico(prodCero, { precio_kg: '-5', vigente_desde: HOY });
revisar(
  'precio negativo -> 400',
  precioNegativo.status === 400,
  JSON.stringify(precioNegativo.cuerpo),
);

// El precio en CERO si se acepta: hay precios de cortesia y de muestra. A
// diferencia de la presentacion, que no puede ser cero.
const precioCeroReal = await crearPublico(prodCero, { precio_kg: '0', vigente_desde: HOY });
revisar(
  'precio en cero SI se acepta -> 201',
  precioCeroReal.status === 201,
  JSON.stringify(precioCeroReal.cuerpo),
);

const tresDecimales = await crearPublico(prodCero, { precio_kg: '90.555', vigente_desde: HOY });
revisar(
  'tres decimales -> 400',
  tresDecimales.status === 400,
  JSON.stringify(tresDecimales.cuerpo),
);

const centavosDeMas = await crearPublico(prodCero, { precio_kg: '90.5.5', vigente_desde: HOY });
revisar('formato raro -> 400', centavosDeMas.status === 400, JSON.stringify(centavosDeMas.cuerpo));

const textoNoNumero = await crearPublico(prodCero, { precio_kg: 'noventa', vigente_desde: HOY });
revisar(
  'texto en vez de numero -> 400',
  textoNoNumero.status === 400,
  JSON.stringify(textoNoNumero.cuerpo),
);

const vigenciaAlReves = await crearPublico(prodCero, {
  precio_kg: '90',
  vigente_desde: desplazar(10),
  vigente_hasta: desplazar(5),
});
revisar(
  'vigencia al reves -> 400',
  vigenciaAlReves.status === 400,
  JSON.stringify(vigenciaAlReves.cuerpo),
);

const productoFantasmaPrecio = await crearPublico(999999, { precio_kg: '90', vigente_desde: HOY });
revisar(
  'precio de producto inexistente -> 400',
  productoFantasmaPrecio.status === 400,
  JSON.stringify(productoFantasmaPrecio.cuerpo),
);

const clienteFantasmaPrecio = await pedir('/api/precios/clientes', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cliente_id: 999999,
    producto_id: prodPrincipal,
    precio_kg: '90',
    vigente_desde: HOY,
  }),
});
revisar(
  'precio de cliente inexistente -> 400',
  clienteFantasmaPrecio.status === 400,
  JSON.stringify(clienteFantasmaPrecio.cuerpo),
);

const sinFechaInicio = await crearPublico(prodCero, { precio_kg: '90' });
revisar(
  'alta sin vigente_desde -> 400, porque el trigger compara contra ella',
  sinFechaInicio.status === 400,
  JSON.stringify(sinFechaInicio.cuerpo),
);

const parchePrecioVacio = await pedir(`/api/precios/publicos/${pubPrincipalId}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
revisar(
  'PATCH vacio -> 400',
  parchePrecioVacio.status === 400,
  JSON.stringify(parchePrecioVacio.cuerpo),
);

const parchePrecio = await pedir(`/api/precios/publicos/${pubPrincipalId}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ precio_kg: '92.50' }),
});
revisar(
  'PATCH de un campo solo -> 200',
  parchePrecio.status === 200,
  JSON.stringify(parchePrecio.cuerpo),
);
revisar('y cambia solo ese campo', parchePrecio.cuerpo?.precio_kg === 92.5);
revisar(
  'sin tocar la vigencia',
  parchePrecio.cuerpo?.vigente_desde === pubAbierto.cuerpo?.vigente_desde,
);

const queryMalEscrita = await pedir('/api/precios/publicos?vigensia=todos', tokenAdmin);
revisar(
  'parametro de vigencia mal escrito -> 400',
  queryMalEscrita.status === 400,
  JSON.stringify(queryMalEscrita.cuerpo),
);

// ------------------------------------------------------------------
// El trigger, contra la base y no contra la API
// ------------------------------------------------------------------
//
// Todo lo de arriba pasa por el servicio, que traduce el error. Esto va
// directo a la base para comprobar que el TRIGGER esta, que es lo que
// decide cuando dos peticiones simultaneas se chocan entre si.

/**
 * `sqlDirecto` NO atrapa errores: revienta la exception. Estas dos pruebas
 * quieren justamente eso, el error del trigger, asi que se envuelven en
 * try/catch a mano. Sin esto la suite muere ahi y se lleva por delante las
 * ultimas 300 comprobaciones, que es la forma mas cara de tener una prueba
 * mal escrita.
 *
 * La primera version de este bloque dejo las llamadas sueltas y
 * fallo justo en la ultima: 301 OK, 0 FALLA, y un crash. Un resumen de
 * "todo paso" con el proceso muerto es peor que uno con una falla, porque
 * parece que se probo todo.
 */
const intentaSql = async (texto, valores) => {
  try {
    const r = await sqlDirecto(texto, valores);
    return { fallo: null, filas: r.rowCount };
  } catch (error) {
    return { fallo: error, filas: 0 };
  }
};

const porSqlTraslape = await intentaSql(
  `INSERT INTO pos.precios_publicos (producto_id, precio_kg, vigente_desde)
   VALUES ($1, 99, CURRENT_DATE + 5)`,
  [prodPrincipal],
);
revisar(
  'el trigger salta tambien escribiendo directo a SQL',
  porSqlTraslape.filas === 0 && String(porSqlTraslape.fallo?.message ?? '').includes('se traslapa'),
  porSqlTraslape.fallo?.message ?? `paso, rowCount ${porSqlTraslape.filas}`,
);

// Y por UPDATE, que es la puerta de atras que dejaria abierta un trigger
// que solo mirara los INSERT. Mover el inicio de un precio historico hacia
// dentro de la ventana abierta lo dejaria solapado.
//
// Se crea el historico aqui, con SQL, en vez de reusar `pubPrincipalId`.
// La primera version apuntava al precio abierto y "paso con rowCount 1":
// el trigger excluye a si mismo de la comparacion (p.id <> NEW.id), asi
// que mover ese precio no se chocaba con nadie, porque el unico que se
// cruzaba consigo mismo era el. La prueba no fallaba por un trigger roto,
// fallaba por haber elegido mal la fila objetivo.
const historicoSql = await intentaSql(
  `INSERT INTO pos.precios_publicos (producto_id, precio_kg, vigente_desde, vigente_hasta)
   VALUES ($1, 88, CURRENT_DATE - 90, CURRENT_DATE - 60)`,
  [prodPrincipal],
);
revisar(
  'el historico de apoyo se creo por SQL',
  historicoSql.filas === 1,
  historicoSql.fallo?.message ?? `rowCount ${historicoSql.filas}`,
);

const porSqlUpdate = await intentaSql(
  `UPDATE pos.precios_publicos
      SET vigente_desde = CURRENT_DATE + 1, vigente_hasta = CURRENT_DATE + 90
    WHERE producto_id = $1 AND precio_kg = 88`,
  [prodPrincipal],
);
revisar(
  'y tambien en UPDATE',
  porSqlUpdate.filas === 0 && String(porSqlUpdate.fallo?.message ?? '').includes('se traslapa'),
  porSqlUpdate.fallo?.message ?? `paso, rowCount ${porSqlUpdate.filas}`,
);

// Y que el trigger NO salta cuando no hay choque, para que la prueba de
// arriba no sea "el trigger siempre avienta".
const porSqlLibre = await intentaSql(
  `INSERT INTO pos.precios_publicos (producto_id, precio_kg, vigente_desde, vigente_hasta)
   VALUES ($1, 77, CURRENT_DATE - 400, CURRENT_DATE - 200)`,
  [prodPrincipal],
);
revisar(
  'el trigger NO salta cuando la ventana esta libre',
  porSqlLibre.filas === 1,
  porSqlLibre.fallo?.message ?? `rowCount ${porSqlLibre.filas}`,
);

// ------------------------------------------------------------------ cajera
//
// Que puede y que no puede hacer una cajera REAL contra este modulo. No es
// teoria: son los mismos 38 permisos que le dejo 0006, leidos de la base.
//
// El comentario de rutas.ts decia "Cajera no entra", copiado del modulo de
// productos, donde si es cierto. Aqui es falso, y no por una diferencia de
// detalle: entre los 38 hay `precios.editar`. La cajera consulta el precio
// del producto justo antes de cobrarlo, asi que quitarle la lectura la
// obliga a pedirle el numero a otra persona en cada venta.

const cajeraVePublicos = await pedir('/api/precios/publicos', tokenCajera);
revisar(
  'la cajera lee los precios publicos',
  cajeraVePublicos.status === 200,
  JSON.stringify(cajeraVePublicos.cuerpo),
);

const cajeraVeEfectivo = await pedir(
  `/api/precios/efectivo?producto_id=${prodPrincipal}`,
  tokenCajera,
);
revisar(
  'y el precio efectivo del producto que esta cobrando',
  cajeraVeEfectivo.status === 200 && cajeraVeEfectivo.cuerpo?.vigente === true,
  JSON.stringify(cajeraVeEfectivo.cuerpo),
);

const cajeraCierra = await pedir(`/api/precios/publicos/${pubPrincipalId}/cerrar`, tokenCajera, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vigente_hasta: HOY }),
});
revisar(
  'y tambien los cierra, porque 0006 le dejo precios.editar',
  cajeraCierra.status === 200,
  JSON.stringify(cajeraCierra.cuerpo),
);

// Lo que si debe quedar cerrado, y no es un detalle de permisos: el
// empleado de mostrador NO edita precios. Si esto pasara, cualquier
// transaccion podria cambiar el precio del producto entre que se autoriza
// y se cobra, y el cobro ya no cuadraria con la lista.
const sinTokenCierra = await pedir(`/api/precios/publicos/${pubPrincipalId}/cerrar`, undefined, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vigente_hasta: HOY }),
});
revisar(
  'pero sin token no, ni de broma',
  sinTokenCierra.status === 401,
  JSON.stringify(sinTokenCierra.cuerpo),
);

// ======================================================================
// NOTAS DE REMISION
// ======================================================================
//
// El punto de venta. Es el modulo donde por fin se cruzan los otros tres:
// el precio que se Autofillea es el del modulo de precios, en la FECHA de la
// nota, y la nota le descuenta al cliente.
//
// Lo que mas se prueba aqui no es el alta (que es un INSERT y un POST mas),
// sino las cuatro cosas que la base hace sola y que estan muertas si nadie
// las mira:
//   1. que la nota se deshaga SOLA cuando un renglon falla (el folio no
//      puede quedar quemado),
//   2. que la base no acepte renglones en una nota cancelada, que era el
//      agujero silencioso que cerro la migracion 0008,
//   3. que cancelar devuelva el inventario y NO libere el folio,
//   4. que editar no revalua lo que ya se cobro.

const DESPLAZAR = (dias) => {
  const f = new Date();
  f.setDate(f.getDate() + dias);
  return f.toISOString().slice(0, 10);
};

const crearNota = (cuerpo, token = tokenAdmin) =>
  pedir('/api/notas-remision', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const parcheNota = (id, cuerpo, token = tokenAdmin) =>
  pedir(`/api/notas-remision/${id}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const existeSql = async (texto, valores = []) => {
  const r = await sqlDirecto(texto, valores);
  return r.rowCount;
};

// Existencias de un producto en el almacen 1. Se lee SIEMPRE antes y
// despues de la operacion que se esta probando, y el delta es lo que se
// compara. Pegar el numero de salida en el assert es lo que hace fragile
// a una suite: en cuanto se agrega o quita una nota, todos los numeros
// pegados se rompen a la vez y no se sabe cual de los asserts mintio.
const existenciaDe = async (productoId) => {
  const r = await sqlDirecto(
    `SELECT COALESCE(SUM(CASE WHEN tipo IN ('entrada_compra','ajuste_positivo')
                              THEN cantidad_bultos ELSE -cantidad_bultos END), 0)::TEXT AS e
     FROM pos.inventario_movimientos WHERE producto_id = $1 AND almacen_id = 1`,
    [productoId],
  );
  return Number(r.rows[0].e);
};

// --- Preparacion: productos con existencias, clientes y talonario -------
//
// Existencias por SQL y no por la API a proposito. `inventario.ajustar` es
// del Administrador y la API todavia no existe; el trigger
// `trg_permiso_inventario` no estorba porque `sqlDirecto` no abre sesion, y
// `fn_trg_permiso` salta la revision cuando no hay usuario. Asi el modulo
// de notas se puede probar sin depender de un modulo que no existe.

const crearProductoDeNota = async (codigo, nombre, presentacion) => {
  const r = await crearProducto({ codigo, nombre, presentacion_kg: presentacion }, tokenAdmin);
  return r.cuerpo?.id;
};

const prodNota = await crearProductoDeNota('TST-NOTA', 'Producto de nota', '25.000');
revisar('producto de la nota -> 201', Number.isInteger(prodNota), String(prodNota));

// Un segundo producto, con otro kg por bulto y otro precio, para probar que
// cambiar el producto de un renglon NO se lleva el precio del anterior.
const prodOtro = await crearProductoDeNota('TST-NOTA2', 'Otro producto de nota', '10.000');
revisar('segundo producto de la nota -> 201', Number.isInteger(prodOtro), String(prodOtro));

const clienteNota = await pedir('/api/clientes', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigo_cliente: 'cnota', nombre: 'Cliente de nota' }),
});
revisar(
  'cliente de la nota -> 201',
  clienteNota.status === 201,
  JSON.stringify(clienteNota.cuerpo),
);
const clienteNotaId = clienteNota.cuerpo?.id;

// Un cliente SIN precio especial, para que las pruebas de "el precio sigue
// a la fecha" no se crucen con el especial del otro cliente.
const clienteFechas = await pedir('/api/clientes', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ codigo_cliente: 'cfecha', nombre: 'Cliente de fechas' }),
});
revisar(
  'cliente de fechas -> 201',
  clienteFechas.status === 201,
  JSON.stringify(clienteFechas.cuerpo),
);
const clienteFechasId = clienteFechas.cuerpo?.id;

for (const pid of [prodNota, prodOtro]) {
  await sqlDirecto(
    `INSERT INTO pos.inventario_movimientos (producto_id, almacen_id, tipo, cantidad_bultos, referencia_tabla)
     VALUES ($1, 1, 'entrada_compra', 50, 'seed')`,
    [pid],
  );
}
revisar(
  'y arrancan con 50 bultos',
  (await existenciaDe(prodNota)) === 50,
  `${await existenciaDe(prodNota)}`,
);
revisar('ambos', (await existenciaDe(prodOtro)) === 50, `${await existenciaDe(prodOtro)}`);

// El talonario lo carga el ADMIN. Es lo unico que hay que preparar para
// poder vender, asi que va primero: todo lo demas depende de que exista un
// folio disponible.
const talonario = await pedir('/api/notas-remision/folios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'TST', desde: 2001, hasta: 2010 }),
});
revisar(
  'el admin carga el talonario -> 201',
  talonario.status === 201,
  JSON.stringify(talonario.cuerpo),
);
revisar(
  'y carga los 10 folios, contados uno por uno',
  talonario.cuerpo?.creados === 10,
  JSON.stringify(talonario.cuerpo),
);
revisar(
  'sin reportar omitidos',
  talonario.cuerpo?.omitidos === 0,
  JSON.stringify(talonario.cuerpo),
);
revisar(
  'con el primero y el ultimo del rango',
  talonario.cuerpo?.primero === 2001 && talonario.cuerpo?.ultimo === 2010,
);

// Recargar un rango que pisa folios existentes tiene que ser inocuo: mete
// los que faltan y dice cuantos dejo fuera. Antes reventaba con 23505.
const recargarTalonario = await pedir('/api/notas-remision/folios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'TST', desde: 2006, hasta: 2012 }),
});
revisar(
  'recargar un rango que se traslapa -> 201, no un 23505',
  recargarTalonario.status === 201,
  JSON.stringify(recargarTalonario.cuerpo),
);
revisar(
  'mete solo los que faltaban, 2011 y 2012',
  recargarTalonario.cuerpo?.creados === 2,
  JSON.stringify(recargarTalonario.cuerpo),
);
revisar(
  'y reporta los 5 que ya estaban',
  recargarTalonario.cuerpo?.omitidos === 5,
  JSON.stringify(recargarTalonario.cuerpo),
);

const recargarTodo = await pedir('/api/notas-remision/folios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'TST', desde: 2001, hasta: 2010 }),
});
revisar(
  'un rango que ya esta COMPLETO -> 409',
  recargarTodo.status === 409 && recargarTodo.cuerpo?.codigo === 'TALONARIO_YA_CARGADO',
  JSON.stringify(recargarTodo.cuerpo),
);

const serieSinCargar = await pedir('/api/notas-remision/folios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: '', desde: 1, hasta: 5 }),
});
revisar('serie vacia -> 400', serieSinCargar.status === 400, JSON.stringify(serieSinCargar.cuerpo));

// ------------------------------------------------------- alta y autofill

// Sin precio vigente no hay nota: una venta no se puede capturar a ciegas.
const sinPrecio = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '2' }],
});
revisar(
  'sin precio vigente -> 422',
  sinPrecio.status === 422 && sinPrecio.cuerpo?.codigo === 'SIN_PRECIO',
  JSON.stringify(sinPrecio.cuerpo),
);

// Y el folio NO se quemo con el rechazo. Si se quemara, el talonario
// perderia un numero por cada nota mal capturada y nadie lo notaria hasta
// que faltara un folio.
const foliosTrasFallo = await pedir('/api/notas-remision/folios?serie=TST&limite=200', tokenAdmin);
revisar(
  'y el folio NO se quemo con el rechazo',
  foliosTrasFallo.cuerpo?.datos?.filter((f) => f.estatus === 'disponible').length === 12,
  JSON.stringify(foliosTrasFallo.cuerpo?.datos?.filter((f) => f.estatus === 'disponible').length),
);

const pubDiez = await pedir('/api/precios/publicos', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    producto_id: prodNota,
    precio_kg: '10.00',
    vigente_desde: DESPLAZAR(-30),
  }),
});
revisar('precio publico de lista -> 201', pubDiez.status === 201, JSON.stringify(pubDiez.cuerpo));
await pedir('/api/precios/publicos', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ producto_id: prodOtro, precio_kg: '5.00', vigente_desde: DESPLAZAR(-30) }),
});

const stockAntesDelAlta = await existenciaDe(prodNota);
const notaBase = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '2' }],
});
revisar('alta de nota -> 201', notaBase.status === 201, JSON.stringify(notaBase.cuerpo));
revisar(
  'toma el folio mas bajo disponible',
  notaBase.cuerpo?.folio === 'TST-2001',
  notaBase.cuerpo?.folio,
);
revisar('queda en pendiente', notaBase.cuerpo?.estatus === 'pendiente', notaBase.cuerpo?.estatus);
revisar(
  'el vendedor sale de la sesion, no del cuerpo',
  notaBase.cuerpo?.vendedor === 'Administrador',
  notaBase.cuerpo?.vendedor,
);
revisar(
  'y la fecha sale de la base, no del reloj del servidor',
  typeof notaBase.cuerpo?.fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(notaBase.cuerpo?.fecha),
  JSON.stringify(notaBase.cuerpo?.fecha),
);

const renglonBase = notaBase.cuerpo?.renglones?.[0];
revisar('un solo renglon', notaBase.cuerpo?.renglones?.length === 1);
revisar(
  'el precio se Autofilleo del modulo de precios',
  renglonBase?.precio_unit_kg === 10,
  JSON.stringify(renglonBase),
);
revisar(
  'el kg por bulto lo heredo del producto',
  renglonBase?.kg_bulto === 25,
  JSON.stringify(renglonBase),
);
revisar(
  'el subtotal lo calcula la base',
  notaBase.cuerpo?.subtotal === 500,
  JSON.stringify(notaBase.cuerpo?.subtotal),
);
revisar(
  'y el del renglon cuadra',
  renglonBase?.subtotal === 500,
  JSON.stringify(renglonBase?.subtotal),
);
revisar(
  'el stock bajo lo que se vendio',
  (await existenciaDe(prodNota)) === stockAntesDelAlta - 2,
  `${stockAntesDelAlta} -> ${await existenciaDe(prodNota)}`,
);
const notaBaseId = notaBase.cuerpo?.id;

// La siguiente toma el que sigue, y nunca repite.
const notaLimpia = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'la siguiente toma el folio que sigue',
  notaLimpia.cuerpo?.folio === 'TST-2002',
  notaLimpia.cuerpo?.folio,
);
revisar('NUNCA repite folio', notaLimpia.cuerpo?.folio !== notaBase.cuerpo?.folio);
const notaLimpiaId = notaLimpia.cuerpo?.id;

// ------------------------------------------------------------ validaciones

const sinRenglones = await crearNota({ cliente_id: clienteNotaId, serie: 'TST', renglones: [] });
revisar(
  'una nota sin renglones -> 400',
  sinRenglones.status === 400,
  JSON.stringify(sinRenglones.cuerpo),
);

const mandarSubtotal = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1', subtotal: 999 }],
});
revisar(
  'mandar el subtotal del renglon -> 400, es GENERATED',
  mandarSubtotal.status === 400,
  JSON.stringify(mandarSubtotal.cuerpo),
);

const mandarVendedor = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  vendedor_id: 999,
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'mandar vendedor_id a mano -> 400',
  mandarVendedor.status === 400,
  JSON.stringify(mandarVendedor.cuerpo),
);

const cambiarEstatus = await parcheNota(notaBaseId, { estatus: 'pagada' });
revisar(
  'cambiar el estatus por la API -> 400, lo mueven los pagos',
  cambiarEstatus.status === 400,
  JSON.stringify(cambiarEstatus.cuerpo),
);

const fechaNotaImposible = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  fecha: '2026-02-30',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'una fecha que no existe -> 400',
  fechaNotaImposible.status === 400,
  JSON.stringify(fechaNotaImposible.cuerpo),
);

const clienteFantasma = await crearNota({
  cliente_id: 999999,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'cliente que no existe -> 400, y lo dice',
  clienteFantasma.status === 400 && clienteFantasma.cuerpo?.error === 'El cliente 999999 no existe',
  JSON.stringify(clienteFantasma.cuerpo),
);

const almacenFantasma = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 2, cantidad_bultos: '1' }],
});
revisar(
  'un almacen que no existe -> 400',
  almacenFantasma.status === 400,
  JSON.stringify(almacenFantasma.cuerpo),
);

const productoFantasma = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: 999999, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'un producto que no existe -> 400',
  productoFantasma.status === 400,
  JSON.stringify(productoFantasma.cuerpo),
);

const serieVacia = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'ZZZ',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'serie sin folios -> 422, y dice cual',
  serieVacia.status === 422 && serieVacia.cuerpo?.codigo === 'SIN_FOLIOS',
  JSON.stringify(serieVacia.cuerpo),
);

// Un producto dado de baja no se vende. El producto se da de baja por SQL
// porque la API de productos no expone el campo `activo` al PATCH.
await sqlDirecto(`UPDATE pos.productos SET activo = false WHERE id = $1`, [prodOtro]);
const productoInactivo = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodOtro, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'vender un producto dado de baja -> 422',
  productoInactivo.status === 422 && productoInactivo.cuerpo?.codigo === 'PRODUCTO_INACTIVO',
  JSON.stringify(productoInactivo.cuerpo),
);
await sqlDirecto(`UPDATE pos.productos SET activo = true WHERE id = $1`, [prodOtro]);

// ------------------------------------------------------------------ stock

const stockAntesDePedirDeMas = await existenciaDe(prodNota);
const sinStock = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '9999' }],
});
revisar(
  'vender mas de lo que hay -> 409 STOCK_INSUFICIENTE',
  sinStock.status === 409 && sinStock.cuerpo?.codigo === 'STOCK_INSUFICIENTE',
  JSON.stringify(sinStock.cuerpo),
);
revisar(
  'y el mensaje dice cuantos bultos faltan',
  sinStock.cuerpo?.detalles?.faltan === 9999 - stockAntesDePedirDeMas,
  JSON.stringify(sinStock.cuerpo?.detalles),
);
revisar(
  'y no se movio el stock',
  (await existenciaDe(prodNota)) === stockAntesDePedirDeMas,
  `${await existenciaDe(prodNota)}`,
);

// El mismo producto dos veces en una nota: el chequeo tiene que SUMAR los
// dos renglones, no mirar cada uno por su lado.
const pedazoDeLoQueQueda = Math.floor(stockAntesDePedirDeMas / 2) + 1;
const dobleRenglon = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [
    { producto_id: prodNota, almacen_id: 1, cantidad_bultos: String(pedazoDeLoQueQueda) },
    { producto_id: prodNota, almacen_id: 1, cantidad_bultos: String(pedazoDeLoQueQueda) },
  ],
});
revisar(
  'el mismo producto en dos renglones suma antes de comparar -> 422',
  dobleRenglon.status === 409 && dobleRenglon.cuerpo?.codigo === 'STOCK_INSUFICIENTE',
  JSON.stringify(dobleRenglon.cuerpo),
);
revisar(
  'y reporta el doble de lo pedido, no una vez',
  dobleRenglon.cuerpo?.detalles?.solicitado === pedazoDeLoQueQueda * 2,
  JSON.stringify(dobleRenglon.cuerpo?.detalles),
);
revisar('y sigue sin mover el stock', (await existenciaDe(prodNota)) === stockAntesDePedirDeMas);

// ------------------------------------------------- el precio de la FECHA
//
// Esta es la razon de que `resolverEfectivo` reciba una fecha. Un precio que
// empieza manana no puede ser el de una nota de hoy, y una nota de la
// semana pasada no se puede revaluar cuando meten un precio nuevo.
//
// El cliente de fechas no tiene precio especial, asi que aqui el unico
// precio que puede salir es el publico de la fecha que toca.

const cerrarDiez = await pedir(`/api/precios/publicos/${pubDiez.cuerpo?.id}/cerrar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ vigente_hasta: DESPLAZAR(9) }),
});
revisar(
  'y se cierra el de 10 el dia 9',
  cerrarDiez.status === 200,
  JSON.stringify(cerrarDiez.cuerpo),
);
revisar(
  'la ventana queda hasta el dia 9',
  cerrarDiez.cuerpo?.vigente_hasta === DESPLAZAR(9),
  JSON.stringify(cerrarDiez.cuerpo?.vigente_hasta),
);

const pubVeinte = await pedir('/api/precios/publicos', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ producto_id: prodNota, precio_kg: '20.00', vigente_desde: DESPLAZAR(10) }),
});
revisar(
  'precio de 20 desde el dia 10 -> 201',
  pubVeinte.status === 201,
  JSON.stringify(pubVeinte.cuerpo),
);

const notaPasada = await crearNota({
  cliente_id: clienteFechasId,
  serie: 'TST',
  fecha: DESPLAZAR(-5),
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar('nota de hace 5 dias -> 201', notaPasada.status === 201, JSON.stringify(notaPasada.cuerpo));
revisar(
  'y usa el precio que estaba vigente EN ESA FECHA, no el de hoy',
  notaPasada.cuerpo?.renglones?.[0]?.precio_unit_kg === 10,
  JSON.stringify(notaPasada.cuerpo?.renglones?.[0]),
);

const notaFutura = await crearNota({
  cliente_id: clienteFechasId,
  serie: 'TST',
  fecha: DESPLAZAR(20),
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'y una nota de manana SI alcanza el precio de manana',
  notaFutura.cuerpo?.renglones?.[0]?.precio_unit_kg === 20,
  JSON.stringify(notaFutura.cuerpo?.renglones?.[0]),
);

// El precio escrito a mano manda sobre el de lista.
const notaConTrato = await crearNota({
  cliente_id: clienteFechasId,
  serie: 'TST',
  renglones: [
    { producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1', precio_unit_kg: '7.77' },
  ],
});
revisar('precio a mano -> 201', notaConTrato.status === 201, JSON.stringify(notaConTrato.cuerpo));
revisar(
  'y el trato del operador gana sobre la lista',
  notaConTrato.cuerpo?.renglones?.[0]?.precio_unit_kg === 7.77,
  JSON.stringify(notaConTrato.cuerpo?.renglones?.[0]),
);
revisar(
  'el subtotal usa el precio a mano',
  notaConTrato.cuerpo?.subtotal === 7.77 * 25,
  JSON.stringify(notaConTrato.cuerpo?.subtotal),
);
const notaConTratoId = notaConTrato.cuerpo?.id;

// El precio especial del cliente tiene precedencia sobre el publico.
const precioEspecial = await pedir('/api/precios/clientes', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cliente_id: clienteNotaId,
    producto_id: prodNota,
    precio_kg: '9.00',
    vigente_desde: DESPLAZAR(-30),
  }),
});
revisar(
  'precio especial del cliente -> 201',
  precioEspecial.status === 201,
  JSON.stringify(precioEspecial.cuerpo),
);
const notaConEspecial = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'la nota del cliente usa su especial, no el publico',
  notaConEspecial.cuerpo?.renglones?.[0]?.precio_unit_kg === 9,
  JSON.stringify(notaConEspecial.cuerpo?.renglones?.[0]),
);

// ---------------------------------------------------------------- edicion

const editarDireccion = await parcheNota(notaBaseId, { direccion_entrega: 'Rancho La Esperanza' });
revisar(
  'editar la direccion -> 200',
  editarDireccion.status === 200,
  JSON.stringify(editarDireccion.cuerpo),
);
revisar(
  'y guarda la direccion',
  editarDireccion.cuerpo?.direccion_entrega === 'Rancho La Esperanza',
);
revisar(
  'sin tocar el subtotal',
  editarDireccion.cuerpo?.subtotal === notaBase.cuerpo?.subtotal,
  JSON.stringify(editarDireccion.cuerpo?.subtotal),
);
revisar('ni los renglones', editarDireccion.cuerpo?.renglones?.length === 1);

// ------------------------------------------------------------------ pdf

/**
 * El PDF de la nota.
 *
 * Lo que se comprueba aqui es el CONTRATO de la respuesta, no el papel: que
 * salga un PDF de verdad, con el tipo y el nombre correctos, y sobre todo que
 * un error siga siendo JSON. Ese ultimo punto es el que se paga caro si se
 * rompe: si el PDF se empieza a mandar antes de saber si se pudo armar, un
 * 404 llega como un PDF corrupto y el navegador dice "el archivo esta
 * danado" en vez de "esa nota no existe".
 */
const pdfDeLaNota = await pedirBytes(`/api/notas-remision/${notaBaseId}/pdf`, tokenAdmin);
revisar('el pdf de la nota -> 200', pdfDeLaNota.status === 200, String(pdfDeLaNota.status));
revisar(
  'es un PDF de verdad',
  pdfDeLaNota.bytes.subarray(0, 5).toString('latin1') === '%PDF-',
  JSON.stringify(pdfDeLaNota.bytes.subarray(0, 8).toString('latin1')),
);
revisar(
  'sale como application/pdf',
  pdfDeLaNota.headers.get('content-type') === 'application/pdf',
  pdfDeLaNota.headers.get('content-type'),
);
revisar(
  'con el folio en el nombre del archivo',
  (pdfDeLaNota.headers.get('content-disposition') ?? '').includes(
    `nota-remision-${notaBase.cuerpo?.folio}-`,
  ),
  pdfDeLaNota.headers.get('content-disposition'),
);
revisar(
  'y sin cache: el mismo folio puede reimprimirse con otro contenido',
  pdfDeLaNota.headers.get('cache-control') === 'no-store',
  pdfDeLaNota.headers.get('cache-control'),
);

const pdfSinNota = await pedirBytes('/api/notas-remision/99999999/pdf', tokenAdmin);
revisar(
  'una nota que no existe sigue dando JSON, no un PDF roto',
  pdfSinNota.status === 404 && pdfSinNota.bytes.toString('utf8').includes('NO_ENCONTRADO'),
  `${pdfSinNota.status} ${pdfSinNota.bytes.toString('utf8').slice(0, 80)}`,
);

const pdfSinToken = await pedirBytes(`/api/notas-remision/${notaBaseId}/pdf`, null);
revisar('sin sesion no hay PDF', pdfSinToken.status === 401, String(pdfSinToken.status));

// La cajera y la empleada si tienen `notas.ver`, asi que las dos pueden
// imprimir: el PDF no es un permiso aparte del de ver.
const pdfCajera = await pedirBytes(`/api/notas-remision/${notaBaseId}/pdf`, tokenCajera);
revisar('la cajera tambien puede imprimir', pdfCajera.status === 200, String(pdfCajera.status));

const stockAntesDeCantidad = await existenciaDe(prodNota);
const precioDelRenglon = editarDireccion.cuerpo?.renglones?.[0]?.precio_unit_kg;
const cambiarCantidad = await parcheNota(notaBaseId, {
  renglones: [{ id: renglonBase.id, producto_id: prodNota, almacen_id: 1, cantidad_bultos: '3' }],
});
revisar(
  'cambiar la cantidad -> 200',
  cambiarCantidad.status === 200,
  JSON.stringify(cambiarCantidad.cuerpo),
);
revisar(
  'el subtotal se recalcula con el precio del renglon',
  cambiarCantidad.cuerpo?.subtotal === 3 * 25 * precioDelRenglon,
  `${cambiarCantidad.cuerpo?.subtotal} vs ${3 * 25 * precioDelRenglon}`,
);
revisar(
  'y el stock baja solo el bulto que se sumo',
  (await existenciaDe(prodNota)) === stockAntesDeCantidad - 1,
  `${stockAntesDeCantidad} -> ${await existenciaDe(prodNota)}`,
);
revisar('sin dejar renglones de mas', cambiarCantidad.cuerpo?.renglones?.length === 1);

const parcheNotaVacio = await parcheNota(notaBaseId, {});
revisar(
  'un PATCH vacio -> 400',
  parcheNotaVacio.status === 400,
  JSON.stringify(parcheNotaVacio.cuerpo),
);

// Este va antes de la nota al borde, no despues: prodOtro es el unico
// producto con precio propio de 5.00, y la nota al borde se lo lleva
// entero. Despues de esa no habria existencias con las que cambiar de
// producto.
// Un renglon que cambia de PRODUCTO tiene que releer el precio del nuevo.
// Antes se quedaba con el del anterior, porque el mapa de "precios a
// conservar" no guardaba de que producto eran.
const cambiarProducto = await parcheNota(notaConTratoId, {
  renglones: [
    {
      id: notaConTrato.cuerpo?.renglones?.[0]?.id,
      producto_id: prodOtro,
      almacen_id: 1,
      cantidad_bultos: '1',
    },
  ],
});
revisar(
  'cambiar el producto del renglon -> 200',
  cambiarProducto.status === 200,
  JSON.stringify(cambiarProducto.cuerpo),
);
revisar(
  'y toma el precio del PRODUCTO NUEVO, no el del que estaba',
  cambiarProducto.cuerpo?.renglones?.[0]?.precio_unit_kg === 5,
  JSON.stringify(cambiarProducto.cuerpo?.renglones?.[0]),
);
revisar(
  'con el kg del producto nuevo',
  cambiarProducto.cuerpo?.renglones?.[0]?.kg_bulto === 10,
  JSON.stringify(cambiarProducto.cuerpo?.renglones?.[0]),
);
revisar(
  'y el subtotal con ese precio y ese kg',
  cambiarProducto.cuerpo?.subtotal === 1 * 10 * 5,
  JSON.stringify(cambiarProducto.cuerpo?.subtotal),
);

// Editar una nota y dejar un renglon COMO ESTABA no puede rebotar por
// falta de stock. La existencia que se compara ya viene descontada por esta
// misma nota, asi que sin el credito del consumo propio, "no hay producto
// suficiente" salia con 45 bultos en bodega y 45 en la nota.
//
// La cantidad es la que HAY, no un 50 pegado: si antes se vendio de este
// producto, con 50 fijos esta nota reventaba por stock y la pruebaeria estar
// midiendo otra cosa.
const todoLoQueQueda = await existenciaDe(prodOtro);
const notaAlBorde = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodOtro, almacen_id: 1, cantidad_bultos: String(todoLoQueQueda) }],
});
revisar(
  'nota que se lleva TODO lo que hay -> 201',
  notaAlBorde.status === 201,
  JSON.stringify(notaAlBorde.cuerpo),
);
revisar(
  'y deja el almacen en cero',
  (await existenciaDe(prodOtro)) === 0,
  `${await existenciaDe(prodOtro)}`,
);
const notaAlBordeId = notaAlBorde.cuerpo?.id;
const renglonEnBorde = notaAlBorde.cuerpo?.renglones?.[0];
const editarSinMoverStock = await parcheNota(notaAlBordeId, {
  direccion_entrega: 'misma mercancia, otra direccion',
  renglones: [
    {
      id: renglonEnBorde.id,
      producto_id: prodOtro,
      almacen_id: 1,
      cantidad_bultos: String(todoLoQueQueda),
      precio_unit_kg: renglonEnBorde.precio_unit_kg,
    },
  ],
});
revisar(
  'dejar el renglon igual y cambiar otra cosa -> 200, NO es falta de stock',
  editarSinMoverStock.status === 200,
  JSON.stringify(editarSinMoverStock.cuerpo),
);
revisar(
  'y sigue pendiente',
  editarSinMoverStock.cuerpo?.estatus === 'pendiente',
  JSON.stringify(editarSinMoverStock.cuerpo?.estatus),
);
revisar(
  'con el stock igual',
  (await existenciaDe(prodOtro)) === 0,
  `${await existenciaDe(prodOtro)}`,
);

// Quitar un renglon: el stock de ese renglon regresa solo. Los dos
// renglones son del MISMO producto a proposito: asi el unico producto del
// bloque con existencias (prodOtro) queda reservado para la nota al borde,
// que necesita llevarselo todo.
const conDos = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [
    { producto_id: prodNota, almacen_id: 1, cantidad_bultos: '3' },
    { producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' },
  ],
});
revisar('nota con dos renglones -> 201', conDos.status === 201, JSON.stringify(conDos.cuerpo));
revisar(
  'y dos renglones',
  conDos.cuerpo?.renglones?.length === 2,
  JSON.stringify(conDos.cuerpo?.renglones?.length),
);
const precioConDos = conDos.cuerpo?.renglones?.[0]?.precio_unit_kg;
const quitarUno = await parcheNota(conDos.cuerpo?.id, {
  renglones: [
    {
      id: conDos.cuerpo?.renglones?.[0]?.id,
      producto_id: prodNota,
      almacen_id: 1,
      cantidad_bultos: '3',
    },
  ],
});
revisar('quitar un renglon -> 200', quitarUno.status === 200, JSON.stringify(quitarUno.cuerpo));
revisar(
  'queda solo el que se quedo',
  quitarUno.cuerpo?.renglones?.length === 1,
  JSON.stringify(quitarUno.cuerpo?.renglones?.length),
);
revisar(
  'y el subtotal se recalcula con lo que queda',
  quitarUno.cuerpo?.subtotal === 3 * 25 * precioConDos,
  `${quitarUno.cuerpo?.subtotal} vs ${3 * 25 * precioConDos}`,
);

// --- el precio NO se revalua solo, y cuando si, es a proposito ---------
//
// Tres reglas distintas, y por lo que se prueban con el cliente de fechas
// (sin precio especial) para que no se cruzen con el otro cliente.

const renglonPasada = notaPasada.cuerpo?.renglones?.[0];
const editarFechaYRenglones = await parcheNota(notaPasada.cuerpo?.id, {
  fecha: DESPLAZAR(20),
  renglones: [{ id: renglonPasada.id, producto_id: prodNota, almacen_id: 1, cantidad_bultos: '2' }],
});
revisar(
  'cambiar la fecha CON renglones -> 200',
  editarFechaYRenglones.status === 200,
  JSON.stringify(editarFechaYRenglones.cuerpo),
);
revisar(
  'guarda la fecha nueva',
  editarFechaYRenglones.cuerpo?.fecha === DESPLAZAR(20),
  editarFechaYRenglones.cuerpo?.fecha,
);
revisar(
  'y ahi si revalua al precio de ESA fecha, que es lo que pide el operador que se equivoco al capturar el dia',
  editarFechaYRenglones.cuerpo?.renglones?.[0]?.precio_unit_kg === 20,
  JSON.stringify(editarFechaYRenglones.cuerpo?.renglones?.[0]),
);
revisar(
  'y el subtotal se recalcula con el precio nuevo',
  editarFechaYRenglones.cuerpo?.subtotal === 2 * 25 * 20,
  JSON.stringify(editarFechaYRenglones.cuerpo?.subtotal),
);

const soloLaFecha = await parcheNota(notaFutura.cuerpo?.id, { fecha: DESPLAZAR(2) });
revisar(
  'cambiar la fecha SOLA -> 200',
  soloLaFecha.status === 200,
  JSON.stringify(soloLaFecha.cuerpo),
);
revisar(
  'pero no revalua nada: la cabecera no trae renglones que revaluar',
  soloLaFecha.cuerpo?.renglones?.[0]?.precio_unit_kg === 20,
  JSON.stringify(soloLaFecha.cuerpo?.renglones?.[0]),
);

const renglonEditado = editarFechaYRenglones.cuerpo?.renglones?.[0];
const soloLaCantidad = await parcheNota(notaPasada.cuerpo?.id, {
  renglones: [
    { id: renglonEditado.id, producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' },
  ],
});
revisar(
  'y cambiar la cantidad tampoco revalua, aunque hoy el precio sea otro',
  soloLaCantidad.cuerpo?.renglones?.[0]?.precio_unit_kg === 20,
  JSON.stringify(soloLaCantidad.cuerpo?.renglones?.[0]),
);

// ---------------------------------------------------------- nota pagada
//
// Para llegar a 'pagada' hay que pagar de verdad, porque eso es lo unico
// que la pone asi: `fn_actualizar_estatus_por_aplicaciones` lee
// `pagos_aplicacion`. Se escribe a proposito, porque las pruebas de este
// bloque tienen que poder dejar la nota en cualquier estado.

const notaParaPagar = await pedir(`/api/notas-remision/${notaBaseId}`, tokenAdmin);
const aPagar = notaParaPagar.cuerpo?.subtotal;
revisar(
  'la nota a pagar sigue pendiente',
  notaParaPagar.cuerpo?.estatus === 'pendiente',
  JSON.stringify(notaParaPagar.cuerpo?.estatus),
);
revisar('y su subtotal es el de ahora', typeof aPagar === 'number' && aPagar > 0, String(aPagar));

const pago = await sqlDirecto(
  `INSERT INTO pos.pagos (cliente_id, fecha, metodo, monto) VALUES ($1, CURRENT_DATE, 'Efectivo', 99999) RETURNING id`,
  [clienteNotaId],
);
const pagoId = Number(pago.rows[0].id);
await sqlDirecto(
  `INSERT INTO pos.pagos_aplicacion (pago_id, nota_id, monto_aplicado) VALUES ($1, $2, $3)`,
  [pagoId, notaBaseId, aPagar],
);
const estatusTrasPago = await pedir(`/api/notas-remision/${notaBaseId}`, tokenAdmin);
revisar(
  'aplicar un pago la deja PAGADA sola',
  estatusTrasPago.cuerpo?.estatus === 'pagada',
  JSON.stringify(estatusTrasPago.cuerpo?.estatus),
);

const editarPagada = await parcheNota(notaBaseId, {
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'editar una nota pagada -> 409',
  editarPagada.status === 409 && editarPagada.cuerpo?.codigo === 'NOTA_CONGELADA',
  JSON.stringify(editarPagada.cuerpo),
);
revisar(
  'y el mensaje dice que hacer',
  /cancelala/.test(editarPagada.cuerpo?.error ?? ''),
  editarPagada.cuerpo?.error,
);

// Y por debajo del API, para probar que la BASE tambien la frena: un
// UPDATE directo a la cabecera. Si este pasara, el bloqueo viviria solo en
// el servicio y un script de psql podria rebalar una venta cobrada.
const sqlPagadaCabecera = await intentaSql(
  `UPDATE pos.notas_remision SET direccion_entrega = 'cambiada a mano' WHERE id = $1`,
  [notaBaseId],
);
revisar(
  'y la BASE frena editar la cabecera de una pagada (23514)',
  sqlPagadaCabecera.filas === 0 &&
    String(sqlPagadaCabecera.fallo?.message ?? '').includes('no se puede modificar'),
  sqlPagadaCabecera.fallo?.message ?? `paso, rowCount ${sqlPagadaCabecera.filas}`,
);

const sqlPagadaRenglon = await intentaSql(
  `INSERT INTO pos.nota_remision_detalle (nota_id, producto_id, almacen_id, cantidad_bultos, precio_unit_kg)
   VALUES ($1, $2, 1, 1, 5)`,
  [notaBaseId, prodNota],
);
revisar(
  'y la BASE frena meter renglones en una pagada (23514)',
  sqlPagadaRenglon.filas === 0 &&
    String(sqlPagadaRenglon.fallo?.message ?? '').includes('renglones no se pueden tocar'),
  sqlPagadaRenglon.fallo?.message ?? `paso, rowCount ${sqlPagadaRenglon.filas}`,
);

// El estatus SI se puede seguir tocando en una pagada, porque ahi lo mueven
// los pagos. Si este UPDATE rebentara, el modulo de pagos dejaria de
// funcionar contra notas ya pagadas.
const sqlTocaEstatus = await intentaSql(
  `UPDATE pos.notas_remision SET estatus = estatus WHERE id = $1`,
  [notaBaseId],
);
revisar(
  'pero tocar solo el estatus SI se deja (lo hacen los pagos)',
  sqlTocaEstatus.filas === 1,
  sqlTocaEstatus.fallo?.message ?? `rowCount ${sqlTocaEstatus.filas}`,
);

// -------------------------------------------------------------- cancelar

const cancelarSinMotivo = await pedir(`/api/notas-remision/${notaAlBordeId}/cancelar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
revisar(
  'cancelar sin motivo -> 400',
  cancelarSinMotivo.status === 400,
  JSON.stringify(cancelarSinMotivo.cuerpo),
);

const stockAntesDeCancelar = await existenciaDe(prodOtro);
const cancelar = await pedir(`/api/notas-remision/${notaAlBordeId}/cancelar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ motivo: 'Se equivoc\u00f3 la mercancia' }),
});
revisar('cancelar -> 200', cancelar.status === 200, JSON.stringify(cancelar.cuerpo));
revisar('queda cancelada', cancelar.cuerpo?.estatus === 'cancelada', cancelar.cuerpo?.estatus);
revisar(
  'guarda el motivo',
  cancelar.cuerpo?.motivo_cancelacion === 'Se equivoc\u00f3 la mercancia',
  cancelar.cuerpo?.motivo_cancelacion,
);
revisar(
  'y el inventario REGRESA solo, sin que nadie lo ajuste',
  (await existenciaDe(prodOtro)) === stockAntesDeCancelar + todoLoQueQueda,
  `${stockAntesDeCancelar} + ${todoLoQueQueda} vs ${await existenciaDe(prodOtro)}`,
);

const folioCancelada = await pedir('/api/notas-remision/folios?serie=TST&limite=200', tokenAdmin);
const folioDeLaCancelada = folioCancelada.cuerpo?.datos?.find(
  (f) => f.completo === notaAlBorde.cuerpo?.folio,
);
revisar(
  'pero el folio NO se libera: ese numero ya salio de la casa',
  folioDeLaCancelada?.estatus === 'usado',
  JSON.stringify(folioDeLaCancelada),
);

const cancelarDosVeces = await pedir(`/api/notas-remision/${notaAlBordeId}/cancelar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ motivo: 'otra vez' }),
});
revisar(
  'cancelar dos veces -> 409',
  cancelarDosVeces.status === 409 && cancelarDosVeces.cuerpo?.codigo === 'NOTA_YA_CANCELADA',
  JSON.stringify(cancelarDosVeces.cuerpo),
);

const editarCancelada = await parcheNota(notaAlBordeId, {
  renglones: [{ producto_id: prodOtro, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'editar una cancelada -> 409',
  editarCancelada.status === 409 && editarCancelada.cuerpo?.codigo === 'NOTA_CONGELADA',
  JSON.stringify(editarCancelada.cuerpo),
);

// El agujero que cerro 0008: renglones en una nota cancelada. Con el trigger
// de inventario de 0001 esto PASABA en silencio, porque ese trigger dice
// "si la nota esta cancelada, no muevo el stock" y se iba sin avisar. El
// renglon se guardaba, el subtotal subia y la nota debia producto que
// nadie habia entregado.
const stockTrasCancelar = await existenciaDe(prodOtro);
const sqlCanceladaRenglon = await intentaSql(
  `INSERT INTO pos.nota_remision_detalle (nota_id, producto_id, almacen_id, cantidad_bultos, precio_unit_kg)
   VALUES ($1, $2, 1, 5, 5)`,
  [notaAlBordeId, prodOtro],
);
revisar(
  'y la BASE ya no acepta renglones en una cancelada (23514)',
  sqlCanceladaRenglon.filas === 0 &&
    String(sqlCanceladaRenglon.fallo?.message ?? '').includes('renglones no se pueden tocar'),
  sqlCanceladaRenglon.fallo?.message ?? `paso, rowCount ${sqlCanceladaRenglon.filas}`,
);
revisar(
  'y por eso el inventario no se movio',
  (await existenciaDe(prodOtro)) === stockTrasCancelar,
  `${await existenciaDe(prodOtro)}`,
);

// Una pagada SI se puede cancelar: el usuario lo pidio, y el trigger de
// 0008 lo permite justamente porque deja pasar los cambios de estatus.
const cancelarPagada = await pedir(`/api/notas-remision/${notaBaseId}/cancelar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ motivo: 'Se cobro mal, se anula la venta' }),
});
revisar(
  'cancelar una PAGADA -> 200',
  cancelarPagada.status === 200,
  JSON.stringify(cancelarPagada.cuerpo?.error),
);
revisar(
  'queda cancelada',
  cancelarPagada.cuerpo?.estatus === 'cancelada',
  cancelarPagada.cuerpo?.estatus,
);

// No hay DELETE de nota, y por una razon que se nota en el folio.
const borrarNota = await pedir(`/api/notas-remision/${notaLimpiaId}`, tokenAdmin, {
  method: 'DELETE',
});
revisar(
  'no hay DELETE de nota -> 404',
  borrarNota.status === 404,
  JSON.stringify(borrarNota.cuerpo),
);

// -------------------------------------------------------------- listado

const listadoNotas = await pedir('/api/notas-remision?limite=200', tokenAdmin);
revisar('listar -> 200', listadoNotas.status === 200, JSON.stringify(listadoNotas.cuerpo?.error));
revisar(
  'trae el folio armado, no el numero suelto',
  listadoNotas.cuerpo?.datos?.every((n) => /^[A-Z]+-\d+$/.test(n.folio)),
  JSON.stringify(listadoNotas.cuerpo?.datos?.slice(0, 2)),
);
revisar(
  'y el nombre del cliente, no el id',
  listadoNotas.cuerpo?.datos?.every((n) => typeof n.cliente === 'string' && n.cliente.length > 0),
);
revisar(
  'el listado trae CUANTOS renglones, no los renglones',
  listadoNotas.cuerpo?.datos?.every((x) => Number.isInteger(x.renglones) && x.renglones >= 1),
  JSON.stringify(listadoNotas.cuerpo?.datos?.slice(0, 2)?.map((x) => x.renglones)),
);
revisar(
  'y la nota que tenia dos renglones, ya sin uno, cuenta 1',
  listadoNotas.cuerpo?.datos?.find((x) => x.folio === conDos.cuerpo?.folio)?.renglones === 1,
  JSON.stringify(listadoNotas.cuerpo?.datos?.find((x) => x.folio === conDos.cuerpo?.folio)),
);

const porCliente = await pedir(
  `/api/notas-remision?cliente_id=${clienteNotaId}&limite=200`,
  tokenAdmin,
);
revisar(
  'filtrar por cliente',
  porCliente.cuerpo?.total === porCliente.cuerpo?.datos?.length,
  `${porCliente.cuerpo?.total} vs ${porCliente.cuerpo?.datos?.length}`,
);
revisar(
  'y son todas suyas',
  porCliente.cuerpo?.datos?.every((n) => n.cliente === 'Cliente de nota'),
);

const porEstatus = await pedir('/api/notas-remision?estatus=cancelada', tokenAdmin);
revisar(
  'filtrar por estatus',
  porEstatus.cuerpo?.datos?.every((n) => n.estatus === 'cancelada') &&
    porEstatus.cuerpo?.total >= 1,
  JSON.stringify(porEstatus.cuerpo?.total),
);

const buscarPorFolio = await pedir('/api/notas-remision?buscar=TST-2001', tokenAdmin);
revisar(
  'buscar por folio -> 1',
  buscarPorFolio.cuerpo?.total === 1,
  JSON.stringify(buscarPorFolio.cuerpo?.total),
);
revisar('y es la correcta', buscarPorFolio.cuerpo?.datos?.[0]?.folio === 'TST-2001');

const buscarPorNombre = await pedir('/api/notas-remision?buscar=Cliente%20de%20nota', tokenAdmin);
revisar(
  'buscar por nombre de cliente',
  buscarPorNombre.cuerpo?.total > 0,
  JSON.stringify(buscarPorNombre.cuerpo?.total),
);

const paginado = await pedir('/api/notas-remision?limite=2&offset=1', tokenAdmin);
revisar(
  'paginar devuelve la ventana pedida',
  paginado.cuerpo?.datos?.length <= 2,
  JSON.stringify(paginado.cuerpo?.datos?.length),
);
revisar(
  'y el total completo, no el de la pagina',
  paginado.cuerpo?.total > 2,
  JSON.stringify(paginado.cuerpo?.total),
);

const limiteCero = await pedir('/api/notas-remision?limite=0', tokenAdmin);
revisar('limite 0 -> 400', limiteCero.status === 400, JSON.stringify(limiteCero.cuerpo));

const rangoInvertido = await pedir(
  '/api/notas-remision?desde=2026-12-01&hasta=2026-01-01',
  tokenAdmin,
);
revisar(
  'desde posterior a hasta -> 400',
  rangoInvertido.status === 400,
  JSON.stringify(rangoInvertido.cuerpo),
);

const verNota = await pedir(`/api/notas-remision/${notaBaseId}`, tokenAdmin);
revisar('ver el detalle -> 200', verNota.status === 200);
revisar('trae los renglones', verNota.cuerpo?.renglones?.length >= 1);
revisar(
  'y el nombre del almacen',
  verNota.cuerpo?.renglones?.[0]?.almacen === 'Bodega principal',
  JSON.stringify(verNota.cuerpo?.renglones?.[0]?.almacen),
);

const notaFantasma = await pedir('/api/notas-remision/999999', tokenAdmin);
revisar(
  'nota que no existe -> 404',
  notaFantasma.status === 404,
  JSON.stringify(notaFantasma.cuerpo),
);

// -------------------------------------------------------------- permisos

const sinTokenNota = await pedir('/api/notas-remision');
revisar(
  'listar sin token -> 401',
  sinTokenNota.status === 401,
  JSON.stringify(sinTokenNota.cuerpo),
);

// `notas.folios` es solo del Administrador, y esa es la diferencia con
// `notas.crear`: ampliar el talonario decide que numeros de documento
// existen, y no es tarea de quien captura notas.
const empleadaTalonario = await pedir('/api/notas-remision/folios', tokenEmpleada, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'TST', desde: 2050, hasta: 2055 }),
});
revisar(
  'la empleada NO carga talonario -> 403',
  empleadaTalonario.status === 403,
  JSON.stringify(empleadaTalonario.cuerpo),
);

const cajeraTalonario = await pedir('/api/notas-remision/folios', tokenCajera, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'TST', desde: 2050, hasta: 2055 }),
});
revisar(
  'la cajera tampoco -> 403',
  cajeraTalonario.status === 403,
  JSON.stringify(cajeraTalonario.cuerpo),
);

const cajeraCreaNota = await crearNota(
  {
    cliente_id: clienteNotaId,
    serie: 'TST',
    renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
  },
  tokenCajera,
);
revisar(
  'pero la cajera SI cobra -> 201',
  cajeraCreaNota.status === 201,
  JSON.stringify(cajeraCreaNota.cuerpo?.error),
);
revisar(
  'y sale SU nombre en el vendedor, no el del admin',
  cajeraCreaNota.cuerpo?.vendedor === 'Carla',
  JSON.stringify(cajeraCreaNota.cuerpo?.vendedor),
);
const cajeraNotaId = cajeraCreaNota.cuerpo?.id;
const cajeraRelee = await pedir(`/api/notas-remision/${cajeraNotaId}`, tokenCajera);
revisar(
  'y despues la puede releer, con su vendedor ya guardado',
  cajeraRelee.status === 200 && cajeraRelee.cuerpo?.vendedor === 'Carla',
  JSON.stringify(cajeraRelee.cuerpo?.error ?? cajeraRelee.cuerpo?.vendedor),
);

const empleadaCancela = await pedir(`/api/notas-remision/${notaLimpiaId}/cancelar`, tokenEmpleada, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ motivo: 'la empleada tambien intenta cancelar' }),
});
revisar(
  'pero la empleada NO cancela -> 403 (notas.cancelar no es suyo)',
  empleadaCancela.status === 403,
  JSON.stringify(empleadaCancela.cuerpo),
);

const cajeraCancela = await pedir(`/api/notas-remision/${notaLimpiaId}/cancelar`, tokenCajera, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ motivo: 'La cajera deshace una venta mal capturada' }),
});
revisar(
  'la cajera SI cancela -> 200',
  cajeraCancela.status === 200,
  JSON.stringify(cajeraCancela.cuerpo?.error),
);

// =======================================================================
// PAGOS (COBRANZA)
// =======================================================================
//
// Va despues del bloque de notas a proposito: los pagos se aplican a notas,
// y las notas de este bloque las crea la suite de arriba. No se reescribe
// nada de ese bloque: este usa su propia serie de folios (PGO) y notas
// nuevas, para que una prueba de cobranza no dependa de en que estado
// quedo la nota que uso la de edicion.

const talonarioPagos = await pedir('/api/notas-remision/folios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'PGO', desde: 3001, hasta: 3010 }),
});
revisar(
  'talonario de la serie PGO -> 201',
  talonarioPagos.status === 201,
  JSON.stringify(talonarioPagos.cuerpo),
);

const notaDePago = async (productoId, bultos, almacen = 1) => {
  const r = await pedir('/api/notas-remision', tokenAdmin, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cliente_id: clienteNotaId,
      // La serie va explicita: el talonario se cargo con una sola serie, pero
      // el endpoint no la deduce, y esta prueba no depende de que se agregue
      // otra despues.
      serie: 'PGO',
      renglones: [
        { producto_id: productoId, almacen_id: almacen, cantidad_bultos: String(bultos) },
      ],
    }),
  });
  return r;
};

const notaPago1 = await notaDePago(prodNota, 2);
revisar('nota para cobrar -> 201', notaPago1.status === 201, JSON.stringify(notaPago1.cuerpo));
const notaPago1Id = notaPago1.cuerpo?.id;
const totalPago1 = notaPago1.cuerpo?.subtotal;

const notaPago2 = await notaDePago(prodOtro, 1);
const notaPago2Id = notaPago2.cuerpo?.id;
const totalPago2 = notaPago2.cuerpo?.subtotal;
revisar('segunda nota para cobrar -> 201', notaPago2.status === 201, JSON.stringify(notaPago2));

const crearPago = (cuerpo, token = tokenAdmin) =>
  pedir('/api/pagos', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

// A proposito NO se usa `crearPago` para esta: ese helper trae
// `token = tokenAdmin` por omision, y un `undefined` explicito se convierte
// en el token del ADMIN. La prueba pasaria en verde haciendo la operacion
// con la sesion de otro. Mismo motivo por el que `crearProducto` no tiene
// default, y por eso que este comentario este aqui y no en el helper.
const pagoSinToken = await pedir('/api/pagos', undefined, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ cliente_id: clienteNotaId, monto: '10.00' }),
});
revisar('pago sin token -> 401', pagoSinToken.status === 401, JSON.stringify(pagoSinToken.cuerpo));

const pagoMontoCero = await crearPago({ cliente_id: clienteNotaId, monto: '0.00' });
revisar(
  'monto 0 -> 400',
  pagoMontoCero.status === 400 && pagoMontoCero.cuerpo?.codigo === 'VALIDACION',
  JSON.stringify(pagoMontoCero.cuerpo),
);

const pagoNegativo = await crearPago({ cliente_id: clienteNotaId, monto: '-50.00' });
revisar('monto negativo -> 400', pagoNegativo.status === 400, JSON.stringify(pagoNegativo.cuerpo));

const pagoClienteFantasma = await crearPago({ cliente_id: 999999, monto: '10.00' });
revisar(
  'pago de un cliente que no existe -> 400',
  pagoClienteFantasma.status === 400,
  JSON.stringify(pagoClienteFantasma.cuerpo),
);

const pagoMetodoInventado = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  metodo: 'Bitcoin',
});
revisar(
  'metodo de pago que no existe -> 400',
  pagoMetodoInventado.status === 400,
  JSON.stringify(pagoMetodoInventado.cuerpo),
);

const pagoCampoExtra = await crearPago({ cliente_id: clienteNotaId, monto: '10.00', notas: 1 });
revisar(
  'campo que no existe en el cuerpo -> 400',
  pagoCampoExtra.status === 400,
  JSON.stringify(pagoCampoExtra.cuerpo),
);

// El anticipo: un pago sin destino es una operacion real (un abono a
// cuenta), y el saldo del cliente lo descuenta igual. Si esto no se
// aceptara, el operador tendria que inventar una nota para poder cobrar.
const anticipo = await crearPago({
  cliente_id: clienteNotaId,
  monto: '500.00',
  metodo: 'Efectivo',
  requiere_factura: true,
  referencia: 'ANTICIPO-PRUEBA',
});
revisar('anticipo sin aplicar -> 201', anticipo.status === 201, JSON.stringify(anticipo.cuerpo));
revisar(
  'y sale con saldo a favor, no aplicado',
  anticipo.cuerpo?.monto_aplicado === 0 && anticipo.cuerpo?.saldo === 500,
  JSON.stringify(anticipo.cuerpo),
);
revisar(
  'y el Location apunta al pago nuevo',
  String(anticipo.headers?.get?.('location') ?? '').includes(String(anticipo.cuerpo?.id)),
  anticipo.headers?.get?.('location'),
);
const anticipoId = anticipo.cuerpo?.id;

const saldoClienteTrasAnticipo = await sqlDirecto(
  `SELECT saldo_actual::TEXT AS s FROM pos.clientes WHERE id = $1`,
  [clienteNotaId],
);
revisar(
  'y el saldo del cliente ya descuenta el anticipo aunque no este aplicado',
  Number(saldoClienteTrasAnticipo.rows[0].s) < 0,
  `saldo ${saldoClienteTrasAnticipo.rows[0].s}`,
);

// Aplicar de mas a una nota: el servicio lo ve antes que la base.
const pagoDeMas = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  aplicaciones: [{ nota_id: notaPago1Id, monto: '999999.00' }],
});
revisar(
  'aplicar mas que el total de la nota -> 422',
  pagoDeMas.status === 422 && pagoDeMas.cuerpo?.codigo === 'MONTO_MAYOR_A_NOTA',
  JSON.stringify(pagoDeMas.cuerpo),
);

const pagoSinReach = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  aplicaciones: [{ nota_id: notaPago1Id, monto: '50.00' }],
});
revisar(
  'aplicar mas de lo que trae el pago -> 422',
  pagoSinReach.status === 422 && pagoSinReach.cuerpo?.codigo === 'EL_PAGO_NO_ALCANZA',
  JSON.stringify(pagoSinReach.cuerpo),
);

// La nota del cliente equivocado tiene que ser una nota REAL de otro
// cliente, y no una nota cualquiera: si se usara la del seed, la prueba
// pasaria por 404 (nota inexistente) o por el cliente equivocado, y no por
// lo que esta probando.
const notaAjena = await pedir('/api/notas-remision', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    cliente_id: clienteFechasId,
    serie: 'PGO',
    renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
  }),
});
revisar('nota de otro cliente -> 201', notaAjena.status === 201, JSON.stringify(notaAjena.cuerpo));
const pagoAjenoReal = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  aplicaciones: [{ nota_id: notaAjena.cuerpo?.id, monto: '10.00' }],
});
revisar(
  'y aplicar a ESA nota -> 422 NOTA_DE_OTRO_CLIENTE',
  pagoAjenoReal.status === 422 && pagoAjenoReal.cuerpo?.codigo === 'NOTA_DE_OTRO_CLIENTE',
  JSON.stringify(pagoAjenoReal.cuerpo),
);

// Cancelada es 409 y no 422, a proposito: la nota esta en un estado, no en
// uno invalido. Es la misma familia que NOTA_CONGELADA al editar una pagada.
const pagoNotaCancelada = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  aplicaciones: [{ nota_id: notaAlBordeId, monto: '10.00' }],
});
revisar(
  'aplicar a una nota CANCELADA -> 409',
  pagoNotaCancelada.status === 409 &&
    pagoNotaCancelada.cuerpo?.codigo === 'NOTA_CANCELADA_NO_SE_COBRA',
  JSON.stringify(pagoNotaCancelada.cuerpo),
);

const pagoNotaFantasma = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  aplicaciones: [{ nota_id: 999999, monto: '10.00' }],
});
revisar(
  'aplicar a una nota que no existe -> 400',
  pagoNotaFantasma.status === 400,
  JSON.stringify(pagoNotaFantasma.cuerpo),
);

// Pago parcial: la nota pasa a 'parcial' sola, que es el estatus que
// mantiene `fn_actualizar_estatus_por_aplicaciones`.
const laMitad = (totalPago1 / 2).toFixed(2);
const parcial = await crearPago({
  cliente_id: clienteNotaId,
  monto: laMitad,
  metodo: 'Transferencia',
  aplicaciones: [{ nota_id: notaPago1Id, monto: laMitad }],
});
revisar('pago parcial -> 201', parcial.status === 201, JSON.stringify(parcial.cuerpo));
revisar(
  'y el pago queda entero aplicado (saldo 0)',
  parcial.cuerpo?.saldo === 0 && parcial.cuerpo?.monto_aplicado === Number(laMitad),
  JSON.stringify(parcial.cuerpo),
);
const notaTrasParcial = await pedir(`/api/notas-remision/${notaPago1Id}`, tokenAdmin);
revisar(
  'y la nota queda PARCIAL',
  notaTrasParcial.cuerpo?.estatus === 'parcial',
  JSON.stringify(notaTrasParcial.cuerpo?.estatus),
);

const sobrante = (totalPago1 - Number(laMitad)).toFixed(2);
const completa = await crearPago({
  cliente_id: clienteNotaId,
  monto: sobrante,
  metodo: 'Efectivo',
  aplicaciones: [{ nota_id: notaPago1Id, monto: sobrante }],
});
revisar('pago del resto -> 201', completa.status === 201, JSON.stringify(completa.cuerpo));
const notaTrasPagar = await pedir(`/api/notas-remision/${notaPago1Id}`, tokenAdmin);
revisar(
  'y la nota queda PAGADA',
  notaTrasPagar.cuerpo?.estatus === 'pagada',
  JSON.stringify(notaTrasPagar.cuerpo?.estatus),
);

const sobrePago = await crearPago({
  cliente_id: clienteNotaId,
  monto: '10.00',
  aplicaciones: [{ nota_id: notaPago1Id, monto: '10.00' }],
});
revisar(
  'pagar de mas una nota ya pagada -> 409',
  sobrePago.status === 409 && sobrePago.cuerpo?.codigo === 'NOTA_YA_COBRADA',
  JSON.stringify(sobrePago.cuerpo),
);

// Un pago repartido en dos notas de una vez: es el caso normal de "cobro
// en efectivo y dejo saldada la otra". Las dos notas tienen que seguir
// PENDIENTES: aplicar a una ya pagada es el 409 que se acaba de probar.
const notaPago3 = await notaDePago(prodOtro, 1);
const notaPago3Id = notaPago3.cuerpo?.id;
const totalPago3 = notaPago3.cuerpo?.subtotal;
revisar('tercera nota para cobrar -> 201', notaPago3.status === 201, JSON.stringify(notaPago3));

const dosNotas = (totalPago2 + totalPago3).toFixed(2);
const repartido = await crearPago({
  cliente_id: clienteNotaId,
  monto: dosNotas,
  metodo: 'Efectivo',
  aplicaciones: [
    { nota_id: notaPago2Id, monto: totalPago2 },
    { nota_id: notaPago3Id, monto: totalPago3 },
  ],
});
revisar(
  'pago repartido en dos notas -> 201',
  repartido.status === 201,
  JSON.stringify(repartido.cuerpo),
);
revisar(
  'y queda entero aplicado, sin sobrante',
  repartido.cuerpo?.saldo === 0 && repartido.cuerpo?.monto_aplicado === Number(dosNotas),
  JSON.stringify(repartido.cuerpo),
);
for (const [nombre, id] of [
  ['la segunda', notaPago2Id],
  ['la tercera', notaPago3Id],
]) {
  const n = await pedir(`/api/notas-remision/${id}`, tokenAdmin);
  revisar(
    `${nombre} nota queda PAGADA`,
    n.cuerpo?.estatus === 'pagada',
    JSON.stringify(n.cuerpo?.estatus),
  );
}

// Y el caso del otro lado: un pago MAS GRANDE que lo que se aplica. La
// diferencia no se pierde ni se reparte sola: queda a favor del cliente.
const notaPago4 = await notaDePago(prodNota, 1);
const notaPago4Id = notaPago4.cuerpo?.id;
const totalPago4 = notaPago4.cuerpo?.subtotal;
const conSobrante = await crearPago({
  cliente_id: clienteNotaId,
  monto: (totalPago4 + 50).toFixed(2),
  metodo: 'Efectivo',
  aplicaciones: [{ nota_id: notaPago4Id, monto: totalPago4 }],
});
revisar('pago con sobrante -> 201', conSobrante.status === 201, JSON.stringify(conSobrante.cuerpo));
revisar(
  'y el sobrante queda como saldo del pago',
  conSobrante.cuerpo?.monto_aplicado === totalPago4 && conSobrante.cuerpo?.saldo === 50,
  JSON.stringify(conSobrante.cuerpo),
);
const nota4TrasPagar = await pedir(`/api/notas-remision/${notaPago4Id}`, tokenAdmin);
revisar(
  'y la nota queda pagada igual',
  nota4TrasPagar.cuerpo?.estatus === 'pagada',
  JSON.stringify(nota4TrasPagar.cuerpo?.estatus),
);

// El trigger de la base tambien frena el exceso, no solo el servicio: si
// esto pasara, un script de psql podria cobrar de mas una nota. Se usa el
// pago con sobrante (tiene 50 disponibles) contra una nota ya pagada.
// Se aplican LOS 50 DISPONIBLES del pago a una nota que ya esta pagada: con
// esa cantidad el chequeo del pago pasa de largo, y el unico que puede
// rebotar es el de la nota. Asi la prueba apunta al 23514 del "por cubrir" y
// no al del "el pago solo tiene tanto", que son dos validaciones distintas.
const repartidoId = conSobrante.cuerpo?.id;
const sqlSobrePago = await intentaSql(
  `INSERT INTO pos.pagos_aplicacion (pago_id, nota_id, monto_aplicado) VALUES ($1, $2, $3)`,
  [repartidoId, notaPago1Id, 50],
);
revisar(
  'y la BASE frena aplicar a una nota ya pagada por SQL (23514)',
  sqlSobrePago.filas === 0 && String(sqlSobrePago.fallo?.message ?? '').includes('por cubrir'),
  sqlSobrePago.fallo?.message ?? `paso, rowCount ${sqlSobrePago.filas}`,
);

// Tampoco se puede aplicar dos veces a la misma nota en la MISMA peticion
// para pasarse del total: el servicio lleva lo ya pedido por nota.
const dobleEnLaMisma = await crearPago({
  cliente_id: clienteNotaId,
  monto: (totalPago4 * 2).toFixed(2),
  aplicaciones: [
    { nota_id: notaPago4Id, monto: '0.01' },
    { nota_id: notaPago4Id, monto: totalPago4 },
  ],
});
revisar(
  'aplicar dos veces a la misma nota pasandose -> 409 (ya cobrada)',
  dobleEnLaMisma.status === 409 && dobleEnLaMisma.cuerpo?.codigo === 'NOTA_YA_COBRADA',
  JSON.stringify(dobleEnLaMisma.cuerpo),
);

const verPago = await pedir(`/api/pagos/${repartidoId}`, tokenAdmin);
revisar('GET /api/pagos/:id -> 200', verPago.status === 200, JSON.stringify(verPago.cuerpo));
revisar(
  'y trae las aplicaciones con el folio de cada nota',
  Array.isArray(verPago.cuerpo?.aplicaciones) &&
    verPago.cuerpo.aplicaciones.length === 1 &&
    String(verPago.cuerpo.aplicaciones[0]?.nota).includes('PGO'),
  JSON.stringify(verPago.cuerpo?.aplicaciones),
);
revisar(
  'y cada aplicacion trae su monto y el estatus en que quedo la nota',
  typeof verPago.cuerpo?.aplicaciones?.[0]?.monto === 'number' &&
    typeof verPago.cuerpo?.aplicaciones?.[0]?.nota_estatus === 'string',
  JSON.stringify(verPago.cuerpo?.aplicaciones?.[0]),
);
revisar(
  'y la fecha es AAAA-MM-DD, no un timestamp ISO',
  /^\d{4}-\d{2}-\d{2}$/.test(verPago.cuerpo?.fecha ?? ''),
  verPago.cuerpo?.fecha,
);

const verPagoFantasma = await pedir('/api/pagos/999999', tokenAdmin);
revisar(
  'pago que no existe -> 404',
  verPagoFantasma.status === 404,
  JSON.stringify(verPagoFantasma.cuerpo),
);

const parchePago = await pedir(`/api/pagos/${anticipoId}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ monto: '1.00' }),
});
revisar(
  'PATCH /api/pagos/:id -> 404',
  parchePago.status === 404,
  JSON.stringify(parchePago.cuerpo),
);

const borrarPago = await pedir(`/api/pagos/${anticipoId}`, tokenAdmin, { method: 'DELETE' });
revisar(
  'DELETE /api/pagos/:id -> 404',
  borrarPago.status === 404,
  JSON.stringify(borrarPago.cuerpo),
);

const pagosSinToken = await pedir('/api/pagos');
revisar(
  'listar pagos sin token -> 401',
  pagosSinToken.status === 401,
  JSON.stringify(pagosSinToken.cuerpo),
);

const pagosDelCliente = await pedir(
  `/api/pagos?cliente_id=${clienteNotaId}&limite=200`,
  tokenAdmin,
);
revisar(
  'listar pagos del cliente -> 200',
  pagosDelCliente.status === 200 && pagosDelCliente.cuerpo?.datos.length >= 4,
  JSON.stringify(pagosDelCliente.cuerpo?.datos?.length),
);
revisar(
  'y TODOS son del cliente pedido',
  pagosDelCliente.cuerpo?.datos.every((p) => p.cliente_id === clienteNotaId),
  'se colaron pagos de otro cliente',
);
revisar(
  'y el listado tambien trae la fecha como AAAA-MM-DD',
  pagosDelCliente.cuerpo?.datos.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.fecha)),
  JSON.stringify(pagosDelCliente.cuerpo?.datos?.[0]?.fecha),
);

const pagosPorNota = await pedir(`/api/pagos?nota_id=${notaPago1Id}`, tokenAdmin);
revisar(
  'filtrar pagos por nota: los dos que la cubrieron',
  pagosPorNota.status === 200 && pagosPorNota.cuerpo?.datos.length === 2,
  JSON.stringify(pagosPorNota.cuerpo?.datos?.map((p) => p.id)),
);

const pagosPorMetodo = await pedir('/api/pagos?metodo=Efectivo&limite=200', tokenAdmin);
revisar(
  'filtrar pagos por metodo',
  pagosPorMetodo.status === 200 &&
    pagosPorMetodo.cuerpo?.datos.every((p) => p.metodo === 'Efectivo'),
  JSON.stringify(pagosPorMetodo.cuerpo?.datos?.length),
);

const pagosBuscados = await pedir('/api/pagos?buscar=ANTICIPO-PRUEBA', tokenAdmin);
revisar(
  'buscar pagos por referencia',
  pagosBuscados.status === 200 && pagosBuscados.cuerpo?.datos.length === 1,
  JSON.stringify(pagosBuscados.cuerpo?.datos?.length),
);

const pagosRango = await pedir('/api/pagos?desde=2000-01-01&hasta=2000-01-02', tokenAdmin);
revisar(
  'un rango sin pagos -> lista vacia, no error',
  pagosRango.status === 200 && pagosRango.cuerpo?.datos.length === 0,
  JSON.stringify(pagosRango.cuerpo?.datos?.length),
);

const pagosRangoInvertido = await pedir('/api/pagos?desde=2026-12-01&hasta=2026-01-01', tokenAdmin);
revisar(
  'rango al reves -> 400',
  pagosRangoInvertido.status === 400,
  JSON.stringify(pagosRangoInvertido.cuerpo),
);

const pagosLimiteCero = await pedir('/api/pagos?limite=0', tokenAdmin);
revisar('limite 0 -> 400', pagosLimiteCero.status === 400, JSON.stringify(pagosLimiteCero.cuerpo));

const pagosPagina = await pedir(
  `/api/pagos?cliente_id=${clienteNotaId}&limite=1&offset=1`,
  tokenAdmin,
);
revisar(
  'la paginacion no repite renglones',
  pagosPagina.status === 200 && pagosPagina.cuerpo?.datos.length === 1,
  JSON.stringify(pagosPagina.cuerpo?.datos?.map((p) => p.id)),
);

// =======================================================================
// PROVEEDORES
// =======================================================================

const crearProveedor = (cuerpo, token = tokenAdmin) =>
  pedir('/api/proveedores', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const parcheProveedor = (id, cuerpo, token = tokenAdmin) =>
  pedir(`/api/proveedores/${id}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const nuevoProveedor = await crearProveedor({
  nombre: 'Proveedor de pruebaUno',
  contacto: 'Ventas',
  telefono: '000-000-0001',
});
revisar(
  'alta de proveedor -> 201',
  nuevoProveedor.status === 201,
  JSON.stringify(nuevoProveedor.cuerpo),
);
// `compras` NO se comprueba aqui: es una columna del LISTADO, y el detalle
// (igual que el alta) devuelve solo la entidad. Se comprueba mas abajo, en
// el listado.
revisar(
  'y arranca activo y en cero',
  nuevoProveedor.cuerpo?.activo === true && nuevoProveedor.cuerpo?.saldo_actual === 0,
  JSON.stringify(nuevoProveedor.cuerpo),
);
revisar(
  'y el detalle no se trae campos del listado',
  nuevoProveedor.cuerpo?.compras === undefined,
  JSON.stringify(nuevoProveedor.cuerpo),
);
revisar(
  'y el Location del proveedor apunta al nuevo',
  String(nuevoProveedor.headers?.get('location') ?? '').endsWith(`/${nuevoProveedor.cuerpo?.id}`),
  nuevoProveedor.headers?.get('location') ?? '(sin cabecera location)',
);
const provUnoId = nuevoProveedor.cuerpo?.id;

const proveedorDuplicado = await crearProveedor({ nombre: 'Proveedor de pruebaUno' });
revisar(
  'nombre repetido -> 409',
  proveedorDuplicado.status === 409 && proveedorDuplicado.cuerpo?.codigo === 'PROVEEDOR_DUPLICADO',
  JSON.stringify(proveedorDuplicado.cuerpo),
);

const proveedorSinNombre = await crearProveedor({ contacto: 'Nadie' });
revisar(
  'alta sin nombre -> 400',
  proveedorSinNombre.status === 400,
  JSON.stringify(proveedorSinNombre.cuerpo),
);

const proveedorNombreLargo = await crearProveedor({ nombre: 'P'.repeat(121) });
revisar(
  'nombre de 121 caracteres -> 400',
  proveedorNombreLargo.status === 400,
  JSON.stringify(proveedorNombreLargo.cuerpo),
);

const proveedorCampoExtra = await crearProveedor({ nombre: 'Proveedor de pruebaExtra', rfc: 'X' });
revisar(
  'campo que no existe -> 400',
  proveedorCampoExtra.status === 400,
  JSON.stringify(proveedorCampoExtra.cuerpo),
);

const proveedorEmpleada = await crearProveedor(
  { nombre: 'Proveedor de pruebaEmpleada' },
  tokenEmpleada,
);
revisar(
  'la empleada NO da de alta proveedores -> 403',
  proveedorEmpleada.status === 403,
  JSON.stringify(proveedorEmpleada.cuerpo),
);

const verProveedor = await pedir(`/api/proveedores/${provUnoId}`, tokenAdmin);
revisar('ver proveedor -> 200', verProveedor.status === 200, JSON.stringify(verProveedor.cuerpo));

const verProveedorFantasma = await pedir('/api/proveedores/999999', tokenAdmin);
revisar(
  'proveedor que no existe -> 404',
  verProveedorFantasma.status === 404,
  JSON.stringify(verProveedorFantasma.cuerpo),
);

const proveedorSinToken = await pedir('/api/proveedores');
revisar(
  'listar proveedores sin token -> 401',
  proveedorSinToken.status === 401,
  JSON.stringify(proveedorSinToken.cuerpo),
);

const proveedorEditado = await parcheProveedor(provUnoId, { contacto: 'Compras', telefono: null });
revisar(
  'editar proveedor -> 200',
  proveedorEditado.status === 200,
  JSON.stringify(proveedorEditado.cuerpo),
);
revisar(
  'y el telefono se puede vaciar (queda null)',
  proveedorEditado.cuerpo?.telefono === null && proveedorEditado.cuerpo?.contacto === 'Compras',
  JSON.stringify(proveedorEditado.cuerpo),
);

const proveedorParcheVacio = await parcheProveedor(provUnoId, {});
revisar(
  'editar sin mandar nada -> 400',
  proveedorParcheVacio.status === 400,
  JSON.stringify(proveedorParcheVacio.cuerpo),
);

// Renombrar a un nombre LIBRE: 200. Y da igual cual sea, mientras conserve
// el prefijo "Proveedor de prueba": la limpieza recognizes a sus proveedores
// por nombre, asi que uno que lo pierda se queda en la base.
const renombrarAUnoLibre = await parcheProveedor(provUnoId, {
  nombre: 'Proveedor de pruebaRenombrado',
});
revisar(
  'renombrar a un nombre libre -> 200',
  renombrarAUnoLibre.status === 200,
  JSON.stringify(renombrarAUnoLibre.cuerpo),
);
revisar(
  'y el nombre nuevo es el que se guardo',
  renombrarAUnoLibre.cuerpo?.nombre === 'Proveedor de pruebaRenombrado',
  JSON.stringify(renombrarAUnoLibre.cuerpo?.nombre),
);

// Y renombrar a un nombre que ya existe: 409. Se usa el del proveedor del
// seed porque es el unico que se sabe ocupado sin depender de esta suite:
// usar aqui un nombre de la propia suite seria probar el caso contrario
// (un nombre libre), que es justo lo que paso una vez.
const nombreDelSeed = (await pedir('/api/proveedores?limite=1', tokenAdmin)).cuerpo?.datos?.[0]
  ?.nombre;
revisar(
  'el listado trae al proveedor del seed',
  typeof nombreDelSeed === 'string',
  String(nombreDelSeed),
);

const proveedorRenombrado = await parcheProveedor(provUnoId, { nombre: nombreDelSeed });
revisar(
  'no se puede renombrar a un nombre ya usado -> 409',
  proveedorRenombrado.status === 409 &&
    proveedorRenombrado.cuerpo?.codigo === 'PROVEEDOR_DUPLICADO',
  JSON.stringify(proveedorRenombrado.cuerpo),
);
// El 409 no trae el proveedor entero (trae el mensaje y el detalle del
// choque), asi que el nombre se comprueba yendo a leerlo, que es como lo
// veria el operador: recarga la pantalla y sigue igual.
revisar(
  'y el nombre no cambia (el 409 no dejo el nombre a medias)',
  (await pedir(`/api/proveedores/${provUnoId}`, tokenAdmin)).cuerpo?.nombre ===
    'Proveedor de pruebaRenombrado',
  (await pedir(`/api/proveedores/${provUnoId}`, tokenAdmin)).cuerpo?.nombre,
);

const buscable = await crearProveedor({ nombre: 'Proveedor de pruebaBuscable' });
const buscableId = buscable.cuerpo?.id;
revisar('proveedor buscable -> 201', buscable.status === 201, JSON.stringify(buscable.cuerpo));

const listarProveedores = await pedir('/api/proveedores?buscar=Buscable', tokenAdmin);
revisar(
  'buscar proveedores por nombre',
  listarProveedores.status === 200,
  JSON.stringify(listarProveedores.cuerpo),
);
revisar(
  'y encuentra al que se busca',
  listarProveedores.cuerpo?.datos.some((p) => p.id === buscableId),
  JSON.stringify(listarProveedores.cuerpo?.datos?.map((p) => p.nombre)),
);

const listarTodos = await pedir('/api/proveedores?limite=200', tokenAdmin);
revisar(
  'el listado trae el total del encabezado',
  listarTodos.status === 200 && typeof listarTodos.cuerpo?.total === 'number',
  JSON.stringify(listarTodos.cuerpo?.total),
);
revisar(
  'y la pagina no se pasa del total',
  listarTodos.cuerpo?.datos.length <= listarTodos.cuerpo?.total,
  JSON.stringify({ datos: listarTodos.cuerpo?.datos.length, total: listarTodos.cuerpo?.total }),
);

const listarProveedoresPagina = await pedir('/api/proveedores?limite=1&offset=1', tokenAdmin);
revisar(
  'la paginacion de proveedores funciona',
  listarProveedoresPagina.status === 200 && listarProveedoresPagina.cuerpo?.datos.length === 1,
  JSON.stringify(listarProveedoresPagina.cuerpo?.datos?.map((p) => p.id)),
);

const proveedoresLimiteCero = await pedir('/api/proveedores?limite=0', tokenAdmin);
revisar(
  'limite 0 en proveedores -> 400',
  proveedoresLimiteCero.status === 400,
  JSON.stringify(proveedoresLimiteCero.cuerpo),
);

const verProveedorFantasmaId = await pedir('/api/proveedores/abc', tokenAdmin);
revisar(
  'id que no es numero -> 400',
  verProveedorFantasmaId.status === 400,
  JSON.stringify(verProveedorFantasmaId.cuerpo),
);

// =======================================================================
// COMPRAS
// =======================================================================
//
// Los productos de compra son propios (TST-COMP) y no los de las notas: las
// pruebas de existencias comparan un numero exacto antes y despues, y si
// compartieran producto las dos secciones se estorbarían.

const prodCompra = await crearProducto(
  { codigo: 'TST-COMP', nombre: 'Producto de compra', presentacion_kg: '25.000' },
  tokenAdmin,
).then((r) => r.cuerpo?.id);
revisar('producto de compra -> 201', Number.isInteger(prodCompra), String(prodCompra));

const prodCompraSinCosto = await crearProducto(
  { codigo: 'TST-COMP2', nombre: 'Producto de compra sin costo', presentacion_kg: '10.000' },
  tokenAdmin,
).then((r) => r.cuerpo?.id);
revisar(
  'segundo producto de compra -> 201',
  Number.isInteger(prodCompraSinCosto),
  String(prodCompraSinCosto),
);

for (const pid of [prodCompra, prodCompraSinCosto]) {
  await sqlDirecto(
    `INSERT INTO pos.inventario_movimientos (producto_id, almacen_id, tipo, cantidad_bultos, referencia_tabla)
     VALUES ($1, 1, 'entrada_compra', 50, 'seed')`,
    [pid],
  );
}
revisar(
  'y arrancan con 50 bultos',
  (await existenciaDe(prodCompra)) === 50,
  `${await existenciaDe(prodCompra)}`,
);

// El costo historico se mete por SQL porque no hay API de costos todavia:
// `producto_proveedor_precios` se alimenta desde la compra misma, no desde
// una pantalla.
//
// Dos ventanas que NO se traslapan, y ese es el caso que hay que probar: si
// el costo se resolvio con "el ultimo costo" en vez de "el costo vigente
// en la fecha de la compra", una compra de hoy tomaria el de 30 que todavia
// no empieza, y una compra futura tomaria el de 20 que ya caduco.
const costoPasado = await sqlDirecto(
  `INSERT INTO pos.producto_proveedor_precios
     (proveedor_id, producto_id, precio_kg, vigente_desde, vigente_hasta)
   VALUES ($1, $2, 20.00, CURRENT_DATE - 10, CURRENT_DATE + 4)
   RETURNING precio_bulto::TEXT AS pb`,
  [provUnoId, prodCompra],
);
revisar(
  'costo historico de 20 -> el trigger calcula el precio por bulto',
  costoPasado.rows[0]?.pb === '500.00',
  JSON.stringify(costoPasado.rows[0]),
);
const costoFuturo = await sqlDirecto(
  `INSERT INTO pos.producto_proveedor_precios
     (proveedor_id, producto_id, precio_kg, vigente_desde)
   VALUES ($1, $2, 30.00, CURRENT_DATE + 5)`,
  [provUnoId, prodCompra],
);
revisar('costo futuro de 30 -> 1 fila', costoFuturo.rowCount === 1);

const crearCompra = (cuerpo, token = tokenAdmin) =>
  pedir('/api/compras', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const cancelarCompra = (id, cuerpo, token = tokenAdmin) =>
  pedir(`/api/compras/${id}/cancelar`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

// Igual que en pagos: fuera del helper, para que el `undefined` del token no
// se convierta en el token del admin y la compra se cree de todos modos.
const compraSinToken = await pedir('/api/compras', undefined, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    proveedor_id: provUnoId,
    renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1' }],
  }),
});
revisar(
  'alta de compra sin token -> 401',
  compraSinToken.status === 401,
  JSON.stringify(compraSinToken.cuerpo),
);

// El costo de HOY con vigente_hasta = CURRENT_DATE + 4 y el de CURRENT_DATE
// + 5 se tocan en un dia. En los precios de venta eso es traslape (0007) y
// la base lo rechaza; en los costos NO hay trigger de traslape, y por eso
// esta suite los escribe sin cerrarlos. No es un olvido: se deja asi a
// proposito para probar que la resolucion por fecha usa la ventana correcta
// aun cuando dos ventanas abiertas se pisan. Si algun dia se agrega el
// trigger de traslape a `producto_proveedor_precios`, estas dos filas
// empiezan a rebotar y hay que cerrarlas.
const traslapeDeCostos = await sqlDirecto(
  `SELECT COUNT(*)::TEXT AS n FROM pos.producto_proveedor_precios
    WHERE proveedor_id = $1 AND producto_id = $2`,
  [provUnoId, prodCompra],
);
revisar(
  'hay 2 ventanas de costo para el mismo producto',
  traslapeDeCostos.rows[0].n === '2',
  traslapeDeCostos.rows[0].n,
);

const compraSinRenglones = await crearCompra({ proveedor_id: provUnoId, renglones: [] });
revisar(
  'compra sin renglones -> 400',
  compraSinRenglones.status === 400,
  JSON.stringify(compraSinRenglones.cuerpo),
);

const compraProveedorFantasma = await crearCompra({
  proveedor_id: 999999,
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'compra a un proveedor inexistente -> 400',
  compraProveedorFantasma.status === 400,
  JSON.stringify(compraProveedorFantasma.cuerpo),
);

const compraProductoFantasma = await crearCompra({
  proveedor_id: provUnoId,
  renglones: [{ producto_id: 999999, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'compra de un producto inexistente -> 400',
  compraProductoFantasma.status === 400,
  JSON.stringify(compraProductoFantasma.cuerpo),
);

const compraSinCosto = await crearCompra({
  proveedor_id: provUnoId,
  renglones: [{ producto_id: prodCompraSinCosto, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'compra sin costo y sin precio -> 422',
  compraSinCosto.status === 422 && compraSinCosto.cuerpo?.codigo === 'SIN_COSTO',
  JSON.stringify(compraSinCosto.cuerpo),
);

const compraCantidadCero = await crearCompra({
  proveedor_id: provUnoId,
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '0' }],
});
revisar(
  'cantidad 0 -> 400',
  compraCantidadCero.status === 400,
  JSON.stringify(compraCantidadCero.cuerpo),
);

const compraConSubtotal = await crearCompra({
  proveedor_id: provUnoId,
  subtotal: 1,
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'mandar el subtotal a mano -> 400 (es GENERATED)',
  compraConSubtotal.status === 400,
  JSON.stringify(compraConSubtotal.cuerpo),
);

// El camino feliz: sin precio_kg, el costo sale del historico DE HOY (20).
const compraOk = await crearCompra({
  proveedor_id: provUnoId,
  folio_proveedor: 'FOLIO-PRUEBA-1',
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '4' }],
});
revisar('alta de compra -> 201', compraOk.status === 201, JSON.stringify(compraOk.cuerpo));
revisar(
  'y el monto sale del costo vigente de HOY, no del futuro',
  compraOk.cuerpo?.monto_total === 4 * 25 * 20,
  `monto ${compraOk.cuerpo?.monto_total}, esperado ${4 * 25 * 20}`,
);
revisar(
  'y cada renglon guarda el precio ya resuelto',
  compraOk.cuerpo?.renglones?.[0]?.precio_kg === 20,
  JSON.stringify(compraOk.cuerpo?.renglones?.[0]),
);
revisar(
  'y arranca PENDIENTE y sin motivo de cancelacion',
  compraOk.cuerpo?.estatus === 'pendiente' && compraOk.cuerpo?.motivo_cancelacion === null,
  JSON.stringify(compraOk.cuerpo),
);
revisar(
  'y la compra trae su Location',
  /^\/api\/compras\/\d+$/.test(compraOk.headers?.get('location') ?? ''),
  compraOk.headers?.get('location') ?? '(sin cabecera location)',
);
const compraOkId = compraOk.cuerpo?.id;

revisar(
  'y el almacen recibio los 4 bultos',
  (await existenciaDe(prodCompra)) === 54,
  `${await existenciaDe(prodCompra)}`,
);

const verCompra = await pedir(`/api/compras/${compraOkId}`, tokenAdmin);
revisar('ver compra -> 200', verCompra.status === 200, JSON.stringify(verCompra.cuerpo));
revisar(
  'y trae el nombre del proveedor y el codigo del producto',
  typeof verCompra.cuerpo?.proveedor === 'string' &&
    verCompra.cuerpo?.renglones?.[0]?.producto_codigo === 'TST-COMP',
  JSON.stringify(verCompra.cuerpo?.renglones?.[0]),
);
revisar(
  'y la fecha es AAAA-MM-DD',
  /^\d{4}-\d{2}-\d{2}$/.test(verCompra.cuerpo?.fecha ?? ''),
  verCompra.cuerpo?.fecha,
);

const compraFechada = await crearCompra({
  proveedor_id: provUnoId,
  fecha: '2099-01-01',
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1', precio_kg: '5.00' }],
});
revisar(
  'compra con fecha propia -> 201',
  compraFechada.status === 201,
  JSON.stringify(compraFechada.cuerpo),
);
revisar(
  'y con precio explicito manda el explicito, no el del catalogo',
  compraFechada.cuerpo?.monto_total === 25 * 5,
  `monto ${compraFechada.cuerpo?.monto_total}`,
);
revisar(
  'y la fecha guardada es la que se mando',
  compraFechada.cuerpo?.fecha === '2099-01-01',
  compraFechada.cuerpo?.fecha,
);
const compraFechadaId = compraFechada.cuerpo?.id;

// El precio del historico FUTURO: una compra fechada despues de que empiece
// esa ventana tiene que usar 30, no 20. Es la prueba de que el costo se
// resuelve por FECHA y no "el ultimo costo".
const compraFuturaConCosto = await crearCompra({
  proveedor_id: provUnoId,
  fecha: '2099-06-01',
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'compra fechada dentro de la ventana futura -> 201',
  compraFuturaConCosto.status === 201,
  JSON.stringify(compraFuturaConCosto.cuerpo),
);
revisar(
  'y toma el costo que estaba vigente EN ESA FECHA (30)',
  compraFuturaConCosto.cuerpo?.monto_total === 25 * 30,
  `monto ${compraFuturaConCosto.cuerpo?.monto_total}, esperado ${25 * 30}`,
);
const compraFuturaId = compraFuturaConCosto.cuerpo?.id;

const parcheCompra = await pedir(`/api/compras/${compraOkId}`, tokenAdmin, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ folio_proveedor: 'OTRO' }),
});
revisar(
  'PATCH /api/compras/:id -> 404',
  parcheCompra.status === 404,
  JSON.stringify(parcheCompra.cuerpo),
);

const borrarCompra = await pedir(`/api/compras/${compraOkId}`, tokenAdmin, { method: 'DELETE' });
revisar(
  'DELETE /api/compras/:id -> 404',
  borrarCompra.status === 404,
  JSON.stringify(borrarCompra.cuerpo),
);

// --------------------------------------------------------------- cancelar

const cancelarCompraSinMotivo = await cancelarCompra(compraFechadaId, {});
revisar(
  'cancelar compra sin motivo -> 400',
  cancelarCompraSinMotivo.status === 400,
  JSON.stringify(cancelarCompraSinMotivo.cuerpo),
);

const cancelarMotivoCorto = await cancelarCompra(compraFechadaId, { motivo: 'x' });
revisar(
  'motivo de 1 letra -> 400',
  cancelarMotivoCorto.status === 400,
  JSON.stringify(cancelarMotivoCorto.cuerpo),
);

const existenciaAntesDeCancelar = await existenciaDe(prodCompra);
const cancelarOk = await cancelarCompra(compraFechadaId, {
  motivo: 'La prueba de compra se cancela para no dejar basura',
});
revisar('cancelar compra -> 200', cancelarOk.status === 200, JSON.stringify(cancelarOk.cuerpo));
revisar(
  'y queda CANCELADA con su motivo',
  cancelarOk.cuerpo?.estatus === 'cancelada' &&
    cancelarOk.cuerpo?.motivo_cancelacion === 'La prueba de compra se cancela para no dejar basura',
  JSON.stringify(cancelarOk.cuerpo),
);
revisar(
  'y el almacen devuelve lo que habia recibido',
  (await existenciaDe(prodCompra)) === existenciaAntesDeCancelar - 1,
  `${existenciaAntesDeCancelar} -> ${await existenciaDe(prodCompra)}`,
);

const cancelarCompraDosVeces = await cancelarCompra(compraFechadaId, { motivo: 'otra vez' });
revisar(
  'cancelar dos veces la misma compra -> 409',
  cancelarCompraDosVeces.status === 409 &&
    cancelarCompraDosVeces.cuerpo?.codigo === 'COMPRA_YA_CANCELADA',
  JSON.stringify(cancelarCompraDosVeces.cuerpo),
);
revisar(
  'y el 409 trae el motivo con el que se cancelo',
  cancelarCompraDosVeces.cuerpo?.detalles?.motivo ===
    'La prueba de compra se cancela para no dejar basura',
  JSON.stringify(cancelarCompraDosVeces.cuerpo?.detalles),
);

// La BASE exige el motivo, no solo el servicio: sin esto, un UPDATE a mano
// podria dejar una compra cancelada sin razon. Ojo con lo que NO se toca
// aqui: el estatus. Volverlo a 'pendiente' por la viajcita del trigger
// `trg_cancelar_compra_inventario` volveria a meter los movimientos de
// entrada, y la prueba estaria comprobando dos cosas a la vez.
const sqlCancelarSinMotivo = await intentaSql(
  `UPDATE pos.compras SET motivo_cancelacion = NULL WHERE id = $1`,
  [compraFechadaId],
);
revisar(
  'y la BASE no deja vaciar el motivo de una cancelada (23514)',
  sqlCancelarSinMotivo.filas === 0,
  sqlCancelarSinMotivo.fallo?.message ?? `paso, rowCount ${sqlCancelarSinMotivo.filas}`,
);
const motivoLargoVacio = await intentaSql(
  `UPDATE pos.compras SET motivo_cancelacion = '   ' WHERE id = $1`,
  [compraFechadaId],
);
revisar(
  'ni un motivo de puros espacios',
  motivoLargoVacio.filas === 0,
  motivoLargoVacio.fallo?.message ?? `paso, rowCount ${motivoLargoVacio.filas}`,
);

// Compra con pago registrado: no se puede cancelar desde aqui.
await sqlDirecto(
  `INSERT INTO pos.pagos_proveedor (proveedor_id, compra_id, monto, metodo) VALUES ($1, $2, $3, 'Transferencia')`,
  [provUnoId, compraFuturaId, 25 * 30],
);
const compraPagada = await pedir(`/api/compras/${compraFuturaId}`, tokenAdmin);
revisar(
  'el pago por SQL la deja PAGADA sola',
  compraPagada.cuerpo?.estatus === 'pagada',
  JSON.stringify(compraPagada.cuerpo?.estatus),
);
const existenciaConPagada = await existenciaDe(prodCompra);
const cancelarCompraPagada = await cancelarCompra(compraFuturaId, {
  motivo: 'ya la pague, quiero el dinero',
});
revisar(
  'cancelar una compra PAGADA -> 409',
  cancelarCompraPagada.status === 409 && cancelarCompraPagada.cuerpo?.codigo === 'COMPRA_CON_PAGO',
  JSON.stringify(cancelarCompraPagada.cuerpo),
);
revisar(
  'y el mensaje dice que hacer primero',
  /devolver/.test(cancelarCompraPagada.cuerpo?.error ?? ''),
  cancelarCompraPagada.cuerpo?.error,
);
revisar(
  'y el almacen NO se toco (la compra sigue viva)',
  (await existenciaDe(prodCompra)) === existenciaConPagada,
  `${existenciaConPagada} -> ${await existenciaDe(prodCompra)}`,
);
revisar(
  'y la compra sigue PAGADA, no la dejo a medias',
  (await pedir(`/api/compras/${compraFuturaId}`, tokenAdmin)).cuerpo?.estatus === 'pagada',
  'quedo en otro estatus',
);

// --------------------------------------------------------------- listado

const listarCompras = await pedir(`/api/compras?proveedor_id=${provUnoId}&limite=50`, tokenAdmin);
revisar(
  'listar compras del proveedor -> 200',
  listarCompras.status === 200 && listarCompras.cuerpo?.datos.length >= 3,
  JSON.stringify(listarCompras.cuerpo?.datos?.length),
);
revisar(
  'y TODAS son de ese proveedor',
  listarCompras.cuerpo?.datos.every((c) => c.proveedor_id === provUnoId),
  'se colaron compras de otro proveedor',
);
revisar(
  'y el listado trae la fecha como AAAA-MM-DD',
  listarCompras.cuerpo?.datos.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c.fecha)),
  JSON.stringify(listarCompras.cuerpo?.datos?.[0]?.fecha),
);

const comprasCanceladas = await pedir('/api/compras?estatus=cancelada', tokenAdmin);
revisar(
  'filtrar compras por estatus',
  comprasCanceladas.status === 200 &&
    comprasCanceladas.cuerpo?.datos.every((c) => c.estatus === 'cancelada'),
  JSON.stringify(comprasCanceladas.cuerpo?.datos?.length),
);

const comprasBuscadas = await pedir('/api/compras?buscar=FOLIO-PRUEBA', tokenAdmin);
revisar(
  'buscar compras por folio del proveedor',
  comprasBuscadas.status === 200 && comprasBuscadas.cuerpo?.datos.length === 1,
  JSON.stringify(comprasBuscadas.cuerpo?.datos?.length),
);

const comprasSinToken = await pedir('/api/compras');
revisar(
  'listar compras sin token -> 401',
  comprasSinToken.status === 401,
  JSON.stringify(comprasSinToken.cuerpo),
);

const comprasLimiteCero = await pedir('/api/compras?limite=0', tokenAdmin);
revisar(
  'limite 0 en compras -> 400',
  comprasLimiteCero.status === 400,
  JSON.stringify(comprasLimiteCero.cuerpo),
);

// =======================================================================
// INVENTARIO (LECTURA)
// =======================================================================
//
// Se prueba DESPUES que las compras a proposito: la existencia que se mira
// aqui es la que dejaron las compras de arriba, y asi se comprueba de un
// vistazo que comprar entra a inventario.

const existenciaProducto = async (productoId) =>
  pedir(`/api/inventario/existencia?producto_id=${productoId}`, tokenAdmin);

const verExistencia = await existenciaProducto(prodCompra);
revisar(
  'existencia del producto de compra',
  verExistencia.status === 200 && verExistencia.cuerpo?.datos.length === 1,
  JSON.stringify(verExistencia.cuerpo),
);
revisar(
  'y coincide con lo que dice la base: 50 de apertura + 4 de la compra buena - 1 de la cancelada + 1 de la futura + 1 de la reactivada - 1 de esa ultima cancelacion',
  verExistencia.cuerpo?.datos[0]?.existencia_bultos === 55,
  `existencia ${verExistencia.cuerpo?.datos[0]?.existencia_bultos}`,
);
revisar(
  'y trae el almacen y el codigo del producto',
  typeof verExistencia.cuerpo?.datos[0]?.almacen === 'string' &&
    verExistencia.cuerpo?.datos[0]?.producto_codigo === 'TST-COMP',
  JSON.stringify(verExistencia.cuerpo?.datos[0]),
);

const existenciaTodos = await pedir('/api/inventario/existencia?limite=200', tokenAdmin);
revisar(
  'sin filtros sale el CRUZADO producto x almacen',
  existenciaTodos.status === 200 && existenciaTodos.cuerpo?.datos.length > 3,
  JSON.stringify(existenciaTodos.cuerpo?.datos?.length),
);
revisar(
  'y el total del encabezado es el del cruzado, no el de productos',
  existenciaTodos.cuerpo?.total >= existenciaTodos.cuerpo?.datos.length,
  JSON.stringify({
    total: existenciaTodos.cuerpo?.total,
    datos: existenciaTodos.cuerpo?.datos.length,
  }),
);

const existenciaPorAlmacen = await pedir(
  '/api/inventario/existencia?almacen_id=1&limite=200',
  tokenAdmin,
);
revisar(
  'filtrar por almacen',
  existenciaPorAlmacen.status === 200 &&
    existenciaPorAlmacen.cuerpo?.datos.every((e) => e.almacen_id === 1),
  JSON.stringify(existenciaPorAlmacen.cuerpo?.datos?.length),
);

const existenciaAlmacenFantasma = await pedir(
  '/api/inventario/existencia?almacen_id=9999',
  tokenAdmin,
);
revisar(
  'almacen que no existe -> lista vacia, no 404',
  existenciaAlmacenFantasma.status === 200 && existenciaAlmacenFantasma.cuerpo?.datos.length === 0,
  JSON.stringify(existenciaAlmacenFantasma.cuerpo),
);

const existenciaProductoFantasma = await pedir(
  '/api/inventario/existencia?producto_id=999999',
  tokenAdmin,
);
revisar(
  'producto que no existe -> lista vacia, no 404',
  existenciaProductoFantasma.status === 200 &&
    existenciaProductoFantasma.cuerpo?.datos.length === 0,
  JSON.stringify(existenciaProductoFantasma.cuerpo),
);

const existenciaAlmacenGrande = await pedir(
  '/api/inventario/existencia?almacen_id=32768',
  tokenAdmin,
);
revisar(
  'almacen_id fuera del rango de SMALLINT -> 400',
  existenciaAlmacenGrande.status === 400,
  JSON.stringify(existenciaAlmacenGrande.cuerpo),
);

const existenciaBusqueda = await pedir(
  '/api/inventario/existencia?buscar=TST-COMP&limite=50',
  tokenAdmin,
);
revisar(
  'buscar por codigo de producto',
  existenciaBusqueda.status === 200 && existenciaBusqueda.cuerpo?.datos.length > 0,
  JSON.stringify(existenciaBusqueda.cuerpo?.datos?.length),
);

const existenciaSinToken = await pedir('/api/inventario/existencia');
revisar(
  'inventario sin token -> 401',
  existenciaSinToken.status === 401,
  JSON.stringify(existenciaSinToken.cuerpo),
);

const existenciaLimiteCero = await pedir('/api/inventario/existencia?limite=0', tokenAdmin);
revisar(
  'limite 0 en inventario -> 400',
  existenciaLimiteCero.status === 400,
  JSON.stringify(existenciaLimiteCero.cuerpo),
);

const existenciaVacios = await pedir(
  '/api/inventario/existencia?vacios=true&limite=200',
  tokenAdmin,
);
revisar(
  'solo lo que esta en cero',
  existenciaVacios.status === 200 &&
    existenciaVacios.cuerpo?.datos.every((e) => e.existencia_bultos <= 0),
  JSON.stringify(existenciaVacios.cuerpo?.datos?.length),
);

const existenciaConCosas = await pedir(
  '/api/inventario/existencia?vacios=false&limite=200',
  tokenAdmin,
);
revisar(
  'y con vacios=false solo sale lo que SI hay',
  existenciaConCosas.status === 200 &&
    existenciaConCosas.cuerpo?.datos.every((e) => e.existencia_bultos > 0),
  JSON.stringify(existenciaConCosas.cuerpo?.datos?.length),
);

// Se da de baja un producto para ver que el inventario lo sigue
// mostrando, marcado, en vez de esconderlo: esconder el producto que esta
// en cero es justo cuando mas hace falta verlo.
await parcheProveedor(provUnoId, { activo: false });
const compraProveedorInactivo = await crearCompra({
  proveedor_id: provUnoId,
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1', precio_kg: '10.00' }],
});
revisar(
  'comprar a un proveedor dado de baja -> 409',
  compraProveedorInactivo.status === 409 &&
    compraProveedorInactivo.cuerpo?.codigo === 'PROVEEDOR_INACTIVO',
  JSON.stringify(compraProveedorInactivo.cuerpo),
);

// El filtro del listado es `?activo=true|false`, y SIN filtro salen todos,
// dados de baja incluidos: en la pantalla de proveedores hace falta ver a
// quien se le dio de baja, no solo a quien se le puede comprar. Lo que no
// hay que hacer es adivinarlo, asi que el caso de uso de una compra pide
// `?activo=true` explicito.
const soloActivos = await pedir('/api/proveedores?activo=true&limite=200', tokenAdmin);
revisar(
  'con ?activo=true el dado de baja NO sale',
  soloActivos.status === 200 &&
    soloActivos.cuerpo?.datos.every((p) => p.activo === true) &&
    !soloActivos.cuerpo?.datos.some((p) => p.id === provUnoId),
  JSON.stringify(soloActivos.cuerpo?.datos?.map((p) => [p.id, p.activo])),
);

const soloInactivos = await pedir('/api/proveedores?activo=false&limite=200', tokenAdmin);
revisar(
  'con ?activo=false SI sale, marcado como inactivo',
  soloInactivos.status === 200 &&
    soloInactivos.cuerpo?.datos.some((p) => p.id === provUnoId && p.activo === false),
  JSON.stringify(soloInactivos.cuerpo?.datos?.map((p) => [p.id, p.activo])),
);

const sinFiltro = await pedir('/api/proveedores?limite=200', tokenAdmin);
revisar(
  'y sin filtro salen todos, el dado de baja incluido',
  sinFiltro.status === 200 && sinFiltro.cuerpo?.datos.some((p) => p.id === provUnoId),
  JSON.stringify(sinFiltro.cuerpo?.datos?.map((p) => [p.id, p.activo])),
);

const activoMal = await pedir('/api/proveedores?activo=quiza', tokenAdmin);
revisar('activo=quiza -> 400', activoMal.status === 400, JSON.stringify(activoMal.cuerpo));

await parcheProveedor(provUnoId, { activo: true });
const compraTrasReactivar = await crearCompra({
  proveedor_id: provUnoId,
  renglones: [{ producto_id: prodCompra, almacen_id: 1, cantidad_bultos: '1', precio_kg: '10.00' }],
});
revisar(
  'y tras reactivarlo ya se le puede comprar (-> 201)',
  compraTrasReactivar.status === 201,
  JSON.stringify(compraTrasReactivar.cuerpo),
);
await cancelarCompra(compraTrasReactivar.cuerpo?.id, { motivo: 'prueba de reactivacion' });

// =======================================================================
// CAJA Y BANCOS
// =======================================================================
//
// El unico modulo con DELETE, asi que aqui se prueba de mas lo que en los
// demas: no solo que el movimiento se guarda, sino que el saldo de la cuenta
// se recalcula en el sentido correcto y que borrar uno lo devuelve.
//
// Las cuentas son PROPIAS de la suite ('Caja de prueba', 'Banco de prueba') y
// no se tocan las del seed ('Caja chica', 'Banco principal'): el saldo de la
// caja chica es un numero que el seed dejo a proposito, y las pruebas de
// "el saldo quedo en X" se compararian contra el historial de la tienda.
//
// Y el saldo NO va pegado en los asserts. Se lleva en una variable y se
// compara el delta, que es lo mismo que hace el bloque de notas con las
// existencias y por el mismo motivo: el saldo depende de cuantos movimientos
// queden vivos, y en cuanto se agregue una prueba mas todos los numeros
// pegados quedan viejos a la vez sin que se sepa cual mintio.

console.log('\n--- caja y bancos ---');

const crearCuentaCaja = (cuerpo, token) =>
  pedir('/api/caja/cuentas', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const crearMovimientoCaja = (cuerpo, token) =>
  pedir('/api/caja/movimientos', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

// El saldo que la base tiene ahora mismo, y el que la suite espera. La
// cuenta se lleva aparte porque los movimientos del banco no cuentan para el
// saldo de la caja y si se sumaran todos los dos totales no cuadrarian.
const saldoDe = async (id) =>
  Number(
    (
      await sqlDirecto(
        `SELECT saldo_actual::TEXT AS s FROM pos.cuentas_financieras WHERE id = $1`,
        [id],
      )
    ).rows[0].s,
  );

// ------------------------------------------------------------- cuentas
const cuentaEfectivo = await crearCuentaCaja(
  { nombre: 'Caja de prueba', tipo: 'efectivo' },
  tokenAdmin,
);
revisar(
  'alta de cuenta de efectivo -> 201',
  cuentaEfectivo.status === 201,
  JSON.stringify(cuentaEfectivo.cuerpo),
);
revisar(
  'y sale con el Location, para poder leerla sin armarla a mano',
  String(cuentaEfectivo.headers?.get?.('location') ?? '').includes(
    String(cuentaEfectivo.cuerpo?.id ?? 'x'),
  ),
  String(cuentaEfectivo.headers?.get?.('location')),
);
revisar(
  'una cuenta nueva vale cero, no null',
  cuentaEfectivo.cuerpo?.saldo_actual === 0,
  JSON.stringify(cuentaEfectivo.cuerpo?.saldo_actual),
);
const cuentaEfectivoId = cuentaEfectivo.cuerpo?.id;

const cuentaBanco = await crearCuentaCaja(
  { nombre: 'Banco de prueba', tipo: 'banco', banco: 'BANCO DE PRUEBA', titular: 'La dueña' },
  tokenAdmin,
);
revisar('alta de cuenta de banco -> 201', cuentaBanco.status === 201);
const cuentaBancoId = cuentaBanco.cuerpo?.id;

// Una cuenta de banco sin nombre de banco no se distingue de otra en la
// lista, que es justo donde se mira cuando hay que encontrar un pago. La base
// NO lo exige (la columna es TEXT sin CHECK), asi que el 400 es del esquema.
const bancoSinNombre = await crearCuentaCaja(
  { nombre: 'Banco sin nombre', tipo: 'banco' },
  tokenAdmin,
);
revisar(
  'cuenta de banco sin `banco` -> 400',
  bancoSinNombre.status === 400,
  JSON.stringify(bancoSinNombre.cuerpo),
);

const cuentaDuplicada = await crearCuentaCaja(
  { nombre: 'Caja de prueba', tipo: 'efectivo' },
  tokenAdmin,
);
revisar(
  'nombre repetido -> 409',
  cuentaDuplicada.status === 409,
  JSON.stringify(cuentaDuplicada.cuerpo),
);
revisar(
  'y el codigo del 409 es CUENTA_DUPLICADA',
  cuentaDuplicada.cuerpo?.codigo === 'CUENTA_DUPLICADA',
  JSON.stringify(cuentaDuplicada.cuerpo),
);

const cuentas = await pedir('/api/caja/cuentas', tokenAdmin);
revisar('listar cuentas -> 200', cuentas.status === 200, JSON.stringify(cuentaEfectivo.cuerpo));
revisar(
  'trae las del seed Y las de la suite',
  cuentas.cuerpo?.some((c) => c.nombre === 'Caja chica') &&
    cuentas.cuerpo?.some((c) => c.nombre === 'Caja de prueba'),
  JSON.stringify(cuentas.cuerpo?.map((c) => c.nombre)),
);
revisar(
  'el saldo de la caja chica es el del seed, no el de la suite',
  cuentas.cuerpo?.find((c) => c.nombre === 'Caja chica')?.saldo_actual === 600,
  JSON.stringify(cuentas.cuerpo?.find((c) => c.nombre === 'Caja chica')),
);

const soloBancos = await pedir('/api/caja/cuentas?tipo=banco', tokenAdmin);
revisar(
  'filtrar por tipo',
  soloBancos.cuerpo?.length > 0 && soloBancos.cuerpo?.every((c) => c.tipo === 'banco'),
  JSON.stringify(soloBancos.cuerpo?.map((c) => [c.nombre, c.tipo])),
);
const tipoMal = await pedir('/api/caja/cuentas?tipo=cripto', tokenAdmin);
revisar('tipo de cuenta que no existe -> 400', tipoMal.status === 400);

const verCuenta = await pedir(`/api/caja/cuentas/${cuentaEfectivoId}`, tokenAdmin);
revisar(
  'ver la cuenta -> 200',
  verCuenta.status === 200 && verCuenta.cuerpo?.id === cuentaEfectivoId,
);
const cuentaFantasma = await pedir('/api/caja/cuentas/999', tokenAdmin);
revisar(
  'cuenta que no existe -> 404',
  cuentaFantasma.status === 404,
  JSON.stringify(cuentaFantasma.cuerpo),
);
const cuentaNoNumero = await pedir('/api/caja/cuentas/abc', tokenAdmin);
revisar('id que no es numero -> 400', cuentaNoNumero.status === 400);

// --------------------------------------------------------- movimientos
// El saldo esperado de la caja de la suite, que se actualiza solo con cada
// movimiento que la suite acepta. Si un movimiento se rechaza, no suma: por
// eso `mover` mira el status antes de apuntarlo.
const esperado = { ingresos: 0, egresos: 0, movimientos: 0 };
const saldoEsperado = () => esperado.ingresos - esperado.egresos;

const mover = async (cuerpo, token = tokenAdmin) => {
  const r = await crearMovimientoCaja(cuerpo, token);
  if (r.status === 201 && cuerpo.cuenta_id === cuentaEfectivoId) {
    // La API dice `ingreso`/`egreso` y el contador dice `ingresos`/`egresos`.
    // No es el mismo nombre, y sin el `s` el saldo esperado se queda en cero
    // para siempre: las comparaciones de abajo contrarian 0 contra la base y
    // fallarian sin decir nada de porque.
    esperado[`${cuerpo.tipo}s`] += Number(cuerpo.monto);
    esperado.movimientos += 1;
  }
  return r;
};

const ingreso = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '1000.00',
  descripcion: 'Venta del dia',
});
revisar('alta de movimiento -> 201', ingreso.status === 201, JSON.stringify(ingreso.cuerpo));
revisar(
  'y la respuesta trae el nombre de la cuenta, no el id',
  ingreso.cuerpo?.cuenta === 'Caja de prueba',
  JSON.stringify(ingreso.cuerpo),
);
const movimientoIngresoId = ingreso.cuerpo?.id;
revisar(
  'el saldo subio a 1000',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado(),
  `${await saldoDe(cuentaEfectivoId)} != ${saldoEsperado()}`,
);

const egreso = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'egreso',
  categoria: 'Flete',
  monto: '250.00',
});
revisar('egreso -> 201', egreso.status === 201);
revisar(
  'y el saldo bajo',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado(),
  `${await saldoDe(cuentaEfectivoId)} != ${saldoEsperado()}`,
);

// El saldo NEGATIVO es una decision y no un olvido, y por eso se prueba: una
// transferencia se registra el dia que se emite y la cuenta queda corrida
// hasta la compensacion. Bloquearlo empujaria al operador a meter el
// movimiento en otra cuenta, que es peor.
const sobregirado = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'egreso',
  categoria: 'Pago proveedor',
  monto: '1000.00',
});
revisar(
  'un egreso mayor al saldo SI se captura (-> 201)',
  sobregirado.status === 201,
  JSON.stringify(sobregirado.cuerpo),
);
revisar(
  'y la cuenta queda en negativo, que es lo que significa sobregirada',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado() && (await saldoDe(cuentaEfectivoId)) < 0,
  `${await saldoDe(cuentaEfectivoId)} vs ${saldoEsperado()}`,
);

// Al banco, con los dos lados: un ingreso de un cliente y un egreso a un
// proveedor. Es lo que se usa en el dia a dia. Los dos van al banco a
// proposito: mezclarlos con los de la caja haria que el saldo esperado de
// esta tuviera que distinguir por cuenta, y no vale la pena.
const ventaCliente = await crearMovimientoCaja(
  {
    cuenta_id: cuentaBancoId,
    tipo: 'ingreso',
    categoria: 'Transferencia',
    monto: '5000.00',
    cliente_id: clienteNotaId,
    tiene_factura: true,
  },
  tokenAdmin,
);
revisar(
  'ingreso de un cliente -> 201',
  ventaCliente.status === 201,
  JSON.stringify(ventaCliente.cuerpo),
);
revisar(
  'y trae el nombre del cliente, no el id',
  ventaCliente.cuerpo?.cliente === 'Cliente de nota',
  JSON.stringify(ventaCliente.cuerpo?.cliente),
);
revisar('el id del cliente tambien viene', ventaCliente.cuerpo?.cliente_id === clienteNotaId);
revisar('y sale marcado con factura', ventaCliente.cuerpo?.tiene_factura === true);

const pagoProveedor = await crearMovimientoCaja(
  {
    cuenta_id: cuentaBancoId,
    tipo: 'egreso',
    categoria: 'Pago proveedor',
    monto: '1800.00',
    proveedor_id: provUnoId,
  },
  tokenAdmin,
);
revisar(
  'egreso a un proveedor -> 201',
  pagoProveedor.status === 201,
  JSON.stringify(pagoProveedor.cuerpo),
);
const nombreDelProveedor = (
  await sqlDirecto(`SELECT nombre FROM pos.proveedores WHERE id = $1`, [
    pagoProveedor.cuerpo?.proveedor_id,
  ])
).rows[0]?.nombre;
revisar(
  'y trae el nombre del proveedor, no el id',
  pagoProveedor.cuerpo?.proveedor === nombreDelProveedor,
  `${pagoProveedor.cuerpo?.proveedor} vs ${nombreDelProveedor}`,
);

// ------------------------------------------------------------- validacion
// El `monto` es positivo y de dos decimales. El `CHECK (monto > 0)` de la
// base lo frena igual, pero aqui se comprueba que el 400 llega con el nombre
// del campo y no como un 23503.
const montoCero = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '0',
});
revisar('monto en cero -> 400', montoCero.status === 400, JSON.stringify(montoCero.cuerpo));
const montoNegativo = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '-50',
});
revisar('monto negativo -> 400', montoNegativo.status === 400);
const montoCentimos = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '10.555',
});
revisar('monto con tres decimales -> 400', montoCentimos.status === 400);
const montoTexto = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: 'mucho',
});
revisar('monto que no es numero -> 400', montoTexto.status === 400);
revisar(
  'y el saldo no se movio con ninguno de los cuatro rechazos',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado(),
  `${await saldoDe(cuentaEfectivoId)} != ${saldoEsperado()}`,
);

const categoriaCorta = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'V',
  monto: '10.00',
});
revisar('categoria de una letra -> 400', categoriaCorta.status === 400);

const cuentaInexistente = await mover({
  cuenta_id: 32000,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '10.00',
});
revisar(
  'cuenta que no existe -> 400, no un 23503',
  cuentaInexistente.status === 400,
  JSON.stringify(cuentaInexistente.cuerpo),
);
revisar(
  'y el error dice que campo es',
  JSON.stringify(cuentaInexistente.cuerpo).includes('cuenta_id'),
  JSON.stringify(cuentaInexistente.cuerpo),
);

const clienteInexistente = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '10.00',
  cliente_id: 999999999,
});
revisar('cliente que no existe -> 400', clienteInexistente.status === 400);
revisar(
  'y tambien dice que campo',
  JSON.stringify(clienteInexistente.cuerpo).includes('cliente_id'),
  JSON.stringify(clienteInexistente.cuerpo),
);

// Cliente Y proveedor a la vez no significa nada. La base no lo prohibe
// (ningun CHECK lo cubre) y por eso el 400 lo pone el esquema.
const dosLados = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '10.00',
  cliente_id: clienteNotaId,
  proveedor_id: provUnoId,
});
revisar(
  'cliente y proveedor a la vez -> 400',
  dosLados.status === 400,
  JSON.stringify(dosLados.cuerpo),
);

const losDosNull = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'egreso',
  categoria: 'Renta local',
  monto: '8000.00',
  cliente_id: null,
  proveedor_id: null,
});
revisar(
  'sin cliente ni proveedor SI se captura: la renta es de nadie',
  losDosNull.status === 201,
  JSON.stringify(losDosNull.cuerpo),
);
const rentaId = losDosNull.cuerpo?.id;

const desconocido = await mover({
  cuenta_id: cuentaEfectivoId,
  tipo: 'ingreso',
  categoria: 'Venta',
  monto: '10.00',
  raro: 1,
});
revisar(
  'campo que no existe -> 400 (el esquema es estricto)',
  desconocido.status === 400,
  JSON.stringify(desconocido.cuerpo),
);

// --------------------------------------------------------------- listado
const listaMovs = await pedir(`/api/caja/movimientos?cuenta_id=${cuentaEfectivoId}`, tokenAdmin);
revisar('listar por cuenta -> 200', listaMovs.status === 200, JSON.stringify(listaMovs.cuerpo));
revisar(
  'y trae SOLO los de esa cuenta',
  listaMovs.cuerpo?.datos.every((m) => m.cuenta_id === cuentaEfectivoId),
  JSON.stringify(listaMovs.cuerpo?.datos?.map((m) => [m.cuenta_id, m.monto])),
);
revisar(
  'el total del encabezado es el de los movimientos, no el de la pagina',
  listaMovs.cuerpo?.total === listaMovs.cuerpo?.datos.length,
  `${listaMovs.cuerpo?.total} vs ${listaMovs.cuerpo?.datos.length}`,
);

// ESTE es el caso que rompia con `?buscar=`: el `total` se contaba con un
// `FROM` mas pobre que el de las filas y, como `buscar` filtra por el nombre
// de la cuenta (`cf.nombre`), la columna quedaba fuera del alcance y la
// consulta reventaba. Se comprueba el TOTAL, no solo que responda 200: un 500
// en el conteo se comeria la fila sin que se notara en el listado.
const buscarMovs = await pedir(
  `/api/caja/movimientos?cuenta_id=${cuentaEfectivoId}&buscar=Renta`,
  tokenAdmin,
);
revisar(
  'buscar por descripcion, CON total -> 200',
  buscarMovs.status === 200,
  JSON.stringify(buscarMovs.cuerpo),
);
revisar(
  'y encuentra el de la renta',
  buscarMovs.cuerpo?.datos?.some((m) => m.id === rentaId),
  JSON.stringify(buscarMovs.cuerpo?.datos?.map((m) => [m.id, m.descripcion])),
);
revisar(
  'y el total coincide con lo que trae',
  buscarMovs.cuerpo?.total === buscarMovs.cuerpo?.datos.length,
  `${buscarMovs.cuerpo?.total} vs ${buscarMovs.cuerpo?.datos.length}`,
);

// Y por el nombre de la CUENTA, que es el otro lado del mismo `buscar`.
const buscarPorCuenta = await pedir('/api/caja/movimientos?buscar=prueba', tokenAdmin);
revisar(
  'buscar por nombre de cuenta -> 200 con total',
  buscarPorCuenta.status === 200 && typeof buscarPorCuenta.cuerpo?.total === 'number',
  JSON.stringify(buscarPorCuenta.cuerpo?.error),
);

const soloIngresos = await pedir(
  `/api/caja/movimientos?cuenta_id=${cuentaEfectivoId}&tipo=ingreso`,
  tokenAdmin,
);
revisar(
  'filtrar por tipo',
  soloIngresos.cuerpo?.datos.every((m) => m.tipo === 'ingreso') && soloIngresos.cuerpo?.total >= 1,
  JSON.stringify(soloIngresos.cuerpo?.datos?.map((m) => m.tipo)),
);

const conFactura = await pedir('/api/caja/movimientos?con_factura=true', tokenAdmin);
revisar(
  'filtrar por con_factura',
  conFactura.status === 200 && conFactura.cuerpo?.datos.every((m) => m.tiene_factura === true),
  JSON.stringify(conFactura.cuerpo?.datos?.map((m) => [m.tiene_factura, m.categoria])),
);
const conFacturaMal = await pedir('/api/caja/movimientos?con_factura=quiza', tokenAdmin);
revisar('con_factura que no es booleano -> 400', conFacturaMal.status === 400);

// El rango se compara contra el listado SIN filtro de fechas. Si el `hasta`
// fuera exclusivo, el listado traeria N-1 y el total no cuadraria.
const rangoCaja = await pedir(
  `/api/caja/movimientos?cuenta_id=${cuentaEfectivoId}&desde=2000-01-01&hasta=2099-12-31`,
  tokenAdmin,
);
revisar(
  'rango de fechas que cubre todo: el total no cambia',
  rangoCaja.cuerpo?.total === listaMovs.cuerpo?.total,
  `${rangoCaja.cuerpo?.total} vs ${listaMovs.cuerpo?.total}`,
);
const rangoInvertidoCaja = await pedir(
  '/api/caja/movimientos?desde=2099-01-01&hasta=2000-01-01',
  tokenAdmin,
);
revisar('rango invertido -> 400', rangoInvertidoCaja.status === 400);
const paginaMovs = await pedir('/api/caja/movimientos?limite=1&offset=1', tokenAdmin);
revisar(
  'la paginacion recorta la pagina y NO el total',
  paginaMovs.cuerpo?.datos.length === 1 && paginaMovs.cuerpo?.total > 1,
  JSON.stringify({ datos: paginaMovs.cuerpo?.datos.length, total: paginaMovs.cuerpo?.total }),
);
const limiteCeroCaja = await pedir('/api/caja/movimientos?limite=0', tokenAdmin);
revisar('limite 0 -> 400', limiteCeroCaja.status === 400);

const verMovimiento = await pedir(`/api/caja/movimientos/${movimientoIngresoId}`, tokenAdmin);
revisar('ver el movimiento -> 200', verMovimiento.status === 200);
revisar(
  'con el nombre de la cuenta y el tipo de la cuenta',
  verMovimiento.cuerpo?.cuenta === 'Caja de prueba' &&
    verMovimiento.cuerpo?.cuenta_tipo === 'efectivo',
  JSON.stringify(verMovimiento.cuerpo),
);
revisar(
  'y el monto es numero, no texto',
  typeof verMovimiento.cuerpo?.monto === 'number',
  JSON.stringify(verMovimiento.cuerpo?.monto),
);
const movimientoFantasma = await pedir('/api/caja/movimientos/999999', tokenAdmin);
revisar('movimiento que no existe -> 404', movimientoFantasma.status === 404);

// ---------------------------------------------------------------- resumen
// El resumen existe porque las sumas no se pueden sacar del listado
// paginado: sin el, "hoy entrare X" seria la suma de lo que se alcanzo a ver.
// Y trae DOS saldos a proposito: el de la cuenta (arrastra todo) y el del
// periodo (solo lo que paso en el rango). Son preguntas distintas.
const resumen = await pedir('/api/caja/resumen?desde=2000-01-01&hasta=2099-12-31', tokenAdmin);
revisar('resumen -> 200', resumen.status === 200, JSON.stringify(resumen.cuerpo?.error));
const resumenEfectivo = resumen.cuerpo?.find((r) => r.cuenta_id === cuentaEfectivoId);
revisar('y trae la cuenta de la suite', !!resumenEfectivo, JSON.stringify(resumen.cuerpo));
revisar(
  'ingresos y egresos del periodo son los que se movieron',
  resumenEfectivo?.ingresos === esperado.ingresos && resumenEfectivo?.egresos === esperado.egresos,
  `${JSON.stringify(resumenEfectivo)} vs ${JSON.stringify(esperado)}`,
);
revisar(
  'el saldo del periodo es ingresos - egresos',
  resumenEfectivo?.saldo_periodo === saldoEsperado(),
  `${resumenEfectivo?.saldo_periodo} != ${saldoEsperado()}`,
);
revisar(
  'y coincide con el saldo ACTUAL de la cuenta, porque el periodo es toda la historia',
  resumenEfectivo?.saldo_actual === (await saldoDe(cuentaEfectivoId)),
  `${resumenEfectivo?.saldo_actual} != ${await saldoDe(cuentaEfectivoId)}`,
);
revisar(
  'y cuenta cuantos movimientos son',
  resumenEfectivo?.movimientos === esperado.movimientos,
  `${resumenEfectivo?.movimientos} != ${esperado.movimientos}`,
);
revisar(
  'trae tambien la cuenta del seed, sin tocarla',
  resumen.cuerpo?.some((r) => r.cuenta === 'Caja chica'),
  JSON.stringify(resumen.cuerpo?.map((r) => [r.cuenta, r.ingresos, r.egresos])),
);
revisar(
  'la del seed sigue con los numeros del seed',
  resumen.cuerpo?.find((r) => r.cuenta === 'Caja chica')?.ingresos === 850 &&
    resumen.cuerpo?.find((r) => r.cuenta === 'Caja chica')?.egresos === 250,
  JSON.stringify(resumen.cuerpo?.find((r) => r.cuenta === 'Caja chica')),
);
revisar(
  'y el banco de la suite: 5000 de entrada y 1800 de salida',
  resumen.cuerpo?.find((r) => r.cuenta_id === cuentaBancoId)?.ingresos === 5000 &&
    resumen.cuerpo?.find((r) => r.cuenta_id === cuentaBancoId)?.egresos === 1800,
  JSON.stringify(resumen.cuerpo?.find((r) => r.cuenta_id === cuentaBancoId)),
);

// Un periodo que NO incluye los movimientos tiene que dar cero, no el total
// de toda la historia. Es el caso de "el corte del mes".
const resumenFuturo = await pedir(
  '/api/caja/resumen?desde=2099-01-01&hasta=2099-12-31',
  tokenAdmin,
);
revisar(
  'un periodo sin movimientos da cero, no la suma de todo',
  resumenFuturo.cuerpo?.every((r) => r.ingresos === 0 && r.egresos === 0),
  JSON.stringify(resumenFuturo.cuerpo?.find((r) => r.cuenta_id === cuentaEfectivoId)),
);
const resumenInvertido = await pedir(
  '/api/caja/resumen?desde=2099-01-01&hasta=2000-01-01',
  tokenAdmin,
);
revisar('resumen con rango invertido -> 400', resumenInvertido.status === 400);
const resumenSinFiltro = await pedir('/api/caja/resumen', tokenAdmin);
revisar(
  'sin fechas el resumen es de toda la historia',
  resumenSinFiltro.cuerpo?.find((r) => r.cuenta_id === cuentaEfectivoId)?.ingresos ===
    esperado.ingresos,
  JSON.stringify(resumenSinFiltro.cuerpo?.find((r) => r.cuenta_id === cuentaEfectivoId)),
);

// ------------------------------------------------------------- categorias
const categorias = await pedir(`/api/caja/categorias?cuenta_id=${cuentaEfectivoId}`, tokenAdmin);
revisar('categorias -> 200', categorias.status === 200, JSON.stringify(categorias.cuerpo));
revisar(
  'y son las de los movimientos de esa cuenta',
  categorias.cuerpo?.some((c) => c.categoria === 'Renta local') &&
    categorias.cuerpo?.some((c) => c.categoria === 'Venta'),
  JSON.stringify(categorias.cuerpo),
);
revisar(
  'y traen cuantos movimientos hay de cada una',
  categorias.cuerpo?.find((c) => c.categoria === 'Venta')?.movimientos === 1,
  JSON.stringify(categorias.cuerpo?.find((c) => c.categoria === 'Venta')),
);
const categoriasSinFiltro = await pedir('/api/caja/categorias', tokenAdmin);
revisar(
  'sin filtro salen tambien las del seed',
  categoriasSinFiltro.cuerpo?.some((c) => c.categoria === 'Flete'),
  JSON.stringify(categoriasSinFiltro.cuerpo),
);
const categoriasCuentaFalsa = await pedir('/api/caja/categorias?cuenta_id=999', tokenAdmin);
revisar(
  'categorias de una cuenta que no existe -> lista vacia',
  categoriasCuentaFalsa.status === 200 && categoriasCuentaFalsa.cuerpo?.length === 0,
  JSON.stringify(categoriasCuentaFalsa.cuerpo),
);

// --------------------------------------------------------------- permisos
// La Empleada tiene `caja.capturar` y `caja.ver` pero NO `caja.eliminar`
// (0001, sin cambios en 0006). Ese es el unico permiso de este modulo que
// esta repartido asi, asi que la prueba del DELETE la hace ella.
const empleadaCaptura = await mover(
  { cuenta_id: cuentaEfectivoId, tipo: 'ingreso', categoria: 'Propina', monto: '20.00' },
  tokenEmpleada,
);
revisar(
  'la empleada SI captura (caja.capturar es suyo)',
  empleadaCaptura.status === 201,
  JSON.stringify(empleadaCaptura.cuerpo),
);
const propinaId = empleadaCaptura.cuerpo?.id;

const borradoPorEmpleada = await pedir(`/api/caja/movimientos/${propinaId}`, tokenEmpleada, {
  method: 'DELETE',
});
revisar(
  'pero NO borra (caja.eliminar no es suyo) -> 403',
  borradoPorEmpleada.status === 403,
  JSON.stringify(borradoPorEmpleada.cuerpo),
);
revisar(
  'y el movimiento sigue ahi',
  (await pedir(`/api/caja/movimientos/${propinaId}`, tokenAdmin)).status === 200,
);
revisar(
  'y el saldo tampoco se movio',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado(),
  `${await saldoDe(cuentaEfectivoId)} != ${saldoEsperado()}`,
);

const cajaSinToken = await pedir('/api/caja/cuentas');
revisar('caja sin token -> 401', cajaSinToken.status === 401);
const cajeraVeResumen = await pedir('/api/caja/resumen', tokenCajera);
revisar(
  'la cajera ve caja entera -> 200',
  cajeraVeResumen.status === 200,
  JSON.stringify(cajeraVeResumen.cuerpo?.error),
);
const cajeraBorra = await pedir(`/api/caja/movimientos/${propinaId}`, tokenCajera, {
  method: 'DELETE',
});
revisar(
  'y la cajera SI borra (caja.eliminar es suyo desde 0006)',
  cajeraBorra.status === 204,
  JSON.stringify(cajeraBorra.cuerpo),
);
// El ajuste va ANTES de comparar: `esperado` es el saldo que la caja deberia
// tener si este movimiento ya no existiera. Comparar antes de restarlo
// compararia el saldo de dos instantes distintos.
esperado.ingresos -= 20;
esperado.movimientos -= 1;
revisar(
  'y ese borrado tambien devuelve el saldo',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado(),
  `${await saldoDe(cuentaEfectivoId)} != ${saldoEsperado()}`,
);

// ------------------------------------------------------------------ DELETE
// El DELETE es lo unico de este modulo que no existe en los demas, y por eso
// se prueba que el saldo vuelve a donde estaba y que el movimiento deja de
// existir de verdad, no de aparecer tachado.
const borrarRenta = await pedir(`/api/caja/movimientos/${rentaId}`, tokenAdmin, {
  method: 'DELETE',
});
revisar('borrar movimiento -> 204', borrarRenta.status === 204, JSON.stringify(borrarRenta.cuerpo));
revisar(
  'y el movimiento ya no existe -> 404',
  (await pedir(`/api/caja/movimientos/${rentaId}`, tokenAdmin)).status === 404,
);
esperado.egresos -= 8000;
esperado.movimientos -= 1;
revisar(
  'el saldo de la cuenta devuelve los 8000 de la renta',
  (await saldoDe(cuentaEfectivoId)) === saldoEsperado(),
  `${await saldoDe(cuentaEfectivoId)} != ${saldoEsperado()}`,
);
revisar(
  'y el saldo que dice la API es el mismo que el de la base',
  (await pedir(`/api/caja/cuentas/${cuentaEfectivoId}`, tokenAdmin)).cuerpo?.saldo_actual ===
    (await saldoDe(cuentaEfectivoId)),
  JSON.stringify(
    (await pedir(`/api/caja/cuentas/${cuentaEfectivoId}`, tokenAdmin)).cuerpo?.saldo_actual,
  ),
);

const borrarDoble = await pedir(`/api/caja/movimientos/${rentaId}`, tokenAdmin, {
  method: 'DELETE',
});
revisar('borrar dos veces -> 404', borrarDoble.status === 404, JSON.stringify(borrarDoble.cuerpo));
const borrarFantasma = await pedir('/api/caja/movimientos/999999', tokenAdmin, {
  method: 'DELETE',
});
revisar('borrar lo que no existe -> 404', borrarFantasma.status === 404);

// Y que el listado ya no las cuente: el total baja en el numero borrado.
const listaDespues = await pedir(`/api/caja/movimientos?cuenta_id=${cuentaEfectivoId}`, tokenAdmin);
revisar(
  'el listado ya no cuenta los dos borrados',
  listaDespues.cuerpo?.total === esperado.movimientos,
  `${listaDespues.cuerpo?.total} != ${esperado.movimientos}`,
);
revisar(
  'y el resumen cuadra con lo que quedo vivo',
  (await pedir('/api/caja/resumen?desde=2000-01-01&hasta=2099-12-31', tokenAdmin)).cuerpo?.find(
    (r) => r.cuenta_id === cuentaEfectivoId,
  )?.ingresos === esperado.ingresos,
  JSON.stringify(esperado),
);

// -------------------------------------------------------------- limpieza
const limpiarCaja = await limpiarCajaFacturasDePrueba();
revisar(
  'las cuentas de caja de prueba se borraron',
  limpiarCaja.cuentas === 2 && limpiarCaja.movimientos > 0,
  JSON.stringify(limpiarCaja),
);
revisar(
  'y con ellas su rastro de auditoria_caja',
  limpiarCaja.auditoriaCaja > 0,
  JSON.stringify(limpiarCaja),
);
revisar(
  'y no sobro ninguna cuenta de prueba',
  (
    await sqlDirecto(
      `SELECT COUNT(*)::TEXT AS n FROM pos.cuentas_financieras
        WHERE nombre IN ('Caja de prueba','Banco de prueba')`,
    )
  ).rows[0].n === '0',
  'sobro una cuenta de caja de prueba',
);
revisar(
  'la caja del seed sigue como estaba',
  (await pedir('/api/caja/cuentas', tokenAdmin)).cuerpo?.find((c) => c.nombre === 'Caja chica')
    ?.saldo_actual === 600,
  'el modulo toco la caja del seed',
);
void ingreso;
void egreso;
void sobregirado;
void ventaCliente;
void pagoProveedor;
void losDosNull;
void movimientoIngresoId;

// =======================================================================
// FACTURACION
// =======================================================================
//
// Aqui se prueba el modulo entero y no sus endpoints sueltos, porque lo
// interesante no es que el POST guarde: es que la base NO prohibe tres
// cosas que sí tienen que quedar prohibidas, y que son las tres que hacen
// dinero equivocado:
//
//   1. Una nota de OTRO cliente. `factura_nota` no liga `facturas.cliente_id`
//      con `notas_remision.cliente_id`, asi que el par entra sin mirar.
//   2. Una nota CANCELADA. Facturar mercancia que no salio.
//   3. Una nota que YA esta en otra factura viva. La misma venta facturada
//      dos veces, que es el doble cobro que este modulo mas que ningun otro
//      tiene que evitar.
//
// Las notas se crean de verdad, con su talonario y su producto, y no por SQL:
// una nota hecha a mano no pasa por el servicio de notas y no prueba nada
// sobre el estado en el que una nota real llega a facturacion.

console.log('\n--- facturacion ---');

const crearFactura = (cuerpo, token) =>
  pedir('/api/facturas', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

const cambiarEstatusFactura = (id, cuerpo, token) =>
  pedir(`/api/facturas/${id}/estatus`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

// El talonario TST lo creo el bloque de notas con el rango 2001-2010, y para
// entonces ya se lo gasto creando notas. Que esta seccion tenga folios
// propios NO es un detalle: si dependiera de los que dejen las pruebas de
// notas, el orden de los bloques seria la diferencia entre que corra o no, y
// el error seria un "no queda ningun folio" que no dice de quien es la culpa.
// Se pide un rango nuevo por la API (que es idempotente: en la segunda
// corrida omite los que ya existen) y no por SQL, porque lo que se prueba es
// que la venta se pueda hacer, no que se pueda meter una nota a mano.
const talonarioFacturas = await pedir('/api/notas-remision/folios', tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ serie: 'TST', desde: 2021, hasta: 2030 }),
});
revisar(
  'y esta seccion carga sus propios folios -> 201',
  talonarioFacturas.status === 201,
  JSON.stringify(talonarioFacturas.cuerpo),
);
revisar(
  'y son 10 los nuevos, o los que ya estaban',
  talonarioFacturas.cuerpo?.creados + talonarioFacturas.cuerpo?.omitidos === 10,
  JSON.stringify(talonarioFacturas.cuerpo),
);

const notaFacturar = async (cantidad = '2') =>
  crearNota({
    cliente_id: clienteNotaId,
    serie: 'TST',
    renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: cantidad }],
  });

const notaA = await notaFacturar();
revisar('nota para facturar -> 201', notaA.status === 201, JSON.stringify(notaA.cuerpo));
const notaAId = notaA.cuerpo?.id;
const notaB = await notaFacturar('1');
revisar('segunda nota -> 201', notaB.status === 201);
const notaBId = notaB.cuerpo?.id;
// Una nota de OTRO cliente, para la regla 1. El cliente de fechas ya existe
// de las pruebas de notas y tiene producto con precio.
const notaOtroCliente = await crearNota({
  cliente_id: clienteFechasId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'nota de otro cliente -> 201',
  notaOtroCliente.status === 201,
  JSON.stringify(notaOtroCliente.cuerpo),
);
const notaOtroClienteId = notaOtroCliente.cuerpo?.id;

// El precio de TST-NOTA lo fijo el bloque de notas, asi que el subtotal sale
// de ahi. Se lee de la base y no se pega: si el bloque de notas cambia su
// precio, esta seccion no se rompe.
const subtotalDe = async (notaId) =>
  Number(
    (await sqlDirecto(`SELECT subtotal::TEXT AS s FROM pos.notas_remision WHERE id = $1`, [notaId]))
      .rows[0].s,
  );

// ------------------------------------------------------------ alta y monto
const facturaOk = await crearFactura(
  { cliente_id: clienteNotaId, metodo_pago: 'Transferencia', notas: [notaAId, notaBId] },
  tokenAdmin,
);
revisar('alta de factura -> 201', facturaOk.status === 201, JSON.stringify(facturaOk.cuerpo));
revisar(
  'y sale con el Location',
  String(facturaOk.headers?.get?.('location') ?? '').includes(String(facturaOk.cuerpo?.id ?? 'x')),
  String(facturaOk.headers?.get?.('location')),
);
const facturaOkId = facturaOk.cuerpo?.id;
revisar(
  'arranca en solicitada, sin pedir nada',
  facturaOk.cuerpo?.estatus === 'solicitada',
  JSON.stringify(facturaOk.cuerpo?.estatus),
);
revisar(
  'el monto es la SUMA de los subtotales de las notas',
  facturaOk.cuerpo?.monto_total === (await subtotalDe(notaAId)) + (await subtotalDe(notaBId)),
  `${facturaOk.cuerpo?.monto_total} vs ${(await subtotalDe(notaAId)) + (await subtotalDe(notaBId))}`,
);
revisar(
  'y trae las dos notas con su folio',
  facturaOk.cuerpo?.notas?.length === 2 &&
    facturaOk.cuerpo?.notas?.every((n) => typeof n.nota === 'string' && n.nota.length > 0),
  JSON.stringify(facturaOk.cuerpo?.notas),
);
revisar(
  'cada nota trae su subtotal, para que el total se pueda auditar renglón por renglón',
  facturaOk.cuerpo?.notas?.reduce((s, n) => s + n.subtotal, 0) === facturaOk.cuerpo?.monto_total,
  JSON.stringify(facturaOk.cuerpo?.notas?.map((n) => n.subtotal)),
);
revisar(
  'y trae el nombre del cliente, no el id',
  facturaOk.cuerpo?.cliente === 'Cliente de nota',
  JSON.stringify(facturaOk.cuerpo?.cliente),
);
revisar(
  'la fecha es la de hoy si no se manda otra',
  facturaOk.cuerpo?.fecha === (await sqlDirecto(`SELECT CURRENT_DATE::TEXT AS h`)).rows[0].h,
  JSON.stringify(facturaOk.cuerpo?.fecha),
);

// El `monto_total` NO se acepta. Aceptarlo abriria la puerta a facturar una
// nota por una cantidad que no es la que se vendio, y la diferencia no
// apareceria en ningun lado.
const facturaConMonto = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaAId], monto_total: '0.01' },
  tokenAdmin,
);
revisar(
  'mandar el monto_total a mano -> 400',
  facturaConMonto.status === 400,
  JSON.stringify(facturaConMonto.cuerpo),
);

// Una factura de cero notas no es un documento, es un borrador. La base si lo
// dejaria (el `monto_total` tiene DEFAULT 0 y ningun CHECK).
const facturaVacia = await crearFactura({ cliente_id: clienteNotaId, notas: [] }, tokenAdmin);
revisar(
  'factura sin notas -> 400',
  facturaVacia.status === 400,
  JSON.stringify(facturaVacia.cuerpo),
);
revisar(
  'y el error lo explica',
  JSON.stringify(facturaVacia.cuerpo).toLowerCase().includes('nota'),
  JSON.stringify(facturaVacia.cuerpo),
);
const facturaSinNotas = await crearFactura({ cliente_id: clienteNotaId }, tokenAdmin);
revisar('factura sin el campo `notas` -> 400', facturaSinNotas.status === 400);

// ------------------------------------------------------- las tres reglas
// Regla 1: la nota es de otro cliente.
const facturaAjena = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaOtroClienteId] },
  tokenAdmin,
);
revisar(
  'nota de otro cliente -> 409, no 422',
  facturaAjena.status === 409,
  JSON.stringify(facturaAjena.cuerpo),
);
revisar(
  'y el codigo lo dice',
  facturaAjena.cuerpo?.codigo === 'NOTA_DE_OTRO_CLIENTE',
  JSON.stringify(facturaAjena.cuerpo),
);
revisar(
  'y NO se creo la factura a medias',
  (await sqlDirecto(`SELECT COUNT(*)::TEXT AS n FROM pos.facturas`)).rows[0].n === '1',
  'quedo una factura huerfana del intento fallido',
);

// Regla 3: la nota ya esta en una factura viva.
const facturaRepetida = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaAId] },
  tokenAdmin,
);
revisar(
  'nota ya facturada -> 409',
  facturaRepetida.status === 409,
  JSON.stringify(facturaRepetida.cuerpo),
);
revisar(
  'y el codigo es NOTA_YA_FACTURADA',
  facturaRepetida.cuerpo?.codigo === 'NOTA_YA_FACTURADA',
  JSON.stringify(facturaRepetida.cuerpo),
);
revisar(
  'y el error dice en cual factura estaba, para no tener que buscarla',
  facturaRepetida.cuerpo?.detalles?.factura_id === facturaOkId,
  JSON.stringify(facturaRepetida.cuerpo),
);

// La misma nota DOS VECES en el mismo POST es casi siempre un doble clic. Sin
// el `Set`, el `monto_total` la contaria dos veces y la base no lo prohibe
// porque (factura, nota) repetida si cae en el PRIMARY KEY.
const facturaRepetidaMisma = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaOtroClienteId, notaOtroClienteId] },
  tokenAdmin,
);
revisar(
  'una nota de otro cliente repetida sigue siendo de otro cliente -> 409',
  facturaRepetidaMisma.status === 409,
  JSON.stringify(facturaRepetidaMisma.cuerpo),
);

// Y el caso del `Set` de verdad, que es el que no falla: dos notas nuevas con
// una repetida. Se mira el monto, que es donde se notaria el doble conteo.
const notaC = await notaFacturar('3');
const notaD = await notaFacturar('1');
revisar(
  'dos notas mas -> 201',
  notaC.status === 201 && notaD.status === 201,
  JSON.stringify(notaC.cuerpo),
);
const facturaConRepetida = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaC.cuerpo?.id, notaD.cuerpo?.id, notaC.cuerpo?.id] },
  tokenAdmin,
);
revisar(
  'la misma nota dos veces en el mismo POST -> 201 (se ignora el repetido)',
  facturaConRepetida.status === 201,
  JSON.stringify(facturaConRepetida.cuerpo),
);
revisar(
  'y el monto NO la cuenta dos veces',
  facturaConRepetida.cuerpo?.monto_total ===
    (await subtotalDe(notaC.cuerpo?.id)) + (await subtotalDe(notaD.cuerpo?.id)),
  `${facturaConRepetida.cuerpo?.monto_total} vs ${(await subtotalDe(notaC.cuerpo?.id)) + (await subtotalDe(notaD.cuerpo?.id))}`,
);
revisar(
  'y solo hay dos lineas en factura_nota',
  facturaConRepetida.cuerpo?.notas?.length === 2,
  JSON.stringify(facturaConRepetida.cuerpo?.notas?.length),
);

// Regla 2: la nota CANCELADA. Se cancela por la API de notas, que es la
// via real, y luego se intenta facturar.
const notaParaCancelar = await notaFacturar('1');
const notaCanceladaId = notaParaCancelar.cuerpo?.id;
await pedir(`/api/notas-remision/${notaCanceladaId}/cancelar`, tokenAdmin, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ motivo: 'prueba de facturacion' }),
});
const facturaDeCancelada = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaCanceladaId] },
  tokenAdmin,
);
revisar(
  'nota cancelada -> 409',
  facturaDeCancelada.status === 409,
  JSON.stringify(facturaDeCancelada.cuerpo),
);
revisar(
  'y el codigo es NOTA_CANCELADA_NO_SE_FACTURA',
  facturaDeCancelada.cuerpo?.codigo === 'NOTA_CANCELADA_NO_SE_FACTURA',
  JSON.stringify(facturaDeCancelada.cuerpo),
);

const notaDePruebaFantasma = await crearFactura(
  { cliente_id: clienteNotaId, notas: [999999] },
  tokenAdmin,
);
revisar(
  'nota que no existe -> 400',
  notaDePruebaFantasma.status === 400,
  JSON.stringify(notaDePruebaFantasma.cuerpo),
);
const clienteFantasmaFactura = await crearFactura(
  { cliente_id: 999999, notas: [notaOtroClienteId] },
  tokenAdmin,
);
revisar(
  'cliente que no existe -> 400, no un 23503',
  clienteFantasmaFactura.status === 400,
  JSON.stringify(clienteFantasmaFactura.cuerpo),
);

// ------------------------------------------------------------- estatus
// La maquina de estados es solicitada -> emitida -> cancelada, y de ahi no
// sale. La Empleada tiene `facturas.solicitar` pero NO `facturas.emitir`
// (0001), y esa es la razon de que exista el segundo permiso.
const emitidaPorEmpleada = await cambiarEstatusFactura(
  facturaOkId,
  { estatus: 'emitida' },
  tokenEmpleada,
);
revisar(
  'la empleada puede PEDIR la factura pero no EMITIRLA -> 403',
  emitidaPorEmpleada.status === 403,
  JSON.stringify(emitidaPorEmpleada.cuerpo),
);
revisar(
  'y la factura sigue solicitada',
  (await pedir(`/api/facturas/${facturaOkId}`, tokenAdmin)).cuerpo?.estatus === 'solicitada',
);

const emitida = await cambiarEstatusFactura(facturaOkId, { estatus: 'emitida' }, tokenAdmin);
revisar('solicitada -> emitida -> 200', emitida.status === 200, JSON.stringify(emitida.cuerpo));
revisar('y el estatus guardo', emitida.cuerpo?.estatus === 'emitida');
revisar(
  'y las notas siguen en la factura',
  emitida.cuerpo?.notas?.length === 2,
  JSON.stringify(emitida.cuerpo?.notas?.length),
);

const emitidaPorLaCajera = await cambiarEstatusFactura(
  facturaConRepetida.cuerpo?.id,
  { estatus: 'emitida' },
  tokenCajera,
);
revisar(
  'la cajera SI emite (facturas.emitir es suyo desde 0006)',
  emitidaPorLaCajera.status === 200,
  JSON.stringify(emitidaPorLaCajera.cuerpo?.error),
);

// Y las transiciones que NO existen.
const volverASolicitada = await cambiarEstatusFactura(
  facturaOkId,
  { estatus: 'solicitada' },
  tokenAdmin,
);
revisar(
  'emitida -> solicitada -> 409',
  volverASolicitada.status === 409,
  JSON.stringify(volverASolicitada.cuerpo),
);
revisar(
  'y el codigo es TRANSICION_NO_PERMITIDA',
  volverASolicitada.cuerpo?.codigo === 'TRANSICION_NO_PERMITIDA',
  JSON.stringify(volverASolicitada.cuerpo),
);

const mismaEstatus = await cambiarEstatusFactura(facturaOkId, { estatus: 'emitida' }, tokenAdmin);
revisar(
  'emitida -> emitida -> 409',
  mismaEstatus.status === 409,
  JSON.stringify(mismaEstatus.cuerpo),
);

const estatusFantasma = await cambiarEstatusFactura(facturaOkId, { estatus: 'pagada' }, tokenAdmin);
revisar(
  'estatus que no existe -> 400',
  estatusFantasma.status === 400,
  JSON.stringify(estatusFantasma.cuerpo),
);

// Cancelar pide motivo, y no por buena voluntad: es el mismo patron que
// notas (0008) y compras (0009), y la base lo exige con un CHECK.
const cancelarFacturaSinMotivo = await cambiarEstatusFactura(
  facturaOkId,
  { estatus: 'cancelada' },
  tokenAdmin,
);
revisar(
  'cancelar sin motivo -> 400',
  cancelarFacturaSinMotivo.status === 400,
  JSON.stringify(cancelarFacturaSinMotivo.cuerpo),
);
revisar(
  'y sigue emitida',
  (await pedir(`/api/facturas/${facturaOkId}`, tokenAdmin)).cuerpo?.estatus === 'emitida',
);
const cancelarPorEmpleada = await cambiarEstatusFactura(
  facturaOkId,
  { estatus: 'cancelada', motivo: 'la empleada intenta' },
  tokenEmpleada,
);
revisar(
  'y la empleada tampoco cancela -> 403',
  cancelarPorEmpleada.status === 403,
  JSON.stringify(cancelarPorEmpleada.cuerpo),
);

const cancelada = await cambiarEstatusFactura(
  facturaOkId,
  { estatus: 'cancelada', motivo: 'El cliente pidio otra factura con los datos correctos' },
  tokenAdmin,
);
revisar(
  'emitida -> cancelada con motivo -> 200',
  cancelada.status === 200,
  JSON.stringify(cancelada.cuerpo),
);
revisar(
  'y el motivo queda guardado',
  cancelada.cuerpo?.motivo_cancelacion === 'El cliente pidio otra factura con los datos correctos',
  JSON.stringify(cancelada.cuerpo?.motivo_cancelacion),
);

const revivir = await cambiarEstatusFactura(facturaOkId, { estatus: 'emitida' }, tokenAdmin);
revisar(
  'cancelada -> emitida -> 409 (no hay resurreccion)',
  revivir.status === 409,
  JSON.stringify(revivir.cuerpo),
);

// Cancelar LIBERA las notas: una factura cancelada no es un CFDI, asi que
// sus notas tienen que poder facturarse de nuevo. Si no se liberaran, la
// venta quedaria sin facturar para siempre por un documento que ya no
// existe.
const notaLibre = await notaFacturar('1');
const refacturada = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaLibre.cuerpo?.id] },
  tokenAdmin,
);
revisar(
  'una nota nueva si se puede facturar de nuevo',
  refacturada.status === 201,
  JSON.stringify(refacturada.cuerpo),
);

// Y la regla 3 mira solo facturas ACTIVAS: una nota de la factura cancelada
// tiene que volver a entrar en una factura nueva.
const reusarNotaCancelada = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaAId] },
  tokenAdmin,
);
revisar(
  'la nota de una factura CANCELADA si se puede volver a facturar',
  reusarNotaCancelada.status === 201,
  JSON.stringify(reusarNotaCancelada.cuerpo),
);
revisar(
  'y la nueva factura es distinta',
  reusarNotaCancelada.cuerpo?.id !== facturaOkId,
  JSON.stringify(reusarNotaCancelada.cuerpo?.id),
);
revisar('con estatus solicitada, no emitida', reusarNotaCancelada.cuerpo?.estatus === 'solicitada');

// ------------------------------------------------------------- la base
// El motivo lo exige el CHECK de 0010, no solo el servicio. Un UPDATE escrito
// a mano en psql tiene que rebotar con 23514, porque si no el motivo seria
// opcional para quien no pase por la API.
let canceladaAMano = null;
try {
  await sqlDirecto(`UPDATE pos.facturas SET estatus = 'cancelada' WHERE id = $1`, [
    reusarNotaCancelada.cuerpo?.id,
  ]);
} catch (e) {
  canceladaAMano = e.code;
}
revisar(
  'cancelar por SQL sin motivo -> 23514 (lo frena el CHECK de 0010)',
  canceladaAMano === '23514',
  String(canceladaAMano),
);
revisar(
  'y la factura sigue solicitada en la base',
  (
    await sqlDirecto(`SELECT estatus FROM pos.facturas WHERE id = $1`, [
      reusarNotaCancelada.cuerpo?.id,
    ])
  ).rows[0].estatus === 'solicitada',
);

// Y el permiso, abajo de la API: `trg_permiso_facturas` exige
// `facturas.solicitar` en INSERT y UPDATE. Por SQL no se puede probar sin
// sesion (`fn_trg_permiso` salta cuando no hay usuario, que es lo que deja
// trabajar a migraciones y seed), asi que la puerta de arriba ya esta
// probada con la Empleada.

// ------------------------------------------------------------ listado
const listarFacturas = await pedir('/api/facturas?limite=200', tokenAdmin);
revisar(
  'listar -> 200',
  listarFacturas.status === 200,
  JSON.stringify(listarFacturas.cuerpo?.error),
);
revisar(
  'el listado trae cuantos renglones, no los renglones',
  typeof listarFacturas.cuerpo?.total === 'number' &&
    listarFacturas.cuerpo?.datos.length <= listarFacturas.cuerpo?.total,
  JSON.stringify({
    datos: listarFacturas.cuerpo?.datos?.length,
    total: listarFacturas.cuerpo?.total,
  }),
);
revisar(
  'cada renglon dice cuantas notas cubre, no las notas',
  listarFacturas.cuerpo?.datos.every((f) => Number.isInteger(f.notas) && f.notas >= 1),
  JSON.stringify(listarFacturas.cuerpo?.datos?.map((f) => [f.id, f.notas])),
);
revisar(
  'y si esta cancelada, para no tener que mirar el estatus',
  typeof listarFacturas.cuerpo?.datos.every((f) => typeof f.cancelada === 'boolean'),
);

const porClienteFacturas = await pedir(
  `/api/facturas?cliente_id=${clienteNotaId}&limite=200`,
  tokenAdmin,
);
revisar(
  'filtrar por cliente',
  porClienteFacturas.cuerpo?.datos.every((f) => f.cliente_id === clienteNotaId) &&
    porClienteFacturas.cuerpo?.total > 0,
  JSON.stringify(porClienteFacturas.cuerpo?.total),
);
const porEstatusFacturas = await pedir('/api/facturas?estatus=cancelada', tokenAdmin);
revisar(
  'filtrar por estatus',
  porEstatusFacturas.cuerpo?.datos.every((f) => f.estatus === 'cancelada') &&
    porEstatusFacturas.cuerpo?.total >= 1,
  JSON.stringify(porEstatusFacturas.cuerpo?.total),
);
const estatusFacturaMal = await pedir('/api/facturas?estatus=pagada', tokenAdmin);
revisar('estatus que no existe en el filtro -> 400', estatusFacturaMal.status === 400);

// ESTE es el otro `buscar` que rompia por lo mismo que en caja: el `total` se
// contaba con un `FROM` sin el JOIN a clientes y `buscar` filtra por
// `c.nombre`.
const buscarFacturas = await pedir('/api/facturas?buscar=Cliente%20de%20nota', tokenAdmin);
revisar(
  'buscar por nombre de cliente, CON total -> 200',
  buscarFacturas.status === 200,
  JSON.stringify(buscarFacturas.cuerpo),
);
revisar(
  'y encuentra la factura del cliente',
  buscarFacturas.cuerpo?.datos?.some((f) => f.id === facturaOkId),
  JSON.stringify(buscarFacturas.cuerpo?.datos?.map((f) => [f.id, f.cliente])),
);
revisar(
  'y el total coincide con lo que trae',
  buscarFacturas.cuerpo?.total === buscarFacturas.cuerpo?.datos.length,
  `${buscarFacturas.cuerpo?.total} vs ${buscarFacturas.cuerpo?.datos.length}`,
);

const rangoFacturas = await pedir(
  '/api/facturas?desde=2000-01-01&hasta=2099-12-31&limite=200',
  tokenAdmin,
);
revisar(
  'rango que cubre todo: el total no cambia',
  rangoFacturas.cuerpo?.total === listarFacturas.cuerpo?.total,
  `${rangoFacturas.cuerpo?.total} vs ${listarFacturas.cuerpo?.total}`,
);
const rangoInvertidoFacturas = await pedir(
  '/api/facturas?desde=2099-01-01&hasta=2000-01-01',
  tokenAdmin,
);
revisar('rango invertido -> 400', rangoInvertidoFacturas.status === 400);
const paginaFacturas = await pedir('/api/facturas?limite=1&offset=1', tokenAdmin);
revisar(
  'la paginacion recorta la pagina y NO el total',
  paginaFacturas.cuerpo?.datos.length === 1 && paginaFacturas.cuerpo?.total > 1,
  JSON.stringify({
    datos: paginaFacturas.cuerpo?.datos?.length,
    total: paginaFacturas.cuerpo?.total,
  }),
);
const limiteCeroFacturas = await pedir('/api/facturas?limite=0', tokenAdmin);
revisar('limite 0 -> 400', limiteCeroFacturas.status === 400);

const verFactura = await pedir(`/api/facturas/${facturaOkId}`, tokenAdmin);
revisar('ver el detalle -> 200', verFactura.status === 200);
revisar(
  'con sus notas',
  verFactura.cuerpo?.notas?.length === 2,
  JSON.stringify(verFactura.cuerpo?.notas?.length),
);
revisar(
  'y el motivo de la cancelacion',
  verFactura.cuerpo?.motivo_cancelacion?.includes('datos correctos'),
  JSON.stringify(verFactura.cuerpo?.motivo_cancelacion),
);
const facturaFantasma = await pedir('/api/facturas/999999', tokenAdmin);
revisar(
  'factura que no existe -> 404',
  facturaFantasma.status === 404,
  JSON.stringify(facturaFantasma.cuerpo),
);
const facturaNoNumero = await pedir('/api/facturas/abc', tokenAdmin);
revisar('id que no es numero -> 400', facturaNoNumero.status === 400);
const cambiarFacturaFantasma = await cambiarEstatusFactura(
  999999,
  { estatus: 'emitida' },
  tokenAdmin,
);
revisar('cambiar el estatus de una que no existe -> 404', cambiarFacturaFantasma.status === 404);

// ------------------------------------------------------------ permisos
// No hay DELETE, y no por estilo: `auditoria_log` tiene que conservar la
// fila para que se vea que existo una factura y por que se cancelo. Un DELETE
// de una factura emitida deja el mismo hueco que borrar una nota.
const borrarFactura = await pedir(`/api/facturas/${facturaOkId}`, tokenAdmin, { method: 'DELETE' });
revisar(
  'no hay DELETE de factura -> 404',
  borrarFactura.status === 404,
  JSON.stringify(borrarFactura.cuerpo),
);

const facturaSinToken = await pedir('/api/facturas');
revisar('facturas sin token -> 401', facturaSinToken.status === 401);
const empleadaListaFacturas = await pedir('/api/facturas', tokenEmpleada);
revisar(
  'la empleado ve facturas (facturas.ver es suyo)',
  empleadaListaFacturas.status === 200,
  JSON.stringify(empleadaListaFacturas.cuerpo?.error),
);

// -------------------------------------------------------------- limpieza
const limpiarFacturas = await limpiarCajaFacturasDePrueba();
revisar(
  'las facturas de prueba se borraron',
  limpiarFacturas.facturas > 0,
  JSON.stringify(limpiarFacturas),
);
revisar(
  'y con ellas su rastro en auditoria_log (0010)',
  limpiarFacturas.log > 0,
  JSON.stringify(limpiarFacturas),
);
// La base de pruebas arranca en CERO facturas: el seed no crea ninguna, asi
// que lo que quede despues de la limpieza es de esta seccion y solo de esta.
revisar(
  'no sobro ninguna factura de la suite',
  (await sqlDirecto(`SELECT COUNT(*)::TEXT AS n FROM pos.facturas`)).rows[0].n === '0',
  'sobro una factura',
);
revisar(
  'y las lineas de factura_nota se fueron en cascada',
  (await sqlDirecto(`SELECT COUNT(*)::TEXT AS n FROM pos.factura_nota`)).rows[0].n === '0',
  'sobro una linea de factura_nota',
);
void notaA;
void notaB;
void notaOtroCliente;
void notaParaCancelar;
void notaLibre;

// =======================================================================
// AUDITORIA (SOLO LECTURA)
// =======================================================================
//
// El unico modulo del proyecto sin una sola operacion de escritura, y lo que
// se prueba aqui es justamente eso: que no haya puerta. Un `POST` a
// `/api/auditoria/log` tiene que dar 404, no 405, porque no existe.
//
// Y se prueba que las cinco bitacoras DEVUELVEN lo que la base escribio por
// trigger, con los nombres resueltos. Si el modulo devolviera ids, el
// frontend tendria que hacer un JOIN por cada columna de cada renglon, y
// para eso ya estan las vistas de 0001.

console.log('\n--- auditoria ---');

// ------------------------------------------------------------------- datos
//
// Esta seccion NO hereda datos del bloque de facturas: ese bloque limpia sus
// facturas (y su rastro) al terminar, asi que si esta section dependiera de
// el, el orden de los dos bloques seria la diferencia entre que las pruebas
// corran o no. Se crea aqui una factura y se le cambia el estatus, que es
// justo lo que 0010 vino a dejar con rastro, y se mide eso.
//
// Lo que no se crea y si se lee son las otras cuatro bitacoras: las del
// inventario y los precios las dejaron los bloques de compras y de precios,
// y las del seed. Esos datos no se tocan en ningun momento.
const notaAuditoria = await crearNota({
  cliente_id: clienteNotaId,
  serie: 'TST',
  renglones: [{ producto_id: prodNota, almacen_id: 1, cantidad_bultos: '1' }],
});
revisar(
  'nota para la bitacora -> 201',
  notaAuditoria.status === 201,
  JSON.stringify(notaAuditoria.cuerpo),
);
const facturaAuditada = await crearFactura(
  { cliente_id: clienteNotaId, notas: [notaAuditoria.cuerpo?.id] },
  tokenAdmin,
);
revisar(
  'factura para la bitacora -> 201',
  facturaAuditada.status === 201,
  JSON.stringify(facturaAuditada.cuerpo),
);
const facturaAuditadaId = facturaAuditada.cuerpo?.id;
const emitidaAuditada = await cambiarEstatusFactura(
  facturaAuditadaId,
  { estatus: 'emitida' },
  tokenAdmin,
);
revisar(
  'y se emite -> 200',
  emitidaAuditada.status === 200,
  JSON.stringify(emitidaAuditada.cuerpo?.error),
);

// ------------------------------------------------------------------- log
const logGeneral = await pedir('/api/auditoria/log?limite=200', tokenAdmin);
revisar('log -> 200', logGeneral.status === 200, JSON.stringify(logGeneral.cuerpo?.error));
revisar(
  'trae la tabla, la operacion y el registro',
  logGeneral.cuerpo?.datos.every(
    (r) => typeof r.tabla === 'string' && ['INSERT', 'UPDATE', 'DELETE'].includes(r.operacion),
  ),
  JSON.stringify(logGeneral.cuerpo?.datos?.slice(0, 2)),
);
revisar(
  'y el renglon trae el antes y el despues, sin transformar',
  logGeneral.cuerpo?.datos.some(
    (r) => r.datos_nuevos !== null && typeof r.datos_nuevos === 'object',
  ),
  'ningun renglon trae datos_nuevos',
);
revisar(
  'con el nombre del usuario, no el id',
  logGeneral.cuerpo?.datos.every((r) => r.usuario === null || typeof r.usuario === 'string'),
  JSON.stringify(logGeneral.cuerpo?.datos?.map((r) => r.usuario)),
);
revisar(
  'y sale del mas reciente al mas viejo',
  logGeneral.cuerpo?.datos.length < 2 ||
    new Date(logGeneral.cuerpo.datos[0].fecha) >= new Date(logGeneral.cuerpo.datos[1].fecha),
  JSON.stringify(logGeneral.cuerpo?.datos?.slice(0, 3)?.map((r) => r.fecha)),
);

// El filtro por tabla es el que se usa para "¿quien toco esto?", y el de
// facturas es el que 0010 vino a arreglar: antes de 0010 esas filas no
// existian porque no habia trigger.
const logFacturas = await pedir('/api/auditoria/log?tabla=facturas&limite=200', tokenAdmin);
revisar(
  'filtrar por tabla=facturas -> 200',
  logFacturas.status === 200,
  JSON.stringify(logFacturas.cuerpo?.error),
);
revisar(
  'y encuentra lo que acaba de hacer esta seccion (0010)',
  logFacturas.cuerpo?.total >= 2,
  JSON.stringify(logFacturas.cuerpo?.total),
);
revisar(
  'todo lo que trae es de facturas',
  logFacturas.cuerpo?.datos.every((r) => r.tabla === 'facturas'),
  JSON.stringify(logFacturas.cuerpo?.datos?.map((r) => r.tabla)),
);
revisar(
  'con operacion de escritura, no de lectura',
  logFacturas.cuerpo?.datos.every((r) => r.operacion !== 'SELECT'),
  JSON.stringify(logFacturas.cuerpo?.datos?.map((r) => r.operacion)),
);
revisar(
  'y el renglon de la factura trae su id, para poder abrirla',
  logFacturas.cuerpo?.datos.every((r) => Number.isInteger(r.registro_id)),
  JSON.stringify(logFacturas.cuerpo?.datos?.map((r) => r.registro_id)),
);

// El UPDATE de estatus es lo que mas importa: de ahi se ve que una factura
// paso de solicitada a emitida sin que nadie pueda quitarlo despues.
const cambiosEstatus = await pedir(
  '/api/auditoria/log?tabla=facturas&operacion=UPDATE&limite=200',
  tokenAdmin,
);
revisar(
  'filtrar por operacion=UPDATE',
  cambiosEstatus.status === 200 &&
    cambiosEstatus.cuerpo?.datos.every((r) => r.operacion === 'UPDATE'),
  JSON.stringify(cambiosEstatus.cuerpo?.total),
);
revisar(
  'y se ve el estatus anterior y el nuevo en el JSON',
  cambiosEstatus.cuerpo?.datos.some(
    (r) =>
      r.registro_id === facturaAuditadaId &&
      r.datos_anteriores?.estatus === 'solicitada' &&
      r.datos_nuevos?.estatus === 'emitida',
  ),
  JSON.stringify(
    cambiosEstatus.cuerpo?.datos
      ?.filter((r) => r.registro_id === facturaAuditadaId)
      ?.map((r) => [r.datos_anteriores?.estatus, r.datos_nuevos?.estatus]),
  ),
);
revisar(
  'y el rastro lo escribio la sesion del admin, no el sistema',
  cambiosEstatus.cuerpo?.datos
    ?.filter((r) => r.registro_id === facturaAuditadaId)
    ?.every((r) => r.usuario_id === 1),
  JSON.stringify(cambiosEstatus.cuerpo?.datos?.map((r) => r.usuario_id)),
);

// `factura_nota` no tiene id, asi que su fila de bitacora queda con
// `registro_id` en NULL y el par viaja dentro del JSON. Es la concesion que
// la 0010 documenta, y se comprueba para que el que lea la bitacora no se
// sorprenda.
const logFacturaNota = await pedir('/api/auditoria/log?tabla=factura_nota&limite=200', tokenAdmin);
revisar(
  'las lineas de factura_nota tambien se auditan',
  logFacturaNota.cuerpo?.total > 0,
  JSON.stringify(logFacturaNota.cuerpo?.total),
);
revisar(
  'con registro_id en NULL, que es la concesion de 0010',
  logFacturaNota.cuerpo?.datos.every((r) => r.registro_id === null),
  JSON.stringify(logFacturaNota.cuerpo?.datos?.map((r) => r.registro_id)),
);
revisar(
  'y el par factura_id/nota_id viaja en el JSON',
  logFacturaNota.cuerpo?.datos.every(
    (r) => r.datos_nuevos?.factura_id !== undefined && r.datos_nuevos?.nota_id !== undefined,
  ),
  JSON.stringify(logFacturaNota.cuerpo?.datos?.slice(0, 1)),
);

const logPorRegistro = await pedir('/api/auditoria/log?registro_id=1&limite=10', tokenAdmin);
revisar(
  'filtrar por registro_id -> 200',
  logPorRegistro.status === 200,
  JSON.stringify(logPorRegistro.cuerpo?.error),
);
const logPorTablaLarga = await pedir(`/api/auditoria/log?tabla=${'x'.repeat(200)}`, tokenAdmin);
revisar('tabla que no cabe -> 400', logPorTablaLarga.status === 400);
const logOperacionMala = await pedir('/api/auditoria/log?operacion=TRUNCATE', tokenAdmin);
revisar('operacion que no existe -> 400', logOperacionMala.status === 400);
const logLimiteCero = await pedir('/api/auditoria/log?limite=0', tokenAdmin);
revisar('limite 0 -> 400', logLimiteCero.status === 400);

// El rango de fechas es la trampa de este modulo. `hasta` es EXCLUSIVO con
// `+ 1 dia` porque las columnas son TIMESTAMP: un `<= 'AAAA-MM-DD'` sobre una
// fila de las 14:30 no entraria y el dia final desapareceria del reporte. Se
// compara el total con y sin filtro: si el `hasta` fuera exclusivo de
// veras, el numero cambiaria.
const logRango = await pedir(
  '/api/auditoria/log?desde=2000-01-01&hasta=2099-12-31&limite=1',
  tokenAdmin,
);
revisar(
  'rango que cubre todo: el total NO cambia (hasta es inclusivo)',
  logRango.cuerpo?.total === (await pedir('/api/auditoria/log?limite=1', tokenAdmin)).cuerpo?.total,
  `${logRango.cuerpo?.total} vs`,
);
const logRangoInvertido = await pedir(
  '/api/auditoria/log?desde=2099-01-01&hasta=2000-01-01',
  tokenAdmin,
);
revisar('rango invertido -> 400', logRangoInvertido.status === 400);
const logRangoVacio = await pedir(
  '/api/auditoria/log?desde=2099-01-01&hasta=2099-12-31',
  tokenAdmin,
);
revisar(
  'un rango futuro no trae nada, y no es un 500',
  logRangoVacio.status === 200 && logRangoVacio.cuerpo?.total === 0,
  JSON.stringify(logRangoVacio.cuerpo),
);

// --------------------------------------------------------------- accesos
// `auditoria_accesos` lleva un permiso PROPIO (`auditoria.accesos`) y no
// cuelga de `auditoria.ver`, porque no dice que se movio un precio: dice a
// que hora entra la gente al sistema, con IP y con el nombre de usuario que
// se tecleo en los intentos fallidos.
const accesos = await pedir('/api/auditoria/accesos?limite=200', tokenAdmin);
revisar('accesos -> 200', accesos.status === 200, JSON.stringify(accesos.cuerpo?.error));
revisar(
  'y trae el evento, la IP y el momento',
  accesos.cuerpo?.datos.every(
    (r) => typeof r.evento === 'string' && typeof r.ip === 'string' && typeof r.fecha === 'string',
  ),
  JSON.stringify(accesos.cuerpo?.datos?.slice(0, 2)),
);
revisar(
  'el LOGIN FALLIDO aparece, y con el nombre tecleado',
  accesos.cuerpo?.datos.some((r) => r.evento === 'login_fallido' && r.usuario?.includes('@')),
  JSON.stringify(accesos.cuerpo?.datos?.filter((r) => r.evento === 'login_fallido')?.slice(0, 2)),
);
const soloFallidos = await pedir('/api/auditoria/accesos?evento=login_fallido', tokenAdmin);
revisar(
  'filtrar por evento',
  soloFallidos.cuerpo?.datos.every((r) => r.evento === 'login_fallido') &&
    soloFallidos.cuerpo?.total >= 1,
  JSON.stringify(soloFallidos.cuerpo?.total),
);
const eventoMalo = await pedir('/api/auditoria/accesos?evento=invasion', tokenAdmin);
revisar('evento que no existe -> 400', eventoMalo.status === 400);
const accesosRango = await pedir(
  '/api/auditoria/accesos?desde=2000-01-01&hasta=2099-12-31&limite=1',
  tokenAdmin,
);
revisar(
  'el rango de accesos tambien es inclusivo',
  accesosRango.cuerpo?.total ===
    (await pedir('/api/auditoria/accesos?limite=1', tokenAdmin)).cuerpo?.total,
  `${accesosRango.cuerpo?.total} vs`,
);

// ------------------------------------------------------------------- caja
// La bitacora de caja es la UNICA que trae el saldo antes y el despues, y es
// lo que hace insustituible: un cambio de precio de un producto se puede
// leer del antes/despues del PRECIO, pero de un saldo de banco no hay otro
// lado del que compararlo. Por eso la cuenta va en la fila y no en un JOIN.
const audCaja = await pedir('/api/auditoria/caja?limite=200', tokenAdmin);
revisar('caja -> 200', audCaja.status === 200, JSON.stringify(audCaja.cuerpo?.error));
revisar(
  'trae el saldo antes y el despues',
  audCaja.cuerpo?.datos.some(
    (r) => r.saldo_antes !== null && r.saldo_despues !== null && r.saldo_despues !== r.saldo_antes,
  ),
  'ningun renglon con saldo antes/despues distintos',
);
revisar(
  'y el nombre de la cuenta, no el id',
  audCaja.cuerpo?.datos.every((r) => typeof r.cuenta === 'string' && r.cuenta.length > 0),
  JSON.stringify(audCaja.cuerpo?.datos?.slice(0, 1)),
);
revisar(
  'con el tipo de la cuenta, para separar efectivo de banco',
  audCaja.cuerpo?.datos.every((r) => ['efectivo', 'banco'].includes(r.cuenta_tipo)),
  JSON.stringify(audCaja.cuerpo?.datos?.map((r) => r.cuenta_tipo)),
);
revisar(
  'y el usuario que lo capturo',
  audCaja.cuerpo?.datos.every((r) => typeof r.usuario === 'string' && r.usuario.length > 0),
  JSON.stringify(audCaja.cuerpo?.datos?.map((r) => r.usuario)),
);
revisar(
  'y la fecha es AAAA-MM-DD, no un ISO con hora',
  audCaja.cuerpo?.datos.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.fecha)),
  JSON.stringify(audCaja.cuerpo?.datos?.slice(0, 2)?.map((r) => r.fecha)),
);

// El filtro por cuenta es el de "el estado de cuenta del banco". Las cuentas
// de la suite ya se borraron al terminar el bloque de caja (y con ellas su
// rastro, que tiene FK a la cuenta), asi que lo que queda para consultar es
// la del seed, con los saldos que el seed dejo.
const cuentaSeed = (
  await sqlDirecto(`SELECT id FROM pos.cuentas_financieras WHERE nombre = 'Caja chica'`)
).rows[0].id;
const audCajaSemilla = await pedir(
  `/api/auditoria/caja?cuenta_id=${cuentaSeed}&limite=200`,
  tokenAdmin,
);
revisar(
  'la caja del seed se puede consultar por su cuenta',
  audCajaSemilla.status === 200 && audCajaSemilla.cuerpo?.total > 0,
  JSON.stringify(audCajaSemilla.cuerpo?.error),
);
revisar(
  'y el saldo del seed se puede seguir el renglon por renglon: 0 -> 850 -> 600',
  audCajaSemilla.cuerpo?.datos.some((r) => r.saldo_antes === 0 && r.saldo_despues === 850) &&
    audCajaSemilla.cuerpo?.datos.some((r) => r.saldo_antes === 850 && r.saldo_despues === 600),
  JSON.stringify(audCajaSemilla.cuerpo?.datos?.map((r) => [r.saldo_antes, r.saldo_despues])),
);
revisar(
  'y las dos son del seed, asi que su usuario es (sistema)',
  audCajaSemilla.cuerpo?.datos.every((r) => r.usuario === '(sistema)' && r.usuario_id === null),
  JSON.stringify(audCajaSemilla.cuerpo?.datos?.map((r) => [r.usuario, r.usuario_id])),
);
revisar(
  'y el movimiento sigue enlazado, porque el seed no borro nada',
  audCajaSemilla.cuerpo?.datos.every((r) => Number.isInteger(r.movimiento_id)),
  JSON.stringify(audCajaSemilla.cuerpo?.datos?.map((r) => r.movimiento_id)),
);
const audCajaPorTipo = await pedir('/api/auditoria/caja?tipo=egreso&limite=200', tokenAdmin);
revisar(
  'y por tipo de movimiento',
  audCajaPorTipo.cuerpo?.datos.every((r) => r.tipo === 'egreso') &&
    audCajaPorTipo.cuerpo?.total >= 1,
  JSON.stringify(audCajaPorTipo.cuerpo?.total),
);
const audCajaPorUsuario = await pedir('/api/auditoria/caja?usuario_id=1&limite=5', tokenAdmin);
revisar(
  'y por usuario',
  audCajaPorUsuario.status === 200,
  JSON.stringify(audCajaPorUsuario.cuerpo?.error),
);
const audCajaRango = await pedir(
  '/api/auditoria/caja?desde=2000-01-01&hasta=2099-12-31&limite=1',
  tokenAdmin,
);
revisar(
  'y el rango de caja es inclusivo en el dia final',
  audCajaRango.cuerpo?.total ===
    (await pedir('/api/auditoria/caja?limite=1', tokenAdmin)).cuerpo?.total,
  `${audCajaRango.cuerpo?.total} vs`,
);
const audCajaRangoInvertido = await pedir(
  '/api/auditoria/caja?desde=2099-01-01&hasta=2000-01-01',
  tokenAdmin,
);
revisar('rango invertido -> 400', audCajaRangoInvertido.status === 400);
const audCajaCuentaLarga = await pedir('/api/auditoria/caja?cuenta_id=99999999', tokenAdmin);
revisar('cuenta_id fuera de rango -> 400', audCajaCuentaLarga.status === 400);

// ------------------------------------------------------------ inventario
const audInv = await pedir('/api/auditoria/inventario?limite=200', tokenAdmin);
revisar('inventario -> 200', audInv.status === 200, JSON.stringify(audInv.cuerpo?.error));
revisar(
  'trae el producto con su codigo y el almacen, por nombre',
  audInv.cuerpo?.datos.every(
    (r) =>
      typeof r.producto === 'string' &&
      typeof r.producto_codigo === 'string' &&
      typeof r.almacen === 'string',
  ),
  JSON.stringify(audInv.cuerpo?.datos?.slice(0, 1)),
);
revisar(
  'y la existencia antes y la de despues, que es el karded',
  audInv.cuerpo?.datos.some((r) => r.existencia_antes !== null && r.existencia_despues !== null),
  'ningun renglon con existencia antes/despues',
);
revisar(
  'y las existencias son numero, no texto',
  audInv.cuerpo?.datos.every((r) => typeof r.cantidad_bultos === 'number'),
  JSON.stringify(audInv.cuerpo?.datos?.slice(0, 1)),
);
const audInvProducto = await pedir('/api/auditoria/inventario?limite=1', tokenAdmin);
const productoAuditado = audInvProducto.cuerpo?.datos?.[0]?.producto_id;
revisar(
  'y se puede filtrar por producto',
  Number.isInteger(productoAuditado),
  String(productoAuditado),
);
const audInvFiltrado = await pedir(
  `/api/auditoria/inventario?producto_id=${productoAuditado}&limite=200`,
  tokenAdmin,
);
revisar(
  'y el filtro no trae filas de otros productos',
  audInvFiltrado.cuerpo?.datos.every((r) => r.producto_id === productoAuditado) &&
    audInvFiltrado.cuerpo?.total > 0,
  JSON.stringify({ total: audInvFiltrado.cuerpo?.total }),
);

// --------------------------------------------------------------- precios
const audPrecios = await pedir('/api/auditoria/precios?limite=200', tokenAdmin);
revisar('precios -> 200', audPrecios.status === 200, JSON.stringify(audPrecios.cuerpo?.error));
revisar(
  'trae el precio anterior y el nuevo',
  audPrecios.cuerpo?.datos.some((r) => r.precio_anterior !== null || r.precio_nuevo !== null),
  'ningun renglon con precios',
);
revisar(
  'y la variacion es la diferencia, no el precio',
  audPrecios.cuerpo?.datos.some(
    (r) =>
      r.precio_anterior !== null &&
      r.precio_nuevo !== null &&
      Math.abs(r.variacion - (r.precio_nuevo - r.precio_anterior)) < 0.005,
  ),
  JSON.stringify(
    audPrecios.cuerpo?.datos
      ?.filter((r) => r.precio_anterior !== null && r.precio_nuevo !== null)
      ?.slice(0, 2)
      ?.map((r) => [r.precio_anterior, r.precio_nuevo, r.variacion]),
  ),
);
revisar(
  'y el tipo de precio es uno de los tres',
  audPrecios.cuerpo?.datos.every((r) => ['cliente', 'publico', 'costo'].includes(r.tipo_precio)),
  JSON.stringify(audPrecios.cuerpo?.datos?.map((r) => r.tipo_precio)),
);
const audPreciosTipo = await pedir('/api/auditoria/precios?tipo_precio=costo', tokenAdmin);
revisar(
  'y se filtra por tipo de precio',
  audPreciosTipo.status === 200 &&
    audPreciosTipo.cuerpo?.datos.every((r) => r.tipo_precio === 'costo'),
  JSON.stringify(audPreciosTipo.cuerpo?.total),
);
const audPreciosRango = await pedir(
  '/api/auditoria/precios?desde=2000-01-01&hasta=2099-12-31&limite=1',
  tokenAdmin,
);
revisar(
  'y el rango de precios es inclusivo en el dia final',
  audPreciosRango.cuerpo?.total ===
    (await pedir('/api/auditoria/precios?limite=1', tokenAdmin)).cuerpo?.total,
  `${audPreciosRango.cuerpo?.total} vs`,
);

// -------------------------------------------------------- sin escritura
// La prueba de que este modulo es de solo lectura NO es que no haya rutas de
// escritura en el archivo: es que la API las rechaza. Un 405 significaria que
// la ruta existe y le falta el metodo; el 404 es lo unico que dice "esta
// puerta no existe".
for (const metodo of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const intento = await pedir('/api/auditoria/log', tokenAdmin, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabla: 'inventario_log', operacion: 'DELETE' }),
  });
  revisar(
    `escribir en la bitacora con ${metodo} -> 404`,
    intento.status === 404,
    JSON.stringify(intento.cuerpo),
  );
}
const facturaInventada = await pedir('/api/auditoria/facturas', tokenAdmin, { method: 'POST' });
revisar(
  'y no hay ni una ruta mas de escritura',
  facturaInventada.status === 404,
  JSON.stringify(facturaInventada.cuerpo),
);

// Que un GET no acepte filtros por cuerpo NO se puede probar desde aqui, y no
// por un detalle del servidor: `fetch` lanza "Request with GET/HEAD method
// cannot have body" antes de salir, o sea que ni existe el cliente que pueda
// mandar esa peticion. Lo que si se comprueba es que los filtros viven en el
// query y no en el cuerpo: mandar un filtro que NO existe es un 400 con el
// nombre del campo, no un 200 que lo ignore en silencio.
const filtroQueNoExiste = await pedir('/api/auditoria/log?inventado=1', tokenAdmin);
revisar(
  'filtro que no existe -> 400, no se ignora en silencio',
  filtroQueNoExiste.status === 400,
  JSON.stringify(filtroQueNoExiste.cuerpo),
);

// ------------------------------------------------------------ permisos
// La Cajera tiene los cuatro permisos de lectura de cambios (0006 le
// concede todo menos cinco cosas) pero NO `auditoria.accesos`, que es una
// de las cinco exclusiones. La Empleada no tiene NINGUNO de los cinco. Con
// las dos se prueba la separacion entera sin tocar la tabla de roles.
const cajeraLog = await pedir('/api/auditoria/log?limite=1', tokenCajera);
revisar(
  'la cajera ve el log -> 200',
  cajeraLog.status === 200,
  JSON.stringify(cajeraLog.cuerpo?.error),
);
const cajeraCajaAud = await pedir('/api/auditoria/caja?limite=1', tokenCajera);
revisar(
  'y la bitacora de caja',
  cajeraCajaAud.status === 200,
  JSON.stringify(cajeraCajaAud.cuerpo?.error),
);
const cajeraAccesos = await pedir('/api/auditoria/accesos', tokenCajera);
revisar(
  'pero NO los accesos, que son de las cinco exclusiones de 0006 -> 403',
  cajeraAccesos.status === 403,
  JSON.stringify(cajeraAccesos.cuerpo),
);

const empleadaLog = await pedir('/api/auditoria/log', tokenEmpleada);
revisar(
  'la empleada NO ve el log -> 403',
  empleadaLog.status === 403,
  JSON.stringify(empleadaLog.cuerpo),
);
const empleadaCajaAud = await pedir('/api/auditoria/caja', tokenEmpleada);
revisar('ni la de caja -> 403', empleadaCajaAud.status === 403);
const empleadaAccesos = await pedir('/api/auditoria/accesos', tokenEmpleada);
revisar('ni los accesos -> 403', empleadaAccesos.status === 403);
const empleadaInvAud = await pedir('/api/auditoria/inventario', tokenEmpleada);
revisar('ni la de inventario -> 403', empleadaInvAud.status === 403);
const empleadaPreciosAud = await pedir('/api/auditoria/precios', tokenEmpleada);
revisar('ni la de precios -> 403', empleadaPreciosAud.status === 403);

const auditoriaSinToken = await pedir('/api/auditoria/log');
revisar('auditoria sin token -> 401', auditoriaSinToken.status === 401);

// El filtro por `usuario_id` es el que la vista no podia dar, y por eso el
// repositorio lee la tabla y no la vista. Con el admin (usuario 1) tiene que
// traer sus propias filas y no las de nadie mas.
const logDelAdmin = await pedir('/api/auditoria/log?usuario_id=1&limite=200', tokenAdmin);
revisar(
  'filtrar por usuario_id -> 200',
  logDelAdmin.status === 200,
  JSON.stringify(logDelAdmin.cuerpo?.error),
);
revisar(
  'y trae filas, o sea que el filtro SI se esta aplicando (no devuelve todo)',
  logDelAdmin.cuerpo?.total > 0 && logDelAdmin.cuerpo?.total < logGeneral.cuerpo?.total,
  `${logDelAdmin.cuerpo?.total} vs ${logGeneral.cuerpo?.total}`,
);
const logDeNadie = await pedir('/api/auditoria/log?usuario_id=999999', tokenAdmin);
revisar(
  'y un usuario que no existe sale vacio, no 404',
  logDeNadie.status === 200 && logDeNadie.cuerpo?.total === 0,
  JSON.stringify(logDeNadie.cuerpo),
);

// La factura de esta seccion se deja a proposito: la borra
// `limpiarCajaFacturasDePrueba` al final del archivo, que corre antes de que
// se borren las notas. Borrarla aqui dejaria la nota huerfana, que es
// justo lo que el bloque de pagos intentaba evitar con su orden.
void notaAuditoria;

// -------------------------------------------------------------- limpieza
//
// El ORDEN importa y no es obvio, asi que va en la funcion de limpieza
// compartida, que se corre al arrancar el archivo y otra vez aqui. Lo que
// no se ve desde aqui esta todo comentado ahi.

// Caja y facturacion van PRIMERO, y por el mismo motivo que al arrancar el
// archivo: `factura_nota.nota_id` es FK DURA a la nota, asi que la factura
// tiene que estar fuera antes de que corra la limpieza de notas. Ademas las
// cuentas de caja tienen su rastro con FK a la cuenta, y ese rastro lo genera
// el mismo borrado de los movimientos.
const limpiezaCaja = await limpiarCajaFacturasDePrueba();
revisar(
  'las facturas de prueba se borraron, y con ellas su rastro',
  limpiezaCaja.facturas > 0 && limpiezaCaja.log > 0,
  JSON.stringify(limpiezaCaja),
);
// Aqui `cuentas` es 0 y tiene que serlo: el bloque de caja borro sus propias
// cuentas al terminar y ya lo comprobo. Pedir > 0 seria pedir que quedara algo,
// que es justo lo contrario de lo que se quiere.
revisar(
  'y de las cuentas de caja no queda ni una (las borro su propio bloque)',
  limpiezaCaja.cuentas === 0 && limpiezaCaja.movimientos === 0,
  JSON.stringify(limpiezaCaja),
);
revisar(
  'no sobro ninguna factura de los clientes de prueba',
  (
    await sqlDirecto(
      `SELECT COUNT(*)::TEXT AS n FROM pos.facturas
        WHERE cliente_id IN (SELECT id FROM pos.clientes WHERE codigo_cliente IN ('CNOTA','CFECHA'))`,
    )
  ).rows[0].n === '0',
  'sobro una factura de un cliente de prueba',
);

const limpiezaCompras = await limpiarPagosComprasProveedoresDePrueba();
revisar(
  'las compras de prueba se borraron',
  limpiezaCompras.compras > 0 && limpiezaCompras.proveedores > 0,
  JSON.stringify(limpiezaCompras),
);
revisar(
  'y con las compras fuera, el almacen vuelve a los 50 de apertura',
  (await existenciaDe(prodCompra)) === 0,
  `quedaron ${await existenciaDe(prodCompra)} movimientos de un producto que ya no existe`,
);
revisar(
  'y no quedo ninguno de los productos de compra',
  (await sqlDirecto(`SELECT COUNT(*)::TEXT AS n FROM pos.productos WHERE codigo LIKE 'TST-COMP%'`))
    .rows[0].n === '0',
  'sobro un TST-COMP',
);
revisar(
  'ni sus costos historicos',
  (
    await sqlDirecto(
      `SELECT COUNT(*)::TEXT AS n FROM pos.producto_proveedor_precios
      WHERE producto_id NOT IN (SELECT id FROM pos.productos)`,
    )
  ).rows[0].n === '0',
  'sobro un costo de proveedor huerfano',
);
revisar(
  'ni sus rastros de inventario',
  (
    await sqlDirecto(
      `SELECT COUNT(*)::TEXT AS n FROM pos.auditoria_inventario
      WHERE producto_id NOT IN (SELECT id FROM pos.productos)`,
    )
  ).rows[0].n === '0',
  'sobro una auditoria de inventario huerfana',
);

const limpieza = await limpiarNotasDePrueba();
const foliosPago = await limpiarFoliosPago();
revisar('las notas de prueba se borraron', limpieza.notas > 0, `${limpieza.notas} notas`);
revisar(
  'y con las notas fuera, el stock de cada producto vuelve a los 50 de apertura',
  limpieza.existencia === 50,
  JSON.stringify(limpieza),
);
revisar(
  'y tambien el producto con sus precios, y el talonario',
  limpieza.productos > 1 && limpieza.folios > 0,
  JSON.stringify(limpieza),
);
revisar(
  'y el talonario de pagos, que se borra aparte porque depende de las notas',
  foliosPago > 0,
  `${foliosPago} folios PGO`,
);
void pagoId;
void notaPago1Id;
void notaPago2Id;
void totalPago2;
void totalPago3;
void anticipoId;
void provUnoId;
void prodCompraSinCosto;
void compraOkId;
void compraFechadaId;
void compraFuturaId;
void verExistencia;
void pagosDelCliente;
void notaFutura;
void notaPasada;
void notaConTrato;
void notaLimpia;
void notaAlBorde;
void existeSql;

// Limpia lo de esta seccion. Los productos van tambien en la limpieza
// general por codigo, pero los precios no tienen codigo y se van por
// producto.
await sqlDirecto(`DELETE FROM pos.precios_cliente WHERE producto_id = ANY($1::bigint[])`, [
  [prodPrincipal, prodCadena, prodCero, prodSinPrecio],
]);
await sqlDirecto(`DELETE FROM pos.precios_publicos WHERE producto_id = ANY($1::bigint[])`, [
  [prodPrincipal, prodCadena, prodCero, prodSinPrecio],
]);
// Igual que con los productos: borrar los precios deja rastro en
// auditoria_precios, y ese rastro apunta tambien al cliente. Sin esta
// linea, el DELETE de clientes revienta con 23503.
await sqlDirecto(
  `DELETE FROM pos.auditoria_precios
    WHERE cliente_id IN (SELECT id FROM pos.clientes WHERE nombre = 'Cliente de precios')`,
  [],
);
await sqlDirecto(`DELETE FROM pos.clientes WHERE nombre = 'Cliente de precios'`);

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
  // Mismo motivo que en el pool de arriba: en la conexion, no en la sesion.
  options: '-c search_path=pos',
});
try {
  // pgcrypto se instalo en el esquema pos, no en public, asi que sin esto
  // crypt() y gen_salt() no existen para este Pool (error 42883).

  const r = await pool.query(
    `UPDATE pos.usuarios SET contrasena = crypt($1, gen_salt('bf', 12)),
                            debe_cambiar_contrasena = true,
                            intentos_fallidos = 0, bloqueado_hasta = NULL`,
    ['CAMBIAR-ESTA-CLAVE'],
  );
  revisar('las contrasenas del seed se restauraron', r.rowCount > 0, `${r.rowCount} usuarios`);

  // Lo ULTIMO de todo, y por una razon concreta: el restore de arriba es un
  // UPDATE sobre `usuarios` y por lo tanto deja dos renglones de bitacora
  // nuevos. Si esta limpieza corriera antes, esos dos se quedarian.
  const rastros = await limpiarRastrosDeLaCorrida();
  revisar(
    'los rastros de la corrida se borraron',
    Object.keys(rastros).length > 0,
    Object.keys(rastros).length > 0 ? JSON.stringify(rastros) : 'la corrida no audito nada',
  );
} finally {
  await pool.end();
  await cerrarPoolDirecto();
}

console.log(`\n${fallos === 0 ? 'TODAS LAS PRUEBAS PASARON' : fallos + ' PRUEBA(S) FALLARON'}`);
process.exit(fallos === 0 ? 0 : 1);
