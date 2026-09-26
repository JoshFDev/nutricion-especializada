-- =====================================================================
--  BASE DE DATOS: "nutricion_especializada"
--  Distribuidora de alimento balanceado para ganado (bovinos, ovinos,
--  porcinos) - POS + Inventario + Cartera de clientes/proveedores
--  + Flujo de efectivo + Auditoría (triggers)
--
--  Generado a partir del análisis de:
--    - Inventarios_semanales_AD.xlsx
--    - Nota_de_remisión_AD.xlsx
--    - Septiembre_2026_AD.xlsx (Ventas, Proveedores, Ingresos/Egresos...)
--    - Estado_de_cuenta_clientes.xlsx
-- =====================================================================
--
-- CREATE DATABASE nutricion_especializada WITH ENCODING 'UTF8';
-- \c nutricion_especializada

CREATE SCHEMA IF NOT EXISTS pos;
SET search_path TO pos, public;

-- pgcrypto: hash de contraseñas (bcrypt) para `usuarios.contrasena`
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- Control de migraciones. DDL en PostgreSQL es transaccional, así que todo
-- el archivo va dentro de un BEGIN/COMMIT: si algo falla a la mitad, no
-- queda el schema a medias.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos.schema_migrations (
    version      TEXT PRIMARY KEY,
    aplicada_en  TIMESTAMP NOT NULL DEFAULT now(),
    duracion_ms  INTEGER
);

-- Esta migración no se vuelve a correr si ya se aplicó: las correcciones
-- van en un archivo 0002_*.sql nuevo, nunca editando este.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pos.schema_migrations WHERE version = '0001_init') THEN
        RAISE EXCEPTION
            'La migración 0001_init ya fue aplicada. No la edites ni la repitas: '
            'crea un archivo nuevo db/migrations/0002_<descripcion>.sql';
    END IF;
END $$;

BEGIN;


-- =====================================================================
-- 0. FUNCIONES DE APOYO
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_set_actualizado_en()
RETURNS TRIGGER AS $$
BEGIN
    NEW.actualizado_en := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------
-- 0.1  USUARIO ACTUAL DE LA APLICACIÓN
--
-- `current_user` devuelve el ROL de Postgres (normalmente el mismo para
-- todos), así que no sirve para saber QUIÉN hizo el cambio. Para eso el
-- backend debe announce el usuario logueado al abrir la transacción:
--
--     BEGIN;
--     SELECT fn_iniciar_sesion(1, '192.168.1.20');
--     UPDATE clientes SET ... ;
--     COMMIT;
--
-- Se usa set_config(..., TRUE) = LOCAL, así que el valor desaparece al
-- cerrar la transacción y no se filtra a la siguiente petición.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_iniciar_sesion(p_usuario_id BIGINT, p_ip TEXT DEFAULT NULL)
RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.usuario_id', COALESCE(p_usuario_id::TEXT, ''), TRUE);
    PERFORM set_config('app.usuario_ip', COALESCE(p_ip, ''), TRUE);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_usuario_actual()
RETURNS BIGINT AS $$
DECLARE
    v TEXT;
BEGIN
    v := NULLIF(current_setting('app.usuario_id', true), '');
    IF v IS NULL THEN
        RETURN NULL;                      -- p.ej. scripts manuales, psql
    END IF;
    RETURN v::BIGINT;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION fn_usuario_actual_ip()
RETURNS INET AS $$
DECLARE
    v TEXT;
BEGIN
    v := NULLIF(current_setting('app.usuario_ip', true), '');
    IF v IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN v::INET;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;


-- ---------------------------------------------------------------------
-- 0.2  OCULTAR SECRETOS ANTES DE GUARDARLOS EN LA BITÁCORA
-- to_jsonb(NEW) se lleva TODO, incluida la contraseña hasheada y los
-- tokens de sesión. Esto los replaces por "[REDACTADO]".
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_redactar(j JSONB)
RETURNS JSONB AS $$
    SELECT CASE
        WHEN j IS NULL THEN NULL
        ELSE COALESCE((
            SELECT jsonb_object_agg(
                       k,
                       CASE WHEN k IN ('contrasena','password','token',
                                       'token_hash','contrasena_hash')
                            THEN '"[REDACTADO]"'::JSONB
                            ELSE v END)
            FROM jsonb_each(j) AS e(k, v)
        ), '{}'::JSONB)
    END;
$$ LANGUAGE sql IMMUTABLE;


-- =====================================================================
-- 0.3  USUARIOS, ROLES Y PERMISOS
--
-- Modelo RBAC: los PERMISOS son la unidad real de acceso ("caja.eliminar"),
-- se agrupan en ROLES, y un usuario puede tener VARIOS roles (N:M). Así
-- una empleada puede ser, por ejemplo, Empleada + Cajera sin duplicar
-- permisos.
-- =====================================================================

CREATE TABLE roles (
    id           SMALLSERIAL PRIMARY KEY,
    nombre       TEXT UNIQUE NOT NULL
                 CHECK (nombre IN ('Administrador','Empleada','Cajera')),
    descripcion  TEXT,
    -- Solo un rol con es_admin = TRUE puede saltarse las validaciones de
    -- permisos. La api lo revisa con fn_es_admin().
    es_admin     BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en    TIMESTAMP NOT NULL DEFAULT now()
);

