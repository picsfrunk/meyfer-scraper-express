# Meyfer Scraper Microservice

Este microservicio se encarga de realizar tareas de scraping sobre un sitio web definido por variables de entorno y enviar los resultados a un endpoint webhook especificado por el cliente.

## Endpoints

### POST `/api/scraper/sitemap/`

Inicia un proceso de scraping sobre el sitemap del sitio web base.

**Body esperado (JSON):**

```
{
  "pageDelay": 250,
  "webhookUrl": "http://localhost:3001/api/webhook/scraper"
}
```

- `pageDelay`: Tiempo en milisegundos entre solicitudes a páginas.
- `webhookUrl`: URL del backend receptor de la notificación cuando termina el scraping.

**Descripción:** Este endpoint recorrerá las URLs listadas en el sitemap del sitio base y extraerá los datos de cada página. Al finalizar, notificará al `webhookUrl`.

---

### POST `/api/scraper/category/`

Inicia el scraping sobre un conjunto de categorías (rubros) predefinidas.

**Body esperado (JSON):**

```
{
  "rubros": 4,
  "pageDelay": 100,
  "categoryDelay": 300,
  "webhookUrl": "http://localhost:3001/api/webhook/scraper"
}
```

- `rubros`: Número entero que define cuántos rubros se procesan. Si se omite, se procesan todos los rubros definidos en `rubros.js`.
- `pageDelay`: Demora entre páginas dentro de una categoría.
- `categoryDelay`: Demora entre cada categoría.
- `webhookUrl`: URL para notificar al finalizar el proceso.

**Descripción:** Este endpoint itera por cada categoría (hasta `rubros`), extrayendo los productos y enviando los resultados al `webhookUrl`.

---

## Arquitectura

Este microservicio está dividido en las siguientes capas:

- `controllers`: Orquestan la lógica de cada endpoint.
- `services`: Ejecutan la lógica de negocio (scraping y notificaciones).
- `scraper`: Contiene lógica pura de scraping específica para sitemap y categorías.
- `utils`: Funciones auxiliares (e.g. logueo a archivos).
- `config`: Archivos de configuración como delays, rubros, etc.
- `database`: Conexión con MongoDB.

## Webhook

El microservicio notificará al `webhookUrl` enviado en cada solicitud POST al finalizar la tarea de scraping. La carga útil del webhook puede contener un resumen o detalle de los datos procesados.

## Variables de entorno (.env)

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

## Instalación local

```bash
git clone https://github.com/tu-usuario/meyfer-scraper-microservice.git
cd meyfer-scraper-microservice
npm install
npm start
```

## Deploy con Docker

Ver el archivo `Dockerfile` y `docker-compose.yml` para despliegue.

---


### Commit [`6790f94`](https://github.com/picsfrunk/meyfer-scraper-express/commit/6790f9469eef1d3f460d33935eb4b2ae3d59fb78)
**fix: bug en endpoint sitemap y compatibilidad webhook**

- Se corrigió el endpoint `/api/scraper/sitemap/` para asegurar que el payload enviado al webhook del backend cumpla con el formato esperado (`source`, `status`, `processed`, `timestamp`).
- Ahora el microservicio scraper es compatible con las validaciones del backend y reporta correctamente el estado al finalizar el proceso de scraping.
- Se mejoró el control de errores y el formato de la notificación enviada, evitando rechazos o errores 400 por parte del backend.
- Refactor en el service del scraper para limpiar la estructura del código y hacer más clara la notificación al webhook.

---

### Notas adicionales

- Con estos cambios, la integración entre el backend y el scraper es más robusta y escalable.
- El backend puede recibir notificaciones de fin de proceso de scraping sin errores de validación y el frontend puede orquestar ambos procesos de forma sencilla.

## Licencia

MIT