# Scraper API

Este documento describe los endpoints del scraper actualizado, tanto para categorías como para sitemap. Los scrapers ahora devuelven métricas completas y notifican un webhook con estadísticas del proceso.

Endpoints:

1. Category Scraper

* URL: `/api/scraper/category`
* Método: `POST`
* Descripción: Ejecuta el scraper de productos por categorías.
* Request body ejemplo:

```json
{
  "categoryId": "all",
  "pageDelay": 500,
  "categoryDelay": 1000,
  "webhookUrl": "https://example.com/webhook"
}
```

* Campos:

    * `categoryId`: "all" o ID numérico de la categoría.
    * `pageDelay`: Tiempo en ms entre procesamiento de productos.
    * `categoryDelay`: Tiempo en ms entre categorías.
    * `webhookUrl`: URL donde se notifica el resultado del scraping.
* Response inicial:

```json
{
  "status": "accepted",
  "message": "Category scraper started"
}
```

* Webhook payload ejemplo:

```json
{
  "source": "categoryScraper",
  "status": "success",
  "processed": 154,
  "stats": {
    "durationMs": 12345,
    "totalErrors": 2,
    "startedAt": "2025-10-24T20:00:00.000Z",
    "finishedAt": "2025-10-24T20:20:00.000Z"
  },
  "timestamp": "2025-10-24T20:20:01.000Z"
}
```

2. Sitemap Scraper

* URL: `/api/scraper/sitemap`
* Método: `POST`
* Descripción: Ejecuta el scraper basado en URLs de sitemap.
* Request body ejemplo:

```json
{
  "sitemapSource": "https://rhcomercial.com.ar/sitemap.xml",
  "limitProducts": 100,
  "pageDelay": 500,
  "webhookUrl": "https://example.com/webhook"
}
```

* Campos:

    * `sitemapSource`: URL del sitemap (opcional).
    * `limitProducts`: Limitar la cantidad de productos a procesar (opcional).
    * `pageDelay`: Tiempo en ms entre procesamiento de productos.
    * `webhookUrl`: URL donde se notifica el resultado del scraping.
* Response inicial:

```json
{
  "status": "accepted",
  "message": "Sitemap scraper started"
}
```

* Webhook payload ejemplo:

```json
{
  "source": "sitemapScraper",
  "status": "success",
  "processed": 100,
  "stats": {
    "durationMs": 6789,
    "totalErrors": 0,
    "startedAt": "2025-10-24T20:00:00.000Z",
    "finishedAt": "2025-10-24T20:10:00.000Z"
  },
  "timestamp": "2025-10-24T20:10:01.000Z"
}
```

Notas importantes:

* Ambos scrapers devuelven respuesta inmediata `202 Accepted` y procesan los datos en segundo plano.
* El webhook recibe métricas completas del scraping (`processed`, `errors`, `durationMs`, `startedAt`, `finishedAt`).
* Los delays (`pageDelay` y `categoryDelay`) ayudan a evitar bloqueos por requests simultáneas.
* Compatible con la nueva versión de `notifyWebhook`, que maneja resultados completos y mantiene compatibilidad hacia atrás con `processed` solo.
