import { createHash } from "node:crypto";
import { createGunzip, createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { statvfs } from "node:fs";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { app } from "electron";
import pg from "pg";
import { aplicarTodasLasMigraciones } from "./migraciones.js";

/**
 * Respaldos logicos de la base `pos`.
 *
 * Por que no `pg_dump`. El PostgreSQL que viaja dentro de la aplicacion
 * (`embedded-postgres`) trae el servidor y `initdb`, pero NO trae las
 * herramientas de cliente: en el paquete de Windows no existe `pg_dump`,
 * `pg_restore` ni `psql`. Se comprobo sobre los binarios empaquetados.
 *
 * Por eso el respaldo se arma desde la propia conexion: se lee cada tabla
 * como JSON y se escribe un NDJSON comprimido con gzip. Un renglon por fila:
 *
 *   {"t":"meta","formato":1,...}          cabecera, una sola vez
 *   {"t":"f","tabla":"productos","d":{...}} una fila
 *   {"t":"fin","filas":{"productos":123}} resumen, para detectar archivos
 *                                         truncados antes de confirmar
 *
 * Ventajas de este formato para una sola computadora:
 *
 *   - No depende de binarios externos ni de la version exacta del servidor.
 *   - Se puede leer y revisar (es texto comprimido) si algun dia hace falta.
 *   - La restauracion inserta con `json_populate_recordset`, en lotes, sin
 *     construir un INSERT gigante en memoria.
 *
 * Lo que NO se respalda, a proposito:
 *
 *   - `schema_migrations`: se reconstruye aplicando las migraciones actuales.
 *   - `sesiones`: son credenciales vivas. Restaurarlas dejaria sesiones
 *     abiertas de antes del respaldo; despues de restaurar, todos vuelven a
 *     entrar con su contrasena.
 */

const FORMATO = 1;
const ESQUEMA = "pos";
const LOTE_ESCRITURA = 500;
const LOTE_LECTURA = 500;
const MAX_AUTOMATICOS = 30;

/** Extensión del archivo de checksum que acompaña a cada respaldo. */
const EXTENSION_CHECKSUM = ".sha256";

/** Tablas que no se exportan (ver la explicacion de arriba). */
const TABLAS_EXCLUIDAS = new Set(["schema_migrations", "sesiones"]);

export interface ConfiguracionPg {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type TipoRespaldo = "automatico" | "manual" | "seguridad";

export interface ResumenRespaldo {
  /** Nombre del archivo, que es lo que se le pasa a `restaurar`. */
  nombre: string;
  /** Ruta absoluta, para abrir la carpeta o mostrarla. */
  ruta: string;
  /** Tamano en bytes. */
  tamano: number;
  /** Fecha de modificacion en ISO. */
  creadoEn: string;
  tipo: TipoRespaldo;
}

interface TablaRespaldo {
  nombre: string;
  columnas: string[];
}

interface MetaRespaldo {
  t: "meta";
  formato: number;
  esquema: string;
  creadoEn: string;
  versionApp: string;
  tablas: TablaRespaldo[];
}

interface FilaRespaldo {
  t: "f";
  tabla: string;
  d: Record<string, unknown>;
}

interface FinRespaldo {
  t: "fin";
  filas: Record<string, number>;
}

export interface ResultadoRestauracion {
  /** Cuantas tablas se importaron. */
  tablas: number;
  /** Cuantas filas se insertaron en total. */
  filas: number;
}

/** Escapa un identificador de SQL (tabla o columna). */
function ident(nombre: string): string {
  return `"${nombre.replace(/"/g, '""')}"`;
}

function marcaDeTiempo(): string {
  // `:` y `.` no son validos en un nombre de archivo en Windows.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function tipoDe(nombre: string): TipoRespaldo {
  if (nombre.startsWith("automatico-")) return "automatico";
  if (nombre.startsWith("seguridad-")) return "seguridad";
  return "manual";
}

function nombreDeArchivo(tipo: TipoRespaldo): string {
  const prefijo =
    tipo === "automatico"
      ? "automatico"
      : tipo === "seguridad"
        ? "seguridad"
        : "respaldo";
  return `${prefijo}-${marcaDeTiempo()}.json.gz`;
}

function nombreArchivoChecksum(nombre: string): string {
  return `${nombre}${EXTENSION_CHECKSUM}`;
}

/**
 * Resultado de la validación de integridad de un respaldo.
 */
export interface ResultadoValidacion {
  /** Si el respaldo pasa todas las comprobaciones. */
  valido: boolean;
  /** Errores encontrados, si los hay. */
  errores: string[];
  /** Cabecera del respaldo, si se pudo leer. */
  meta?: MetaRespaldo;
  /** Checksum calculado del archivo. */
  checksum: string;
}

/**
 * Calcula el hash SHA-256 de un archivo.
 */
async function calcularChecksum(ruta: string): Promise<string> {
  const hash = createHash("sha256");
  const entrada = createReadStream(ruta);
  for await (const fragmento of entrada) {
    hash.update(fragmento);
  }
  return hash.digest("hex");
}

/**
 * Valida la integridad de un respaldo antes de restaurarlo.
 *
 * Comprueba:
 *   - Que el archivo exista y termine en `.json.gz`.
 * *   - Que la cabecera `meta` tenga formato, esquema y tablas válidos.
 *   - Que el resumen `fin` exista y las filas esperadas coincidan con las
 *     reales del archivo (detecta archivos truncados).
 *   - Que el checksum del archivo coincida con el archivo `.sha256`
 *     acompañado, si existe.
 *
 * No modifica la base de datos: es solo de lectura.
 */
export async function validarIntegridadRespaldo(
  config: ConfiguracionPg,
  carpeta: string,
  nombre: string,
): Promise<ResultadoValidacion> {
  const errores: string[] = [];

  if (basename(nombre) !== nombre || !nombre.endsWith(".json.gz")) {
    return {
      valido: false,
      errores: ["El nombre del respaldo no es valido."],
      meta: undefined,
      checksum: "",
    };
  }

  const ruta = join(carpeta, nombre);

  let existe = false;
  try {
    await stat(ruta);
    existe = true;
  } catch {
    /* archivo no existe */
  }
  if (!existe) {
    return {
      valido: false,
      errores: ["El archivo del respaldo no existe."],
      meta: undefined,
      checksum: "",
    };
  }

  const checksum = await calcularChecksum(ruta);

  // Verificar el archivo .sha256 si lo hay.
  const rutaChecksum = join(carpeta, nombreArchivoChecksum(nombre));
  try {
    const contenido = await readFile(rutaChecksum, "utf8");
    const esperadoLimpio = contenido.split(/\s+/)[0] ?? "";
    if (esperadoLimpio && esperadoLimpio !== checksum) {
      errores.push(
        "El checksum del archivo no coincide con el registro de seguridad. El archivo pudo haberse modificado o corrompido.",
      );
    }
  } catch {
    // No hay archivo de checksum: no es un error, solo no se puede verificar.
  }

  // Leer y validar la cabecera.
  let meta: MetaRespaldo | undefined;
  try {
    meta = await leerMeta(ruta);
  } catch (error) {
    errores.push(
      `No se pudo leer la cabecera del respaldo: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      valido: false,
      errores,
      meta: undefined,
      checksum,
    };
  }

  if (!meta || meta.formato !== FORMATO) {
    errores.push("El formato del respaldo no es compatible con esta version.");
  }
  if (meta.esquema !== ESQUEMA) {
    errores.push(
      "El esquema del respaldo no coincide con el de la base actual.",
    );
  }
  if (!Array.isArray(meta.tablas) || meta.tablas.length === 0) {
    errores.push("El respaldo no contiene tablas definidas.");
  }

  // Leer el resumen final y comparar filas esperadas vs reales.
  let filasReales: Record<string, number> = {};
  try {
    const entrada = createReadStream(ruta).pipe(createGunzip());
    const lector = createInterface({ input: entrada, crlfDelay: Infinity });
    let vistoFin = false;
    try {
      for await (const linea of lector) {
        if (!linea.trim()) continue;
        const valor = JSON.parse(linea) as Record<string, unknown>;
        if (valor["t"] === "fin") {
          const filas = valor["filas"];
          filasReales =
            filas !== null && typeof filas === "object"
              ? (filas as Record<string, number>)
              : {};
          vistoFin = true;
        }
      }
    } finally {
      lector.close();
      entrada.destroy();
    }
    if (!vistoFin) {
      errores.push(
        "El respaldo no trae el resumen final; puede estar incompleto.",
      );
    }
  } catch (error) {
    errores.push(
      `No se pudo leer el resumen del respaldo: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const valido = errores.length === 0;
  return { valido, errores, meta, checksum };
}

/** Estado de salud de los respaldos. */
export type SaludRespaldos = "saludable" | "advertencia" | "critico";

/** Resultado de la evaluacion de salud de los respaldos. */
export interface ResultadoSaludRespaldos {
  /** Estado general: saludable, advertencia o critico. */
  estado: SaludRespaldos;
  /** Fecha del ultimo respaldo (cualquier tipo), si hay alguno. */
  ultimoRespaldo: string | null;
  /** Dias transcurridos desde el ultimo respaldo. */
  diasDesdeUltimo: number | null;
  /** Mensaje legible para mostrar al usuario. */
  mensaje: string;
}

/**
 * Evalua la salud de los respaldos basado en la fecha del ultimo archivo.
 *
 * - saludable: menos de 7 dias sin respaldo.
 * - advertencia: entre 7 y 14 dias sin respaldo.
 * - critico: mas de 14 dias sin respaldo, o nunca hubo uno.
 */
export async function obtenerSaludRespaldos(
  carpeta: string,
): Promise<ResultadoSaludRespaldos> {
  const respaldos = await listarRespaldos(carpeta);

  const ahora = Date.now();
  const DIAS_SALUDABLE = 7;
  const DIAS_ADVERTENCIA = 14;

  if (respaldos.length === 0) {
    return {
      estado: "critico",
      ultimoRespaldo: null,
      diasDesdeUltimo: null,
      mensaje:
        "No hay respaldos. Crea uno ahora para proteger los datos del negocio.",
    };
  }

  const ultimo = respaldos[0]; // Ya estan ordenados del mas nuevo al mas viejo.
  const dias = Math.floor(
    (ahora - new Date(ultimo.creadoEn).getTime()) / (1000 * 60 * 60 * 24),
  );

  let estado: SaludRespaldos;
  let mensaje: string;

  if (dias < DIAS_SALUDABLE) {
    estado = "saludable";
    mensaje = `Ultimo respaldo hace ${dias} dia(s). Los datos estan protegidos.`;
  } else if (dias < DIAS_ADVERTENCIA) {
    estado = "advertencia";
    mensaje = `Hace ${dias} dias sin respaldo. Se recomienda crear uno pronto.`;
  } else {
    estado = "critico";
    mensaje = `Hace ${dias} dias sin respaldo. Los datos estan en riesgo.`;
  }

  return {
    estado,
    ultimoRespaldo: ultimo.creadoEn,
    diasDesdeUltimo: dias,
    mensaje,
  };
}

/** Los respaldos que hay en la carpeta, del mas nuevo al mas viejo. */
export async function listarRespaldos(
  carpeta: string,
): Promise<ResumenRespaldo[]> {
  let archivos: string[];
  try {
    archivos = await readdir(carpeta);
  } catch {
    return [];
  }

  const respaldos: ResumenRespaldo[] = [];
  for (const nombre of archivos) {
    if (!nombre.endsWith(".json.gz")) continue;
    const ruta = join(carpeta, nombre);
    try {
      const info = await stat(ruta);
      if (!info.isFile()) continue;
      respaldos.push({
        nombre,
        ruta,
        tamano: info.size,
        creadoEn: info.mtime.toISOString(),
        tipo: tipoDe(nombre),
      });
    } catch {
      // Un archivo que se borro entre el readdir y el stat: se ignora.
    }
  }

  return respaldos.sort((a, b) => b.creadoEn.localeCompare(a.creadoEn));
}

/** Las tablas y columnas que se pueden insertar (sin columnas generadas). */
async function leerColumnas(
  cliente: pg.ClientBase,
): Promise<Map<string, string[]>> {
  const resultado = await cliente.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = $1
        AND t.table_type = 'BASE TABLE'
        AND c.is_generated = 'NEVER'
      ORDER BY c.table_name, c.ordinal_position`,
    [ESQUEMA],
  );

  const tablas = new Map<string, string[]>();
  for (const fila of resultado.rows) {
    const nombre = String(fila.table_name);
    if (TABLAS_EXCLUIDAS.has(nombre)) continue;
    const columnas = tablas.get(nombre) ?? [];
    columnas.push(String(fila.column_name));
    tablas.set(nombre, columnas);
  }
  return tablas;
}

/**
 * Crea un respaldo completo.
 *
 * Se hace dentro de una transaccion `REPEATABLE READ READ ONLY`: todas las
 * tablas se leen de la misma foto, aunque alguien este vendiendo mientras
 * tanto. Sin eso, una venta podria quedar con su nota pero sin su pago (o al
 * reves) y el respaldo seria incoherente.
 */
/** Informacion de espacio en disco para una ruta dada. */
export interface EspacioDisco {
  /** Espacio libre en bytes. */
  libre: number;
  /** Espacio total en bytes. */
  total: number;
}

/**
 * Devuelve el espacio libre y total en disco para la carpeta indicada.
 *
 * Usa `statvfs` para consultar el sistema de archivos sin necesidad de
 * crear archivos temporales. No lanza: si falla, devuelve ceros.
 */
export async function obtenerEspacioDisponible(
  ruta: string,
): Promise<EspacioDisco> {
  try {
    const info = statvfs(ruta);
    const bloqueSize = info.bsize || info.frsize || 4096;
    return {
      libre: info.bavail * bloqueSize,
      total: info.blocks * bloqueSize,
    };
  } catch {
    return { libre: 0, total: 0 };
  }
}

/**
 * Espacio minimo recomendado libre antes de crear un respaldo (50 MB).
 */
const ESPACIO_MINIMO_RECOMENDADO = 50 * 1024 * 1024;

/**
 * Umbral por debajo del cual se advierte que el disco esta casi lleno (100 MB).
 */
const ESPACIO_UMBRAL_ADVERTENCIA = 100 * 1024 * 1024;

export async function crearRespaldo(
  config: ConfiguracionPg,
  carpeta: string,
  tipo: TipoRespaldo = "manual",
): Promise<ResumenRespaldo> {
  const nombre = nombreDeArchivo(tipo);
  const ruta = join(carpeta, nombre);

  // Verificar espacio en disco antes de empezar. Si queda menos del
  // umbral recomendado, abortamos con un mensaje claro en vez de fallar
  // a mitad de escritura con un archivo corrupto.
  const espacio = await obtenerEspacioDisponible(carpeta);
  if (espacio.libre < ESPACIO_MINIMO_RECOMENDADO) {
    throw new Error(
      `No hay suficiente espacio en disco para crear el respaldo. ` +
        `Quedan ${Math.floor(espacio.libre / 1024 / 1024)} MB libres; ` +
        `se recomiendan al menos 50 MB.`,
    );
  }

  const cliente = new pg.Client({ ...config, client_encoding: "UTF8" });
  await cliente.connect();

  const salida = createWriteStream(ruta, { flags: "wx" });
  const gzip = createGzip({ level: 6 });

  /**
   * `pipeline` y no `gzip.pipe(salida)`: asi un error de disco o de gzip
   * rechaza esta promesa y destruye las dos corrientes. Con `.pipe` un error
   * del compresor no cierra el archivo y el `await` del final se quedaba
   * esperando para siempre.
   */
  const completado = pipeline(gzip, salida);

  const escribir = async (texto: string): Promise<void> => {
    if (!gzip.write(`${texto}\n`)) {
      await once(gzip, "drain");
    }
  };

  try {
    const tablas = await leerColumnas(cliente);

    const meta: MetaRespaldo = {
      t: "meta",
      formato: FORMATO,
      esquema: ESQUEMA,
      creadoEn: new Date().toISOString(),
      versionApp: app.getVersion(),
      tablas: [...tablas.entries()].map(([nombreTabla, columnas]) => ({
        nombre: nombreTabla,
        columnas,
      })),
    };
    await escribir(JSON.stringify(meta));

    const filas: Record<string, number> = {};

    await cliente.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      for (const [tabla, columnas] of tablas) {
        const lista = columnas.map(ident).join(", ");
        await cliente.query(
          `DECLARE respaldo_cursor NO SCROLL CURSOR FOR
             SELECT row_to_json(t)::text AS fila
               FROM (SELECT ${lista} FROM ${ESQUEMA}.${ident(tabla)}) t`,
        );

        let contador = 0;
        for (;;) {
          const lote = await cliente.query<{ fila: string }>(
            `FETCH ${LOTE_LECTURA} FROM respaldo_cursor`,
          );
          const cantidad = lote.rows.length;
          if (cantidad === 0) break;

          for (const renglon of lote.rows) {
            const fila: FilaRespaldo = {
              t: "f",
              tabla,
              d: JSON.parse(renglon.fila) as Record<string, unknown>,
            };
            await escribir(JSON.stringify(fila));
          }
          contador += cantidad;
        }

        await cliente.query("CLOSE respaldo_cursor");
        filas[tabla] = contador;
      }
      await cliente.query("COMMIT");
    } catch (error) {
      await cliente.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    const fin: FinRespaldo = { t: "fin", filas };
    await escribir(JSON.stringify(fin));

    gzip.end();
    await completado;

    // Escribir el archivo de checksum (.sha256) junto al respaldo para
    // poder verificar su integridad antes de restaurar.
    const checksum = await calcularChecksum(ruta);
    await writeFile(
      join(carpeta, nombreArchivoChecksum(nombre)),
      `${checksum}  ${nombre}\n`,
      "utf8",
    );

    const info = await stat(ruta);
    console.log(`[respaldos] Creado ${nombre} (${info.size} bytes)`);
    return {
      nombre,
      ruta,
      tamano: info.size,
      creadoEn: info.mtime.toISOString(),
      tipo,
    };
  } catch (error) {
    gzip.destroy();
    salida.destroy();
    await completado.catch(() => undefined);
    await unlink(ruta).catch(() => undefined);
    await unlink(join(carpeta, nombreArchivoChecksum(nombre))).catch(
      () => undefined,
    );
    throw error;
  } finally {
    await cliente.end().catch(() => undefined);
  }
}

/**
 * Crea un respaldo automatico solo si el ultimo tiene mas de `horasMinimas`.
 *
 * Se llama al arrancar y al cerrar. El umbral evita que abrir y cerrar la
 * aplicacion tres veces seguidas llene la carpeta de copias identicas; el
 * respaldo diario (o el del cierre, si paso el tiempo) sigue ocurriendo.
 */
export async function crearRespaldoAutomatico(
  config: ConfiguracionPg,
  carpeta: string,
  horasMinimas: number,
): Promise<ResumenRespaldo | null> {
  const respaldos = await listarRespaldos(carpeta);
  const ultimo = respaldos.find((respaldo) => respaldo.tipo === "automatico");

  if (ultimo) {
    const edadHoras =
      (Date.now() - new Date(ultimo.creadoEn).getTime()) / 3_600_000;
    if (edadHoras < horasMinimas) return null;
  }

  const nuevo = await crearRespaldo(config, carpeta, "automatico");
  await rotarAutomaticos(carpeta);
  return nuevo;
}

/**
 * Conserva los ultimos `MAX_AUTOMATICOS` respaldos automaticos.
 *
 * Los manuales y los de seguridad NO se tocan: si alguien creo uno antes de
 * una restauracion, borrarlo seria justo lo contrario de lo que se busca.
 */
export async function rotarAutomaticos(carpeta: string): Promise<void> {
  const automaticos = (await listarRespaldos(carpeta)).filter(
    (respaldo) => respaldo.tipo === "automatico",
  );

  for (const viejo of automaticos.slice(MAX_AUTOMATICOS)) {
    await unlink(viejo.ruta).catch(() => undefined);
    console.log(`[respaldos] Rotado ${viejo.nombre}`);
  }
}

/** Lee solo la cabecera del archivo, sin cargar el resto en memoria. */
async function leerMeta(ruta: string): Promise<MetaRespaldo> {
  const entrada = createReadStream(ruta).pipe(createGunzip());
  const lector = createInterface({ input: entrada, crlfDelay: Infinity });

  try {
    for await (const linea of lector) {
      if (!linea.trim()) continue;
      const valor = JSON.parse(linea) as unknown;
      if (
        valor !== null &&
        typeof valor === "object" &&
        (valor as Record<string, unknown>)["t"] === "meta" &&
        (valor as Record<string, unknown>)["formato"] === FORMATO &&
        (valor as Record<string, unknown>)["esquema"] === ESQUEMA &&
        Array.isArray((valor as Record<string, unknown>)["tablas"])
      ) {
        return valor as MetaRespaldo;
      }
      throw new Error(
        "El archivo no empieza con la cabecera de un respaldo valido.",
      );
    }
    throw new Error("El respaldo esta vacio.");
  } finally {
    lector.close();
    entrada.destroy();
  }
}

interface ResultadoImportacion {
  insertadas: Record<string, number>;
  total: number;
  esperadas: Record<string, number>;
}

/**
 * Importa las filas del respaldo.
 *
 * Lee todo el archivo y agrupa las filas por tabla en memoria, luego las
 * inserta en orden topológico (padres antes que hijos) para respetar las
 * llaves foráneas sin desactivarlas. Cada tabla se inserta en lotes de
 * `LOTE_ESCRITURA` con `json_populate_recordset`, que acepta un arreglo JSON
 * y lo convierte en filas de la tabla. Las columnas que se insertan son la
 * intersección entre las que trae el respaldo y las que existen hoy: si una
 * versión posterior agregó una columna con valor por defecto, se omite y la
 * base pone el default; si el respaldo trae una columna que ya no existe, se
 * ignora.
 *
 * `orden` es el orden de inserción (padres primero), calculado por
 * `ordenarTablasPorDependencias`.
 */
async function importar(
  cliente: pg.ClientBase,
  ruta: string,
  meta: MetaRespaldo,
  columnasActuales: Map<string, string[]>,
  orden: string[],
): Promise<ResultadoImportacion> {
  const columnasDelRespaldo = new Map(
    meta.tablas.map((tabla) => [tabla.nombre, tabla.columnas] as const),
  );

  const insertadas: Record<string, number> = {};
  let esperadas: Record<string, number> = {};
  let total = 0;

  const filasPorTabla = new Map<string, Record<string, unknown>[]>();
  for (const tabla of orden) filasPorTabla.set(tabla, []);

  const entrada = createReadStream(ruta).pipe(createGunzip());
  const lector = createInterface({ input: entrada, crlfDelay: Infinity });

  try {
    for await (const linea of lector) {
      if (!linea.trim()) continue;
      const valor = JSON.parse(linea) as Record<string, unknown>;
      const tipo = valor["t"];

      if (tipo === "meta") continue;

      if (tipo === "fin") {
        const filas = valor["filas"];
        esperadas =
          filas !== null && typeof filas === "object"
            ? (filas as Record<string, number>)
            : {};
        continue;
      }

      if (tipo !== "f") {
        throw new Error("El respaldo trae un renglon que no se entiende.");
      }

      const tabla = String(valor["tabla"] ?? "");
      const filas = filasPorTabla.get(tabla);
      if (!filas) {
        throw new Error(`El respaldo trae una tabla no esperada: ${tabla}`);
      }

      const datos = valor["d"];
      if (datos === null || typeof datos !== "object") {
        throw new Error("El respaldo trae una fila sin datos.");
      }
      filas.push(datos as Record<string, unknown>);
    }
  } finally {
    lector.close();
    entrada.destroy();
  }

  if (Object.keys(esperadas).length === 0) {
    throw new Error(
      "El respaldo no trae el resumen final; puede estar incompleto.",
    );
  }

  // Insertar tabla por tabla en orden de dependencias (padres primero).
  for (const tabla of orden) {
    const filas = filasPorTabla.get(tabla) ?? [];
    const actuales = columnasActuales.get(tabla);
    if (!actuales) {
      throw new Error(
        `El respaldo trae una tabla que no existe en esta version: ${tabla}`,
      );
    }

    const delRespaldo = columnasDelRespaldo.get(tabla) ?? [];
    const columnas = delRespaldo.filter((columna) =>
      actuales.includes(columna),
    );
    if (columnas.length === 0) {
      throw new Error(
        `La tabla ${tabla} no comparte columnas con la base actual.`,
      );
    }

    const lista = columnas.map(ident).join(", ");
    for (let i = 0; i < filas.length; i += LOTE_ESCRITURA) {
      const lote = filas.slice(i, i + LOTE_ESCRITURA);
      await cliente.query(
        `INSERT INTO ${ESQUEMA}.${ident(tabla)} (${lista})
         SELECT ${lista}
           FROM json_populate_recordset(NULL::${ESQUEMA}.${ident(tabla)}, $1::json)`,
        [JSON.stringify(lote)],
      );
      insertadas[tabla] = (insertadas[tabla] ?? 0) + lote.length;
      total += lote.length;
    }
  }

  for (const [tabla, cantidad] of Object.entries(esperadas)) {
    const reales = insertadas[tabla] ?? 0;
    if (reales !== cantidad) {
      throw new Error(
        `El respaldo esta incompleto en ${tabla}: se esperaban ${cantidad} filas y llegaron ${reales}.`,
      );
    }
  }

  return { insertadas, total, esperadas };
}

/**
 * Deja cada secuencia en el valor que le corresponde despues de importar.
 *
 * Sin esto, la primera venta despues de restaurar intentaria usar el id 1,
 * que ya existe, y reventaria por clave duplicada. Se calcula con el MAX de
 * la tabla en vez de guardar el valor en el respaldo: asi tambien funciona
 * con respaldos viejos o editados a mano.
 */
async function ajustarSecuencias(cliente: pg.ClientBase): Promise<void> {
  const resultado = await cliente.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND column_default LIKE 'nextval(%'
      ORDER BY table_name, column_name`,
    [ESQUEMA],
  );

  for (const fila of resultado.rows) {
    const tabla = String(fila.table_name);
    const columna = String(fila.column_name);
    const tablaSql = `${ESQUEMA}.${ident(tabla)}`;
    const columnaSql = ident(columna);

    await cliente.query(
      `SELECT setval(
         pg_get_serial_sequence($1, $2),
         COALESCE((SELECT MAX(${columnaSql}) FROM ${tablaSql}), 0) + 1,
         false
       )`,
      [tablaSql, columna],
    );
  }
}

/**
 * Devuelve las tablas de `nombres` ordenadas de modo que las tablas
 * referenciadas (padres) aparezcan antes que las que las referencian
 * (hijos). Así, al insertar en este orden se respetan las llaves foráneas
 * sin tener que desactivarlas. Las tablas sin dependencias van primero. Si
 * hubiera un ciclo (no debería ocurrir en este esquema), las tablas
 * restantes se añaden al final en orden alfabético.
 */
async function ordenarTablasPorDependencias(
  cliente: pg.ClientBase,
  nombres: string[],
): Promise<string[]> {
  if (nombres.length === 0) return [];
  const set = new Set(nombres);
  const dependencias = new Map<string, Set<string>>();
  for (const nombre of nombres) dependencias.set(nombre, new Set());

  const resultado = await cliente.query<{ tabla: string; referencia: string }>(
    `SELECT ct.relname AS tabla, ref.relname AS referencia
       FROM pg_constraint con
       JOIN pg_class ct ON con.conrelid = ct.oid
       JOIN pg_class ref ON con.confrelid = ref.oid
       JOIN pg_namespace ns ON ct.relnamespace = ns.oid
       JOIN pg_namespace refns ON ref.relnamespace = refns.oid
      WHERE ns.nspname = $1
        AND refns.nspname = $1
        AND con.contype = 'f'`,
    [ESQUEMA],
  );

  for (const fila of resultado.rows) {
    const tabla = String(fila.tabla);
    const referencia = String(fila.referencia);
    if (set.has(tabla) && set.has(referencia) && tabla !== referencia) {
      dependencias.get(tabla)!.add(referencia);
    }
  }

  // Orden topológico (Kahn): padres antes que hijos.
  const entrada = new Map<string, number>();
  const dependientes = new Map<string, Set<string>>();
  for (const nombre of nombres) {
    entrada.set(nombre, dependencias.get(nombre)!.size);
    dependientes.set(nombre, new Set());
  }
  for (const [tabla, refs] of dependencias) {
    for (const ref of refs) dependientes.get(ref)!.add(tabla);
  }

  const cola = nombres.filter((n) => (entrada.get(n) ?? 0) === 0).sort();
  const orden: string[] = [];
  while (cola.length > 0) {
    const actual = cola.shift()!;
    orden.push(actual);
    for (const dependiente of [...(dependientes.get(actual) ?? [])].sort()) {
      const nuevo = (entrada.get(dependiente) ?? 1) - 1;
      entrada.set(dependiente, nuevo);
      if (nuevo === 0) cola.push(dependiente);
    }
  }

  const restantes = nombres.filter((n) => !orden.includes(n)).sort();
  return [...orden, ...restantes];
}

/**
 * Deja vacías las tablas que se van a restaurar.
 *
 * Hace falta porque las migraciones siembran datos: `0001_init.sql` crea los
 * roles, permisos y su reparto, y `0028` agrega los de respaldos. Si se
 * importara encima, el primer renglon de `permisos` chocaría con el que ya
 * insertó la migración y toda la restauración caería por clave duplicada.
 *
 * `TRUNCATE ... CASCADE` alcanza a las tablas que apuntan a estas por llave
 * foránea (por ejemplo `sesiones`, que no se respalda). Es intencional: las
 * sesiones no se restauran, así que quedar vacías está bien.
 */
async function vaciarTablas(
  cliente: pg.ClientBase,
  tablas: string[],
): Promise<void> {
  if (tablas.length === 0) return;
  const lista = tablas.map((tabla) => `${ESQUEMA}.${ident(tabla)}`).join(", ");
  await cliente.query(`TRUNCATE TABLE ${lista} CASCADE`);
}

/**
 * Restaura un respaldo completo.
 *
 * Todo ocurre dentro de UNA transaccion: se borra el esquema, se aplican las
 * migraciones actuales, se importan las filas y se ajustan las secuencias.
 * Si algo falla, el ROLLBACK devuelve la base exactamente como estaba. Esa
 * es la garantia que hace que restaurar no sea una apuesta.
 *
 * El llamador (main.ts) debe detener el backend antes de entrar aqui: si hay
 * peticiones usando el esquema, el DROP espera por sus locks y la
 * restauracion se queda colgada.
 */
export async function restaurarRespaldo(
  config: ConfiguracionPg,
  carpeta: string,
  nombre: string,
): Promise<ResultadoRestauracion> {
  if (basename(nombre) !== nombre || !nombre.endsWith(".json.gz")) {
    throw new Error("El nombre del respaldo no es valido.");
  }

  const ruta = join(carpeta, nombre);

  // Validar integridad antes de tocar la base de datos. Si el archivo esta
  // corrupto, truncado o modificado, se aborta aqui sin riesgo de perder datos.
  const validacion = await validarIntegridadRespaldo(config, carpeta, nombre);
  if (!validacion.valido) {
    throw new Error(
      `El respaldo no es valido y no se puede restaurar:\n- ${validacion.errores.join(
        "\n- ",
      )}`,
    );
  }

  const meta = validacion.meta!;

  const cliente = new pg.Client({ ...config, client_encoding: "UTF8" });
  await cliente.connect();

  try {
    await cliente.query("BEGIN");
    try {
      // Desactiva las llaves foraneas y los triggers mientras se importa.
      // Es superusuario (el usuario lo crea `initdb`), asi que puede. Sin
      // esto habria que ordenar las tablas por dependencias y los triggers
      // de auditoria volverian a escribir cada fila restaurada.
      await cliente.query("SET LOCAL session_replication_role = replica");

      await cliente.query(`DROP SCHEMA IF EXISTS ${ESQUEMA} CASCADE`);
      await cliente.query(`CREATE SCHEMA ${ESQUEMA}`);

      await aplicarTodasLasMigraciones(cliente);

      const columnas = await leerColumnas(cliente);

      for (const tabla of meta.tablas) {
        if (!columnas.has(tabla.nombre)) {
          throw new Error(
            `El respaldo trae una tabla que no existe en esta version: ${tabla.nombre}`,
          );
        }
      }

      // Las migraciones siembran roles, permisos y su reparto. Se borran las
      // tablas del respaldo para importar encima sin choques de clave única.
      const tablasRespaldo = meta.tablas.map((tabla) => tabla.nombre);
      await vaciarTablas(cliente, tablasRespaldo);

      // Orden de inserción: padres antes que hijos, para respetar las llaves
      // foráneas sin tener que desactivarlas.
      const orden = await ordenarTablasPorDependencias(cliente, tablasRespaldo);

      const importado = await importar(cliente, ruta, meta, columnas, orden);

      await ajustarSecuencias(cliente);
      await cliente.query("COMMIT");

      console.log(
        `[respaldos] Restaurado ${nombre}: ${importado.total} filas en ${Object.keys(importado.insertadas).length} tablas`,
      );
      return {
        tablas: Object.keys(importado.insertadas).length,
        filas: importado.total,
      };
    } catch (error) {
      await cliente.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await cliente.end().catch(() => undefined);
  }
}
