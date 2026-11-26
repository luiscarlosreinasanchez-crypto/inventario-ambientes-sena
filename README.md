# Inventario de ambientes SENA

Aplicación web para que cada instructor verifique y **firme digitalmente** el inventario del ambiente de formación al iniciar su jornada. Coordinación recibe alertas de faltantes, el **acta diaria en PDF** por sede y la **sábana en Excel** con alertas.

Proyecto del Centro Agroturístico (SENA, Regional Santander). Responsable funcional: Luis Carlos Reina.

## Funciones

| Rol | Acceso | Qué hace |
|---|---|---|
| Instructor | Sin cuenta: enlace o QR del ambiente (`/f/<sede>`) | Escribe nombre y documento, elige jornada, cuenta cada elemento, describe novedades y firma en pantalla |
| Coordinación de sede | Usuario y contraseña (`/s/<sede>`) | Alertas del día, registros, acta diaria (firma y PDF), sábana Excel, ambientes con inventario asignado y QR, elementos, instructores (importación Excel), usuarios, ajustes (logo, encabezado del formato) |
| Superadmin | Usuario y contraseña (`/admin`) | Crea y activa/desactiva sedes, sábana consolidada, entra a cualquier sede |

Sedes iniciales: **Sede Principal** (`principal`), **Sede Unisangil** (`unisangil`), **Sede Confines** (`confines`).

Reglas de negocio:
- **Faltante**: cantidad verificada menor que la asignada. Obliga a describir la novedad.
- **Sobrante / novedad**: cantidad mayor que la asignada o novedad escrita.
- **Sin reporte**: ambiente activo sin registro firmado en el día.
- **Jornadas y horarios** fijos: Mañana 6:30–12:30, Tarde 12:30–18:30, Noche 18:30–23:30 (`HORARIOS` en `src/server.js`).
- Fecha y hora las pone el servidor (zona `America/Bogota`). Un registro errado se **anula** con motivo, no se borra.
- Instructor nuevo: si el documento no está en la lista de la sede, se registra automáticamente con el nombre escrito.

## Tecnología

- Node.js **22.13 o superior** (usa el módulo nativo `node:sqlite`, sin compilación nativa).
- Express 5, cookie-session, bcryptjs, multer, pdfkit (acta PDF), exceljs (sábana), qrcode.
- Base de datos: un solo archivo SQLite (`$DATA_DIR/inventario.db`), modo WAL.
- Sin frontend compilado: HTML generado en el servidor + `public/app.css` y `public/formulario.js` (pad de firma).

```
src/
  server.js     rutas, autenticación, formularios
  db.js         esquema SQLite, datos iniciales (sedes y usuarios)
  servicios.js  reglas de faltantes/alertas y consultas
  pdf.js        acta diaria (pdfkit)
  excel.js      sábana con alertas (exceljs)
  views.js      plantilla HTML y utilidades
public/         CSS y JS del navegador
despliegue/     instalador, servicio systemd, Nginx, respaldo
```

## Probar en local

```bash
npm ci
SESSION_SECRET=dev ADMIN_PASSWORD=Cambiar123 npm start
# http://localhost:3100  ·  usuario superadmin: admin (o ADMIN_USER)
```

En el primer arranque se crean las 3 sedes y sus usuarios. Las contraseñas generadas quedan en `$DATA_DIR/credenciales-iniciales.txt` (permisos 600). Cámbielas al entrar y borre ese archivo.

## Despliegue en servidor

Ver **[DESPLIEGUE.md](DESPLIEGUE.md)**: guía paso a paso para Ubuntu con Nginx, HTTPS, respaldos y actualización.
