# Frontend

La app. Angular 22,zoneless, con signals y sin NgModules.

```bash
pnpm install
pnpm start        # ng serve, en http://localhost:4200
pnpm build        # bundle de produccion a dist/
pnpm test         # vitest
pnpm lint
pnpm verificar    # formato + lint + build + pruebas, todo junto
```

Para que funcione hace falta el backend arriba (`pnpm dev` dentro de
`backend/`) y el origen de esta pagina en `CORS_ORIGINS`, que con
`.env.example` ya viene bien.

## Que hay y que no

Lo que hay es **todo**: sesion, login, cambio de contrasena, el marco con el
menu, las doce pantallas del negocio y las dos de Sistema. No queda ningun
modulo con el aviso de "pantalla pendiente", y las rutas se siguen generando
desde la misma tabla que arma el menu, asi que no puede salir un enlace a una
pantalla que no exista.

Ya tienen pantalla el POS (`/notas`: cliente, renglones, totales e imprimir
el PDF), los clientes (`/clientes`: alta y edicion con codigo, especie y
filtros), los productos (`/productos`: alta, edicion y baja), el catalogo
(`/categorias` y `/especies`: alta, renombrado y borrado), los precios
(`/precios`: el de lista y el de cliente, con edicion de vigencia y cierre
en vez de borrado), los pagos (`/pagos`: listado filtrable, registro con
detalle y aplicacion a las notas abiertas del cliente), los proveedores
(`/proveedores`: alta y edicion, con la baja logica alternada desde la fila
y sin boton de borrar, porque un proveedor con compras tiene su nombre en
documentos viejos), las compras (`/compras`: captura con renglones, sin
editar y sin borrar, porque una compra se deshace cancelandola con motivo),
el inventario (`/inventario`: existencia en solo lectura, con busqueda y
filtro de lo que se esta acabando), la facturacion (`/facturacion`: la nota
no se edita nunca y la factura tampoco, lo unico que admite es el cambio de
estatus) y caja y bancos (`/caja`: el periodo por cuenta, el alta de cuentas
y los movimientos de ingreso y egreso, con el unico borrado de la app).

Las dos de Sistema son de otra familia. En `/usuarios` la lista sale paginada
de a 25 filas, y el RFC y el correo no se editan porque el `PATCH` no los
acepta; los roles van aparte porque cambiarlos cierra las sesiones abiertas
de esa persona. En el alta el administrador deja la clave en blanco y el
sistema genera una temporal que la persona cambia al entrar, o la escribe y
se usa tal cual. La contrasena temporal se muestra una vez y sin aviso que
se vaya, porque en la base solo queda su huella. En `/auditoria` hay cinco
bitacoras en pestanas, cada una con su permiso, y ninguna se puede editar:
lo que aparece lo escribieron los triggers de la base.

## Donde esta lo que importa

| Archivo                                | Que decide                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/nucleo/menu.ts`               | Que modulos existen, en que orden y con que permiso. De esta tabla salen TAMBIEN las rutas, asi que el menu no puede ofrecer algo que no exista |
| `src/app/nucleo/sesion.ts`             | El token, el perfil y los permisos. Un solo servicio, con signals                                                                               |
| `src/app/nucleo/interceptor-sesion.ts` | Le pone el token a todo y manda a `/login` cuando el servidor dice 401                                                                          |
| `src/app/nucleo/guarda-sesion.ts`      | Quien entra a donde                                                                                                                             |
| `src/app/nucleo/api.ts`                | Que se le muestra a la persona cuando algo sale mal                                                                                             |
| `src/environments/`                    | Donde vive la API: absoluta en desarrollo, relativa en produccion                                                                               |
| `src/app/nucleo/buscador.ts`           | El campo de busqueda con lista: espera 250 ms, una respuesta vieja no pisa una nueva, y el clic no se pierde por el `focusout`                  |
| `public/logo-nutricion.png`            | El logo que se ve en la barra, el login y la pestana. El original esta en `src/images/` (ver "El logo")                                         |

## Decisiones que no se ven en el codigo

**El token va en `localStorage`.** En un mostrador la sesion dura el turno,
y con el token en memoria cualquier recarga echaria a la persona fuera a
media operacion. El precio es que un `innerHTML` mal puesto daria lectura
del token. Arreglarlo de verdad es un cookie `httpOnly` de refresco, y eso
es un cambio del BACKEND: hoy el token solo se acepta en la cabecera
`Authorization`, no en cookie.

**La API se pide en relativa en produccion** (`/api`), no en absoluta. El
mismo nginx sirve el archivo de Angular y la API, asi que no hay CORS ni
un segundo origen del que alguien pueda colarse. En desarrollo si es
absoluta (`http://localhost:3000/api`) porque los puertos son distintos.

