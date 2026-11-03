# Despliegue paso a paso desde Android

Puedes ejecutar estos pasos desde Termux o una computadora.

## A. Preparar GitHub

Crea dos repositorios vacíos:
- `video-api-cloudflare`
- `video-downloader-android`

Descomprime cada ZIP y sube su contenido al repositorio correspondiente. No subas archivos `.env`, contraseñas ni tokens.

## B. API y D1

```bash
cd video-api-cloudflare
npm install
npx wrangler login
npx wrangler d1 create video-api-db
```

Edita `wrangler.toml` con el ID real de D1. Después:

```bash
npx wrangler d1 execute video-api-db --remote --file=./schema.sql
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler deploy
```

Copia la URL publicada del Worker.

## C. Crear administrador

```bash
curl -X POST "https://TU-WORKER.workers.dev/admin/bootstrap" \
-H "Content-Type: application/json" \
-H "X-Bootstrap-Secret: TU_SECRETO" \
-d '{"email":"TU_CORREO","password":"UNA_CLAVE_DE_12_O_MAS_CARACTERES"}'
```

No compartas el secreto. Una vez creado el administrador, el endpoint ya no permitirá crear otro.

## D. Panel Pages

Edita `admin/config.js` con la URL del Worker. Conecta el repo en Cloudflare Pages y define `admin` como directorio de salida. Si el repo API también contiene Worker, despliega el Worker por Wrangler por separado.

Actualiza `ADMIN_ORIGIN` en `wrangler.toml` con el dominio Pages exacto y vuelve a desplegar el Worker:

```bash
npx wrangler deploy
```

## E. Android

Edita `API_BASE_URL` en `app/build.gradle.kts`. Abre el proyecto en Android Studio y ejecuta.

## F. Pruebas básicas

```bash
curl https://TU-WORKER.workers.dev/health
```

Registro:

```bash
curl -X POST https://TU-WORKER.workers.dev/auth/register \
-H "Content-Type: application/json" \
-d '{"email":"usuario@example.com","password":"UnaClaveSegura123"}'
```

Inicia sesión, copia el token y consulta:

```bash
curl https://TU-WORKER.workers.dev/auth/me \
-H "Authorization: Bearer TOKEN"
```

El usuario aparecerá como `pending`. Apruébalo desde el panel. Después de aprobarlo, el endpoint de extracción seguirá devolviendo `EXTRACTOR_NOT_CONFIGURED` hasta que se desarrolle un adaptador real.
