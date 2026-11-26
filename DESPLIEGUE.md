# Guía de despliegue – Inventario de ambientes SENA

Guía para el ingeniero o programador que instala la aplicación en un servidor propio (VPS Linux). Tiempo estimado: 30 a 45 minutos.

> **Regla principal:** si el servidor ya aloja otras aplicaciones (por ejemplo `firmas.luiscarlosreina.com`), **no modifique sus archivos, servicios ni configuración de Nginx**. Esta app se instala aislada: su propio Node, su propio usuario de sistema, su propio servicio y un archivo de Nginx **nuevo**.

## 1. Requisitos

| Elemento | Valor |
|---|---|
| Sistema operativo | Ubuntu 22.04 o superior (probado en el diseño para Ubuntu 24/26 LTS) |
| Acceso | `root` o usuario con `sudo` |
| Recursos | 1 vCPU, 512 MB RAM libres, 1 GB de disco |
| Puerto interno | `3100` (solo `127.0.0.1`; cámbielo en `.env` si está ocupado) |
| Dominio | Subdominio propio, p. ej. `inventario.luiscarlosreina.com` |
| Software | `curl`, `tar`, `xz-utils`, `openssl`, `nginx`, `certbot` (opcional para HTTPS) |
| Node.js | Lo descarga el instalador (v22, aislado en `/opt/inventario-sena/node`). No toca el Node del sistema |

## 2. Antes de empezar: revisar el servidor (solo lectura)

```bash
ss -ltnp                         # puertos en uso: confirme que 3100 está libre
systemctl list-units --type=service --state=running | grep -Ei 'node|pm2|nginx|caddy|docker|traefik'
ls /etc/nginx/sites-enabled/     # qué sitios existen hoy
nginx -t                         # la configuración actual debe estar OK antes de tocar nada
df -h / && free -m
```

Si el servidor **no usa Nginx** sino Caddy, Traefik o Apache, adapte el paso 5 con ese servidor (la app solo necesita un proxy inverso hacia `127.0.0.1:3100`).

## 3. DNS

Cree un registro **A**:

| Tipo | Nombre | Valor | TTL |
|---|---|---|---|
| A | `inventario` | IP pública del VPS | 3600 |

Verifique: `dig +short inventario.luiscarlosreina.com` debe devolver la IP del VPS.

## 4. Instalar la aplicación

El repositorio es **público**: se clona sin credenciales.

```bash
cd /root
git clone https://github.com/luiscarlosreinasanchez-crypto/inventario-ambientes-sena.git
cd inventario-ambientes-sena
# Opcional: nombre del usuario superadmin y nombre visible
export ADMIN_USER=lreina ADMIN_NAME="Luis Carlos Reina"
bash despliegue/instalar.sh https://inventario.luiscarlosreina.com
```

El instalador (`despliegue/instalar.sh`):
1. Verifica que el puerto 3100 esté libre.
2. Crea el usuario de sistema `inventario` (sin shell).
3. Descarga Node.js v22 en `/opt/inventario-sena/node`.
4. Copia el código a `/opt/inventario-sena/app` e instala dependencias (`npm ci --omit=dev`).
5. Crea `/opt/inventario-sena/app/.env` con un `SESSION_SECRET` aleatorio.
6. Instala y arranca el servicio `inventario-sena` (systemd) y prueba `http://127.0.0.1:3100/salud`.

Comprobación:

```bash
systemctl status inventario-sena
curl -s http://127.0.0.1:3100/salud          # {"ok":true}
cat /var/lib/inventario-sena/credenciales-iniciales.txt
```

Ese archivo trae las contraseñas iniciales del superadmin y de las 3 sedes. Entréguelas por un canal seguro, pida que se cambien al primer ingreso y luego bórrelo: `shred -u /var/lib/inventario-sena/credenciales-iniciales.txt`.

## 5. Nginx (archivo nuevo, sin tocar los existentes)

```bash
cp /opt/inventario-sena/app/despliegue/nginx-inventario.conf /etc/nginx/sites-available/inventario.luiscarlosreina.com
ln -s /etc/nginx/sites-available/inventario.luiscarlosreina.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx          # solo recargar si nginx -t dice OK
```

Si `nginx -t` falla, **no recargue**: borre el enlace recién creado en `sites-enabled` y revise.

## 6. HTTPS

```bash
certbot --nginx -d inventario.luiscarlosreina.com
```

Certbot edita solo el bloque de este subdominio. Verifique la renovación: `certbot renew --dry-run`.

