// Crea un servidor HTTP estático mínimo para medir el rendimiento del login en un navegador real.
// No requiere dependencias externas, ya que utiliza los módulos nativos de Node.js.
// Se obtiene el módulo HTTP para crear el servidor.
const http = require('http');
// Se obtiene el módulo FS para consultar y leer archivos del sistema.
const fs = require('fs');
// Se obtiene el módulo PATH para construir rutas de archivos.
const path = require('path');

// Define la ruta raíz donde se encuentran los archivos compilados del frontend.
const raiz = path.join(__dirname, 'dist', 'frontend', 'browser');
// Define el puerto del servidor; utiliza 4321 si no se proporciona otro mediante argumentos.
const puerto = Number(process.argv[2] || 4321);

// Define los tipos MIME correspondientes a las extensiones de archivo que puede servir.
const tipos = {
  '.html': 'text/html', // Documentos HTML.
  '.js': 'text/javascript', // Archivos JavaScript.
  '.css': 'text/css', // Hojas de estilo CSS.
  '.json': 'application/json', // Archivos JSON.
  '.jpg': 'image/jpeg', // Imágenes JPG.
  '.png': 'image/png', // Imágenes PNG.
  '.svg': 'image/svg+xml', // Imágenes vectoriales SVG.
  '.ico': 'image/x-icon', // Iconos del sitio web.
};

// Crea el servidor HTTP y define cómo procesar cada petición recibida.
http
  .createServer((peticion, respuesta) => {
    // Obtiene la ruta solicitada y elimina los parámetros de consulta (query string).
    // También decodifica los caracteres especiales de la URL.
    const pedido = decodeURIComponent(peticion.url.split('?')[0]);

    // Construye la ruta completa del archivo solicitado dentro del directorio raíz.
    let archivo = path.join(raiz, pedido);

    // Comprueba que el archivo pertenezca al directorio raíz, exista y no sea un directorio.
    if (
      !archivo.startsWith(raiz) ||
      !fs.existsSync(archivo) ||
      fs.statSync(archivo).isDirectory()
    ) {
      // Si no se cumple alguna condición, devuelve index.html.
      // Esto permite que las rutas internas de una SPA, como /login, funcionen correctamente.
      archivo = path.join(raiz, 'index.html');
    }

    // Envía una respuesta HTTP con código 200 (OK).
    // Establece el tipo MIME según la extensión del archivo solicitado.
    // Si la extensión no está registrada, utiliza application/octet-stream.
    respuesta.writeHead(200, {
      'content-type': tipos[path.extname(archivo)] || 'application/octet-stream',
    });

    // Lee el archivo solicitado mediante un flujo de lectura y lo envía al navegador.
    fs.createReadStream(archivo).pipe(respuesta);

  // Inicia el servidor en el puerto configurado.
  // Cuando comienza a escuchar peticiones, muestra un mensaje en la consola.
  })
  .listen(puerto, () => console.log(`listo en ${puerto}`));