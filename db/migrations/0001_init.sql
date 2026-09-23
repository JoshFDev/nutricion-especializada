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


-- =====================================================================
-- 0. FUNCIONES DE APOYO (updated_at, auditoría genérica)
-- =====================================================================

CREATE OR REPLACE FUNCTION fn_set_actualizado_en()
RETURNS TRIGGER AS $$
BEGIN
    NEW.actualizado_en := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- Bitácora genérica: guarda quién/qué/cuándo cambió en las tablas
-- críticas del negocio (esto es lo que pediste como "auditorías")
CREATE TABLE auditoria_log (
    id               BIGSERIAL PRIMARY KEY,
    tabla            TEXT NOT NULL,
    operacion        TEXT NOT NULL CHECK (operacion IN ('INSERT','UPDATE','DELETE')),
    registro_id      BIGINT,
    datos_anteriores JSONB,
    datos_nuevos     JSONB,
    usuario_bd       TEXT DEFAULT current_user,
    fecha            TIMESTAMP DEFAULT now()
);

CREATE OR REPLACE FUNCTION fn_auditoria()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        INSERT INTO auditoria_log(tabla, operacion, registro_id, datos_anteriores)
        VALUES (TG_TABLE_NAME, TG_OP, OLD.id, to_jsonb(OLD));
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO auditoria_log(tabla, operacion, registro_id, datos_anteriores, datos_nuevos)
        VALUES (TG_TABLE_NAME, TG_OP, NEW.id, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSIF (TG_OP = 'INSERT') THEN
        INSERT INTO auditoria_log(tabla, operacion, registro_id, datos_nuevos)
        VALUES (TG_TABLE_NAME, TG_OP, NEW.id, to_jsonb(NEW));
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;


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
    precio_kg       NUMERIC(10,2) NOT NULL,
    vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta   DATE,
    UNIQUE (cliente_id, producto_id, vigente_desde)
);
CREATE TRIGGER trg_precios_cliente_auditoria
    AFTER INSERT OR UPDATE OR DELETE ON precios_cliente
    FOR EACH ROW EXECUTE FUNCTION fn_auditoria();

-- Lista de precios públicos (cuando el cliente no tiene precio especial)
CREATE TABLE precios_publicos (
    id              BIGSERIAL PRIMARY KEY,
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    precio_kg       NUMERIC(10,2) NOT NULL,
    vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta   DATE
);

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
    precio_kg       NUMERIC(10,2) NOT NULL,
    precio_bulto    NUMERIC(10,2) NOT NULL,
    vigente_desde   DATE NOT NULL DEFAULT CURRENT_DATE,
    vigente_hasta   DATE
);

CREATE TABLE compras (
    id              BIGSERIAL PRIMARY KEY,
    proveedor_id    BIGINT NOT NULL REFERENCES proveedores(id),
    fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
    folio_proveedor TEXT,
    monto_total     NUMERIC(12,2) NOT NULL DEFAULT 0,   -- se recalcula vía trigger
    estatus         TEXT NOT NULL DEFAULT 'pendiente' CHECK (estatus IN ('pendiente','parcial','pagada')),
    creado_en       TIMESTAMP DEFAULT now()
);

CREATE TABLE compra_detalle (
    id              BIGSERIAL PRIMARY KEY,
    compra_id       BIGINT NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
    producto_id     BIGINT NOT NULL REFERENCES productos(id),
    almacen_id      SMALLINT NOT NULL REFERENCES almacenes(id),
    cantidad_bultos NUMERIC(10,2) NOT NULL,
    precio_kg       NUMERIC(10,2) NOT NULL,
    subtotal        NUMERIC(12,2) GENERATED ALWAYS AS
                     (cantidad_bultos * precio_kg) STORED
                     -- ojo: aquí "precio_kg" ya viene multiplicado por el
                     -- peso del bulto si tu hermana cotiza por bulto;
                     -- ajusta la fórmula si prefieres precio_kg * kg_bulto
);

CREATE TABLE pagos_proveedor (
    id              BIGSERIAL PRIMARY KEY,
    proveedor_id    BIGINT NOT NULL REFERENCES proveedores(id),
    compra_id       BIGINT REFERENCES compras(id),
    fecha           DATE NOT NULL DEFAULT CURRENT_DATE,
    monto           NUMERIC(12,2) NOT NULL,
    metodo          TEXT CHECK (metodo IN ('Efectivo','Transferencia','Depósito')),
    referencia      TEXT,
    creado_en       TIMESTAMP DEFAULT now()
);


-- =====================================================================
-- 4. FOLIOS Y NOTAS DE REMISIÓN (EL "PUNTO DE VENTA")
-- =====================================================================

