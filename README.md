# Meyfer Scraper Microservice

Este microservicio se encarga de scrapear productos desde un sitio externo y enviar un webhook al backend una vez completado el proceso.

## 🚀 Endpoints

### Sitemap Scraper

POST /api/scraper/sitemap/


**Body:**

```json
{
  "pageDelay": 250,
  "webhookUrl": "http://localhost:3001/api/webhook/scraper"
}
```

### Category Scraper

POST /api/scraper/category/

Body:
```json
{
  "rubros": 4,
  "pageDelay": 100,
  "categoryDelay": 300,
  "webhookUrl": "http://localhost:3001/api/webhook/scraper"
}
```


⚙️ Variables de entorno

Crea un archivo .env con el siguiente contenido:

```
MONGO_URI=mongodb://root:root@localhost:27018/?authSource=admin
MONGO_DB=catalog
MONGO_COLLECTION=products
ODOO_USER=mail@gmail.com
ODOO_PASS=odoopass
ODOO_DB=odoodb
BASE_URL=https://web.com
PAGE_DELAY_MS=1500
CATEGORY_DELAY_MS=3000
PORT=3000
```
