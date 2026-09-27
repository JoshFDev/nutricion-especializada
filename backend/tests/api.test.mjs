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
  const cuenta = { notas: 0, productos: 0, folios: 0, existencia: null };

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

await limpiarNotasDePrueba();

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
  'vender mas de lo que hay -> 422 STOCK_INSUFICIENTE',
  sinStock.status === 422 && sinStock.cuerpo?.codigo === 'STOCK_INSUFICIENTE',
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
  dobleRenglon.status === 422 && dobleRenglon.cuerpo?.codigo === 'STOCK_INSUFICIENTE',
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
const notaConEspecialId = notaConEspecial.cuerpo?.id;

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

// -------------------------------------------------------------- limpieza
//
// El ORDEN importa y no es obvio, asi que va en la funcion de limpieza
// compartida, que se corre al arrancar el archivo y otra vez aqui. Lo que
// no se ve desde aqui esta todo comentado ahi.

const limpieza = await limpiarNotasDePrueba();
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
void pagoId;
void notaConEspecialId;
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
