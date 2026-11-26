#!/usr/bin/env bash
# Copia de seguridad en caliente de la base de datos (SQLite) sin detener el servicio.
# Uso (root):  bash /opt/inventario-sena/app/despliegue/respaldo.sh
# Cron sugerido (diario 23:50):  50 23 * * * root bash /opt/inventario-sena/app/despliegue/respaldo.sh
set -euo pipefail
DATA="${DATA_DIR:-/var/lib/inventario-sena}"
DEST="${BACKUP_DIR:-/var/backups/inventario-sena}"
NODE="${NODE_BIN:-/opt/inventario-sena/node/bin/node}"
mkdir -p "$DEST"
ARCH="$DEST/inventario-$(date +%Y%m%d-%H%M%S).db"
"$NODE" --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
" "$DATA/inventario.db" "$ARCH"
gzip "$ARCH"
# Conservar 60 días
find "$DEST" -name 'inventario-*.db.gz' -mtime +60 -delete
echo "Respaldo creado: $ARCH.gz"