La app marca la cookie de sesión como `Secure` cuando `BASE_URL` empieza por `https`. Si temporalmente sirve por `http`, ponga `COOKIE_SECURE=0` en `.env` y reinicie.

## 7. Variables de entorno (`/opt/inventario-sena/app/.env`)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `PORT` | Sí | Puerto interno (por defecto 3100) |
| `BASE_URL` | Sí | URL pública, se usa en enlaces y QR. **Si la cambia, los QR impresos dejan de servir** |
| `SESSION_SECRET` | Sí | Cadena aleatoria larga (`openssl rand -hex 32`). Cambiarla cierra todas las sesiones |
| `DATA_DIR` | Sí | Carpeta de la base de datos (`/var/lib/inventario-sena`) |
| `ADMIN_USER`, `ADMIN_NAME` | Solo 1.er arranque | Usuario y nombre del superadmin |
| `ADMIN_PASSWORD`, `PASS_PRINCIPAL`, `PASS_UNISANGIL`, `PASS_CONFINES` | Opcional, 1.er arranque | Si se omiten, se generan aleatorias |
| `COOKIE_SECURE` | Opcional | `1` o `0` para forzar el atributo `Secure` de la cookie |

Tras editar: `systemctl restart inventario-sena`.

## 8. Respaldos

La base de datos es un único archivo SQLite. El script hace una copia consistente sin detener el servicio:

```bash
bash /opt/inventario-sena/app/despliegue/respaldo.sh      # crea /var/backups/inventario-sena/inventario-AAAAMMDD-HHMMSS.db.gz
echo '50 23 * * * root bash /opt/inventario-sena/app/despliegue/respaldo.sh >/dev/null 2>&1' > /etc/cron.d/inventario-sena
```

Conserva 60 días. Copie también los respaldos fuera del servidor (Drive, otro VPS).

**Restaurar:**
```bash
systemctl stop inventario-sena
gunzip -c /var/backups/inventario-sena/inventario-AAAAMMDD-HHMMSS.db.gz > /var/lib/inventario-sena/inventario.db
rm -f /var/lib/inventario-sena/inventario.db-wal /var/lib/inventario-sena/inventario.db-shm
chown inventario:inventario /var/lib/inventario-sena/inventario.db
systemctl start inventario-sena
```

## 9. Actualizar a una nueva versión

```bash
bash /opt/inventario-sena/app/despliegue/respaldo.sh
cd /root/inventario-ambientes-sena && git pull
bash despliegue/instalar.sh https://inventario.luiscarlosreina.com
```

El instalador conserva `.env` y los datos (`/var/lib/inventario-sena`). El esquema de la base usa `CREATE TABLE IF NOT EXISTS`; si una versión futura cambia tablas, debe incluir su migración.

## 10. Operación y diagnóstico

| Necesidad | Comando |
|---|---|
| Estado | `systemctl status inventario-sena` |
| Logs en vivo | `journalctl -u inventario-sena -f` |
| Reiniciar | `systemctl restart inventario-sena` |
| Salud | `curl -s http://127.0.0.1:3100/salud` |
| Error 502 en Nginx | El servicio está caído: revise `journalctl -u inventario-sena -n 100` |
| "Sesión vencida o formulario inválido" | Normal si la página estuvo abierta muchas horas: recargar |

## 11. Seguridad aplicada

- Contraseñas con bcrypt; límite de 10 intentos de ingreso por IP cada 15 minutos.
- Token CSRF en formularios del panel; verificación de origen en el formulario público.
- Cada sede solo ve sus datos; el superadmin ve todas.
- Servicio systemd endurecido: usuario sin privilegios, `ProtectSystem=strict`, escritura solo en `/var/lib/inventario-sena`, memoria máxima 512 MB.
- La app escucha solo en `127.0.0.1`; el acceso público pasa por Nginx.

Recomendado: firewall (`ufw allow 22,80,443/tcp`), actualizaciones automáticas de seguridad y no compartir contraseñas por chat.

## 12. Primer uso (para coordinación)

1. Ingresar con el superadmin y cambiar su contraseña (Mi cuenta).
2. En cada sede: **Ajustes** (logo oficial SENA en PNG/JPG, código y versión del formato), **Ambientes** (crear cada ambiente y su cantidad asignada por elemento), **Instructores** (cargar el Excel o dejar que se registren solos).
3. Imprimir el **QR de cada ambiente** y pegarlo en la puerta.
4. Cada día: revisar **Inicio** (alertas), abrir **Actas diarias**, firmar y descargar el PDF. Descargar la **Sábana Excel** por rango de fechas cuando se necesite.