-- Control de talonario de folios preimpresos, para que nunca se repita
-- ni se salte uno sin querer
CREATE TABLE folios (
    id            BIGSERIAL PRIMARY KEY,
    folio_numero  INTEGER UNIQUE NOT NULL,
    serie         TEXT NOT NULL DEFAULT 'A',
    estatus       TEXT NOT NULL DEFAULT 'disponible'
                  CHECK (estatus IN ('disponible','usado','cancelado'))
);

CREATE TABLE notas_remision (
    id                 BIGSERIAL PRIMARY KEY,
    folio_id           BIGINT UNIQUE NOT NULL REFERENCES folios(id),
    cliente_id         BIGINT NOT NULL REFERENCES clientes(id),
    fecha              DATE NOT NULL DEFAULT CURRENT_DATE,
    direccion_entrega  TEXT,
    subtotal           NUMERIC(12,2) NOT NULL DEFAULT 0,   -- se recalcula vía trigger
    estatus            TEXT NOT NULL DEFAULT 'pendiente'
                        CHECK (estatus IN ('pendiente','parcial','pagada','cancelada')),
    creado_en          TIMESTAMP DEFAULT now(),
    actualizado_en     TIMESTAMP DEFAULT now()
);
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
    kg_bulto         NUMERIC(10,3) NOT NULL,
    precio_unit_kg   NUMERIC(10,2) NOT NULL,
    subtotal         NUMERIC(12,2) GENERATED ALWAYS AS
                      (cantidad_bultos * kg_bulto * precio_unit_kg) STORED
);


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

-- Relación N:M -> una factura puede agrupar varias notas de remisión
CREATE TABLE factura_nota (
    factura_id  BIGINT NOT NULL REFERENCES facturas(id) ON DELETE CASCADE,
    nota_id     BIGINT NOT NULL REFERENCES notas_remision(id),
    PRIMARY KEY (factura_id, nota_id)
);


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
    referencia_tabla TEXT,          -- 'compra_detalle' / 'nota_remision_detalle' / 'manual'
    referencia_id    BIGINT,
    creado_en        TIMESTAMP DEFAULT now()
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


