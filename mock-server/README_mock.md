# Mock Odoo — MeyFer Scraper Test Server

Servidor Express que simula la API de rhcomercial.com.ar para testear el scraper sin pegar al sitio real.

## Setup

### Opción 1: Ejecutar localmente

```bash
npm install
npm start
# Server en http://localhost:3099
```

### Opción 2: Usar Docker (Recomendado)

```bash
# Construir y ejecutar con Docker Compose
docker-compose up --build

# O ejecutar directamente con Docker
docker build -t mock-odoo .
docker run -p 3099:3099 mock-odoo
```

El servidor estará disponible en http://localhost:3099

## Variables de entorno (.env)

```env
MOCK_PORT=3099
MOCK_BASE_URL=http://localhost:3099
```

## Configurar el scraper para usar el mock

En el `.env` del scraper API cambiar:

```env
BASE_URL=http://localhost:3099
SITEMAP_URL=http://localhost:3099/sitemap.xml
ODOO_USER=cualquiercosa@test.com
ODOO_PASS=cualquierpassword
ODOO_DB=mock_db
```

El mock acepta **cualquier usuario y contraseña** — no valida credenciales.

---

## Catálogo

- **200 productos** distribuidos en 8 categorías
- **8 categorías** con 2 a 5 páginas cada una (8 productos por página)

| Categoría    | ID | Slug          | Productos | Páginas |
|--------------|----|---------------|-----------|---------|
| Agua         | 3  | agua          | 40        | 5       |
| Químicos     | 8  | quimicos      | 24        | 3       |
| Herramientas | 12 | herramientas  | 32        | 4       |
| Electricidad | 15 | electricidad  | 24        | 3       |
| Neumática    | 21 | neumatica     | 24        | 3       |
| Fijaciones   | 27 | fijaciones    | 24        | 3       |
| Medición     | 33 | medicion      | 16        | 2       |
| Seguridad    | 41 | seguridad     | 16        | 2       |

---

## Endpoints

### Auth

**`POST /web/session/authenticate`** — usado por el scraper
```json
// Request
{
  "jsonrpc": "2.0",
  "method": "call",
  "params": { "db": "mock_db", "login": "test@test.com", "password": "test" }
}
// Response
{ "result": { "uid": 1000, "login": "test@test.com", "session_id": "uuid..." } }
```

**`POST /web/login`** — form POST, redirige a `/my` con 303

---

### Sitemap

**`GET /sitemap.xml`** — 220 URLs (estáticas + categorías + marcas + 200 productos)

Formato de URL de producto:
```
http://localhost:3099/shop/2370-acople-comp-prof-ctraba-mec-codo-2-duke-1500
```
El scraper extrae `1500` (templateId) del final con `/shop/-(\d+)$/`

---

### Categorías

**`GET /shop/category/por-rubro-{slug}-{id}`** — página 1

**`GET /shop/category/por-rubro-{slug}-{id}/page/{n}`** — página n

> Cuando `page > totalPages` (ej: `page/999`), devuelve la última página con esa página marcada como activa en la paginación. El scraper usa esto para detectar cuántas páginas tiene cada categoría.

---

### Producto

**`GET /shop/{templateId}`** — redirige (302) a la URL canónica:
```
/shop/{sku}-{slug}-{templateId}
```
El scraper sigue el redirect y extrae el customId de la `responseUrl`.

**`GET /shop/{sku}-{slug}-{templateId}`** — página de detalle con:
```html
<input name="product_id" type="hidden" value="1500">
<input name="product_template_id" type="hidden" value="1500">
```

---

### API de precio

**`POST /website_sale/get_combination_info`**
```json
// Request params
{
  "product_template_id": 1500,
  "product_id": 1500,
  "combination": [],
  "add_qty": 1,
  "parent_combination": []
}
// Response result (campos que usa el scraper)
{
  "display_name": "ACOPLE COMP PROF C/TRABA MEC CODO 2\" \"DUKE\"",
  "list_price": 500.00,
  "base_unit_name": "Un",
  "product_type": "consu",
  "carousel": "<div>...<img src='/web/image/...'/>...</div>"
}
```

---

### Imágenes

**`GET /web/image/*`** — devuelve un SVG placeholder (200x200, fondo gris)

---

## Logs en consola

El servidor loguea cada request con timestamp:
```
[03:53:50.659] POST /web/session/authenticate  →  login=test@test.com
[03:53:50.688] GET  /sitemap.xml               →  200 productos
[03:53:50.798] GET  /shop/category/por-rubro-agua-3  →  cat=Agua page=1/5 productos=8
[03:53:51.053] GET  /shop/1500                 →  redirect → /shop/2370-...-1500
[03:53:51.081] POST /website_sale/get_combination_info  →  ACOPLE... → $500
```
