#!/usr/bin/env bash
# Instala "Inventario de ambientes SENA" en un VPS Ubuntu, AISLADO de otras apps:
#  - Node.js propio en /opt/inventario-sena/node (no toca el Node del sistema)
#  - usuario de sistema "inventario", servicio systemd "inventario-sena" en 127.0.0.1:3100
#  - datos en /var/lib/inventario-sena
# No modifica Nginx: eso se hace aparte, con un archivo nuevo (ver nginx-inventario.conf).
# Uso (como root, desde la carpeta del código):  bash despliegue/instalar.sh https://inventario.luiscarlosreina.com
set -euo pipefail
BASE_URL="${1:?Indique la URL pública, ej.: https://inventario.luiscarlosreina.com}"
NODE_VER="v22.21.1"
DEST=/opt/inventario-sena
DATA=/var/lib/inventario-sena
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if ss -ltn | grep -q ':3100 '; then
  if ! systemctl is-active --quiet inventario-sena; then echo "ERROR: el puerto 3100 ya lo usa otra aplicación. Cambie PORT." >&2; exit 1; fi
fi

id inventario >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin inventario
mkdir -p "$DEST" "$DATA"

if [ ! -x "$DEST/node/bin/node" ] || [ "$("$DEST/node/bin/node" -v)" != "$NODE_VER" ]; then
  arch=$(uname -m); case "$arch" in x86_64) a=x64;; aarch64) a=arm64;; *) echo "Arquitectura no soportada: $arch"; exit 1;; esac
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$a.tar.xz" -o "$tmp/node.tar.xz"
  mkdir -p "$DEST/node.nuevo" && tar -xJf "$tmp/node.tar.xz" -C "$DEST/node.nuevo" --strip-components=1
  [ -d "$DEST/node" ] && mv "$DEST/node" "$DEST/node.viejo.$(date +%s)"
  mv "$DEST/node.nuevo" "$DEST/node"
fi

# Copiar el código (sin datos ni dependencias)
mkdir -p "$DEST/app"
tar -C "$SRC" --exclude=node_modules --exclude=data --exclude=.git --exclude=.env -cf - . | tar -C "$DEST/app" -xf -
cd "$DEST/app"
PATH="$DEST/node/bin:$PATH" npm ci --omit=dev --no-audit --no-fund

if [ ! -f "$DEST/app/.env" ]; then
  cat > "$DEST/app/.env" <<EOF
PORT=3100
BASE_URL=$BASE_URL
SESSION_SECRET=$(openssl rand -hex 32)
DATA_DIR=$DATA
ADMIN_USER=${ADMIN_USER:-lreina}
ADMIN_NAME=${ADMIN_NAME:-Luis Carlos Reina}
EOF
  chmod 600 "$DEST/app/.env"
fi
chown -R inventario:inventario "$DATA" "$DEST/app"
chown root:inventario "$DEST/app/.env"; chmod 640 "$DEST/app/.env"

install -m 644 "$DEST/app/despliegue/inventario-sena.service" /etc/systemd/system/inventario-sena.service
systemctl daemon-reload
systemctl enable inventario-sena >/dev/null
systemctl restart inventario-sena
sleep 3
curl -fsS http://127.0.0.1:3100/salud && echo
echo "Listo. Servicio: systemctl status inventario-sena"
[ -f "$DATA/credenciales-iniciales.txt" ] && echo "Credenciales iniciales: $DATA/credenciales-iniciales.txt (léalas con: cat $DATA/credenciales-iniciales.txt)"