-- 8.3  Cada renglón vendido genera automáticamente su salida de inventario
CREATE OR REPLACE FUNCTION fn_salida_inventario_por_venta()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO inventario_movimientos
        (producto_id, almacen_id, tipo, cantidad_bultos, referencia_tabla, referencia_id)
    VALUES
        (NEW.producto_id, NEW.almacen_id, 'salida_venta', NEW.cantidad_bultos,
         'nota_remision_detalle', NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_salida_inventario_venta
    AFTER INSERT ON nota_remision_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_salida_inventario_por_venta();


-- 8.4  Cada renglón comprado genera automáticamente su entrada de inventario
CREATE OR REPLACE FUNCTION fn_entrada_inventario_por_compra()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO inventario_movimientos
        (producto_id, almacen_id, tipo, cantidad_bultos, referencia_tabla, referencia_id)
    VALUES
        (NEW.producto_id, NEW.almacen_id, 'entrada_compra', NEW.cantidad_bultos,
         'compra_detalle', NEW.id);

    UPDATE compras
       SET monto_total = COALESCE((SELECT SUM(subtotal) FROM compra_detalle
                                     WHERE compra_id = NEW.compra_id), 0)
     WHERE id = NEW.compra_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_entrada_inventario_compra
    AFTER INSERT ON compra_detalle
    FOR EACH ROW EXECUTE FUNCTION fn_entrada_inventario_por_compra();


-- 8.5  Después de cada movimiento de inventario: revisa existencia y
--      dispara una alerta si el stock queda en negativo
CREATE OR REPLACE FUNCTION fn_verificar_stock()
RETURNS TRIGGER AS $$
DECLARE
    v_existencia NUMERIC(10,2);
BEGIN
    SELECT COALESCE(SUM(
             CASE WHEN tipo IN ('entrada_compra','ajuste_positivo') THEN cantidad_bultos
                  ELSE -cantidad_bultos END), 0)
      INTO v_existencia
      FROM inventario_movimientos
     WHERE producto_id = NEW.producto_id AND almacen_id = NEW.almacen_id;

    IF v_existencia < 0 THEN
        INSERT INTO alertas (tipo, descripcion, tabla_origen, registro_id)
        VALUES ('stock_negativo',
                format('El producto_id %s quedó en %s bultos en almacen_id %s',
                       NEW.producto_id, v_existencia, NEW.almacen_id),
                'inventario_movimientos', NEW.id);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_verificar_stock
    AFTER INSERT ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_verificar_stock();


-- 8.6  Actualiza automáticamente la "foto" semanal de inventario
CREATE OR REPLACE FUNCTION fn_actualizar_inventario_semanal()
RETURNS TRIGGER AS $$
DECLARE
    v_anio   SMALLINT := EXTRACT(ISOYEAR FROM NEW.fecha);
    v_semana SMALLINT := EXTRACT(WEEK FROM NEW.fecha);
    v_entra  NUMERIC(10,2) := CASE WHEN NEW.tipo IN ('entrada_compra','ajuste_positivo')
                                    THEN NEW.cantidad_bultos ELSE 0 END;
    v_sale   NUMERIC(10,2) := CASE WHEN NEW.tipo IN ('salida_venta','ajuste_negativo','merma')
                                    THEN NEW.cantidad_bultos ELSE 0 END;
BEGIN
    INSERT INTO inventario_semanal (anio, semana, producto_id, almacen_id, entradas, salidas)
    VALUES (v_anio, v_semana, NEW.producto_id, NEW.almacen_id, v_entra, v_sale)
    ON CONFLICT (anio, semana, producto_id, almacen_id)
    DO UPDATE SET entradas = inventario_semanal.entradas + v_entra,
                  salidas  = inventario_semanal.salidas  + v_sale;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizar_inventario_semanal
    AFTER INSERT ON inventario_movimientos
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_inventario_semanal();


-- 8.7  Saldo del cliente: sube con cada nota, baja con cada pago aplicado
CREATE OR REPLACE FUNCTION fn_actualizar_saldo_cliente()
RETURNS TRIGGER AS $$
DECLARE
    v_cliente_id BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'notas_remision' THEN
        v_cliente_id := COALESCE(NEW.cliente_id, OLD.cliente_id);
    ELSIF TG_TABLE_NAME = 'pagos' THEN
        v_cliente_id := COALESCE(NEW.cliente_id, OLD.cliente_id);
    END IF;

    UPDATE clientes SET saldo_actual =
        COALESCE((SELECT SUM(subtotal) FROM notas_remision
                    WHERE cliente_id = v_cliente_id AND estatus <> 'cancelada'), 0)
        -
        COALESCE((SELECT SUM(monto) FROM pagos
                    WHERE cliente_id = v_cliente_id), 0)
    WHERE id = v_cliente_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_saldo_cliente_por_nota
    AFTER INSERT OR UPDATE OR DELETE ON notas_remision
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cliente();

CREATE TRIGGER trg_saldo_cliente_por_pago
    AFTER INSERT OR UPDATE OR DELETE ON pagos
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cliente();


-- 8.8  Saldo del proveedor: sube con cada compra, baja con cada pago
CREATE OR REPLACE FUNCTION fn_actualizar_saldo_proveedor()
RETURNS TRIGGER AS $$
DECLARE
    v_proveedor_id BIGINT := COALESCE(NEW.proveedor_id, OLD.proveedor_id);
BEGIN
    UPDATE proveedores SET saldo_actual =
        COALESCE((SELECT SUM(monto_total) FROM compras
                    WHERE proveedor_id = v_proveedor_id AND estatus <> 'pagada'), 0)
        -
        COALESCE((SELECT SUM(monto) FROM pagos_proveedor
                    WHERE proveedor_id = v_proveedor_id), 0)
    WHERE id = v_proveedor_id;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_saldo_proveedor_por_compra
    AFTER INSERT OR UPDATE OR DELETE ON compras
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_proveedor();

CREATE TRIGGER trg_saldo_proveedor_por_pago
    AFTER INSERT OR UPDATE OR DELETE ON pagos_proveedor
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_proveedor();


-- 8.9  Los movimientos financieros también actualizan el saldo de la
--      cuenta (caja chica / banco) automáticamente
CREATE OR REPLACE FUNCTION fn_actualizar_saldo_cuenta()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE cuentas_financieras
       SET saldo_actual = saldo_actual +
           CASE WHEN NEW.tipo = 'ingreso' THEN NEW.monto ELSE -NEW.monto END
     WHERE id = NEW.cuenta_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_actualizar_saldo_cuenta
    AFTER INSERT ON movimientos_financieros
    FOR EACH ROW EXECUTE FUNCTION fn_actualizar_saldo_cuenta();


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
SELECT c.id AS cliente_id, c.nombre, c.saldo_actual,
       (SELECT MAX(n.fecha) FROM notas_remision n WHERE n.cliente_id = c.id) AS ultima_venta,
       (SELECT MAX(p.fecha) FROM pagos p WHERE p.cliente_id = c.id) AS ultimo_pago
FROM clientes c;
