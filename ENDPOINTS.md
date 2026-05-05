# Scraper API — Documentación de Endpoints

Base path: `/scraper` (montado en `admin.routes.js`)

---

## Índice

- [POST /scraper/category](#post-scrapercategory)
- [POST /scraper/sitemap](#post-scrapersitemap)
- [POST /scraper/sitemap/analysis](#post-scrapersitemapanalysis)
- [GET /scraper/status](#get-scraperstatus)
- [POST /scraper/check-prices](#post-scrapercheck-prices)
- [DELETE /scraper/jobs/:jobId](#delete-scraperjobsjobid)
- [DELETE /scraper/jobs/all](#delete-scraperjobsall)
- [Modelo de respuesta 202](#modelo-de-respuesta-202)
- [Webhooks](#webhooks)

---

## POST /scraper/category

Inicia o encola un scraping por categorías de Odoo.

### Body

```json
{
  "categoryIds": ["10", "23", "47"],
  "pageDelay": 1500,
  "categoryDelay": 3000,
  "webhookUrl": "https://mi-backend.com/api/webhook/scraper"
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `categoryIds` | `string[]` | ✅ | IDs de las categorías a scrapear |
| `pageDelay` | `number` | ❌ | Delay en ms entre páginas (default: `PAGE_DELAY_MS` del env) |
| `categoryDelay` | `number` | ❌ | Delay en ms entre categorías |
| `webhookUrl` | `string` | ❌ | URL para recibir notificaciones del ciclo de vida del job |

### Respuesta `202 Accepted`

```json
{
  "status": "accepted",
  "jobId": "categoryScraper-1718000000000-1",
  "message": "Category scraper iniciado.",
  "queue": {
    "pending": 0,
    "position": 0,
    "running": { "id": "categoryScraper-1718000000000-1", "type": "categoryScraper", "startedAt": "2024-06-10T12:00:00.000Z", "elapsedMs": 0 }
  }
}
```

> Si ya hay un scraper en ejecución, el job se encola y `status` será `"queued"` con `position` indicando el lugar en la fila.

---

## POST /scraper/sitemap

Inicia o encola un scraping completo desde el sitemap del sitio.

### Body

```json
{
  "sitemapSource": "https://www.tienda.com/sitemap.xml",
  "limitProducts": 500,
  "pageDelay": 1200,
  "webhookUrl": "https://mi-backend.com/api/webhook/scraper"
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `sitemapSource` | `string` | ❌ | URL del sitemap (si se omite usa el default del scraper) |
| `limitProducts` | `number` | ❌ | Limitar cantidad de productos a procesar |
| `pageDelay` | `number` | ❌ | Delay en ms entre páginas |
| `webhookUrl` | `string` | ❌ | URL para recibir notificaciones del ciclo de vida del job |

### Respuesta `202 Accepted`

```json
{
  "status": "accepted",
  "jobId": "sitemapScraper-1718000000000-2",
  "message": "Sitemap scraper iniciado.",
  "queue": {
    "pending": 0,
    "position": 0,
    "running": { "id": "sitemapScraper-1718000000000-2", "type": "sitemapScraper", "startedAt": "2024-06-10T12:05:00.000Z", "elapsedMs": 0 }
  }
}
```

---

## POST /scraper/sitemap/analysis

Analiza el sitemap y genera un catálogo con categorías, marcas y conteo de productos. **No escrapea** — solo indexa la estructura.

### Body

```json
{
  "webhookUrl": "https://mi-backend.com/api/webhook/scraper"
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `webhookUrl` | `string` | ❌ | URL para recibir notificaciones del ciclo de vida del job |

### Respuesta `202 Accepted`

```json
{
  "status": "accepted",
  "jobId": "sitemapAnalysis-1718000000000-3",
  "message": "Sitemap analysis iniciado.",
  "queue": {
    "pending": 0,
    "position": 0,
    "running": { "id": "sitemapAnalysis-1718000000000-3", "type": "sitemapAnalysis", "startedAt": "2024-06-10T12:10:00.000Z", "elapsedMs": 0 }
  }
}
```

---

## GET /scraper/status

Retorna el estado actual de la cola: job en ejecución, jobs en espera e historial reciente (últimos 5).

### Sin body

### Respuesta `200 OK`

```json
{
  "isRunning": true,
  "running": {
    "id": "categoryScraper-1718000000000-1",
    "type": "categoryScraper",
    "startedAt": "2024-06-10T12:00:00.000Z",
    "elapsedMs": 45200
  },
  "pending": 1,
  "pendingJobs": [
    {
      "id": "priceCheck-1718000000000-2",
      "type": "priceCheck",
      "enqueuedAt": "2024-06-10T12:00:30.000Z",
      "waitingMs": 14700
    }
  ],
  "recentHistory": [
    {
      "id": "sitemapScraper-1717900000000-1",
      "type": "sitemapScraper",
      "status": "completed",
      "startedAt": "2024-06-09T08:00:00.000Z",
      "finishedAt": "2024-06-09T08:18:42.000Z",
      "durationMs": 1122000,
      "result": {
        "total": 1540,
        "processed": 1540,
        "errors": 0,
        "uploaded": 1538,
        "orphansDeleted": 3,
        "durationMs": 1122000
      }
    }
  ]
}
```

> Cuando no hay nada corriendo, `isRunning` es `false`, `running` es `null` y `pendingJobs` es `[]`.

---

## POST /scraper/check-prices

Compara precios actuales de Odoo contra los almacenados en MongoDB y detecta cambios, sin hacer scraping completo. Pasa por la misma cola que los scrapers para no saturar la API de Odoo.

### Body

```json
{
  "webhookUrl": "https://mi-backend.com/api/webhook/scraper",
  "sync": false
}
```

| Campo | Tipo | Requerido | Descripción |
|---|---|---|---|
| `webhookUrl` | `string` | ❌ | URL para recibir el resultado del price check (incluye lista de cambios) |
| `sync` | `boolean` | ❌ | Solo para testing. `true` intenta esperar el resultado (no recomendado en producción) |

### Respuesta `202 Accepted`

```json
{
  "status": "accepted",
  "jobId": "priceCheck-1718000000000-4",
  "message": "Price check iniciado.",
  "queue": {
    "pending": 0,
    "position": 0,
    "running": { "id": "priceCheck-1718000000000-4", "type": "priceCheck", "startedAt": "2024-06-10T12:15:00.000Z", "elapsedMs": 0 }
  }
}
```

> Al terminar, si se configuró `webhookUrl`, el webhook recibe el detalle completo con los productos que cambiaron de precio (`changed`), los nuevos (`newIds`) y los eliminados (`removedIds`).

---

## DELETE /scraper/jobs/:jobId

Cancela un job específico por su ID.

- Si el job está **en espera**: se elimina de la cola inmediatamente.
- Si el job está **en ejecución**: se marca para cancelación graceful — finalizará al completar la operación actual.
- Si el job ya **terminó**: retorna `400`.
- Si el ID **no existe**: retorna `404`.

### Parámetros de ruta

| Parámetro | Descripción |
|---|---|
| `jobId` | ID del job obtenido en la respuesta 202 al iniciarlo |

### Respuesta `200 OK` — job en cola de espera

```json
{
  "status": "cancelled",
  "jobId": "priceCheck-1718000000000-4",
  "message": "Job 'priceCheck-1718000000000-4' eliminado de la cola de espera.",
  "cancelled": true,
  "wasQueued": true
}
```

### Respuesta `200 OK` — job en ejecución

```json
{
  "status": "cancelled",
  "jobId": "categoryScraper-1718000000000-1",
  "message": "Solicitud de cancelación enviada al job 'categoryScraper-1718000000000-1' en ejecución. Finalizará al completar la operación actual.",
  "cancelled": true,
  "wasRunning": true
}
```

### Respuesta `400 Bad Request` — job ya terminado

```json
{
  "status": "error",
  "message": "El job 'sitemapScraper-1717900000000-1' ya finalizó con estado 'completed' y no puede ser cancelado.",
  "jobStatus": "completed"
}
```

### Respuesta `404 Not Found`

```json
{
  "status": "error",
  "message": "Job 'priceCheck-0000000000000-99' no encontrado."
}
```

---

## DELETE /scraper/jobs/all

Purga todos los jobs **pendientes** de la cola. El job en ejecución (si lo hay) **no se interrumpe**.

### Sin body

### Respuesta `200 OK`

```json
{
  "status": "purged",
  "message": "3 job(s) pendiente(s) eliminado(s) de la cola.",
  "cancelledCount": 3,
  "queueSnapshot": {
    "isRunning": true,
    "running": {
      "id": "categoryScraper-1718000000000-1",
      "type": "categoryScraper",
      "startedAt": "2024-06-10T12:00:00.000Z",
      "elapsedMs": 90000
    },
    "pending": 0,
    "pendingJobs": []
  }
}
```

> Si la cola ya estaba vacía, `cancelledCount` será `0` y el job en ejecución seguirá corriendo normalmente.

---

## Modelo de respuesta 202

Todos los endpoints de inicio de jobs retornan `202 Accepted` con la misma estructura:

| Campo | Tipo | Descripción |
|---|---|---|
| `status` | `"accepted"` \| `"queued"` | `accepted` = arrancó de inmediato; `queued` = está esperando |
| `jobId` | `string` | ID único del job, usar para consultar cancelación |
| `message` | `string` | Descripción legible del estado |
| `queue.pending` | `number` | Cantidad de jobs esperando en cola |
| `queue.position` | `number` | Posición del job en la cola (0 si arrancó de inmediato) |
| `queue.running` | `object` \| `null` | Info del job actualmente en ejecución |

### Ejemplo encolado

```json
{
  "status": "queued",
  "jobId": "priceCheck-1718000000000-5",
  "message": "Hay un scraper en ejecución. Price check fue encolado en posición 2. Jobs en espera: 2.",
  "queue": {
    "pending": 2,
    "position": 2,
    "running": {
      "id": "sitemapScraper-1718000000000-3",
      "type": "sitemapScraper",
      "startedAt": "2024-06-10T12:00:00.000Z",
      "elapsedMs": 120000
    }
  }
}
```

---

## Webhooks

Si se envía `webhookUrl` en el body, el scraper notifica el ciclo de vida del job con `POST` a esa URL.

### Eventos del ciclo de vida (desde `scraperQueue`)

Todos los eventos tienen esta estructura base:

```json
{
  "event": "started",
  "source": "scraperQueue",
  "status": "started",
  "job": {
    "id": "categoryScraper-1718000000000-1",
    "type": "categoryScraper",
    "params": { "categoryIds": ["10", "23"], "webhookUrl": "..." }
  },
  "queueSnapshot": { "isRunning": true, "pending": 0, "pendingJobs": [] },
  "timestamp": "2024-06-10T12:00:00.000Z"
}
```

| Evento | Cuándo se emite |
|---|---|
| `enqueued` | El job entró a la cola de espera |
| `started` | El job comenzó a ejecutarse |
| `completed` | El job terminó exitosamente |
| `failed` | El job terminó con error |
| `cancelled` | El job fue cancelado |

### Evento `completed` con resultado (scrapers)

```json
{
  "event": "completed",
  "source": "scraperQueue",
  "status": "completed",
  "job": { "id": "categoryScraper-1718000000000-1", "type": "categoryScraper", "params": {} },
  "result": {
    "total": 320,
    "processed": 320,
    "errors": 2,
    "uploaded": 318,
    "orphansDeleted": 5,
    "durationMs": 95000
  },
  "queueSnapshot": { "isRunning": false, "pending": 0, "pendingJobs": [] },
  "timestamp": "2024-06-10T12:01:35.000Z"
}
```

### Webhook adicional de price check

Además del evento de ciclo de vida, el price check envía un webhook propio con el detalle de cambios:

```json
{
  "source": "priceChecker",
  "status": "success",
  "summary": {
    "total": 1540,
    "changed": 12,
    "new": 3,
    "removed": 1,
    "durationMs": 18400
  },
  "changed": ["PROD-001", "PROD-045"],
  "newIds": ["PROD-999"],
  "removedIds": ["PROD-007"],
  "timestamp": "2024-06-10T12:15:20.000Z"
}
```

---

## Tipos de job

| `type` | Origen |
|---|---|
| `categoryScraper` | POST /scraper/category |
| `sitemapScraper` | POST /scraper/sitemap |
| `sitemapAnalysis` | POST /scraper/sitemap/analysis |
| `priceCheck` | POST /scraper/check-prices |