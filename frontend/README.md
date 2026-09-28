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

Lo que hay es la **base de la que cuelga todo lo demas**: sesion, login,
cambio de contrasena, el marco con el menu y un aviso de "pantalla
pendiente" en cada modulo. Los nueve modulos del negocio que faltan
todavia no tienen pantalla; se ven en el menu porque las rutas se generan,
pero abrir uno muestra lo que falta.

Ya tienen pantalla el POS (`/notas`: cliente, renglones, totales e imprimir
el PDF), los clientes (`/clientes`: alta y edicion con codigo, especie y
filtros), los productos (`/productos`: alta, edicion y baja) y el catalogo
(`/categorias` y `/especies`: alta, renombrado y borrado).

## Donde esta lo que importa

| Archivo                                | Que decide                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/nucleo/menu.ts`               | Que modulos existen, en que orden y con que permiso. De esta tabla salen TAMBIEN las rutas, asi que el menu no puede ofrecer algo que no exista |
| `src/app/nucleo/sesion.ts`             | El token, el perfil y los permisos. Un solo servicio, con signals                                                                               |
| `src/app/nucleo/interceptor-sesion.ts` | Le pone el token a todo y manda a `/login` cuando el servidor dice 401                                                                          |
| `src/app/nucleo/guarda-sesion.ts`      | Quien entra a donde                                                                                                                             |
| `src/app/nucleo/api.ts`                | Que se le muestra a la persona cuando algo sale mal                                                                                             |
| `src/environments/`                    | Donde vive la API: absoluta en desarrollo, relativa en produccion                                                                               |

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

**Sin tests de componentes.** Hay 99 pruebas y ninguna levanta un
componente: cubren el menu, el mapeo de errores, la sesion, las cifras y
el mapeo del cuerpo de las peticiones, que es donde esta la logica que se
rompe en silencio. Probar que un boton se dibuja sale mas caro que lo que
aporta; cuando las pantallas tengan estado propio, ahi si.
