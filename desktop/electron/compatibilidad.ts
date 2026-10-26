import fs from 'node:fs/promises';
import { platform } from 'node:os';

// embedded-postgres intenta aplicar chmod a sus binarios antes de ejecutarlos.
// En Linux eso es necesario, pero en Windows los permisos POSIX no aplican y
// chmod falla con EPERM cuando la aplicación está instalada en una carpeta
// protegida como "C:\Program Files". Ignoramos únicamente ese caso: los
// binarios de Windows ya se pueden ejecutar sin cambiarles el modo.
if (platform() === 'win32') {
  const chmodOriginal = fs.chmod;

  fs.chmod = async (ruta, modo) => {
    try {
      return await chmodOriginal(ruta, modo);
    } catch (error) {
      const codigo = (error as NodeJS.ErrnoException).code;
      if (codigo === 'EPERM' || codigo === 'EACCES') {
        console.warn(`[compat] chmod ignorado en Windows para ${String(ruta)} (${codigo})`);
        return;
      }
      throw error;
    }
  };
}
