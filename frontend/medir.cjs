// Servidor estatico minimo para medir el login en un navegador de verdad.
// Sin dependencias: `npx http-server` no esta instalado y no hace falta.
const http = require('http');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, 'dist', 'frontend', 'browser');
const puerto = Number(process.argv[2] || 4321);

const tipos = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer((peticion, respuesta) => {
    // Todo cae en index.html: es una SPA y /login no existe como archivo.
    const pedido = decodeURIComponent(peticion.url.split('?')[0]);
    let archivo = path.join(raiz, pedido);

    if (!archivo.startsWith(raiz) || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
      archivo = path.join(raiz, 'index.html');
    }

    respuesta.writeHead(200, { 'content-type': tipos[path.extname(archivo)] || 'application/octet-stream' });
    fs.createReadStream(archivo).pipe(respuesta);
  })
  .listen(puerto, () => console.log(`listo en ${puerto}`));
