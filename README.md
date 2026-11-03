# RVideo API privada — Cloudflare Workers + D1

Starter inicial para una API privada con aprobación manual de usuarios.

## Estado del starter

Incluye:
- Registro e inicio de sesión.
- Contraseñas derivadas con PBKDF2 (Web Crypto).
- Tokens de sesión opacos; solo se guarda su hash en D1.
- Usuarios `pending`, `approved`, `rejected`, `suspended`, `revoked`.
- Bootstrap de primer administrador protegido por `BOOTSTRAP_SECRET`.
- Endpoints administrativos.
- Límite básico por usuario para solicitudes de extracción.
- Panel web estático para administrar usuarios.
- Validación de dominios admitidos antes de llamar al extractor.

**No incluye todavía extractores funcionales.** El endpoint `/api/v1/extract` devuelve `501 EXTRACTOR_NOT_CONFIGURED` de forma intencional. No se debe presentar como descargador terminado. Los adaptadores de cada plataforma se implementarán y probarán por separado, respetando contenido público, permisos y condiciones de cada plataforma.

## Requisitos

- Cuenta Cloudflare.
- Node.js LTS y npm.
- Wrangler: `npm install -g wrangler`.
- Git.

## 1. Crear D1

```bash
npx wrangler login
npx wrangler d1 create video-api-db
```

Copia el `database_id` devuelto y reemplaza `REPLACE_WITH_D1_DATABASE_ID` en `wrangler.toml`.

Aplica el esquema:

```bash
npx wrangler d1 execute video-api-db --remote --file=./schema.sql
```

Para desarrollo local:

```bash
npx wrangler d1 execute video-api-db --local --file=./schema.sql
```

## 2. Configurar secretos

Desde esta carpeta:

```bash
npx wrangler secret put BOOTSTRAP_SECRET
```

Escribe una contraseña larga, aleatoria y exclusiva. No la guardes en Git ni dentro de la app Android.

Configura el origen del panel en `wrangler.toml` o como variable `ADMIN_ORIGIN`, por ejemplo `https://video-admin.pages.dev`.

## 3. Desplegar Worker

```bash
npm install
npx wrangler deploy
```

Wrangler mostrará la URL `https://...workers.dev`. Guárdala para configurar Android y el panel.

## 4. Crear el primer administrador

Hazlo una sola vez. Sustituye la URL y el secreto:

```bash
curl -X POST "https://TU-WORKER.workers.dev/admin/bootstrap" \
  -H "Content-Type: application/json" \
  -H "X-Bootstrap-Secret: TU_SECRETO" \
  -d '{"email":"tu-correo@example.com","password":"UnaClaveLargaYUnica"}'
```

El endpoint se bloquea después de crear el primer administrador. Si pierdes acceso, no vuelvas a habilitar el bootstrap públicamente: usa un procedimiento de recuperación controlado desde D1.

## 5. Publicar el panel en Cloudflare Pages

1. Sube el contenido de la carpeta `admin/` a un repositorio Git independiente o mantenlo dentro del repo API.
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Selecciona el repositorio.
4. Build command: vacío.
5. Build output directory: `admin`.
6. Despliega.
7. Edita `admin/config.js` y coloca la URL real del Worker en `API_BASE`.
8. Vuelve a desplegar.

El panel guarda el token solo en `sessionStorage`, no en `localStorage`. No publiques `BOOTSTRAP_SECRET` en el panel.

## 6. Configurar Android

En el repositorio Android, cambia `API_BASE_URL` en `app/build.gradle.kts` por la URL real del Worker. Para producción usa HTTPS.

## Endpoints

Públicos:
- `GET /health`
- `GET /api/v1/platforms`
- `POST /auth/register`
- `POST /auth/login`

Con sesión:
- `POST /auth/logout`
- `GET /auth/me`
- `POST /api/v1/extract` (requiere usuario aprobado; extractor pendiente de implementar)
- `GET /api/v1/history`

Administración:
- `GET /admin/users`
- `POST /admin/users/:id/approve`
- `POST /admin/users/:id/reject`
- `POST /admin/users/:id/suspend`
- `POST /admin/users/:id/revoke`

## Seguridad antes de producción

- Cambia cualquier contraseña de ejemplo.
- Usa un correo propio para el administrador.
- No incluyas secretos en Git, APK, JavaScript del panel ni variables `VITE_`.
- Restringe CORS a la URL exacta del panel. La app Android nativa no depende de CORS.
- Activa reglas de rate limiting en Cloudflare cuando estén disponibles en tu configuración.
- Añade verificación de correo, recuperación de contraseña y protección antiabuso antes de abrir registros.
- No aceptes URLs arbitrarias para el extractor: valida hostname y protocolo.
- No hagas que el Worker descargue ni retransmita el archivo de video.
- Las URLs de descarga devueltas por futuros extractores deben ser temporales y originadas por el proveedor.
- No uses este starter para acceder a cuentas privadas, evadir autenticación ni infringir derechos.

## Límites del plan gratuito

Workers Free tiene límites de solicitudes y CPU; D1 también tiene cuotas gratuitas. Revisa las cuotas vigentes antes de producción. Este diseño mantiene la extracción fuera del Worker: Workers autentica y coordina, no ejecuta yt-dlp ni procesa multimedia.