**Los permisos se vuelven a preguntar en cada carga.** El login trae el
usuario pero no la lista de permisos, y aunque las trajera no se guardan:
pueden cambiar mientras la persona trabaja, y con la lista guardada en el
navegador el menu seguiria ofreciendo cosas que ya no puede hacer hasta
recargar con F5. Cuesta una peticion de 30 bytes.

**El boton de entrar como administrador es solo de desarrollo, y el candado
esta en el backend.** El boton se dibuja solo con `ng serve`
(`environment.produccion` es `false` ahi), pero su texto SI queda dentro
del bundle de produccion: esconderlo no es proteccion, es maquillaje. Lo que
de verdad lo cierra es que `app.ts` monta esa ruta solo con
`NODE_ENV === 'development'`, y en produccion la peticion cae en el 404
del final. Si el build de desarrollo acabara en un servidor, el boton no
haria nada. Para quitarlo del proyecto: borrar `auth/rutas-dev.ts` y el
`if` de `app.ts`.

**Salir no espera al servidor.** `salir()` vacia el token al momento y el
POST de logout corre en segundo plano tragandose sus propios errores: antes,
con la red caida la app se congelaba (el interceptor saltaba al `/login`, la
transicion se quedaba a medias y no habia a quien seguirle dando clics). La
app ademas salta las animaciones de transicion cuando el destino es
`/login` o `/cambiar-contrasena`, para que ninguna pantalla se arrastre
encima de la otra al cerrar la sesion.

**Sin tests de componentes.** Hay 315 pruebas y ninguna levanta un
componente: cubren el menu, el mapeo de errores, la sesion, las cifras, el
buscador y el cuerpo de las peticiones de cada pantalla, que es donde esta la
logica que se rompe en silencio. Probar que un boton se dibuja sale mas caro
que lo que aporta; cuando las pantallas tengan estado propio, ahi si.

## El logo

| Archivo                        | Que es                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| `src/images/LogoNutricion.png` | El original, 1254x1254 y 1.2 MB. No lo usa nadie: es el master |
| `public/logo-nutricion.png`    | El que carga la app: 256x256 y 75 KB, en `public/`             |

Son dos archivos a proposito. El original pesa 1.2 MB porque es el archivo
de trabajo del diseño, y-meterlo al bundle costaria eso en cada carga de la
app por un dibujo que se ve a 28 pixeles en la barra y a 72 en el login. A
256 se ve igual de bien (es mas que el doble de esos dos tamanos, que es lo
que hace falta en una pantalla de retina) y pesa dieciseis veces menos.

El de `public/` se reescribio a mano (re-escalado con promediado de caja y
alfa premultiplicado, para que los bordes transparentes no dejen halo) y se
regenera cuando cambie el original, no a mano cada vez.

Y en la barra el logo va sobre una **placa blanca**, no suelto: el dibujo
tiene partes en azul marino (`rgb(0,32,128)`) que sobre el azul de la barra
(`--acento`, `#1e40af`) se perderian, y partes blancas que sobre el azul si
se verian. En el login no hace falta placa: la tarjeta ya es blanca.