-- Catálogo de permisos. Formato: 'modulo.accion'. El backend mapea sus
-- rutas a estos códigos (p.ej. exigir 'notas.crear' para crear remisión).
CREATE TABLE permisos (
    id           SMALLSERIAL PRIMARY KEY,
    codigo       TEXT UNIQUE NOT NULL CHECK (codigo ~ '^[a-z_]+\.[a-z_]+$'),
    modulo       TEXT NOT NULL,
    accion       TEXT NOT NULL,
    descripcion  TEXT NOT NULL,
    -- Los permisos de sólo lectura no llevan esto; los de escritura sí.
    es_escritura BOOLEAN NOT NULL DEFAULT FALSE,
    creado_en    TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_permisos_modulo ON permisos(modulo);

CREATE TABLE roles_permisos (
    rol_id       SMALLINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permiso_id   SMALLINT NOT NULL REFERENCES permisos(id) ON DELETE CASCADE,
    PRIMARY KEY (rol_id, permiso_id)
);

-- El personal: la hermana (Administradora) y las empleadas.
CREATE TABLE usuarios (
    id                      BIGSERIAL PRIMARY KEY,
    -- Identificación
    nombre                  TEXT NOT NULL,
    apellido_paterno        TEXT NOT NULL,
    apellido_materno        TEXT,
    -- RFC como persona física (13: 4 letras + YYMMDD + homoclave) o moral
    -- (12: 3 letras + YYMMDD + homoclave). El dígito de siglo NO forma
    -- parte del RFC, ése va en la CURP. Se normaliza a MAYÚSCULAS con el
    -- trigger de abajo; es único por persona.
    rfc                     TEXT NOT NULL UNIQUE
                            CHECK (rfc ~ '^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
    -- Se puede iniciar sesión con email o con RFC (cualquiera de los dos).
    email                   TEXT UNIQUE CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    -- Laboral
    fecha_contratacion      DATE NOT NULL,
    puesto                  TEXT,
    -- NUNCA texto plano: siempre hash bcrypt de 12 rondas.
    -- Para validar:   contrasena = crypt('la-que-escribio', usuarios.contrasena)
    -- Para asignar:   contrasena = crypt('nueva-clave', gen_salt('bf', 12))
    contrasena              TEXT NOT NULL,
    -- Control de acceso
    activo                  BOOLEAN NOT NULL DEFAULT TRUE,
    es_dueno                BOOLEAN NOT NULL DEFAULT FALSE,  -- la dueña del negocio
    -- Obliga a cambiar la clave del primer ingreso / en cada reseteo.
    debe_cambiar_contrasena BOOLEAN NOT NULL DEFAULT TRUE,
    intentos_fallidos       SMALLINT NOT NULL DEFAULT 0
                            CHECK (intentos_fallidos >= 0),
    bloqueado_hasta         TIMESTAMP,
    ultimo_acceso           TIMESTAMP,
    creado_en               TIMESTAMP NOT NULL DEFAULT now(),
    actualizado_en          TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_usuarios_activo ON usuarios(activo);
CREATE INDEX idx_usuarios_nombre ON usuarios(apellido_paterno, apellido_materno, nombre);
CREATE TRIGGER trg_usuarios_updated
    BEFORE UPDATE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();
-- RFC siempre en mayúsculas y sin espacios, para que 'abc010101' y
-- 'ABC010101' no se cuelan como dos personas distintas.
CREATE OR REPLACE FUNCTION fn_normalizar_rfc()
RETURNS TRIGGER AS $$
BEGIN
    NEW.rfc := upper(regexp_replace(btrim(NEW.rfc), '\s+', '', 'g'));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_usuarios_rfc
    BEFORE INSERT OR UPDATE OF rfc ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_normalizar_rfc();

-- Un usuario puede tener varios roles (p.ej. Empleada + Cajera).
CREATE TABLE usuarios_roles (
    usuario_id  BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    rol_id      SMALLINT NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    asignado_en TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY (usuario_id, rol_id)
);
CREATE INDEX idx_usuarios_roles_rol ON usuarios_roles(rol_id);


-- =====================================================================
-- 0.4  BITÁCORA GENÉRICA
-- =====================================================================

CREATE TABLE auditoria_log (
    id               BIGSERIAL PRIMARY KEY,
    tabla            TEXT NOT NULL,
    operacion        TEXT NOT NULL CHECK (operacion IN ('INSERT','UPDATE','DELETE')),
    registro_id      BIGINT,
    datos_anteriores JSONB,
    datos_nuevos     JSONB,
    -- Quién lo hizo desde la app (referencia a usuarios.id, NULL si fue
    -- un script/manual) y desde dónde. Se llenan solos vía fn_auditoria().
    usuario_id       BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    usuario_ip       INET,
    -- Dato de diagnóstico: el rol de Postgres que ejecutó el INSERT.
    usuario_bd       TEXT NOT NULL DEFAULT current_user,
    fecha            TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_log_tabla_registro
    ON auditoria_log(tabla, registro_id);
CREATE INDEX idx_auditoria_log_usuario_fecha
    ON auditoria_log(usuario_id, fecha DESC);
CREATE INDEX idx_auditoria_log_fecha
    ON auditoria_log(fecha DESC);

CREATE OR REPLACE FUNCTION fn_auditoria()
RETURNS TRIGGER AS $$
DECLARE
    v_anterior JSONB;
    v_nuevo    JSONB;
    v_id       BIGINT;
BEGIN
    IF (TG_OP IN ('UPDATE','DELETE')) THEN
        v_anterior := fn_redactar(to_jsonb(OLD));
    END IF;
    IF (TG_OP IN ('INSERT','UPDATE')) THEN
        v_nuevo := fn_redactar(to_jsonb(NEW));
    END IF;

    v_id := COALESCE((v_nuevo ->> 'id')::BIGINT, (v_anterior ->> 'id')::BIGINT);

    INSERT INTO auditoria_log
        (tabla, operacion, registro_id, datos_anteriores, datos_nuevos,
         usuario_id, usuario_ip)
    VALUES
        (TG_TABLE_NAME, TG_OP, v_id, v_anterior, v_nuevo,
         fn_usuario_actual(), fn_usuario_actual_ip());

    RETURN NULL;   -- trigger AFTER: el valor de retorno se ignora
END;
$$ LANGUAGE plpgsql;

-- Se adjunta a `usuarios` también, para que los cambios de contraseña y
-- de rol queden registrados. (fn_auditoria ya redacta `contrasena`.)
CREATE TRIGGER trg_usuarios_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

CREATE TRIGGER trg_usuarios_roles_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON usuarios_roles
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();


-- ---------------------------------------------------------------------
-- 0.5  HELPERS DE PERMISOS (los usa el backend para autorizar)
-- El orden importa: cada función debe existir antes de que la llame otra.
-- ---------------------------------------------------------------------

-- ¿El usuario actual tiene alguno de los roles dados?
CREATE OR REPLACE FUNCTION fn_tiene_rol(p_rol TEXT)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1
          FROM usuarios_roles ur
          JOIN roles r ON r.id = ur.rol_id
         WHERE ur.usuario_id = fn_usuario_actual()
           AND r.nombre = p_rol
    );
$$ LANGUAGE sql STABLE;

-- El Administrador (o la dueña) pasa siempre.
CREATE OR REPLACE FUNCTION fn_es_admin()
RETURNS BOOLEAN AS $$
    SELECT COALESCE(fn_tiene_rol('Administrador'), FALSE)
        OR EXISTS (
            SELECT 1 FROM usuarios u
             WHERE u.id = fn_usuario_actual() AND u.es_dueno AND u.activo
        );
$$ LANGUAGE sql STABLE;

-- ¿El usuario actual tiene este permiso, sin importar su rol?
CREATE OR REPLACE FUNCTION fn_tiene_permiso(p_codigo TEXT)
RETURNS BOOLEAN AS $$
    SELECT fn_es_admin()
        OR EXISTS (
            SELECT 1
              FROM usuarios_roles ur
              JOIN roles_permisos rp ON rp.rol_id = ur.rol_id
              JOIN permisos p        ON p.id = rp.permiso_id
             WHERE ur.usuario_id = fn_usuario_actual()
               AND p.codigo = p_codigo
        );
$$ LANGUAGE sql STABLE;

-- Todos los códigos de permiso del usuario actual, para mandarlos al
-- frontend y que oculte botones que no le tocan.
CREATE OR REPLACE FUNCTION fn_permisos_usuario_actual()
RETURNS SETOF TEXT AS $$
    SELECT DISTINCT p.codigo
      FROM usuarios_roles ur
      JOIN roles_permisos rp ON rp.rol_id = ur.rol_id
      JOIN permisos p        ON p.id = rp.permiso_id
     WHERE ur.usuario_id = fn_usuario_actual()
    UNION
    SELECT p.codigo
      FROM permisos p
     WHERE fn_es_admin();
$$ LANGUAGE sql STABLE;


-- Tabla de alertas (stock negativo, folio duplicado, etc.)
CREATE TABLE alertas (
    id               BIGSERIAL PRIMARY KEY,
    tipo             TEXT NOT NULL,          -- 'stock_negativo', 'saldo_alto', etc.
    descripcion      TEXT NOT NULL,
    tabla_origen     TEXT,
    registro_id      BIGINT,
    atendida         BOOLEAN DEFAULT FALSE,
    creado_en        TIMESTAMP DEFAULT now()
);


-- =====================================================================
-- 1. CATÁLOGOS BASE
-- =====================================================================

CREATE TABLE especies (
    id      SMALLSERIAL PRIMARY KEY,
    nombre  TEXT UNIQUE NOT NULL          -- Bovinos lecheros, Bovinos de engorde, Ovinos, Porcinos...
);

CREATE TABLE categorias_producto (
    id      SMALLSERIAL PRIMARY KEY,
    nombre  TEXT UNIQUE NOT NULL          -- Sustituto lácteo, Premezcla, Minerales, Materia prima...
);

CREATE TABLE almacenes (
    id      SMALLSERIAL PRIMARY KEY,
    nombre  TEXT UNIQUE NOT NULL          -- Ej. 'Bodega BUAP'
);

CREATE TABLE productos (
    id               BIGSERIAL PRIMARY KEY,
    codigo           TEXT UNIQUE NOT NULL,      -- 'LAC','MBE','MTO','RET','VMP', etc.
    nombre           TEXT NOT NULL,             -- 'VIMILAC 400', 'MEAT BUILDER'...
    categoria_id     SMALLINT REFERENCES categorias_producto(id),
    especie_id       SMALLINT REFERENCES especies(id),
    presentacion_kg  NUMERIC(10,3) NOT NULL,    -- kg por bulto (20, 25, etc.)
    activo           BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en        TIMESTAMP DEFAULT now(),
    actualizado_en   TIMESTAMP DEFAULT now()
);
CREATE TRIGGER trg_productos_updated
    BEFORE UPDATE ON productos
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();


-- =====================================================================
-- 2. CLIENTES Y PRECIOS
-- =====================================================================

CREATE TABLE clientes (
    id               BIGSERIAL PRIMARY KEY,
    codigo_cliente   TEXT UNIQUE,               -- 'AC01','AB02'
    nombre           TEXT NOT NULL,
    establo          TEXT,
    especie_id       SMALLINT REFERENCES especies(id),
    estatus          TEXT NOT NULL DEFAULT 'Activo' CHECK (estatus IN ('Activo','Inactivo')),
    telefono         TEXT,
    direccion        TEXT,
    saldo_actual     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- se mantiene solo, vía trigger
    creado_en        TIMESTAMP DEFAULT now(),
    actualizado_en   TIMESTAMP DEFAULT now()
);
CREATE TRIGGER trg_clientes_updated
    BEFORE UPDATE ON clientes
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();
CREATE TRIGGER trg_clientes_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON clientes
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();


-- Precio especial pactado por cliente y producto (histórico: nunca se
-- borra un precio viejo, se cierra su vigencia y se abre uno nuevo)
CREATE TABLE precios_cliente (
    id              BIGSERIAL PRIMARY KEY,
    cliente_id      BIGINT NOT NULL REFERENCES clientes(id),
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    precio_kg       NUMERIC(10,2) NOT NULL CHECK (precio_kg >= 0),
    vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta   DATE,
    UNIQUE (cliente_id, producto_id, vigente_desde),
    CONSTRAINT chk_vigencia_precios_cliente CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);
CREATE INDEX idx_precios_cliente_producto ON precios_cliente(producto_id);
-- Un producto no puede tener dos precios especiales vigentes a la vez.
CREATE UNIQUE INDEX uq_precios_cliente_vigente
    ON precios_cliente(cliente_id, producto_id)
    WHERE vigente_hasta IS NULL;
CREATE TRIGGER trg_precios_cliente_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON precios_cliente
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Lista de precios públicos (cuando el cliente no tiene precio especial)
CREATE TABLE precios_publicos (
    id              BIGSERIAL PRIMARY KEY,
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    precio_kg       NUMERIC(10,2) NOT NULL CHECK (precio_kg >= 0),
    vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta   DATE,
    UNIQUE (producto_id, vigente_desde),
    CONSTRAINT chk_vigencia_precios_publicos CHECK (vigente_hasta IS NULL OR vigente_hasta >= vigente_desde)
);
CREATE UNIQUE INDEX uq_precios_publicos_vigente
    ON precios_publicos(producto_id) WHERE vigente_hasta IS NULL;

-- Datos fiscales que el cliente da cuando pide factura
CREATE TABLE datos_fiscales_cliente (
    id               BIGSERIAL PRIMARY KEY,
    cliente_id       BIGINT NOT NULL REFERENCES clientes(id),
    rfc              TEXT NOT NULL,
    razon_social     TEXT NOT NULL,
    regimen_fiscal   TEXT,
    codigo_postal    TEXT,
    uso_cfdi         TEXT,
    correo           TEXT,
    creado_en        TIMESTAMP DEFAULT now()
);
-- Un solo juego de datos fiscales vigente por cliente.
CREATE UNIQUE INDEX uq_datos_fiscales_cliente ON datos_fiscales_cliente(cliente_id);
CREATE INDEX idx_datos_fiscales_rfc ON datos_fiscales_cliente(rfc);


-- =====================================================================
-- 3. PROVEEDORES Y COMPRAS
-- =====================================================================

CREATE TABLE proveedores (
    id          BIGSERIAL PRIMARY KEY,
    nombre      TEXT UNIQUE NOT NULL,
    contacto    TEXT,
    telefono    TEXT,
    saldo_actual NUMERIC(12,2) NOT NULL DEFAULT 0,   -- se mantiene vía trigger
    activo      BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en   TIMESTAMP DEFAULT now()
);

-- Precio de costo por proveedor/producto (histórico)
CREATE TABLE producto_proveedor_precios (
    id              BIGSERIAL PRIMARY KEY,
    proveedor_id    BIGINT NOT NULL REFERENCES proveedores(id),
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    precio_kg       NUMERIC(10,2) NOT NULL CHECK (precio_kg >= 0),
    -- Se calcula solo: precio_kg × presentacion_kg del producto. Antes
    -- había que capturarlo a mano y se prestaba para errores.
    precio_bulto    NUMERIC(12,2),
    vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta   DATE,
    UNIQUE (proveedor_id, producto_id, vigente_desde)
);
CREATE INDEX idx_prov_precios_producto ON producto_proveedor_precios(producto_id);

CREATE OR REPLACE FUNCTION fn_calcular_precio_bulto()
RETURNS TRIGGER AS $$
DECLARE
    v_kg NUMERIC(10,3);
BEGIN
    SELECT presentacion_kg INTO v_kg FROM productos WHERE id = NEW.producto_id;
    IF v_kg IS NULL THEN
        RAISE EXCEPTION 'El producto % no existe', NEW.producto_id;
    END IF;
    NEW.precio_bulto := ROUND(NEW.precio_kg * v_kg, 2);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_calcular_precio_bulto
    BEFORE INSERT OR UPDATE OF producto_id, precio_kg ON producto_proveedor_precios
    FOR EACH ROW EXECUTE FUNCTION fn_calcular_precio_bulto();

CREATE TABLE compras (
    id              BIGSERIAL PRIMARY KEY,
    proveedor_id    BIGINT NOT NULL REFERENCES proveedores(id),
    fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
    folio_proveedor TEXT,
    monto_total     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- se recalcula vía trigger
    estatus         TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estatus IN ('pendiente','parcial','pagada','cancelada')),
    creado_en       TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_compras_proveedor ON compras(proveedor_id);
CREATE INDEX idx_compras_fecha ON compras(fecha DESC);

-- Detalle de la compra. OJO CON LAS UNIDADES: el subtotal es
-- bultos × kg_por_bulto × precio_por_kg, igual que en el detalle de la
-- venta. Antes faltaba el factor kg_bulto y el monto salía en unidades
-- distintas al de las notas de remisión.
CREATE TABLE compra_detalle (
    id              BIGSERIAL PRIMARY KEY,
    compra_id       BIGINT NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    almacen_id      SMALLINT NOT NULL REFERENCES almacenes(id),
    cantidad_bultos NUMERIC(10,2) NOT NULL CHECK (cantidad_bultos > 0),
    -- Copia de productos.presentacion_kg al momento de comprar: si mañana
    -- cambian el empaque, el histórico de esa compra no se altera.
    kg_bulto        NUMERIC(10,3) NOT NULL CHECK (kg_bulto > 0),
    precio_kg       NUMERIC(10,2) NOT NULL CHECK (precio_kg >= 0),
    subtotal        NUMERIC(12,2) GENERATED ALWAYS AS
                     (cantidad_bultos * kg_bulto * precio_kg) STORED
);
CREATE INDEX idx_compra_detalle_compra ON compra_detalle(compra_id);

CREATE TABLE pagos_proveedor (
    id              BIGSERIAL PRIMARY KEY,
    proveedor_id    BIGINT NOT NULL REFERENCES proveedores(id),
    compra_id       BIGINT REFERENCES compras(id),
    fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
    monto           NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    metodo          TEXT CHECK (metodo IN ('Efectivo','Transferencia','Depósito')),
    referencia      TEXT,
    creado_en       TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_pagos_proveedor_proveedor ON pagos_proveedor(proveedor_id);
CREATE INDEX idx_pagos_proveedor_compra ON pagos_proveedor(compra_id);

-- Si el caller no manda kg_bulto, se toma de productos.presentacion_kg.
-- Se aplica igual al detalle de venta, para que las dos tablas midan
-- exactamente lo mismo.
CREATE OR REPLACE FUNCTION fn_default_kg_bulto()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.kg_bulto IS NULL THEN
        SELECT presentacion_kg INTO NEW.kg_bulto
          FROM productos WHERE id = NEW.producto_id;
    END IF;
    IF NEW.kg_bulto IS NULL OR NEW.kg_bulto <= 0 THEN
        RAISE EXCEPTION
            'No se pudo determinar el kg por bulto del producto %', NEW.producto_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compra_detalle_kg_bulto
    BEFORE INSERT OR UPDATE OF producto_id, kg_bulto ON compra_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_default_kg_bulto();



-- =====================================================================
-- 4. FOLIOS Y NOTAS DE REMISIÓN (EL "PUNTO DE VENTA")
-- =====================================================================

-- Control de talonario de folios preimpresos, para que nunca se repita
-- ni se salte uno sin querer. El folio es único POR SERIE: la serie 'A'
-- y la serie 'B' pueden tener ambas el folio 1.
CREATE TABLE folios (
    id            BIGSERIAL PRIMARY KEY,
    folio_numero  INTEGER NOT NULL CHECK (folio_numero > 0),
    serie         TEXT NOT NULL DEFAULT 'A' CHECK (btrim(serie) <> ''),
    estatus       TEXT NOT NULL DEFAULT 'disponible'
                  CHECK (estatus IN ('disponible','usado','cancelado')),
    UNIQUE (serie, folio_numero)
);
CREATE INDEX idx_folios_disponible ON folios(serie, folio_numero)
    WHERE estatus = 'disponible';

-- Siguiente folio libre de una serie. Se usa desde la api al abrir el POS
-- para no tener que calcularlo en TypeScript.
CREATE OR REPLACE FUNCTION fn_siguiente_folio(p_serie TEXT DEFAULT 'A')
RETURNS folios AS $$
    SELECT * FROM folios
     WHERE serie = p_serie AND estatus = 'disponible'
     ORDER BY folio_numero
     LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Allego folios de una serie. p_desde/p_hasta son INCLUSIVOS.
CREATE OR REPLACE FUNCTION fn_allegar_folios(
    p_serie TEXT, p_desde INTEGER, p_hasta INTEGER
) RETURNS INTEGER AS $$
DECLARE
    v_insertadas INTEGER;
BEGIN
    INSERT INTO folios (serie, folio_numero)
    SELECT p_serie, g
      FROM generate_series(p_desde, p_hasta) AS g
    ON CONFLICT (serie, folio_numero) DO NOTHING;

    GET DIAGNOSTICS v_insertadas = ROW_COUNT;
    RETURN v_insertadas;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE notas_remision (
    id                 BIGSERIAL PRIMARY KEY,
    folio_id           BIGINT UNIQUE NOT NULL REFERENCES folios(id),
    cliente_id         BIGINT NOT NULL REFERENCES clientes(id),
    -- Quién vendió (la hermana o una empleada). NULL = capturado por
    --.import/manual sin sesión iniciada, p.ej. carga de datos iniciales.
    vendedor_id        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    fecha              DATE NOT NULL DEFAULT CURRENT_DATE,
    direccion_entrega  TEXT,
    subtotal           NUMERIC(12,2) NOT NULL DEFAULT 0,   -- se recalcula vía trigger
    estatus            TEXT NOT NULL DEFAULT 'pendiente'
                        CHECK (estatus IN ('pendiente','parcial','pagada','cancelada')),
    creado_en          TIMESTAMP DEFAULT now(),
    actualizado_en     TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_notas_cliente_fecha ON notas_remision(cliente_id, fecha DESC);
CREATE INDEX idx_notas_fecha ON notas_remision(fecha DESC);
CREATE INDEX idx_notas_vendedor ON notas_remision(vendedor_id);
CREATE TRIGGER trg_notas_updated
    BEFORE UPDATE ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_set_actualizado_en();
CREATE TRIGGER trg_notas_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

CREATE TABLE nota_remision_detalle (
    id               BIGSERIAL PRIMARY KEY,
    nota_id          BIGINT NOT NULL REFERENCES notas_remision(id) ON DELETE CASCADE,
    producto_id      BIGINT NOT NULL REFERENCES productos(id),
    almacen_id       SMALLINT NOT NULL REFERENCES almacenes(id),
    cantidad_bultos  NUMERIC(10,2) NOT NULL CHECK (cantidad_bultos > 0),
    kg_bulto         NUMERIC(10,3) NOT NULL CHECK (kg_bulto > 0),
    precio_unit_kg   NUMERIC(10,2) NOT NULL CHECK (precio_unit_kg >= 0),
    subtotal         NUMERIC(12,2) GENERATED ALWAYS AS
                      (cantidad_bultos * kg_bulto * precio_unit_kg) STORED
);
CREATE INDEX idx_nota_detalle_nota ON nota_remision_detalle(nota_id);
CREATE INDEX idx_nota_detalle_producto ON nota_remision_detalle(producto_id);

CREATE TRIGGER trg_nota_detalle_kg_bulto
    BEFORE INSERT OR UPDATE OF producto_id, kg_bulto ON nota_remision_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_default_kg_bulto();



-- =====================================================================
-- 5. PAGOS / ABONOS DE CLIENTES Y FACTURACIÓN
-- =====================================================================

CREATE TABLE pagos (
    id               BIGSERIAL PRIMARY KEY,
    cliente_id       BIGINT NOT NULL REFERENCES clientes(id),
    fecha            DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo           TEXT CHECK (metodo IN ('Efectivo','Transferencia','Depósito')),
    monto            NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    requiere_factura BOOLEAN NOT NULL DEFAULT FALSE,
    referencia       TEXT,
    creado_en        TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_pagos_cliente_fecha ON pagos(cliente_id, fecha DESC);
CREATE TRIGGER trg_pagos_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON pagos
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Un abono puede repartirse ("aplicarse") entre varias notas de remisión,
-- tal como en tus hojas de "Aplicado a notas"
CREATE TABLE pagos_aplicacion (
    id              BIGSERIAL PRIMARY KEY,
    pago_id         BIGINT NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
    nota_id         BIGINT NOT NULL REFERENCES notas_remision(id),
    monto_aplicado  NUMERIC(12,2) NOT NULL CHECK (monto_aplicado > 0)
);
CREATE INDEX idx_pagos_aplicacion_pago ON pagos_aplicacion(pago_id);
CREATE INDEX idx_pagos_aplicacion_nota ON pagos_aplicacion(nota_id);

CREATE TABLE facturas (
    id            BIGSERIAL PRIMARY KEY,
    cliente_id    BIGINT NOT NULL REFERENCES clientes(id),
    fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
    metodo_pago   TEXT,
    monto_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
    estatus       TEXT NOT NULL DEFAULT 'solicitada'
                  CHECK (estatus IN ('solicitada','emitida','cancelada')),
    creado_en     TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_facturas_cliente ON facturas(cliente_id, fecha DESC);

-- Relación N:M -> una factura puede agrupar varias notas de remisión
CREATE TABLE factura_nota (
    factura_id  BIGINT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
    nota_id     BIGINT NOT NULL REFERENCES notas_remision(id),
    PRIMARY KEY (factura_id, nota_id)
);
CREATE INDEX idx_factura_nota_nota ON factura_nota(nota_id);


-- =====================================================================
-- 6. INVENTARIO (KÁRDEX + FOTO SEMANAL)
-- =====================================================================

-- Kárdex: la verdad histórica, un renglón por cada entrada/salida/ajuste.
-- De aquí se calcula TODO lo demás automáticamente (existencias, semanas, etc.)
CREATE TABLE inventario_movimientos (
    id               BIGSERIAL PRIMARY KEY,
    producto_id      BIGINT NOT NULL REFERENCES productos(id),
    almacen_id       SMALLINT NOT NULL REFERENCES almacenes(id),
    fecha            TIMESTAMP NOT NULL DEFAULT now(),
    tipo             TEXT NOT NULL CHECK (tipo IN
                      ('entrada_compra','salida_venta','ajuste_positivo',
                       'ajuste_negativo','merma')),
    cantidad_bultos  NUMERIC(10,2) NOT NULL CHECK (cantidad_bultos > 0),
    -- Obligatorio en ajustes y mermas: es la justificación que se guarda
    -- en auditoria_inventario. Las entradas/salidas automáticas no lo
    -- necesitan porque se explica con su compra o nota de remisión.
    motivo           TEXT,
    referencia_tabla TEXT,          -- 'compra_detalle' / 'nota_remision_detalle' / 'manual'
    referencia_id    BIGINT,
    creado_en        TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT chk_motivo_requerido CHECK (
        tipo NOT IN ('ajuste_positivo','ajuste_negativo','merma')
        OR (motivo IS NOT NULL AND btrim(motivo) <> '')
    )
);
CREATE INDEX idx_inv_mov_producto_fecha ON inventario_movimientos(producto_id, fecha);
CREATE TRIGGER trg_inv_mov_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- "Foto" semanal (igual a como ya trabaja tu hermana: SEM.01 2026, etc.)
-- Se llena automáticamente con un trigger a partir del kárdex.
CREATE TABLE inventario_semanal (
    id                  BIGSERIAL PRIMARY KEY,
    anio                SMALLINT NOT NULL,
    semana              SMALLINT NOT NULL CHECK (semana BETWEEN 1 AND 53),
    producto_id         BIGINT NOT NULL REFERENCES productos(id),
    almacen_id          SMALLINT NOT NULL REFERENCES almacenes(id),
    existencia_inicial  NUMERIC(10,2) NOT NULL DEFAULT 0,
    entradas            NUMERIC(10,2) NOT NULL DEFAULT 0,
    salidas             NUMERIC(10,2) NOT NULL DEFAULT 0,
    existencia_final    NUMERIC(10,2) GENERATED ALWAYS AS
                         (existencia_inicial + entradas - salidas) STORED,
    UNIQUE (anio, semana, producto_id, almacen_id)
);


-- =====================================================================
-- 7. CAJA / BANCOS (INGRESOS Y EGRESOS)
-- =====================================================================

CREATE TABLE cuentas_financieras (
    id            SMALLSERIAL PRIMARY KEY,
    nombre        TEXT UNIQUE NOT NULL,        -- 'Caja chica', 'Cuenta Pablo Jaramillo'
    tipo          TEXT NOT NULL CHECK (tipo IN ('efectivo','banco')),
    banco         TEXT,
    titular       TEXT,
    saldo_actual  NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- Reemplaza en una sola tabla las 3 hojas que traías repetidas
-- (Ingresos y egresos / Control de efectivo / Movimientos cta bca):
-- todas son el mismo concepto, solo cambia el medio de pago.
CREATE TABLE movimientos_financieros (
    id            BIGSERIAL PRIMARY KEY,
    cuenta_id     SMALLINT NOT NULL REFERENCES cuentas_financieras(id),
    fecha         DATE NOT NULL DEFAULT CURRENT_DATE,
    tipo          TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
    categoria     TEXT NOT NULL,         -- 'Venta','Flete','Renta local','Nómina','Pago proveedor'...
    cliente_id    BIGINT REFERENCES clientes(id),
    proveedor_id  BIGINT REFERENCES proveedores(id),
    monto         NUMERIC(12,2) NOT NULL CHECK (monto > 0),
    descripcion   TEXT,
    tiene_factura BOOLEAN DEFAULT FALSE,
    creado_en     TIMESTAMP DEFAULT now()
);
CREATE INDEX idx_mov_fin_fecha ON movimientos_financieros(fecha);
CREATE INDEX idx_mov_fin_cuenta ON movimientos_financieros(cuenta_id, fecha DESC);


-- =====================================================================
-- 7.b  AUDITORÍA ESPECÍFICA POR MÓDULO
--
-- `auditoria_log` (0.4) es genérica: sirve para depurar. Estas cuatro
-- son las que la dueña revisa en pantalla, ya con el dato listo (monto,
-- saldo antes/después, motivo) y sin tener que leer JSON. Cada una se
-- llena sola por trigger.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 7.b.1  ACCESOS Y SESIONES: quién entró, cuándo y desde dónde
-- ---------------------------------------------------------------------
CREATE TABLE auditoria_accesos (
    id             BIGSERIAL PRIMARY KEY,
    usuario_id     BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    -- Si el login falló porque el usuario no existe, aquí va lo que se
    -- tecleó; si el usuario fue borrado, se conserva el histórico.
    usuario_intento TEXT,
    evento         TEXT NOT NULL CHECK (evento IN
                     ('login_exitoso','login_fallido','logout',
                      'acceso_denegado','cambio_contrasena','bloqueo',
                      'desbloqueo','usuario_creado','usuario_desactivado')),
    ip             INET,
    user_agent     TEXT,
    detalle        TEXT,
    creado_en      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_accesos_usuario_fecha
    ON auditoria_accesos(usuario_id, creado_en DESC);
CREATE INDEX idx_auditoria_accesos_evento
    ON auditoria_accesos(evento, creado_en DESC);

-- Sesiones activas. Se guarda el HASH del token (sha256), nunca el token.
CREATE TABLE sesiones (
    id            BIGSERIAL PRIMARY KEY,
    usuario_id    BIGINT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    token_hash    TEXT UNIQUE NOT NULL,
    ip            INET,
    user_agent    TEXT,
    iniciada_en   TIMESTAMP NOT NULL DEFAULT now(),
    expira_en     TIMESTAMP NOT NULL,
    cerrada_en    TIMESTAMP,
    cierre_motivo TEXT CHECK (cierre_motivo IN
                    ('logout','expiracion','manual','reinicio')),
    CONSTRAINT chk_sesion_cerrada CHECK (
        (cerrada_en IS NULL AND cierre_motivo IS NULL)
        OR (cerrada_en IS NOT NULL AND cierre_motivo IS NOT NULL)
    )
);
CREATE INDEX idx_sesiones_usuario ON sesiones(usuario_id, cerrada_en);
CREATE INDEX idx_sesiones_token ON sesiones(token_hash);

-- ---------------------------------------------------------------------
-- 7.b.2  CAJA Y BANCOS: cada peso que entra o sale
-- Se guarda el saldo ANTES y DESPUÉS de la cuenta, para que cualquier
-- descuadre se pueda rastrear sin recalcular todo el historial.
-- ---------------------------------------------------------------------
CREATE TABLE auditoria_caja (
    id             BIGSERIAL PRIMARY KEY,
    movimiento_id  BIGINT REFERENCES movimientos_financieros(id) ON DELETE SET NULL,
    cuenta_id      SMALLINT NOT NULL REFERENCES cuentas_financieras(id),
    usuario_id     BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    fecha          DATE NOT NULL,
    tipo           TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
    categoria      TEXT NOT NULL,
    monto          NUMERIC(12,2) NOT NULL,
    saldo_antes    NUMERIC(12,2),
    saldo_despues  NUMERIC(12,2),
    operacion      TEXT NOT NULL CHECK (operacion IN ('INSERT','UPDATE','DELETE')),
    descripcion    TEXT,
    creado_en      TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_caja_cuenta_fecha
    ON auditoria_caja(cuenta_id, fecha DESC);
CREATE INDEX idx_auditoria_caja_usuario
    ON auditoria_caja(usuario_id, creado_en DESC);

-- ---------------------------------------------------------------------
-- 7.b.3  INVENTARIO: ajustes, mermas y todo lo que mueve stock
-- ---------------------------------------------------------------------
CREATE TABLE auditoria_inventario (
    id                BIGSERIAL PRIMARY KEY,
    movimiento_id     BIGINT REFERENCES inventario_movimientos(id) ON DELETE SET NULL,
    producto_id       BIGINT NOT NULL REFERENCES productos(id),
    almacen_id        SMALLINT NOT NULL REFERENCES almacenes(id),
    usuario_id        BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    tipo              TEXT NOT NULL,
    cantidad_bultos   NUMERIC(10,2) NOT NULL,
    -- Existencia del producto en ese almacén justo antes y después.
    existencia_antes  NUMERIC(12,2),
    existencia_despues NUMERIC(12,2),
    motivo            TEXT,
    referencia_tabla  TEXT,
    referencia_id     BIGINT,
    operacion         TEXT NOT NULL CHECK (operacion IN ('INSERT','UPDATE','DELETE')),
    creado_en         TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX idx_auditoria_inventario_producto
    ON auditoria_inventario(producto_id, almacen_id, creado_en DESC);
CREATE INDEX idx_auditoria_inventario_usuario
    ON auditoria_inventario(usuario_id, creado_en DESC);

-- ---------------------------------------------------------------------
-- 7.b.4  PRECIOS: cambios de precio de venta y de costo
-- Un precio mal cambiado se lleva el margen de meses; aquí queda el
-- valor anterior, el nuevo y quién lo hizo.
-- ---------------------------------------------------------------------
CREATE TABLE auditoria_precios (
    id              BIGSERIAL PRIMARY KEY,
    tipo_precio     TEXT NOT NULL CHECK (tipo_precio IN
                      ('cliente','publico','costo')),
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    -- Sólo aplica a tipo_precio = 'cliente'
    cliente_id      BIGINT REFERENCES clientes(id) ON DELETE SET NULL,
    -- Sólo aplica a tipo_precio = 'costo'
    proveedor_id    BIGINT REFERENCES proveedores(id) ON DELETE SET NULL,
    usuario_id      BIGINT REFERENCES usuarios(id) ON DELETE SET NULL,
    precio_anterior NUMERIC(10,2),
    precio_nuevo    NUMERIC(10,2),
    vigente_desde   DATE,
    vigente_hasta   DATE,
    operacion       TEXT NOT NULL CHECK (operacion IN ('INSERT','UPDATE','DELETE')),
    motivo          TEXT,
    creado_en       TIMESTAMP NOT NULL DEFAULT now(),
    CONSTRAINT chk_precios_cliente_coherente CHECK (
        tipo_precio <> 'cliente' OR cliente_id IS NOT NULL
    ),
    CONSTRAINT chk_precios_costo_coherente CHECK (
        tipo_precio <> 'costo' OR proveedor_id IS NOT NULL
    )
);
CREATE INDEX idx_auditoria_precios_producto
    ON auditoria_precios(producto_id, creado_en DESC);
CREATE INDEX idx_auditoria_precios_cliente
    ON auditoria_precios(cliente_id, creado_en DESC);
CREATE INDEX idx_auditoria_precios_usuario
    ON auditoria_precios(usuario_id, creado_en DESC);


-- =====================================================================
-- 8. TRIGGERS DE NEGOCIO (el corazón de la automatización)
-- =====================================================================

-- 8.1  Al insertar una nota de remisión: valida y "quema" el folio
CREATE OR REPLACE FUNCTION fn_controlar_folio()
RETURNS TRIGGER AS $$
DECLARE
    v_estatus TEXT;
BEGIN
    SELECT estatus INTO v_estatus FROM folios WHERE id = NEW.folio_id;
    IF v_estatus IS NULL THEN
        RAISE EXCEPTION 'El folio_id % no existe en el talonario', NEW.folio_id;
    ELSIF v_estatus = 'usado' THEN
        RAISE EXCEPTION 'El folio % ya fue usado en otra nota', NEW.folio_id;
    ELSIF v_estatus = 'cancelado' THEN
        RAISE EXCEPTION 'El folio % está cancelado', NEW.folio_id;
    END IF;

    UPDATE folios SET estatus = 'usado' WHERE id = NEW.folio_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_control_folio
    BEFORE INSERT ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_controlar_folio();


-- 8.2  Recalcular subtotal de la nota cuando cambian sus renglones
CREATE OR REPLACE FUNCTION fn_recalcular_subtotal_nota()
RETURNS TRIGGER AS $$
DECLARE
    v_nota_id BIGINT := COALESCE(NEW.nota_id, OLD.nota_id);
BEGIN
    UPDATE notas_remision
       SET subtotal = COALESCE((SELECT SUM(subtotal) FROM nota_remision_detalle
                                  WHERE nota_id = v_nota_id), 0)
     WHERE id = v_nota_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recalcular_subtotal_nota
    AFTER INSERT OR UPDATE OR DELETE ON nota_remision_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_recalcular_subtotal_nota();


-- ---------------------------------------------------------------------
-- 8.3  INVENTARIO SINCRONIZADO CON VENTAS Y COMPRAS
--
-- Antes cada renglón vendído/comprado creaba su movimiento sólo con
-- AFTER INSERT: si se editaba o borraba la línea, el stock quedaba
-- desfasado para siempre (movimientos fantasma). Ahora un solo trigger
-- por tabla mantiene la sincronía en INSERT, UPDATE y DELETE:
--   - borra el movimiento anterior y crea el nuevo, o
--   - en DELETE, borra el movimiento y el stock regresa.
-- El borrado queda registrado en auditoria_inventario y auditoria_log.
-- ---------------------------------------------------------------------

-- Referencia 1:1: un movimiento por renglón de venta/compra.
CREATE UNIQUE INDEX uq_inv_mov_referencia
    ON inventario_movimientos(referencia_tabla, referencia_id)
    WHERE referencia_tabla IS NOT NULL;

-- 8.3.1  Detalle de venta  ->  salida de inventario
CREATE OR REPLACE FUNCTION fn_sincronizar_inventario_venta()
RETURNS TRIGGER AS $$
DECLARE
    v_nota_id BIGINT := COALESCE(NEW.nota_id, OLD.nota_id);
BEGIN
    IF TG_OP IN ('UPDATE','DELETE') THEN
        DELETE FROM inventario_movimientos
         WHERE referencia_tabla = 'nota_remision_detalle'
           AND referencia_id = OLD.id;
    END IF;

    IF TG_OP IN ('INSERT','UPDATE') THEN
        -- Si la nota ya está cancelada, no se toca el stock.
        IF NOT EXISTS (SELECT 1 FROM notas_remision
                        WHERE id = NEW.nota_id AND estatus = 'cancelada') THEN
            INSERT INTO inventario_movimientos
                (producto_id, almacen_id, tipo, cantidad_bultos,
                 referencia_tabla, referencia_id)
            VALUES
                (NEW.producto_id, NEW.almacen_id, 'salida_venta', NEW.cantidad_bultos,
                 'nota_remision_detalle', NEW.id);
        END IF;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventario_venta
    AFTER INSERT OR UPDATE OR DELETE ON nota_remision_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_sincronizar_inventario_venta();


-- 8.3.2  Detalle de compra  ->  entrada de inventario + monto de la compra
CREATE OR REPLACE FUNCTION fn_sincronizar_inventario_compra()
RETURNS TRIGGER AS $$
DECLARE
    v_compra_id BIGINT := COALESCE(NEW.compra_id, OLD.compra_id);
BEGIN
    IF TG_OP IN ('UPDATE','DELETE') THEN
        DELETE FROM inventario_movimientos
         WHERE referencia_tabla = 'compra_detalle'
           AND referencia_id = OLD.id;
    END IF;

    IF TG_OP IN ('INSERT','UPDATE') THEN
        IF NOT EXISTS (SELECT 1 FROM compras
                        WHERE id = NEW.compra_id AND estatus = 'cancelada') THEN
            INSERT INTO inventario_movimientos
                (producto_id, almacen_id, tipo, cantidad_bultos,
                 referencia_tabla, referencia_id)
            VALUES
                (NEW.producto_id, NEW.almacen_id, 'entrada_compra', NEW.cantidad_bultos,
                 'compra_detalle', NEW.id);
        END IF;
    END IF;

    -- El monto de la compra se recalcula SIEMPRE, no sólo al insertar.
    UPDATE compras
       SET monto_total = COALESCE((SELECT SUM(subtotal) FROM compra_detalle
                                     WHERE compra_id = v_compra_id), 0)
     WHERE id = v_compra_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventario_compra
    AFTER INSERT OR UPDATE OR DELETE ON compra_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_sincronizar_inventario_compra();


-- 8.3.3  Cancelar una nota o una compra devuelve el stock.
-- Al cancelar no se borra el documento (queda con estatus 'cancelada' y
-- su historial en la bitácora); lo que se revierte es el movimiento de
-- inventario, para que la bodega no quede con el stock ficticio.
CREATE OR REPLACE FUNCTION fn_revertir_inventario_por_cancelacion()
RETURNS TRIGGER AS $$
DECLARE
    v_estado TEXT;
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RETURN NULL;
    END IF;
    IF NEW.estatus = 'cancelada' AND OLD.estatus <> 'cancelada' THEN
        DELETE FROM inventario_movimientos
         WHERE referencia_tabla = 'nota_remision_detalle'
           AND referencia_id IN (SELECT id FROM nota_remision_detalle
                                 WHERE nota_id = NEW.id);
    ELSIF OLD.estatus = 'cancelada' AND NEW.estatus <> 'cancelada' THEN
        -- Se revierte una cancelación: se rehace la salida de inventario.
        INSERT INTO inventario_movimientos
            (producto_id, almacen_id, tipo, cantidad_bultos,
             referencia_tabla, referencia_id)
        SELECT d.producto_id, d.almacen_id, 'salida_venta', d.cantidad_bultos,
               'nota_remision_detalle', d.id
          FROM nota_remision_detalle d
         WHERE d.nota_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cancelar_nota_inventario
    AFTER UPDATE OF estatus ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_revertir_inventario_por_cancelacion();


CREATE OR REPLACE FUNCTION fn_revertir_inventario_por_cancelacion_compra()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP <> 'UPDATE' THEN
        RETURN NULL;
    END IF;
    IF NEW.estatus = 'cancelada' AND OLD.estatus <> 'cancelada' THEN
        DELETE FROM inventario_movimientos
         WHERE referencia_tabla = 'compra_detalle'
           AND referencia_id IN (SELECT id FROM compra_detalle
                                 WHERE compra_id = NEW.id);
    ELSIF OLD.estatus = 'cancelada' AND NEW.estatus <> 'cancelada' THEN
        INSERT INTO inventario_movimientos
            (producto_id, almacen_id, tipo, cantidad_bultos,
             referencia_tabla, referencia_id)
        SELECT d.producto_id, d.almacen_id, 'entrada_compra', d.cantidad_bultos,
               'compra_detalle', d.id
          FROM compra_detalle d
         WHERE d.compra_id = NEW.id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_cancelar_compra_inventario
    AFTER UPDATE OF estatus ON compras
    FOR EACH ROW EXECUTE FUNCTION fn_revertir_inventario_por_cancelacion_compra();


-- ---------------------------------------------------------------------
-- 8.4  ALERTA DE STOCK NEGATIVO
-- Antes sólo escuchaba INSERT: si se borraba un movimiento el producto
-- se recuperaba pero nadie se enteraba. Ahora cubre las tres operaciones.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_verificar_stock()
RETURNS TRIGGER AS $$
DECLARE
    v_producto BIGINT;
    v_almacen  SMALLINT;
    v_existencia NUMERIC(12,2);
BEGIN
    v_producto := COALESCE(NEW.producto_id, OLD.producto_id);
    v_almacen  := COALESCE(NEW.almacen_id,  OLD.almacen_id);

    SELECT COALESCE(SUM(
             CASE WHEN tipo IN ('entrada_compra','ajuste_positivo') THEN cantidad_bultos
                  ELSE -cantidad_bultos END), 0)
      INTO v_existencia
      FROM inventario_movimientos
     WHERE producto_id = v_producto AND almacen_id = v_almacen;

    IF v_existencia < 0 THEN
        INSERT INTO alertas (tipo, descripcion, tabla_origen, registro_id)
        VALUES ('stock_negativo',
                format('El producto_id %s quedó en %s bultos en almacen_id %s (%s)',
                       v_producto, v_existencia, v_almacen, TG_OP),
                'inventario_movimientos', COALESCE(NEW.id, OLD.id));
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_verificar_stock
    AFTER INSERT OR UPDATE OR DELETE ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_verificar_stock();


-- ---------------------------------------------------------------------
-- 8.5  FOTO SEMANAL DE INVENTARIO
--
-- Antes sólo se acumulaban entradas/salidas y `existencia_inicial` se
-- quedaba en 0 para siempre, así que la foto semanal no servía. Ahora la
-- tabla se DERIVA del kárdex: para cada semana con movimientos se
-- calcula la existencia inicial como todo lo anterior a esa semana, y se
-- arrastra correctamente entre semanas. Además se reconstruye completa
-- cuando un movimiento se edita o borra.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recalcular_inventario_semanal(
    p_producto BIGINT, p_almacen SMALLINT
) RETURNS VOID AS $$
DECLARE
    r RECORD;
BEGIN
    -- Elimina las semanas que se quedaron sin ningún movimiento.
    DELETE FROM inventario_semanal s
     WHERE s.producto_id = p_producto
       AND s.almacen_id  = p_almacen
       AND NOT EXISTS (
            SELECT 1 FROM inventario_movimientos m
             WHERE m.producto_id = p_producto
               AND m.almacen_id  = p_almacen
               AND EXTRACT(ISOYEAR FROM m.fecha) = s.anio
               AND EXTRACT(WEEK    FROM m.fecha) = s.semana);

    -- Recalcula cada semana con movimientos, de la más antigua a la más
    -- reciente, para que la existencia final de una sea la inicial de la
    -- siguiente.
    FOR r IN
        SELECT DISTINCT EXTRACT(ISOYEAR FROM m.fecha)::SMALLINT AS anio,
                        EXTRACT(WEEK    FROM m.fecha)::SMALLINT AS semana
          FROM inventario_movimientos m
         WHERE m.producto_id = p_producto AND m.almacen_id = p_almacen
         ORDER BY 1, 2
    LOOP
        INSERT INTO inventario_semanal
            (anio, semana, producto_id, almacen_id,
             existencia_inicial, entradas, salidas)
        VALUES (
            r.anio, r.semana, p_producto, p_almacen,
            -- Inicial = todo lo acumulado en semanas ANTERIORES
            COALESCE((SELECT SUM(CASE WHEN m.tipo IN ('entrada_compra','ajuste_positivo')
                                     THEN m.cantidad_bultos ELSE -m.cantidad_bultos END)
                        FROM inventario_movimientos m
                       WHERE m.producto_id = p_producto
                         AND m.almacen_id  = p_almacen
                         AND (EXTRACT(ISOYEAR FROM m.fecha),
                              EXTRACT(WEEK    FROM m.fecha)) < (r.anio, r.semana)), 0),
            COALESCE((SELECT SUM(m.cantidad_bultos)
                        FROM inventario_movimientos m
                       WHERE m.producto_id = p_producto
                         AND m.almacen_id  = p_almacen
                         AND m.tipo IN ('entrada_compra','ajuste_positivo')
                         AND EXTRACT(ISOYEAR FROM m.fecha) = r.anio
                         AND EXTRACT(WEEK    FROM m.fecha) = r.semana), 0),
            COALESCE((SELECT SUM(m.cantidad_bultos)
                        FROM inventario_movimientos m
                       WHERE m.producto_id = p_producto
                         AND m.almacen_id  = p_almacen
                         AND m.tipo IN ('salida_venta','ajuste_negativo','merma')
                         AND EXTRACT(ISOYEAR FROM m.fecha) = r.anio
                         AND EXTRACT(WEEK    FROM m.fecha) = r.semana), 0)
        )
        ON CONFLICT (anio, semana, producto_id, almacen_id) DO UPDATE
           SET existencia_inicial = EXCLUDED.existencia_inicial,
               entradas          = EXCLUDED.entradas,
               salidas           = EXCLUDED.salidas;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_actualizar_inventario_semanal()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_recalcular_inventario_semanal(NEW.producto_id, NEW.almacen_id);
    IF TG_OP IN ('UPDATE','DELETE') THEN
        -- Si cambió de producto o de almacén, hay que arreglar la otra
        -- combinación también.
        PERFORM fn_recalcular_inventario_semanal(OLD.producto_id, OLD.almacen_id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizar_inventario_semanal
    AFTER INSERT OR UPDATE OR DELETE ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_inventario_semanal();


-- ---------------------------------------------------------------------
-- 8.6  SALDO DEL CLIENTE
--
-- Es una resta de todo lo facturado menos todo lo abonado. Se recalcula
-- desde cero en vez de mover un delta, así que cualquier corrección
-- queda consistente. Además, si cambia el cliente de una nota o un pago,
-- se recalculan LOS DOS (el viejo y el nuevo): antes sólo se ajustaba el
-- nuevo y el anterior quedaba con el saldo desfasado.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recalcular_saldo_cliente(p_cliente BIGINT)
RETURNS VOID AS $$
BEGIN
    IF p_cliente IS NULL THEN
        RETURN;
    END IF;
    UPDATE clientes SET saldo_actual =
        COALESCE((SELECT SUM(n.subtotal) FROM notas_remision n
                    WHERE n.cliente_id = p_cliente
                      AND n.estatus <> 'cancelada'), 0)
        -
        COALESCE((SELECT SUM(pa.monto) FROM pagos pa
                    WHERE pa.cliente_id = p_cliente), 0)
    WHERE id = p_cliente;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_actualizar_saldo_cliente()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_TABLE_NAME = 'notas_remision' THEN
        PERFORM fn_recalcular_saldo_cliente(NEW.cliente_id);
        IF TG_OP = 'UPDATE' AND OLD.cliente_id IS DISTINCT FROM NEW.cliente_id THEN
            PERFORM fn_recalcular_saldo_cliente(OLD.cliente_id);
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM fn_recalcular_saldo_cliente(OLD.cliente_id);
        END IF;
    ELSIF TG_TABLE_NAME = 'pagos' THEN
        PERFORM fn_recalcular_saldo_cliente(NEW.cliente_id);
        IF TG_OP = 'UPDATE' AND OLD.cliente_id IS DISTINCT FROM NEW.cliente_id THEN
            PERFORM fn_recalcular_saldo_cliente(OLD.cliente_id);
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM fn_recalcular_saldo_cliente(OLD.cliente_id);
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_saldo_cliente_por_nota
    AFTER INSERT OR UPDATE OR DELETE ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cliente();

CREATE TRIGGER trg_saldo_cliente_por_pago
    AFTER INSERT OR UPDATE OR DELETE ON pagos
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cliente();


-- ---------------------------------------------------------------------
-- 8.7  SALDO DEL PROVEEDOR
--
-- FIX: la fórmula anterior restaba los pagos Y excluía las compras con
-- estatus = 'pagada'. Al marcar una compra como pagada desaparecía del
-- sumando pero su pago seguía restando -> doble conteo y saldos
-- negativos falsos. Ahora el estatus NO participa en la suma: sólo se
-- excluyen las compras canceladas, que es lo único que de verdad no se
-- debe. El estatus es informativo; el saldo sale siempre de la resta.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recalcular_saldo_proveedor(p_proveedor BIGINT)
RETURNS VOID AS $$
BEGIN
    IF p_proveedor IS NULL THEN
        RETURN;
    END IF;
    UPDATE proveedores SET saldo_actual =
        COALESCE((SELECT SUM(c.monto_total) FROM compras c
                    WHERE c.proveedor_id = p_proveedor
                      AND c.estatus <> 'cancelada'), 0)
        -
        COALESCE((SELECT SUM(pp.monto) FROM pagos_proveedor pp
                    WHERE pp.proveedor_id = p_proveedor), 0)
    WHERE id = p_proveedor;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_actualizar_saldo_proveedor()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_recalcular_saldo_proveedor(NEW.proveedor_id);
    IF TG_OP IN ('UPDATE','DELETE') THEN
        IF OLD.proveedor_id IS DISTINCT FROM NEW.proveedor_id THEN
            PERFORM fn_recalcular_saldo_proveedor(OLD.proveedor_id);
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM fn_recalcular_saldo_proveedor(OLD.proveedor_id);
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_saldo_proveedor_por_compra
    AFTER INSERT OR UPDATE OR DELETE ON compras
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_proveedor();

CREATE TRIGGER trg_saldo_proveedor_por_pago
    AFTER INSERT OR UPDATE OR DELETE ON pagos_proveedor
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_proveedor();


-- ---------------------------------------------------------------------
-- 8.8  ESTATUS DE COMPRA SEGÚN LO PAGADO
-- (también recalculado; el estatus es informativo, no la fuente del saldo)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_actualizar_estatus_compra()
RETURNS TRIGGER AS $$
DECLARE
    v_compra BIGINT := COALESCE(NEW.compra_id, OLD.compra_id);
    v_total   NUMERIC(12,2);
    v_pagado  NUMERIC(12,2);
BEGIN
    SELECT monto_total INTO v_total FROM compras WHERE id = v_compra;
    SELECT COALESCE(SUM(monto), 0) INTO v_pagado
      FROM pagos_proveedor WHERE compra_id = v_compra;

    UPDATE compras
       SET estatus = CASE
              WHEN estatus = 'cancelada' THEN 'cancelada'
              WHEN v_pagado <= 0            THEN 'pendiente'
              WHEN v_pagado >= v_total      THEN 'pagada'
              ELSE 'parcial'
           END
     WHERE id = v_compra;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estatus_compra_por_pago
    AFTER INSERT OR UPDATE OR DELETE ON pagos_proveedor
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_estatus_compra();


-- ---------------------------------------------------------------------
-- 8.9  SALDO DE CUENTA (CAJA / BANCOS)
--
-- FIX: antes sólo escuchaba INSERT y sumaba incremental, así que al
-- borrar o corregir un movimiento el saldo quedaba desfasado para
-- siempre. Ahora recalcula desde cero y cubre INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recalcular_saldo_cuenta(p_cuenta SMALLINT)
RETURNS VOID AS $$
BEGIN
    IF p_cuenta IS NULL THEN
        RETURN;
    END IF;
    UPDATE cuentas_financieras SET saldo_actual =
        COALESCE((SELECT SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE -m.monto END)
                    FROM movimientos_financieros m
                   WHERE m.cuenta_id = p_cuenta), 0)
    WHERE id = p_cuenta;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_actualizar_saldo_cuenta()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM fn_recalcular_saldo_cuenta(NEW.cuenta_id);
    IF TG_OP IN ('UPDATE','DELETE') THEN
        IF OLD.cuenta_id IS DISTINCT FROM NEW.cuenta_id THEN
            PERFORM fn_recalcular_saldo_cuenta(OLD.cuenta_id);
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM fn_recalcular_saldo_cuenta(OLD.cuenta_id);
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizar_saldo_cuenta
    AFTER INSERT OR UPDATE OR DELETE ON movimientos_financieros
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cuenta();


-- ---------------------------------------------------------------------
-- 8.9.b  APLICACIÓN DE ABONOS A NOTAS  (fix: no se podía aplicar de más)
--
-- Antes `pagos_aplicacion` no validaba nada, así que un abono de $500
-- se podía aplicar a notas por $5,000. Ahora:
--   1. la suma de lo aplicado a un pago no puede pasar su monto, y
--   2. la suma de lo aplicado a una nota no puede pasar su subtotal.
-- De paso se actualiza el estatus de la nota (parcial/pagada) y el del
-- pago según se vaya cubriendo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_validar_aplicacion_pago()
RETURNS TRIGGER AS $$
DECLARE
    v_pago_id  BIGINT  := NEW.pago_id;
    v_nota_id  BIGINT  := NEW.nota_id;
    v_monto    NUMERIC := NEW.monto_aplicado;
    v_id_actual BIGINT := COALESCE(NEW.id, 0);
    v_disponible_pago NUMERIC;
    v_disponible_nota NUMERIC;
    v_subtotal  NUMERIC;
BEGIN
    SELECT monto INTO v_disponible_pago FROM pagos WHERE id = v_pago_id;
    -- Lo ya aplicado a ESE pago, sin contar esta fila.
    v_disponible_pago := v_disponible_pago - COALESCE(
        (SELECT SUM(monto_aplicado) FROM pagos_aplicacion
          WHERE pago_id = v_pago_id AND id <> v_id_actual), 0);

    IF v_monto > v_disponible_pago THEN
        RAISE EXCEPTION
            'El pago % sólo tiene % disponible y se intentó aplicar %',
            v_pago_id, v_disponible_pago, v_monto
            USING ERRCODE = '23514';
    END IF;

    SELECT subtotal INTO v_subtotal FROM notas_remision WHERE id = v_nota_id;
    IF NEW.id IS NULL THEN
        v_disponible_nota := v_subtotal - COALESCE(
            (SELECT SUM(monto_aplicado) FROM pagos_aplicacion
              WHERE nota_id = v_nota_id), 0);
    ELSE
        v_disponible_nota := v_subtotal - COALESCE(
            (SELECT SUM(monto_aplicado) FROM pagos_aplicacion
              WHERE nota_id = v_nota_id AND id <> v_id_actual), 0);
    END IF;

    IF v_monto > v_disponible_nota THEN
        RAISE EXCEPTION
            'La nota % sólo tiene % por cubrir y se intentó aplicar %',
            v_nota_id, v_disponible_nota, v_monto
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validar_aplicacion_pago
    BEFORE INSERT OR UPDATE ON pagos_aplicacion
    FOR EACH ROW EXECUTE FUNCTION fn_validar_aplicacion_pago();


-- Mantiene el estatus de la nota y del pago según lo aplicado.
CREATE OR REPLACE FUNCTION fn_actualizar_estatus_por_aplicaciones()
RETURNS TRIGGER AS $$
DECLARE
    v_nota_id BIGINT  := COALESCE(NEW.nota_id, OLD.nota_id);
    v_pago_id BIGINT  := COALESCE(NEW.pago_id, OLD.pago_id);
BEGIN
    -- Estatus de la nota
    UPDATE notas_remision n
       SET estatus = CASE
              WHEN n.estatus IN ('pagada','cancelada') THEN n.estatus
              WHEN COALESCE((SELECT SUM(a.monto_aplicado) FROM pagos_aplicacion a
                               WHERE a.nota_id = v_nota_id), 0) <= 0 THEN 'pendiente'
              WHEN COALESCE((SELECT SUM(a.monto_aplicado) FROM pagos_aplicacion a
                               WHERE a.nota_id = v_nota_id), 0) >= n.subtotal THEN 'pagada'
              ELSE 'parcial'
           END
     WHERE n.id = v_nota_id;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_estatus_por_aplicaciones
    AFTER INSERT OR UPDATE OR DELETE ON pagos_aplicacion
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_estatus_por_aplicaciones();


-- ---------------------------------------------------------------------
-- 8.9.c  PERMISOS APLICADOS EN LA BASE DE DATOS
--
-- Los triggers de auditoría registran QUIÉN, pero no impedían hacer
-- nada. Estos triggers cierran eso: si la operación se hace con una
-- sesión iniciada y el usuario no tiene el permiso, la base la rechaza
-- con SQLSTATE 42501 (insufficient_privilege).
--
-- Si NO hay sesión (fn_usuario_actual() es NULL) no se revisa nada: así
-- las migraciones, el seed y los scripts manuales de psql siguen
-- funcionando. La diferencia es que un script manual deja rastro
-- usuario_id = NULL, visible como '(sistema)' en las vistas.
--
-- Uso en un trigger (INSERT, UPDATE, DELETE):
--   EXECUTE FUNCTION fn_trg_permiso('caja.capturar',
--                                   'caja.capturar',
--                                   'caja.eliminar')
--
-- Excepción para inventario_movimientos: los movimientos que traen
-- referencia_tabla los genera el sistema al vender o comprar, así que NO
-- se verifican permisos (si no, nadie podría vender). Los ajustes y
-- mermas manuales (referencia_tabla NULL) sí requieren
-- 'inventario.ajustar'.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_exigir_permiso(p_codigo TEXT)
RETURNS VOID AS $$
DECLARE
    v_usuario BIGINT := fn_usuario_actual();
BEGIN
    IF v_usuario IS NULL THEN
        RETURN;   -- sin sesión: script manual, no se autoriza nada
    END IF;
    IF NOT fn_tiene_permiso(p_codigo) THEN
        RAISE EXCEPTION 'El usuario % no tiene el permiso %', v_usuario, p_codigo
            USING ERRCODE = '42501';
    END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_trg_permiso()
RETURNS TRIGGER AS $$
DECLARE
    v_insert TEXT := TG_ARGV[0];
    v_update TEXT := COALESCE(NULLIF(TG_ARGV[1], ''), TG_ARGV[0]);
    v_delete TEXT := COALESCE(NULLIF(TG_ARGV[2], ''), TG_ARGV[0]);
BEGIN
    -- OJO: en un trigger BEFORE hay que devolver NEW/OLD. Devolver NULL
    -- cancela la operación EN SILENCIO (el INSERT simplemente no ocurre).
    IF fn_usuario_actual() IS NULL THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;

    -- Movimientos de inventario generados por el sistema: sin control de
    -- permisos (vender no debería requerir un permiso de inventario).
    IF TG_TABLE_NAME = 'inventario_movimientos' THEN
        IF COALESCE(NEW.referencia_tabla, OLD.referencia_tabla) IS NOT NULL THEN
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        PERFORM fn_exigir_permiso(v_insert);
    ELSIF TG_OP = 'UPDATE' THEN
        PERFORM fn_exigir_permiso(v_update);
    ELSE
        PERFORM fn_exigir_permiso(v_delete);
    END IF;

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_permiso_mov_fin
    BEFORE INSERT OR UPDATE OR DELETE ON movimientos_financieros
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('caja.capturar','caja.capturar','caja.eliminar');

CREATE TRIGGER trg_permiso_clientes
    BEFORE INSERT OR UPDATE OR DELETE ON clientes
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('clientes.crear','clientes.editar','clientes.eliminar');

CREATE TRIGGER trg_permiso_notas
    BEFORE INSERT OR UPDATE OR DELETE ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('notas.crear','notas.editar','notas.cancelar');

CREATE TRIGGER trg_permiso_nota_detalle
    BEFORE INSERT OR UPDATE OR DELETE ON nota_remision_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('notas.crear','notas.editar','notas.editar');

CREATE TRIGGER trg_permiso_pagos
    BEFORE INSERT OR UPDATE OR DELETE ON pagos
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('pagos.crear','pagos.crear','pagos.crear');

CREATE TRIGGER trg_permiso_precios
    BEFORE INSERT OR UPDATE OR DELETE ON precios_cliente
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('precios.editar','precios.editar','precios.editar');

CREATE TRIGGER trg_permiso_precios_publicos
    BEFORE INSERT OR UPDATE OR DELETE ON precios_publicos
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('precios.editar','precios.editar','precios.editar');

CREATE TRIGGER trg_permiso_precios_costo
    BEFORE INSERT OR UPDATE OR DELETE ON producto_proveedor_precios
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('precios.editar','precios.editar','precios.editar');

CREATE TRIGGER trg_permiso_compras
    BEFORE INSERT OR UPDATE OR DELETE ON compras
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('compras.crear','compras.crear','compras.crear');

CREATE TRIGGER trg_permiso_inventario
    BEFORE INSERT OR UPDATE OR DELETE ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('inventario.ajustar','inventario.ajustar','inventario.ajustar');

CREATE TRIGGER trg_permiso_usuarios
    BEFORE INSERT OR UPDATE OR DELETE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('usuarios.crear','usuarios.editar','usuarios.editar');

CREATE TRIGGER trg_permiso_usuarios_roles
    BEFORE INSERT OR UPDATE OR DELETE ON usuarios_roles
    FOR EACH ROW EXECUTE FUNCTION fn_trg_permiso('usuarios.crear','usuarios.editar','usuarios.editar');


-- 8.10  TRIGGERS DE AUDITORÍA POR MÓDULO
-- Sólo registran; el saldo de la cuenta se recalcula arriba.
-- =====================================================================

-- 8.10.1  Caja: guarda el saldo de la cuenta antes y después del cambio.
--
-- OJO con el orden de los triggers: PostgreSQL dispara los AFTER en orden
-- alfabético por nombre, así que trg_actualizar_saldo_cuenta (que actualiza
-- cuentas_financieras.saldo_actual) puedeYA HABER CORRIDO cuando esta
-- función lee el saldo. Por eso NO se lee saldo_actual: se recalcula el
-- saldo real del movimiento hacia atrás y hacia adelante, que da lo mismo
-- exista o no el trigger de saldo.
CREATE OR REPLACE FUNCTION fn_auditar_caja()
RETURNS TRIGGER AS $$
DECLARE
    v_cuenta SMALLINT;
    v_tipo   TEXT;
    v_cat    TEXT;
    v_monto  NUMERIC(12,2);
    v_fecha  DATE;
    v_desc   TEXT;
    v_antes  NUMERIC(12,2);
    v_desp   NUMERIC(12,2);
    v_mov_id BIGINT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_cuenta := OLD.cuenta_id;  v_tipo := OLD.tipo;   v_cat := OLD.categoria;
        v_monto  := OLD.monto;      v_fecha := OLD.fecha; v_desc := OLD.descripcion;
        -- El movimiento ya no existe, así que no se puede guardar su id
        -- (la FK lo rechazaría). La auditoría se queda sin el enlace.
        v_mov_id := NULL;
    ELSE
        v_cuenta := NEW.cuenta_id;  v_tipo := NEW.tipo;   v_cat := NEW.categoria;
        v_monto  := NEW.monto;      v_fecha := NEW.fecha; v_desc := NEW.descripcion;
        v_mov_id := NEW.id;
    END IF;

    -- Saldo de la cuenta con TODOS los movimientos, incluido (o excluido,
    -- en DELETE) el de esta fila: ése es el "después".
    SELECT COALESCE(SUM(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE -m.monto END), 0)
      INTO v_desp
      FROM movimientos_financieros m
     WHERE m.cuenta_id = v_cuenta;

    -- El "antes" es ese saldo sin la contribución de esta fila.
    IF TG_OP = 'DELETE' THEN
        v_antes := v_desp + CASE WHEN v_tipo = 'ingreso' THEN v_monto ELSE -v_monto END;
    ELSE
        v_antes := v_desp - CASE WHEN v_tipo = 'ingreso' THEN v_monto ELSE -v_monto END;
    END IF;

    INSERT INTO auditoria_caja
        (movimiento_id, cuenta_id, usuario_id, fecha, tipo, categoria, monto,
         saldo_antes, saldo_despues, operacion, descripcion)
    VALUES
        (v_mov_id, v_cuenta, fn_usuario_actual(), v_fecha, v_tipo, v_cat, v_monto,
         v_antes, v_desp, TG_OP, v_desc);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auditar_caja
    AFTER INSERT OR UPDATE OR DELETE ON movimientos_financieros
    FOR EACH ROW EXECUTE FUNCTION fn_auditar_caja();


-- 8.10.2  Inventario: existence antes/después y el motivo del ajuste.
CREATE OR REPLACE FUNCTION fn_existencia_de(p_producto BIGINT, p_almacen SMALLINT)
RETURNS NUMERIC AS $$
    SELECT COALESCE(SUM(CASE WHEN tipo IN ('entrada_compra','ajuste_positivo')
                             THEN cantidad_bultos ELSE -cantidad_bultos END), 0)
      FROM inventario_movimientos
     WHERE producto_id = p_producto AND almacen_id = p_almacen;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fn_auditar_inventario()
RETURNS TRIGGER AS $$
DECLARE
    v_prod  BIGINT;
    v_alm   SMALLINT;
    v_tipo  TEXT;
    v_cant  NUMERIC(10,2);
    v_mot   TEXT;
    v_rt    TEXT;
    v_ri    BIGINT;
    v_id    BIGINT;
    v_antes NUMERIC(12,2);
    v_desp  NUMERIC(12,2);
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_prod := OLD.producto_id; v_alm := OLD.almacen_id; v_tipo := OLD.tipo;
        v_cant := OLD.cantidad_bultos; v_mot := OLD.motivo;
        v_rt := OLD.referencia_tabla;  v_ri := OLD.referencia_id;
        v_id := NULL;   -- el movimiento ya no existe: la FK lo rechazaría
    ELSE
        v_prod := NEW.producto_id; v_alm := NEW.almacen_id; v_tipo := NEW.tipo;
        v_cant := NEW.cantidad_bultos; v_mot := NEW.motivo;
        v_rt := NEW.referencia_tabla;  v_ri := NEW.referencia_id; v_id := NEW.id;
    END IF;

    -- En AFTER el movimiento ya está en la tabla, así que el saldo actual
    -- es el de "después" y "antes" se calcula revirtiéndolo.
    v_desp  := fn_existencia_de(v_prod, v_alm);
    v_antes := v_desp - CASE WHEN v_tipo IN ('entrada_compra','ajuste_positivo')
                             THEN v_cant ELSE -v_cant END;

    INSERT INTO auditoria_inventario
        (movimiento_id, producto_id, almacen_id, usuario_id, tipo,
         cantidad_bultos, existencia_antes, existencia_despues, motivo,
         referencia_tabla, referencia_id, operacion)
    VALUES
        (v_id, v_prod, v_alm, fn_usuario_actual(), v_tipo, v_cant,
         v_antes, v_desp, v_mot, v_rt, v_ri, TG_OP);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auditar_inventario
    AFTER INSERT OR UPDATE OR DELETE ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_auditar_inventario();


-- 8.10.3  Precios: un trigger genérico que sirve para las 3 tablas de
--          precios, porque comparten la misma forma.
CREATE OR REPLACE FUNCTION fn_auditar_precios()
RETURNS TRIGGER AS $$
DECLARE
    v_tipo TEXT;
    v_prod BIGINT;
    v_cli  BIGINT;
    v_prov BIGINT;
    v_ant  NUMERIC(10,2);
    v_nue  NUMERIC(10,2);
    v_desde DATE;
    v_hasta DATE;
BEGIN
    -- Un solo trigger para las 3 tablas de precios: el tipo se deduce del
    -- nombre de la tabla. OJO: cada tabla tiene columnas distintas
    -- (cliente_id sólo en precios_cliente, proveedor_id sólo en
    -- producto_proveedor_precios), así que los campos se leen por rama.
    -- En PL/pgSQL las referencias a campos de NEW/OLD se resuelven en
    -- tiempo de ejecución, por eso las ramas distintas no se chocan.
    v_tipo := CASE TG_TABLE_NAME
                WHEN 'precios_cliente'           THEN 'cliente'
                WHEN 'precios_publicos'          THEN 'publico'
                WHEN 'producto_proveedor_precios' THEN 'costo'
              END;

    IF TG_OP = 'DELETE' THEN
        v_prod := OLD.producto_id;
        v_ant  := OLD.precio_kg;
        v_nue  := NULL;
        v_desde := OLD.vigente_desde;
        v_hasta := OLD.vigente_hasta;
    ELSE
        v_prod := NEW.producto_id;
        v_ant  := CASE WHEN TG_OP = 'UPDATE' THEN OLD.precio_kg END;
        v_nue  := NEW.precio_kg;
        v_desde := NEW.vigente_desde;
        v_hasta := NEW.vigente_hasta;
    END IF;

    IF TG_TABLE_NAME = 'precios_cliente' THEN
        v_cli := CASE WHEN TG_OP = 'DELETE' THEN OLD.cliente_id ELSE NEW.cliente_id END;
    ELSE
        v_cli := NULL;
    END IF;

    IF TG_TABLE_NAME = 'producto_proveedor_precios' THEN
        v_prov := CASE WHEN TG_OP = 'DELETE' THEN OLD.proveedor_id ELSE NEW.proveedor_id END;
    ELSE
        v_prov := NULL;
    END IF;

    INSERT INTO auditoria_precios
        (tipo_precio, producto_id, cliente_id, proveedor_id, usuario_id,
         precio_anterior, precio_nuevo, vigente_desde, vigente_hasta, operacion)
    VALUES
        (v_tipo, v_prod, v_cli, v_prov, fn_usuario_actual(),
         v_ant, v_nue, v_desde, v_hasta, TG_OP);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_auditar_precios_cliente
    AFTER INSERT OR UPDATE OR DELETE ON precios_cliente
    FOR EACH ROW EXECUTE FUNCTION fn_auditar_precios();
CREATE TRIGGER trg_auditar_precios_publicos
    AFTER INSERT OR UPDATE OR DELETE ON precios_publicos
    FOR EACH ROW EXECUTE FUNCTION fn_auditar_precios();
CREATE TRIGGER trg_auditar_precios_costo
    AFTER INSERT OR UPDATE OR DELETE ON producto_proveedor_precios
    FOR EACH ROW EXECUTE FUNCTION fn_auditar_precios();


-- =====================================================================
-- 9. VISTAS ÚTILES (reportes automáticos que ya no se van a teclear)
-- =====================================================================

-- Existencia actual por producto/almacén (equivalente a "Conteo-precio")
CREATE OR REPLACE VIEW vw_existencia_actual AS
SELECT p.id AS producto_id, p.codigo, p.nombre, a.id AS almacen_id, a.nombre AS almacen,
       COALESCE(SUM(CASE WHEN m.tipo IN ('entrada_compra','ajuste_positivo')
                          THEN m.cantidad_bultos ELSE -m.cantidad_bultos END), 0) AS existencia_bultos
FROM productos p
CROSS JOIN almacenes a
LEFT JOIN inventario_movimientos m ON m.producto_id = p.id AND m.almacen_id = a.id
GROUP BY p.id, p.codigo, p.nombre, a.id, a.nombre;

-- Consumo semanal aproximado por cliente/producto (equivalente a tu
-- hoja "consumo semanal"), basado en ventas reales de las últimas 8 semanas
CREATE OR REPLACE VIEW vw_consumo_semanal_promedio AS
SELECT c.id AS cliente_id, c.nombre AS cliente, pr.id AS producto_id, pr.nombre AS producto,
       ROUND(SUM(d.cantidad_bultos * d.kg_bulto) /
             NULLIF(COUNT(DISTINCT date_trunc('week', n.fecha)), 0), 2) AS kg_promedio_semanal
FROM notas_remision n
JOIN nota_remision_detalle d ON d.nota_id = n.id
JOIN clientes c ON c.id = n.cliente_id
JOIN productos pr ON pr.id = d.producto_id
WHERE n.fecha >= CURRENT_DATE - INTERVAL '8 weeks'
GROUP BY c.id, c.nombre, pr.id, pr.nombre;

-- Estado de cuenta por cliente (equivalente a tu libro "Estado de cuenta clientes")
CREATE OR REPLACE VIEW vw_estado_cuenta_cliente AS
SELECT c.id AS cliente_id, c.nombre AS cliente, c.saldo_actual,
       (SELECT MAX(n.fecha) FROM notas_remision n WHERE n.cliente_id = c.id) AS ultima_venta,
       (SELECT MAX(p.fecha) FROM pagos p WHERE p.cliente_id = c.id) AS ultimo_pago
FROM clientes c;


-- =====================================================================
-- 10. CATÁLOGO DE ROLES Y PERMISOS
--
-- Esto NO es data de prueba: es configuración que el sistema necesita para
-- funcionar, así que va en la migración y no en el seed. Crear o quitar un
-- permiso es un cambio de código → nueva migración, nunca editar esta.
--
-- Formato del código: 'modulo.accion'. El backend lo pide con
--   SELECT fn_tiene_permiso('caja.eliminar');
-- =====================================================================

INSERT INTO roles (nombre, descripcion, es_admin) VALUES
  ('Administrador', 'Dueña del negocio. Acceso total, incluidos usuarios y auditorías.', TRUE),
  ('Empleada',      'Personal de bodega y mostrador: vende, cobra y registra.',  FALSE),
  ('Cajera',        'Maneja caja y bancos. Útil para delegar sin dar acceso a precios.', FALSE);

INSERT INTO permisos (codigo, modulo, accion, descripcion, es_escritura) VALUES
  -- Clientes / cartera
  ('clientes.ver',      'clientes', 'ver',      'Ver clientes y su estado de cuenta', FALSE),
  ('clientes.crear',    'clientes', 'crear',    'Dar de alta clientes',                TRUE),
  ('clientes.editar',   'clientes', 'editar',   'Editar datos de clientes',            TRUE),
  ('clientes.eliminar', 'clientes', 'eliminar', 'Eliminar clientes',                   TRUE),
  -- Catálogo de productos
  ('productos.ver',     'productos', 'ver',     'Ver productos',                       FALSE),
  ('productos.editar',  'productos', 'editar',  'Editar productos',                    TRUE),
  -- Precios
  ('precios.ver',       'precios', 'ver',      'Ver precios de lista y especiales',    FALSE),
  ('precios.editar',    'precios', 'editar',   'Cambiar precios de venta y de costo',  TRUE),
  -- Punto de venta
  ('notas.ver',         'notas', 'ver',        'Ver notas de remisión',                FALSE),
  ('notas.crear',       'notas', 'crear',      'Emitir notas de remisión (POS)',       TRUE),
  ('notas.editar',      'notas', 'editar',     'Editar notas pendientes',              TRUE),
  ('notas.cancelar',    'notas', 'cancelar',   'Cancelar notas ya emitidas',           TRUE),
  -- Cobranza
  ('pagos.ver',         'pagos', 'ver',        'Ver pagos y abonos',                  FALSE),
  ('pagos.crear',       'pagos', 'crear',      'Registrar abonos',                     TRUE),
  ('facturas.ver',      'facturas', 'ver',     'Ver facturación',                      FALSE),
  ('facturas.solicitar','facturas', 'solicitar','Solicitar factura al cliente',        TRUE),
  ('facturas.emitir',   'facturas', 'emitir',   'Emitir factura (CFDI)',               TRUE),
  -- Inventario
  ('inventario.ver',    'inventario', 'ver',    'Ver kárdex y foto semanal',            FALSE),
  ('inventario.ajustar','inventario', 'ajustar','Ajustar existencias (con motivo)',    TRUE),
  ('inventario.merma',  'inventario', 'merma',  'Registrar merma o pérdida',            TRUE),
  -- Compras / proveedores
  ('compras.ver',       'compras', 'ver',      'Ver compras',                         FALSE),
  ('compras.crear',     'compras', 'crear',    'Registrar compras',                   TRUE),
  ('proveedores.ver',   'proveedores', 'ver',   'Ver proveedores',                     FALSE),
  ('proveedores.editar','proveedores', 'editar','Editar proveedores',                  TRUE),
  -- Caja y bancos
  ('caja.ver',          'caja', 'ver',      'Ver movimientos de caja y bancos',       FALSE),
  ('caja.capturar',     'caja', 'capturar', 'Registrar ingresos y egresos',          TRUE),
  ('caja.eliminar',     'caja', 'eliminar', 'Eliminar/corregir movimientos de caja', TRUE),
  -- Usuarios
  ('usuarios.ver',      'usuarios', 'ver',   'Ver usuarios y roles',                  FALSE),
  ('usuarios.crear',    'usuarios', 'crear', 'Crear usuarios y asignar roles',        TRUE),
  ('usuarios.editar',   'usuarios', 'editar','Editar usuarios, roles y contraseñas', TRUE),
  -- Auditorías
  ('auditoria.ver',        'auditoria', 'ver',         'Ver bitácora general',              FALSE),
  ('auditoria.accesos',    'auditoria', 'accesos',     'Ver accesos y sesiones',            FALSE),
  ('auditoria.caja',       'auditoria', 'caja',        'Ver auditoría de caja y bancos',    FALSE),
  ('auditoria.inventario', 'auditoria', 'inventario',  'Ver auditoría de inventario',      FALSE),
  ('auditoria.precios',    'auditoria', 'precios',     'Ver auditoría de precios',         FALSE);

-- El Administrador lo tiene todo: se le dan todos los permisos sin
-- listarlos uno por uno. (fn_es_admin() también lo acepta igual.)
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r CROSS JOIN permisos p
 WHERE r.nombre = 'Administrador';

-- Empleada: opera el negocio diario, pero NO toca lo sensible.
-- Sin precios (afectan margen), sin caja.eliminar, sin usuarios, sin
-- auditorías, y sin cancelar remisiones ya emitidas.
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r JOIN permisos p ON p.codigo IN (
      'clientes.ver','clientes.crear','clientes.editar',
      'productos.ver',
      'precios.ver',
      'notas.ver','notas.crear','notas.editar',
      'pagos.ver','pagos.crear',
      'facturas.ver','facturas.solicitar',
      'inventario.ver','inventario.merma',
      'compras.ver','compras.crear',
      'proveedores.ver',
      'caja.ver','caja.capturar')
 WHERE r.nombre = 'Empleada';

-- Cajera: registra y cuadra caja, ve clientes para cobrar, no ve precios.
INSERT INTO roles_permisos (rol_id, permiso_id)
SELECT r.id, p.id
  FROM roles r JOIN permisos p ON p.codigo IN (
      'clientes.ver',
      'pagos.ver','pagos.crear',
      'facturas.ver',
      'caja.ver','caja.capturar','caja.eliminar',
      'auditoria.caja')
 WHERE r.nombre = 'Cajera';


-- =====================================================================
-- 11. VISTAS DE AUDITORÍA (lo que se consulta en pantalla)
-- =====================================================================

-- Quién hizo qué, con nombre legible en vez de ids sueltos.
CREATE OR REPLACE VIEW vw_auditoria_log AS
SELECT a.id, a.fecha, a.tabla, a.operacion, a.registro_id,
       u.nombre || ' ' || u.apellido_paterno AS usuario,
       u.rfc AS usuario_rfc,
       a.usuario_ip, a.usuario_bd, a.datos_anteriores, a.datos_nuevos
  FROM auditoria_log a
  LEFT JOIN usuarios u ON u.id = a.usuario_id;

-- Historial de una tabla/registro concreto, para la pantalla de detalle.
CREATE OR REPLACE VIEW vw_auditoria_de_registro AS
SELECT a.tabla, a.registro_id, a.fecha, a.operacion,
       u.nombre || ' ' || u.apellido_paterno AS usuario,
       a.usuario_ip, a.datos_anteriores, a.datos_nuevos
  FROM auditoria_log a
  LEFT JOIN usuarios u ON u.id = a.usuario_id
 WHERE a.registro_id IS NOT NULL;

-- Movimientos de caja con nombre de cuenta y de usuario.
CREATE OR REPLACE VIEW vw_auditoria_caja AS
SELECT ac.id, ac.fecha, ac.operacion, ac.tipo, ac.categoria, ac.monto,
       ac.saldo_antes, ac.saldo_despues, ac.descripcion,
       cf.nombre AS cuenta, cf.tipo AS cuenta_tipo,
       c.nombre  AS cliente,  p.nombre AS proveedor,
       COALESCE(u.nombre || ' ' || u.apellido_paterno, '(sistema)') AS usuario,
       ac.creado_en
  FROM auditoria_caja ac
  JOIN cuentas_financieras cf ON cf.id = ac.cuenta_id
  LEFT JOIN clientes   c ON c.id = (SELECT cliente_id   FROM movimientos_financieros m WHERE m.id = ac.movimiento_id)
  LEFT JOIN proveedores p ON p.id = (SELECT proveedor_id FROM movimientos_financieros m WHERE m.id = ac.movimiento_id)
  LEFT JOIN usuarios u ON u.id = ac.usuario_id;

-- Ajustes, mermas y movimientos de inventario con nombre de producto.
CREATE OR REPLACE VIEW vw_auditoria_inventario AS
SELECT ai.id, ai.creado_en, ai.operacion, ai.tipo, ai.cantidad_bultos,
       ai.existencia_antes, ai.existencia_despues, ai.motivo,
       pr.codigo AS producto_codigo, pr.nombre AS producto,
       a.nombre AS almacen,
       COALESCE(u.nombre || ' ' || u.apellido_paterno, '(sistema)') AS usuario
  FROM auditoria_inventario ai
  JOIN productos pr ON pr.id = ai.producto_id
  JOIN almacenes a  ON a.id  = ai.almacen_id
  LEFT JOIN usuarios u ON u.id = ai.usuario_id;

-- Cambios de precio de lista, especiales y de costo.
CREATE OR REPLACE VIEW vw_auditoria_precios AS
SELECT ap.id, ap.creado_en, ap.operacion, ap.tipo_precio,
       ap.precio_anterior, ap.precio_nuevo,
       (ap.precio_nuevo - ap.precio_anterior) AS variacion,
       pr.codigo AS producto_codigo, pr.nombre AS producto,
       c.nombre AS cliente, pv.nombre AS proveedor,
       COALESCE(u.nombre || ' ' || u.apellido_paterno, '(sistema)') AS usuario,
       ap.motivo
  FROM auditoria_precios ap
  JOIN productos pr ON pr.id = ap.producto_id
  LEFT JOIN clientes c     ON c.id  = ap.cliente_id
  LEFT JOIN proveedores pv ON pv.id = ap.proveedor_id
  LEFT JOIN usuarios u ON u.id = ap.usuario_id;

-- Accesos con nombre de usuario.
CREATE OR REPLACE VIEW vw_auditoria_accesos AS
SELECT aa.id, aa.creado_en, aa.evento, aa.ip, aa.user_agent, aa.detalle,
       COALESCE(u.nombre || ' ' || u.apellido_paterno, aa.usuario_intento) AS usuario,
       u.rfc AS usuario_rfc
  FROM auditoria_accesos aa
  LEFT JOIN usuarios u ON u.id = aa.usuario_id;

-- Permisos efectivos de cada usuario, para la pantalla de usuarios.
CREATE OR REPLACE VIEW vw_usuarios_permisos AS
SELECT u.id AS usuario_id,
       u.nombre || ' ' || u.apellido_paterno || ' ' || COALESCE(u.apellido_materno, '') AS usuario,
       u.rfc, u.email, u.activo, u.es_dueno, u.ultimo_acceso,
       string_agg(DISTINCT r.nombre, ', ' ORDER BY r.nombre) AS roles,
       string_agg(DISTINCT p.codigo, ', ' ORDER BY p.codigo) AS permisos
  FROM usuarios u
  LEFT JOIN usuarios_roles ur ON ur.usuario_id = u.id
  LEFT JOIN roles r           ON r.id = ur.rol_id
  LEFT JOIN roles_permisos rp ON rp.rol_id = r.id
  LEFT JOIN permisos p        ON p.id = rp.permiso_id
 GROUP BY u.id, u.nombre, u.apellido_paterno, u.apellido_materno,
          u.rfc, u.email, u.activo, u.es_dueno, u.ultimo_acceso;

-- ---------------------------------------------------------------------
-- FIN DE LA MIGRACIÓN
--
-- Todavía NO se crea ningún usuario real: tu hermana y las empleadas se
-- dan de alta con datos verdaderos, nunca desde un archivo de este repo.
-- Ver db/seeds/seed_demo.sql para un ejemplo con datos ficticios.
-- ---------------------------------------------------------------------

INSERT INTO pos.schema_migrations (version)
VALUES ('0001_init');

COMMIT;
