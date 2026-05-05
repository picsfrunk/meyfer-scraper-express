# API Documentation - Web Scraping Service

## Índice
1. [Información General](#información-general)
2. [Configuración](#configuración)
3. [Arquitectura](#arquitectura)
4. [Endpoints](#endpoints)
5. [Modelos de Datos](#modelos-de-datos)
6. [Flujos de Trabajo](#flujos-de-trabajo)
7. [Gestión de Errores](#gestión-de-errores)
8. [Ejemplos de Uso](#ejemplos-de-uso)
9. [Testing QA](#testing-qa)

---

## Información General

### Descripción
Microservicio REST API diseñado para realizar web scraping de productos desde plataformas Odoo. Implementa múltiples estrategias de extracción de datos con soporte para procesamiento asíncrono y notificaciones mediante webhooks.

### Tecnologías
- **Runtime**: Node.js
- **Framework**: Express.js v4.x
- **Base de Datos**: MongoDB (Driver nativo)
- **HTTP Client**: Axios
- **Parsing**: Cheerio (HTML), xml2js (XML)
- **Middleware**: Morgan (logging), CORS

### Versión
API Version: 1.0.0

### Base URL
```
http://localhost:3001
```

### Características Principales
- Scraping por categorías con auto-discovery
- Scraping basado en análisis de sitemap.xml
- Procesamiento asíncrono con respuestas 202 Accepted
- Sistema de webhooks para notificaciones
- Persistencia en MongoDB con upsert
- Manejo de delays configurables entre requests
- Sistema de logging estructurado

---

## Configuración

### Variables de Entorno Requeridas

#### MongoDB
```env
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/
MONGO_DB=mydb
MONGO_COLLECTION=products
SITEMAP_COLLECTION=sitemap_analysis
```

#### Autenticación Odoo
```env
ODOO_USER=test@web.com
ODOO_PASS=test123
ODOO_DB=OdooSite
```

#### Scraping
```env
BASE_URL=https://web.com
PAGE_DELAY_MS=1500
CATEGORY_DELAY_MS=5000
SITEMAP_URL=http://web.com/sitemap.xml
GLOBAL_SITEMAP_LIMIT=100
```

#### Webhooks
```env
WEBHOOK_URL=http://tu-backend.com/webhook/scraper-result
```

#### Servidor
```env
PORT=3001
```

#### Cloudinary (Opcional)
```env
CLOUDINARY_API_SECRET=11111
CLOUDINARY_CLOUD_NAME=11111
CLOUDINARY_API_KEY=11111
```

### Validaciones de Configuración
- **MONGO_URI**: Debe ser una URI válida de MongoDB
- **ODOO_USER/PASS**: Credenciales válidas para autenticación
- **BASE_URL**: URL base sin trailing slash
- **PAGE_DELAY_MS**: Número entero > 0 (recomendado: 1000-3000ms)
- **SITEMAP_URL**: URL accesible que retorne XML válido

---

## Arquitectura

### Estructura de Capas

```
┌─────────────────────────────────────┐
│         Express Router              │
│  (scraperRoute.js)                  │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Controllers                 │
│  (scraperController.js)             │
│  - Validación de requests           │
│  - Respuestas 202 Accepted          │
│  - Logging de operaciones           │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Services                    │
│  (scraperService.js)                │
│  - Lógica de negocio                │
│  - Orquestación de scrapers         │
│  - Gestión de webhooks              │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Scraper Core                │
│  (scraper.js)                       │
│  - Estrategias de extracción        │
│  - Auto-discovery de categorías     │
│  - Procesamiento de productos       │
└──────────────┬──────────────────────┘
               │
┌──────────────▼──────────────────────┐
│         Utils                       │
│  - scraperUtils.js (Odoo API)       │
│  - logToFile.js (Logging)           │
│  - mongo.js (Database)              │
└─────────────────────────────────────┘
```

### Patrones de Diseño Implementados

#### 1. Strategy Pattern
Múltiples estrategias de scraping intercambiables:
- `CategoryProductStrategy`: Scraping por categorías
- `SitemapProductStrategy`: Scraping desde sitemap

#### 2. Template Method
`ScraperRunner` implementa el flujo general:
```javascript
initialize() → getProductList() → process() → notify()
```

#### 3. Dependency Injection
Controllers reciben `collection` mediante middleware:
```javascript
app.use((req, res, next) => {
    req.collection = db_collection;
    next();
});
```

---

## Endpoints

### 1. Health Check

#### `GET /`
Verifica el estado del servicio.

**Request**
```http
GET / HTTP/1.1
Host: localhost:3001
```

**Response**
```http
HTTP/1.1 200 OK
Content-Type: text/plain

Welcome to Scraping API!
```

---

### 2. Analizar Sitemap

#### `POST /api/scraper/sitemap/analysis`

Descarga y analiza el sitemap.xml del sitio objetivo, extrayendo estructura de categorías, marcas y productos. Almacena los resultados en MongoDB para uso posterior.

**Request Headers**
```http
Content-Type: application/json
```

**Request Body**
```json
{
  "webhookUrl": "http://backend.com/webhook/scraper-result"
}
```

**Request Body Schema**
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| webhookUrl | string | No | URL para notificación al finalizar |

**Response (Inmediata)**
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "accepted",
  "message": "Sitemap analysis started"
}
```

**Webhook Notification (Al Finalizar)**
```json
{
  "source": "sitemapAnalysis",
  "status": "success",
  "processed": 1500,
  "stats": {
    "durationMs": null,
    "totalErrors": 0,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T15:30:45.123Z"
}
```

**Comportamiento**
1. Descarga sitemap desde `SITEMAP_URL`
2. Parsea XML y clasifica URLs
3. Extrae categorías, marcas y productos
4. Almacena en colección `sitemap_analysis`
5. Notifica vía webhook (si se proporcionó)

**Errores Comunes**
| Código | Descripción | Causa |
|--------|-------------|-------|
| 500 | Internal Server Error | SITEMAP_URL no configurado |
| 500 | Internal Server Error | Sitemap inaccesible o XML inválido |
| 500 | Internal Server Error | Error de conexión a MongoDB |

---

### 3. Category Scraper

#### `POST /api/scraper/category`

Ejecuta scraping de productos navegando por categorías específicas. Utiliza auto-discovery para detectar automáticamente la cantidad de páginas por categoría.

**Request Headers**
```http
Content-Type: application/json
```

**Request Body**
```json
{
  "categoryIds": "all",
  "pageDelay": 1500,
  "categoryDelay": 5000,
  "webhookUrl": "http://backend.com/webhook/scraper-result"
}
```

**Request Body Schema**
| Campo | Tipo | Requerido | Default | Descripción |
|-------|------|-----------|---------|-------------|
| categoryIds | string\|number | Sí | - | "all" para todas, o ID específico |
| pageDelay | number | No | PAGE_DELAY_MS | Delay entre páginas (ms) |
| categoryDelay | number | No | CATEGORY_DELAY_MS | Delay entre categorías (ms) |
| webhookUrl | string | No | - | URL para notificación |

**Response (Inmediata)**
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "accepted",
  "message": "Category scraper started"
}
```

**Webhook Notification (Al Finalizar)**
```json
{
  "source": "categoryScraper",
  "status": "success",
  "processed": 250,
  "stats": {
    "durationMs": null,
    "totalErrors": 5,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T16:45:30.456Z"
}
```

**Flujo de Ejecución**
1. **Autenticación**: Login en Odoo
2. **Auto-discovery**: Detecta categorías y páginas desde sitemap
3. **Scraping**:
    - Por cada categoría
    - Por cada página de la categoría
    - Extrae product_id y product_template_id
4. **Procesamiento**:
    - Obtiene detalles desde API de Odoo
    - Extrae imágenes
    - Aplica margen de ganancia
    - Guarda/actualiza en MongoDB (upsert)
5. **Notificación**: Envía resultado vía webhook

**Estrategia de Auto-Discovery**
```javascript
// Solicita página 999, Odoo redirige a la última página existente
GET /shop/category/por-rubro-{slug}-{id}/page/999

// Extrae número de página actual del HTML
<li class="page-item active">
  <a class="page-link">15</a>
</li>
```

**Errores Comunes**
| Código | Descripción | Causa |
|--------|-------------|-------|
| 500 | Login fallido | Credenciales Odoo inválidas |
| 500 | No se encontró ningún rubro válido | categoryId no existe |
| 500 | Base de datos no inicializada | MongoDB desconectado |

---

### 4. Sitemap Scraper

#### `POST /api/scraper/sitemap`

Ejecuta scraping de productos basándose en las URLs extraídas del análisis previo del sitemap. Ideal para scraping masivo o recuperación de productos específicos.

**Request Headers**
```http
Content-Type: application/json
```

**Request Body**
```json
{
  "sitemapSource": "http://web.com/sitemap.xml",
  "limitProducts": 100,
  "pageDelay": 2000,
  "webhookUrl": "http://backend.com/webhook/scraper-result"
}
```

**Request Body Schema**
| Campo | Tipo | Requerido | Default | Descripción |
|-------|------|-----------|---------|-------------|
| sitemapSource | string | No | null | URL específica del sitemap (usa default si omite) |
| limitProducts | number | No | 1000 | Límite de productos a procesar |
| pageDelay | number | No | PAGE_DELAY_MS | Delay entre requests (ms) |
| webhookUrl | string | No | - | URL para notificación |

**Response (Inmediata)**
```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "accepted",
  "message": "Sitemap scraper started"
}
```

**Webhook Notification (Al Finalizar)**
```json
{
  "source": "sitemapScraper",
  "status": "success",
  "processed": 100,
  "stats": {
    "durationMs": null,
    "totalErrors": 2,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T17:20:15.789Z"
}
```

**Prerequisitos**
- Debe haberse ejecutado `/api/scraper/sitemap/analysis` previamente
- Si no existe análisis, lo ejecuta automáticamente

**Flujo de Ejecución**
1. **Validación**: Verifica existencia de documento sitemap en DB
2. **Auto-análisis**: Si no existe, ejecuta `analyzeSitemap()`
3. **Selección**: Toma `limitProducts` URLs del array `productUrls`
4. **Matching de Categorías**:
   ```javascript
   // Extrae slug del producto
   /shop/123-tornillo-phillips → "tornillo-phillips"
   
   // Busca coincidencias con categorías conocidas
   categoriesMap["tornillos"] → match
   ```
5. **Scraping**: Para cada URL
    - Visita página de producto
    - Extrae product_id del HTML
    - Obtiene detalles desde API
    - Procesa y guarda
6. **Notificación**: Webhook con resultados

**Ventajas vs Category Scraper**
| Aspecto | Sitemap | Category |
|---------|---------|----------|
| Velocidad | ⚡ Más rápido (URLs directas) | 🐢 Más lento (navegación) |
| Cobertura | 📦 Todos los productos | 🗂️ Solo categorizados |
| Precisión categorías | 🎯 Inferida (puede fallar) | ✅ Exacta |
| Uso | Recuperación, testing | Producción, actualización |

**Errores Comunes**
| Código | Descripción | Causa |
|--------|-------------|-------|
| 500 | No se encontraron URLs de productos | Sitemap vacío o mal formado |
| 500 | Login fallido | Credenciales Odoo inválidas |
| 500 | No se pudo crear documento sitemap | Error en auto-análisis |

---

### 5. Cancelar Job por ID

#### `DELETE /api/scraper/jobs/:jobId`

Cancela un job específico de la cola. Si el job está pendiente, lo elimina inmediatamente. Si está en ejecución, le envía una señal de cancelación (graceful shutdown).

**Path Parameters**
| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| jobId | string | ID del job a cancelar (ej: `sitemapScraper-1746000000000-1`) |

**Response 200 — Job pendiente cancelado**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "cancelled",
  "jobId": "sitemapScraper-1746000000000-1",
  "message": "Job 'sitemapScraper-1746000000000-1' eliminado de la cola de espera.",
  "cancelled": true,
  "wasQueued": true
}
```

**Response 200 — Job en ejecución (graceful shutdown)**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "cancelled",
  "jobId": "sitemapScraper-1746000000000-1",
  "message": "Solicitud de cancelación enviada al job 'sitemapScraper-1746000000000-1' en ejecución. Finalizará al completar la operación actual.",
  "cancelled": true,
  "wasRunning": true
}
```

**Response 400 — Job ya finalizado**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "status": "error",
  "message": "El job 'sitemapScraper-1746000000000-1' ya finalizó con estado 'completed' y no puede ser cancelado.",
  "jobStatus": "completed"
}
```

**Response 404 — Job no encontrado**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "status": "error",
  "message": "Job 'sitemapScraper-1746000000000-1' no encontrado."
}
```

---

### 6. Purgar Cola (Cancelar Todos los Pendientes)

#### `DELETE /api/scraper/jobs/all`

Elimina todos los jobs pendientes de la cola. El job actualmente en ejecución **no** se ve afectado.

**Response 200**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "status": "purged",
  "message": "3 job(s) pendiente(s) eliminado(s) de la cola.",
  "cancelledCount": 3,
  "queueSnapshot": {
    "isRunning": true,
    "running": { "id": "categoryScraper-1746000000000-1", "type": "categoryScraper", "startedAt": "...", "elapsedMs": 45000 },
    "pending": 0,
    "pendingJobs": []
  }
}
```

---

### 7. Estado de la Cola

#### `GET /api/scraper/status`

Retorna el estado actual de la cola de jobs: job en ejecución, jobs pendientes e historial reciente.

**Response 200**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "isRunning": true,
  "running": { "id": "sitemapScraper-...", "type": "sitemapScraper", "startedAt": "...", "elapsedMs": 12000 },
  "pending": 2,
  "pendingJobs": [...],
  "recentHistory": [...]
}
```

---

### 8. Error Handling Global

#### 404 - Ruta No Encontrada
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "Ruta no encontrada"
}
```

#### 500 - Base de Datos No Inicializada
```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "error": "Base de datos en Scraper Microservice no inicializada aún"
}
```

---

## Modelos de Datos

### Colección: `products` (scraped data)

Almacena productos scrapeados con información completa.

**Schema**
```javascript
{
  // Identificadores
  "product_id": Number,              // ID único de Odoo
  "custom_product_id": String,       // ID extraído de URL
  "product_template_id": Number,     // Template ID de Odoo
  
  // Información básica
  "display_name": String,            // Nombre del producto
  "description": String,             // Descripción HTML
  "list_price": Number,              // Precio de lista
  "final_price": Number,             // Precio con margen aplicado
  
  // Categorización
  "categoryId": Number,              // ID de categoría
  "categoryName": String,            // Nombre de categoría
  
  // Multimedia
  "image_url": String,               // URL de imagen principal
  "carousel": Array,                 // Array de imágenes adicionales
  
  // Stock y disponibilidad
  "show_availability": Boolean,      // Mostrar disponibilidad
  "out_of_stock_message": String,    // Mensaje si sin stock
  
  // Metadata
  "source": String,                  // URL de origen
  "scraped_at": Date,                // Fecha de scraping
  "updated_at": Date                 // Última actualización
}
```

**Ejemplo de Documento**
```json
{
  "product_id": 12345,
  "custom_product_id": "TOR-PHI-8X50",
  "product_template_id": 6789,
  "display_name": "Tornillo Phillips 8x50mm",
  "description": "<p>Tornillo de acero inoxidable...</p>",
  "list_price": 150.50,
  "final_price": 180.60,
  "categoryId": 42,
  "categoryName": "Tornillos/Fijación",
  "image_url": "https://res.cloudinary.com/xxx/image/upload/v123/product.jpg",
  "carousel": [
    "https://example.com/image1.jpg",
    "https://example.com/image2.jpg"
  ],
  "show_availability": true,
  "out_of_stock_message": "",
  "source": "https://web.com/shop/12345-tornillo-phillips",
  "scraped_at": "2025-11-01T15:30:45.123Z",
  "updated_at": "2025-11-01T15:30:45.123Z"
}
```

**Índices Recomendados**
```javascript
db.products.createIndex({ "product_id": 1 }, { unique: true })
db.products.createIndex({ "categoryId": 1 })
db.products.createIndex({ "scraped_at": -1 })
```

---

### Colección: `sitemap_analysis`

Almacena el análisis estructurado del sitemap.xml.

**Schema**
```javascript
{
  // Metadata
  "source": String,                  // URL del sitemap
  "analyzedAt": Date,                // Fecha de análisis
  
  // Resumen
  "summary": {
    "totalProducts": Number,         // Total de productos encontrados
    "totalBrands": Number,            // Total de marcas
    "totalCategories": Number,        // Total de categorías
    "lastPageDiscovery": Date        // Última ejecución de auto-discovery
  },
  
  // Categorías
  "categories": [
    {
      "id": Number,                  // ID de categoría en Odoo
      "name": String,                // Nombre formateado
      "slug": String,                // Slug URL
      "products": Number,            // Cantidad de productos
      "pages": Number                // Páginas detectadas (auto-discovery)
    }
  ],
  
  // Marcas
  "brands": [
    {
      "id": Number,                  // ID de marca
      "name": String,                // Nombre
      "products": Number,            // Cantidad de productos
      "urls": Array                  // URLs asociadas
    }
  ],
  
  // URLs raw
  "productUrls": Array,              // Lista de URLs de productos
  "brandUrls": Array                 // Lista de URLs de marcas
}
```

**Ejemplo de Documento**
```json
{
  "source": "http://web.com/sitemap.xml",
  "analyzedAt": "2025-11-01T14:00:00.000Z",
  "summary": {
    "totalProducts": 1547,
    "totalBrands": 35,
    "totalCategories": 12,
    "lastPageDiscovery": "2025-11-01T14:15:00.000Z"
  },
  "categories": [
    {
      "id": 42,
      "name": "Tornillos/Fijación",
      "slug": "tornillos-fijacion",
      "products": 234,
      "pages": 10
    }
  ],
  "brands": [
    {
      "id": 15,
      "name": "bosch",
      "products": 89,
      "urls": [
        "http://web.com/shop/category/por-marca-bosch-15",
        "http://web.com/shop/category/por-marca-bosch-15/page/2"
      ]
    }
  ],
  "productUrls": [
    "http://web.com/shop/12345-tornillo-phillips",
    "http://web.com/shop/12346-tuerca-hexagonal"
  ],
  "brandUrls": [
    "http://web.com/shop/category/por-marca-bosch-15"
  ]
}
```

**Índices Recomendados**
```javascript
db.sitemap_analysis.createIndex({ "source": 1 }, { unique: true })
db.sitemap_analysis.createIndex({ "analyzedAt": -1 })
```

---

### Colección: `config` (sistema)

Almacena configuraciones globales del scraper.

**Schema**
```javascript
{
  "key": String,                     // Clave única
  "value": Any,                      // Valor de configuración
  "updatedAt": Date                  // Última actualización
}
```

**Documentos Utilizados**

#### profitMargin
```json
{
  "key": "profitMargin",
  "value": 20,
  "updatedAt": "2025-11-01T10:00:00.000Z"
}
```
- **Descripción**: Porcentaje de margen de ganancia aplicado a precios
- **Uso**: `final_price = list_price * (1 + profitMargin/100)`
- **Tipo**: Number (porcentaje entero)

#### discoveredCategories
```json
{
  "key": "discoveredCategories",
  "value": [
    {
      "id": 42,
      "name": "Tornillos/Fijación",
      "slug": "tornillos-fijacion",
      "pages": 10,
      "products": 234
    }
  ],
  "updatedAt": "2025-11-01T14:15:00.000Z"
}
```
- **Descripción**: Cache de categorías con auto-discovery completado
- **Uso**: Fallback si `sitemap_analysis` no está disponible
- **Tipo**: Array de objetos

---

## Flujos de Trabajo

### Flujo 1: Primera Ejecución Completa
![Flujo Primera Ejecución](./docs/diagrams/first-run-flow.png)

---

### Flujo 2: Actualización Incremental con Sitemap
![Flujo Actualización](./docs/diagrams/incremental-update-flow.png)

---

### Flujo 3: Manejo de Errores
![Flujo Errores](./docs/diagrams/error-handling-flow.png)
---

## Gestión de Errores

### Categorías de Errores

#### 1. Errores de Configuración
**Causas comunes:**
- Variables de entorno faltantes
- Credenciales inválidas
- URLs malformadas

**Manejo:**
```javascript
// En startup
if (!process.env.SITEMAP_URL) {
    throw new Error('Falta variable de entorno: SITEMAP_URL');
}

// En runtime
if (!await loginToOdoo()) {
    throw new Error('Login fallido a Odoo.');
}
```

**Respuesta:**
```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "status": "error",
  "message": "Login fallido a Odoo."
}
```

#### 2. Errores de Red
**Causas comunes:**
- Timeout en requests
- Sitio objetivo caído
- Rate limiting

**Manejo:**
```javascript
// Retry con exponential backoff (implementar)
// Delays configurables entre requests
await delay(this.pageDelay);

// Logging de errores específicos
log(`❌ Error en rubro ${categoryId}, página ${page}: ${error.message}`);
```

**Comportamiento:**
- Los errores individuales NO detienen el proceso completo
- Se continúa con el siguiente producto
- Se acumulan en contador de errores

#### 3. Errores de Parseo
**Causas comunes:**
- HTML/XML malformado
- Cambios en estructura del sitio
- Productos sin datos requeridos

**Manejo:**
```javascript
// Validaciones defensivas
const productId = Number($("input[name='product_id']").val());
if (!productId) return null;

// Filtrado de productos inválidos
.filter(p => p.product_id && p.product_template_id);
```

**Resultado:**
- Producto se saltea
- Se registra en logs
- Incrementa contador de errores

#### 4. Errores de Base de Datos
**Causas comunes:**
- Conexión perdida
- Timeout en queries
- Violación de constraints

**Manejo:**
```javascript
// Middleware de validación
app.use((req, res, next) => {
    if (!db_collection) {
        return res.status(500).json({ 
            error: 'Base de datos no inicializada aún' 
        });
    }
    req.collection = db_collection;
    next();
});

// Upsert para evitar duplicados
await collection.updateOne(
    { product_id: details.product_id },
    { $set: details },
    { upsert: true }
);
```

---

### Sistema de Logging

#### Niveles de Log

**INFO**: Operaciones normales
```javascript
await logToFile.info('Iniciando sitemap scraper', 'controller', {
    limitProducts,
    collection: collection.collectionName
});
```

**ERROR**: Errores recuperables
```javascript
console.error('Error en sitemapScraperController', 'controller', {
    error: error.message,
    stack: error.stack
});
```

**DEBUG**: Información detallada (modo desarrollo)
```javascript
log(`🔍 DEBUG - URL solicitada: /page/999`, enableLogs);
```

#### Estructura de Logs

**Archivo de Log**: Gestionado por `logToFile.js`
```javascript
// Formato típico
[2025-11-01T15:30:45.123Z] [INFO] [controller] Iniciando sitemap scraper
{
  "limitProducts": 100,
  "collection": "products"
}

[2025-11-01T15:31:10.456Z] [ERROR] [controller] Error en sitemapScraperController
{
  "error": "Login fallido a Odoo.",
  "stack": "Error: Login fallido...",
  "body": { "limitProducts": 100 }
}
```

---

### Métricas de Éxito

Cada operación de scraping retorna métricas completas:

```javascript
{
  total: 245,        // Productos guardados exitosamente
  errors: 5,         // Productos que fallaron
  uploaded: 240,     // Productos con imagen en Cloudinary
  processed: 250     // Total de productos procesados
}
```

**Cálculo de Tasa de Éxito:**
```javascript
successRate = (total / processed) * 100
// Ejemplo: (245 / 250) * 100 = 98%
```

**Interpretación de Resultados:**

| Tasa de Éxito | Estado | Acción Recomendada |
|---------------|--------|-------------------|
| > 95% | ✅ Excelente | Continuar normalmente |
| 90-95% | ⚠️ Bueno | Revisar logs de errores |
| 80-90% | 🔶 Regular | Investigar causas comunes |
| < 80% | 🔴 Crítico | Revisar configuración/conexión |

---

## Ejemplos de Uso

### Caso 1: Setup Inicial Completo

**Objetivo**: Configurar sistema desde cero y poblar base de datos.

**Paso 1: Analizar Sitemap**
```bash
curl -X POST http://localhost:3001/api/scraper/sitemap/analysis \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "http://backend.com/webhook/analysis-complete"
  }'
```

**Respuesta:**
```json
{
  "status": "accepted",
  "message": "Sitemap analysis started"
}
```

**Webhook recibido (~2-5 minutos después):**
```json
{
  "source": "sitemapAnalysis",
  "status": "success",
  "processed": 1547,
  "stats": {
    "durationMs": null,
    "totalErrors": 0,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T15:35:20.123Z"
}
```

**Paso 2: Scraping por Categorías**
```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{
    "categoryIds": "all",
    "pageDelay": 2000,
    "categoryDelay": 5000,
    "webhookUrl": "http://backend.com/webhook/scraping-complete"
  }'
```

**Respuesta:**
```json
{
  "status": "accepted",
  "message": "Category scraper started"
}
```

**Webhook recibido (~30-60 minutos después, depende del catálogo):**
```json
{
  "source": "categoryScraper",
  "status": "success",
  "processed": 1547,
  "stats": {
    "durationMs": null,
    "totalErrors": 23,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T16:45:30.456Z"
}
```

---

### Caso 2: Actualización Parcial (Testing)

**Objetivo**: Probar scraper con muestra pequeña antes de ejecución completa.

```bash
curl -X POST http://localhost:3001/api/scraper/sitemap \
  -H "Content-Type: application/json" \
  -d '{
    "limitProducts": 10,
    "pageDelay": 1000,
    "webhookUrl": "http://backend.com/webhook/test-complete"
  }'
```

**Respuesta:**
```json
{
  "status": "accepted",
  "message": "Sitemap scraper started"
}
```

**Uso recomendado:**
- Durante desarrollo
- Antes de scraping masivo
- Para validar cambios en el código

---

### Caso 3: Scraping de Categoría Específica

**Objetivo**: Actualizar solo productos de una categoría.

**Paso 1: Identificar ID de categoría**

Query a MongoDB:
```javascript
db.sitemap_analysis.findOne({}, { categories: 1 })
```

Resultado:
```json
{
  "categories": [
    { "id": 42, "name": "Tornillos/Fijación", "slug": "tornillos-fijacion", "pages": 10 },
    { "id": 43, "name": "Tuercas", "slug": "tuercas", "pages": 5 }
  ]
}
```

**Paso 2: Ejecutar scraper**
```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{
    "categoryIds": 42,
    "pageDelay": 1500,
    "webhookUrl": "http://backend.com/webhook/category-42-complete"
  }'
```

---

### Caso 4: Scraping sin Webhook (Fire and Forget)

**Objetivo**: Ejecutar scraping sin necesidad de notificación.

```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{
    "categoryIds": "all",
    "pageDelay": 2000
  }'
```

**Monitoreo:**
- Revisar logs del servidor
- Consultar MongoDB periódicamente
- Verificar timestamp `updated_at` de productos

---

### Caso 5: Recuperación de Errores

**Escenario**: El scraping se interrumpió a mitad de proceso.

**Verificar estado en MongoDB:**
```javascript
// Contar productos scrapeados hoy
db.products.count({
  scraped_at: {
    $gte: new Date("2025-11-01T00:00:00Z")
  }
})

// Ver últimos productos procesados
db.products.find().sort({ scraped_at: -1 }).limit(10)
```

**Re-ejecutar scraping:**

Opción A: Scraping completo (sobreescribe con upsert)
```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{ "categoryIds": "all" }'
```

Opción B: Sitemap limitado (productos faltantes)
```bash
# Identificar cantidad ya scrapeada
# Usar limitProducts para procesar solo faltantes
curl -X POST http://localhost:3001/api/scraper/sitemap \
  -H "Content-Type: application/json" \
  -d '{ "limitProducts": 500 }'
```

---

## Testing QA

### Plan de Pruebas Completo

#### 1. Pruebas Funcionales

##### 1.1 Endpoint: Health Check
| Test Case | Método | URL | Expected Status | Expected Response |
|-----------|--------|-----|----------------|-------------------|
| TC-001 | GET | / | 200 | "Welcome to Scraping API!" |

**Validaciones:**
- Response es texto plano
- No requiere autenticación
- Responde en < 100ms

---

##### 1.2 Endpoint: Sitemap Analysis

| Test Case | Descripción | Payload | Expected Status | Validaciones |
|-----------|-------------|---------|----------------|--------------|
| TC-002 | Análisis exitoso sin webhook | `{}` | 202 | status: "accepted" |
| TC-003 | Análisis con webhook válido | `{"webhookUrl": "http://valid.com/hook"}` | 202 | status: "accepted" |
| TC-004 | Análisis con webhook inválido | `{"webhookUrl": "invalid-url"}` | 202 | Debe aceptar, error en logs |
| TC-005 | Sin SITEMAP_URL configurado | `{}` | 500 | message contiene "SITEMAP_URL" |

**Validaciones Asíncronas (Webhook):**
```javascript
// Esperar callback del webhook
await waitForWebhook(5 * 60 * 1000); // 5 minutos

// Validar estructura
assert(webhook.source === "sitemapAnalysis");
assert(webhook.status === "success");
assert(webhook.processed > 0);
assert(webhook.timestamp !== null);
```

**Validaciones en MongoDB:**
```javascript
const doc = await db.sitemap_analysis.findOne({});

assert(doc !== null);
assert(doc.source === process.env.SITEMAP_URL);
assert(doc.summary.totalProducts > 0);
assert(doc.categories.length > 0);
assert(Array.isArray(doc.productUrls));
assert(doc.analyzedAt instanceof Date);
```

---

##### 1.3 Endpoint: Category Scraper

| Test Case | Descripción | Payload | Expected Status | Validaciones |
|-----------|-------------|---------|----------------|--------------|
| TC-006 | Scraping todas las categorías | `{"categoryIds": "all"}` | 202 | status: "accepted" |
| TC-007 | Scraping categoría específica válida | `{"categoryIds": 42}` | 202 | status: "accepted" |
| TC-008 | Scraping categoría inexistente | `{"categoryIds": 99999}` | 500 | Error: "ningún rubro válido" |
| TC-009 | Con pageDelay personalizado | `{"categoryIds": "all", "pageDelay": 3000}` | 202 | status: "accepted" |
| TC-010 | Con categoryDelay personalizado | `{"categoryIds": "all", "categoryDelay": 8000}` | 202 | status: "accepted" |
| TC-011 | Sin autenticación Odoo válida | `{"categoryIds": "all"}` | 500 | Error: "Login fallido" |
| TC-012 | Base de datos desconectada | `{"categoryIds": "all"}` | 500 | Error: "no inicializada" |

**Validaciones de Auto-Discovery:**
```javascript
// Verificar que se ejecutó auto-discovery
const sitemap = await db.sitemap_analysis.findOne({});
assert(sitemap.categories[0].pages !== undefined);
assert(sitemap.summary.lastPageDiscovery instanceof Date);

// Verificar cache en config
const config = await db.config.findOne({ key: 'discoveredCategories' });
assert(config !== null);
assert(Array.isArray(config.value));
```

**Validaciones de Productos Scrapeados:**
```javascript
// Esperar suficiente tiempo para scraping
await wait(30 * 60 * 1000); // 30 minutos para catálogo pequeño

// Verificar productos guardados
const products = await db.products.find({
  scraped_at: { $gte: startTime }
}).toArray();

assert(products.length > 0);

// Validar estructura de producto
const product = products[0];
assert(product.product_id !== undefined);
assert(product.display_name !== undefined);
assert(product.list_price > 0);
assert(product.categoryId !== undefined);
assert(product.categoryName !== undefined);
```

---

##### 1.4 Endpoint: Sitemap Scraper

| Test Case | Descripción | Payload | Expected Status | Validaciones |
|-----------|-------------|---------|----------------|--------------|
| TC-013 | Scraping sin limitProducts | `{}` | 202 | Usa default 1000 |
| TC-014 | Scraping con límite pequeño | `{"limitProducts": 5}` | 202 | Procesa exactamente 5 |
| TC-015 | Scraping con sitemapSource específico | `{"sitemapSource": "http://site.com/sitemap.xml"}` | 202 | status: "accepted" |
| TC-016 | Sin documento sitemap previo | `{}` | 202 | Auto-ejecuta analysis |
| TC-017 | Con pageDelay cero | `{"pageDelay": 0}` | 202 | Acepta pero no recomendado |

**Validaciones de Auto-Análisis:**
```javascript
// Limpiar colección sitemap_analysis
await db.sitemap_analysis.deleteMany({});

// Ejecutar sitemap scraper
const response = await fetch('/api/scraper/sitemap', {
  method: 'POST',
  body: JSON.stringify({ limitProducts: 5 })
});

// Verificar que se ejecutó análisis automático
await wait(5 * 60 * 1000); // 5 minutos

const sitemap = await db.sitemap_analysis.findOne({});
assert(sitemap !== null, "Auto-análisis no se ejecutó");
```

**Validaciones de Matching de Categorías:**
```javascript
const products = await db.products.find({
  scraped_at: { $gte: startTime }
}).toArray();

// Contar productos con categoría detectada
const withCategory = products.filter(p => p.categoryId !== null).length;
const detectionRate = (withCategory / products.length) * 100;

// Se espera al menos 70% de detección exitosa
assert(detectionRate >= 70, `Tasa de detección baja: ${detectionRate}%`);
```

---

#### 2. Pruebas de Integración

##### 2.1 Flujo Completo: First-Time Setup

**Objetivo**: Validar setup desde cero.

```javascript
describe('Flujo de Primera Configuración', () => {
  before(async () => {
    // Limpiar base de datos
    await db.sitemap_analysis.deleteMany({});
    await db.products.deleteMany({});
    await db.config.deleteMany({});
  });

  it('TC-018: Debe analizar sitemap exitosamente', async () => {
    const response = await fetch('/api/scraper/sitemap/analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: WEBHOOK_URL })
    });
    
    assert.equal(response.status, 202);
    
    const webhook = await waitForWebhook(5 * 60 * 1000);
    assert.equal(webhook.status, 'success');
    assert(webhook.processed > 0);
  });

  it('TC-019: Debe ejecutar auto-discovery', async () => {
    const response = await fetch('/api/scraper/category', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        categoryIds: 'all',
        webhookUrl: WEBHOOK_URL 
      })
    });
    
    assert.equal(response.status, 202);
    
    // Verificar auto-discovery en DB
    await wait(10 * 1000); // Esperar 10 segundos
    
    const sitemap = await db.sitemap_analysis.findOne({});
    assert(sitemap.categories[0].pages > 0);
  });

  it('TC-020: Debe scrapear productos exitosamente', async () => {
    const webhook = await waitForWebhook(60 * 60 * 1000); // 1 hora
    
    assert.equal(webhook.status, 'success');
    assert(webhook.processed > 0);
    
    const products = await db.products.countDocuments({});
    assert(products > 0);
  });
});
```

---

##### 2.2 Flujo: Actualización Incremental

```javascript
describe('Actualización Incremental', () => {
  it('TC-021: Debe actualizar productos existentes', async () => {
    // Primera ejecución
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ limitProducts: 10 })
    });
    
    await waitForWebhook(5 * 60 * 1000);
    
    const product1 = await db.products.findOne({});
    const firstUpdate = product1.updated_at;
    
    // Segunda ejecución (debe actualizar, no duplicar)
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ limitProducts: 10 })
    });
    
    await waitForWebhook(5 * 60 * 1000);
    
    const product2 = await db.products.findOne({ 
      product_id: product1.product_id 
    });
    
    assert(product2.updated_at > firstUpdate);
    
    const count = await db.products.countDocuments({});
    assert.equal(count, 10, 'No debe duplicar productos');
  });
});
```

---

#### 3. Pruebas de Performance

##### 3.1 Métricas de Tiempo

| Operación | Productos | Tiempo Esperado | Umbral Crítico |
|-----------|-----------|----------------|----------------|
| Sitemap Analysis | N/A | 2-5 min | 10 min |
| Category Scraper (1 categoría) | ~50 | 2-5 min | 15 min |
| Category Scraper (todas) | 1000+ | 30-60 min | 120 min |
| Sitemap Scraper | 10 | 30-60 seg | 3 min |
| Sitemap Scraper | 100 | 5-10 min | 20 min |

**Tests de Performance:**

```javascript
describe('Performance Tests', () => {
  it('TC-022: Sitemap analysis debe completar en < 10 min', async () => {
    const start = Date.now();
    
    await fetch('/api/scraper/sitemap/analysis', {
      method: 'POST',
      body: JSON.stringify({ webhookUrl: WEBHOOK_URL })
    });
    
    await waitForWebhook(10 * 60 * 1000);
    
    const duration = Date.now() - start;
    assert(duration < 10 * 60 * 1000, `Duró ${duration}ms`);
  });

  it('TC-023: Scraping 10 productos debe completar en < 3 min', async () => {
    const start = Date.now();
    
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ 
        limitProducts: 10,
        webhookUrl: WEBHOOK_URL 
      })
    });
    
    await waitForWebhook(3 * 60 * 1000);
    
    const duration = Date.now() - start;
    assert(duration < 3 * 60 * 1000, `Duró ${duration}ms`);
  });
});
```

---

##### 3.2 Métricas de Throughput

```javascript
describe('Throughput Tests', () => {
  it('TC-024: Debe procesar al menos 5 productos/minuto', async () => {
    const start = Date.now();
    
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ 
        limitProducts: 50,
        pageDelay: 1500,
        webhookUrl: WEBHOOK_URL 
      })
    });
    
    const webhook = await waitForWebhook(15 * 60 * 1000);
    const duration = (Date.now() - start) / 1000 / 60; // minutos
    
    const throughput = webhook.processed / duration;
    assert(throughput >= 5, `Throughput: ${throughput.toFixed(2)}/min`);
  });
});
```

---

#### 4. Pruebas de Robustez

##### 4.1 Manejo de Errores de Red

```javascript
describe('Network Error Handling', () => {
  it('TC-025: Debe manejar timeout de Odoo', async () => {
    // Configurar mock que simula timeout
    nock(BASE_URL)
      .get(/.*/)
      .delayConnection(30000)
      .reply(408);
    
    const response = await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ limitProducts: 5 })
    });
    
    assert.equal(response.status, 202);
    
    const webhook = await waitForWebhook(5 * 60 * 1000);
    assert(webhook.stats.totalErrors > 0);
  });

  it('TC-026: Debe continuar después de errores parciales', async () => {
    // Simular 50% de productos con error
    let requestCount = 0;
    nock(BASE_URL)
      .persist()
      .get(/shop\/\d+/)
      .reply(() => {
        requestCount++;
        return requestCount % 2 === 0 ? [200, '<html>...</html>'] : [500];
      });
    
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ limitProducts: 10 })
    });
    
    const webhook = await waitForWebhook(5 * 60 * 1000);
    
    // Debe haber procesado todos, algunos con error
    assert.equal(webhook.processed, 10);
    assert(webhook.stats.totalErrors > 0);
    assert(webhook.stats.totalErrors < 10);
  });
});
```

---

##### 4.2 Manejo de Datos Corruptos

```javascript
describe('Data Corruption Handling', () => {
  it('TC-027: Debe manejar HTML malformado', async () => {
    nock(BASE_URL)
      .get(/shop\/\d+/)
      .reply(200, '<html><body><div>Incomplete HTML');
    
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ limitProducts: 1 })
    });
    
    const webhook = await waitForWebhook(2 * 60 * 1000);
    
    // Debe registrar error pero no crashear
    assert(webhook.stats.totalErrors > 0);
  });

  it('TC-028: Debe manejar productos sin precio', async () => {
    nock(BASE_URL)
      .post('/shop/product/get_combination_info')
      .reply(200, {
        display_name: 'Producto Test',
        list_price: null, // Precio nulo
        product_id: 123
      });
    
    await fetch('/api/scraper/sitemap', {
      method: 'POST',
      body: JSON.stringify({ limitProducts: 1 })
    });
    
    const webhook = await waitForWebhook(2 * 60 * 1000);
    
    // Verificar que no guardó producto inválido
    const product = await db.products.findOne({ product_id: 123 });
    assert(product === null || product.list_price > 0);
  });
});
```

---

##### 4.3 Manejo de Concurrencia

```javascript
describe('Concurrency Tests', () => {
  it('TC-029: Debe rechazar requests concurrentes (si aplica)', async () => {
    // Ejecutar dos scrapers simultáneos
    const promises = [
      fetch('/api/scraper/category', {
        method: 'POST',
        body: JSON.stringify({ categoryIds: 'all' })
      }),
      fetch('/api/scraper/sitemap', {
        method: 'POST',
        body: JSON.stringify({ limitProducts: 10 })
      })
    ];
    
    const responses = await Promise.all(promises);
    
    // Ambos deben aceptarse (actualmente no hay limitación)
    assert(responses.every(r => r.status === 202));
    
    // TODO: Implementar lock si se requiere serialización
  });

  it('TC-030: MongoDB debe manejar writes concurrentes', async () => {
    // Simular writes concurrentes al mismo producto
    const productData = {
      product_id: 999,
      display_name: 'Test Product',
      list_price: 100
    };
    
    const promises = Array(10).fill().map(() => 
      db.products.updateOne(
        { product_id: 999 },
        { $set: productData },
        { upsert: true }
      )
    );
    
    await Promise.all(promises);
    
    // Debe haber solo un documento
    const count = await db.products.countDocuments({ product_id: 999 });
    assert.equal(count, 1);
  });
});
```

---

#### 5. Pruebas de Seguridad

##### 5.1 Validación de Entrada

```javascript
describe('Input Validation', () => {
  it('TC-031: Debe rechazar webhookUrl con XSS', async () => {
    const response = await fetch('/api/scraper/sitemap/analysis', {
      method: 'POST',
      body: JSON.stringify({
        webhookUrl: 'javascript:alert(1)'
      })
    });
    
    // Actualmente acepta (TODO: implementar validación)
    // assert.equal(response.status, 400);
  });

  it('TC-032: Debe rechazar categoryIds con SQL injection', async () => {
    const response = await fetch('/api/scraper/category', {
      method: 'POST',
      body: JSON.stringify({
        categoryIds: "1 OR 1=1"
      })
    });
    
    // Debe fallar al parsear o retornar error
    assert(response.status === 202 || response.status === 500);
  });

  it('TC-033: Debe manejar payloads muy grandes', async () => {
    const hugePayload = {
      webhookUrl: 'http://test.com/' + 'a'.repeat(10000)
    };
    
    const response = await fetch('/api/scraper/sitemap/analysis', {
      method: 'POST',
      body: JSON.stringify(hugePayload)
    });
    
    // Express debe limitar tamaño (configurar limit en app.js)
    assert(response.status === 202 || response.status === 413);
  });
});
```

---

##### 5.2 Autenticación y Autorización

```javascript
describe('Authentication Tests', () => {
  it('TC-034: Debe fallar con credenciales Odoo inválidas', async () => {
    // Cambiar temporalmente variables de entorno
    const original = process.env.ODOO_PASS;
    process.env.ODOO_PASS = 'wrong_password';
    
    const response = await fetch('/api/scraper/category', {
      method: 'POST',
      body: JSON.stringify({ categoryIds: 'all' })
    });
    
    const webhook = await waitForWebhook(2 * 60 * 1000);
    assert.equal(webhook.status, 'error');
    
    // Restaurar
    process.env.ODOO_PASS = original;
  });

  // TODO: Implementar autenticación de API
  it.skip('TC-035: Debe requerir API key para endpoints', async () => {
    const response = await fetch('/api/scraper/category', {
      method: 'POST',
      body: JSON.stringify({ categoryIds: 'all' })
      // Sin header de autenticación
    });
    
    assert.equal(response.status, 401);
  });
});
```

---

#### 6. Pruebas de Regresión

##### 6.1 Checklist Post-Deployment

```markdown
## Checklist de Regresión

### Pre-Tests
- [ ] Variables de entorno configuradas
- [ ] MongoDB accesible
- [ ] Sitio objetivo disponible
- [ ] Webhook endpoint activo

### Core Functionality
- [ ] TC-001: Health check responde
- [ ] TC-002: Sitemap analysis completa
- [ ] TC-006: Category scraper (all) completa
- [ ] TC-014: Sitemap scraper (limitProducts: 5) completa

### Data Integrity
- [ ] Productos no se duplican en re-scraping
- [ ] Categorías detectadas correctamente
- [ ] Precios tienen margen aplicado
- [ ] Timestamps actualizados correctamente

### Performance
- [ ] Analysis completa en < 10 min
- [ ] 10 productos scrapean en < 3 min
- [ ] Throughput > 5 productos/min

### Error Handling
- [ ] Errores de red no crashean servicio
- [ ] Productos inválidos se saltean
- [ ] Webhooks se envían incluso con errores

### Logs
- [ ] Logs se escriben correctamente
- [ ] Errores tienen stack traces
- [ ] Métricas son precisas
```

---

### 7. Herramientas de Testing Recomendadas

#### 7.1 Framework de Testing
```json
{
  "devDependencies": {
    "mocha": "^10.2.0",
    "chai": "^4.3.10",
    "supertest": "^6.3.3",
    "nock": "^13.4.0",
    "mongodb-memory-server": "^9.1.3"
  }
}
```

#### 7.2 Test Runner Script
```json
{
  "scripts": {
    "test": "mocha test/**/*.test.js",
    "test:integration": "mocha test/integration/**/*.test.js --timeout 600000",
    "test:unit": "mocha test/unit/**/*.test.js",
    "test:coverage": "nyc npm test"
  }
}
```

---

### 8. Métricas de Calidad

#### Criterios de Aceptación

| Métrica | Umbral Mínimo | Objetivo |
|---------|--------------|----------|
| Code Coverage | 70% | 85% |
| Test Pass Rate | 95% | 100% |
| Success Rate (Scraping) | 90% | 95% |
| API Response Time (202) | < 200ms | < 100ms |
| Webhook Delivery Rate | 95% | 99% |

---

## Apéndices

### A. Glosario

**Auto-Discovery**: Proceso automático de detección de páginas por categoría mediante navegación a página 999.

**Upsert**: Operación de MongoDB que actualiza si existe o inserta si no existe.

**Product Template ID**: Identificador de plantilla de producto en Odoo (puede tener múltiples variantes).

**Product ID**: Identificador único de producto/variante específica en Odoo.

**Slug**: Versión URL-friendly de un nombre (e.g., "Tornillos/Fijación" → "tornillos-fijacion").

**Strategy Pattern**: Patrón de diseño que permite intercambiar algoritmos (CategoryProductStrategy vs SitemapProductStrategy).

**Webhook**: Callback HTTP que notifica eventos de forma asíncrona.

**Rate Limiting**: Limitación de requests por tiempo para evitar bloqueos del servidor objetivo.

---

### B. Patrones de URL de Odoo

#### Productos
```
https://web.com/shop/{product_template_id}
https://web.com/shop/{product_template_id}-{slug}
https://web.com/shop/{product_template_id}-{slug}?category={category_id}
```

**Ejemplos:**
```
https://web.com/shop/12345
https://web.com/shop/12345-tornillo-phillips-8x50mm
https://web.com/shop/12345-tornillo-phillips?category=42
```

#### Categorías
```
https://web.com/shop/category/por-rubro-{slug}-{category_id}
https://web.com/shop/category/por-rubro-{slug}-{category_id}/page/{page_number}
```

**Ejemplos:**
```
https://web.com/shop/category/por-rubro-tornillos-fijacion-42
https://web.com/shop/category/por-rubro-tornillos-fijacion-42/page/3
```

#### Marcas
```
https://web.com/shop/category/por-marca-{slug}-{brand_id}
https://web.com/shop/category/por-marca-{slug}-{brand_id}/page/{page_number}
```

**Ejemplos:**
```
https://web.com/shop/category/por-marca-bosch-15
https://web.com/shop/category/por-marca-dewalt-23/page/2
```

---

### C. Estructura de Respuesta de API Odoo

#### Endpoint: `/shop/product/get_combination_info`

**Request:**
```javascript
POST /shop/product/get_combination_info HTTP/1.1
Host: web.com
Content-Type: application/json
Cookie: session_id=xxx
Referer: https://web.com/shop/12345

{
  "product_id": 12345,
  "product_template_id": 6789,
  "combination": [],
  "add_qty": 1,
  "parent_combination": false
}
```

**Response:**
```json
{
  "product_id": 12345,
  "product_template_id": 6789,
  "display_name": "Tornillo Phillips 8x50mm - Acero Inoxidable",
  "price": "150.50",
  "list_price": 150.50,
  "has_discounted_price": false,
  "description": "<p>Tornillo de acero inoxidable 304...</p>",
  "is_combination_possible": true,
  "prevent_zero_price_sale": false,
  "show_availability": true,
  "out_of_stock_message": "",
  "virtual_available": 150,
  "cart_qty": 0,
  "uom_name": "Unidades",
  "carousel": [
    {
      "id": 789,
      "image_src": "/web/image/product.image/789",
      "name": "Tornillo Phillips - Vista frontal",
      "is_video": false
    },
    {
      "id": 790,
      "image_src": "/web/image/product.image/790",
      "name": "Tornillo Phillips - Vista lateral",
      "is_video": false
    }
  ],
  "product_variant_count": 1,
  "has_optional_products": false,
  "parent_name": null,
  "parent_combination": false,
  "attribute_values": [],
  "variant_values": []
}
```

---

### D. Códigos de Estado HTTP

| Código | Significado | Uso en API |
|--------|-------------|------------|
| 200 | OK | Health check, responses síncronas |
| 202 | Accepted | Scraping iniciado (procesamiento asíncrono) |
| 400 | Bad Request | Payload inválido (TODO: implementar validación) |
| 401 | Unauthorized | Autenticación requerida (TODO: implementar) |
| 404 | Not Found | Ruta no existe |
| 413 | Payload Too Large | Body excede límite (configurar en Express) |
| 500 | Internal Server Error | Errores de configuración, DB, Odoo |
| 503 | Service Unavailable | Servicio temporalmente no disponible |

---

### E. Variables de Configuración Avanzadas

#### Delays y Timeouts

```env
# Delay entre requests de productos (ms)
PAGE_DELAY_MS=1500

# Delay entre cambios de categoría (ms)
CATEGORY_DELAY_MS=5000

# Timeout para requests HTTP (ms) - TODO: implementar
REQUEST_TIMEOUT_MS=30000

# Timeout para login de Odoo (ms) - TODO: implementar
LOGIN_TIMEOUT_MS=10000
```

**Recomendaciones por Escenario:**

| Escenario | PAGE_DELAY_MS | CATEGORY_DELAY_MS | Razón |
|-----------|---------------|-------------------|-------|
| Desarrollo/Testing | 500-1000 | 2000 | Velocidad |
| Producción Normal | 1500-2000 | 5000 | Balance |
| Servidor Lento | 3000-5000 | 10000 | Evitar timeouts |
| Rate Limited | 5000+ | 15000+ | Evitar bloqueos |

---

#### Límites de Procesamiento

```env
# Límite global de productos en sitemap scraper
GLOBAL_SITEMAP_LIMIT=100

# Máximo de reintentos por producto (TODO: implementar)
MAX_RETRIES=3

# Delay entre reintentos (ms) (TODO: implementar)
RETRY_DELAY_MS=5000
```

---

### F. Troubleshooting Guide

#### Problema 1: "Login fallido a Odoo"

**Síntomas:**
- Webhook retorna `status: "error"`
- Logs muestran: "Login fallido a Odoo."

**Causas Posibles:**
1. Credenciales incorrectas en `.env`
2. Odoo cambió método de autenticación
3. Database name incorrecto
4. Firewall bloqueando requests

**Solución:**
```bash
# Verificar variables
echo $ODOO_USER
echo $ODOO_DB

# Probar login manual
curl -X POST https://web.com/web/login \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "params": {
      "db": "OdooSite",
      "login": "test@web.com",
      "password": "test123"
    }
  }'
```

---

#### Problema 2: "Base de datos no inicializada aún"

**Síntomas:**
- API retorna 500 inmediatamente
- Response: `{"error": "Base de datos en Scraper Microservice no inicializada aún"}`

**Causas Posibles:**
1. MongoDB desconectado
2. URI de MongoDB inválida
3. Credenciales de MongoDB incorrectas
4. Red no alcanza MongoDB

**Solución:**
```bash
# Verificar conectividad
mongo "$MONGO_URI"

# Verificar logs de startup
tail -f logs/app.log | grep MongoDB

# Reiniciar servicio
npm restart
```

---

#### Problema 3: Auto-Discovery retorna siempre 1 página

**Síntomas:**
- `categories[].pages` siempre es 1
- Scraping procesa menos productos de los esperados

**Causas Posibles:**
1. Estructura HTML de paginación cambió
2. JavaScript necesario para renderizar paginación
3. Categoría realmente tiene 1 página

**Diagnóstico:**
```javascript
// Habilitar logs de debug
const pages = await detectCategoryPages(categoryId, categorySlug, true);

// Revisar logs
// 🔍 DEBUG - URL solicitada: /page/999
// 🔍 DEBUG - URL final: /page/15
// 🔍 DEBUG - Productos en página: 24
// 🔍 DEBUG - ¿Existe paginación?: false  <- PROBLEMA
```

**Solución:**
```javascript
// Inspeccionar HTML manualmente
const response = await axios.get(
  `${BASE_URL}/shop/category/por-rubro-xxx-42/page/999`
);
console.log(response.data); // Buscar estructura de paginación
```

---

#### Problema 4: Productos sin categoría en Sitemap Scraper

**Síntomas:**
- `categoryId` es `null` para muchos productos
- Log muestra: "Productos con categoría detectada: 30/100"

**Causas Posibles:**
1. Slugs de productos no coinciden con slugs de categorías
2. Estructura de URL cambió
3. Categorías nuevas no están en sitemap

**Diagnóstico:**
```javascript
// Ver un producto sin categoría
const product = await db.products.findOne({ categoryId: null });
console.log(product.source);
// https://web.com/shop/12345-nuevo-producto-especial

// Ver categorías conocidas
const sitemap = await db.sitemap_analysis.findOne({});
console.log(sitemap.categories.map(c => c.slug));
// ['tornillos', 'tuercas', 'herramientas']
// 'nuevo-producto-especial' no matchea con ninguno
```

**Solución:**
```bash
# Re-analizar sitemap para actualizar categorías
curl -X POST http://localhost:3001/api/scraper/sitemap/analysis

# O usar Category Scraper que tiene categorías exactas
curl -X POST http://localhost:3001/api/scraper/category \
  -d '{"categoryIds": "all"}'
```

---

#### Problema 5: Webhook no se recibe

**Síntomas:**
- Scraping termina pero webhook nunca llega
- Logs no muestran errores de webhook

**Causas Posibles:**
1. URL de webhook inaccesible
2. Firewall bloqueando salida
3. Endpoint de webhook retorna error
4. Timeout en envío de webhook

**Diagnóstico:**
```bash
# Probar webhook manualmente
curl -X POST http://backend.com/webhook/scraper-result \
  -H "Content-Type: application/json" \
  -d '{
    "source": "test",
    "status": "success",
    "processed": 1
  }'

# Verificar logs del servidor
tail -f logs/app.log | grep webhook
```

**Solución:**
```javascript
// Agregar timeout y retry en webhookService.js
async function notifyWebhook(params) {
  const maxRetries = 3;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await axios.post(webhookUrl, payload, { timeout: 10000 });
      console.log(`Webhook enviado exitosamente`);
      return;
    } catch (err) {
      console.error(`Intento ${i+1} falló:`, err.message);
      if (i === maxRetries - 1) throw err;
      await delay(5000); // Esperar antes de reintentar
    }
  }
}
```

---

#### Problema 6: Rate Limiting de Odoo

**Síntomas:**
- Primeros productos scrapean bien, luego muchos errores
- Logs muestran: "Error 429: Too Many Requests"
- Performance degrada con el tiempo

**Causas Posibles:**
1. Delays muy cortos
2. IP bloqueada temporalmente
3. Odoo tiene rate limiting agresivo

**Solución:**
```bash
# Aumentar delays
curl -X POST http://localhost:3001/api/scraper/category \
  -d '{
    "categoryIds": "all",
    "pageDelay": 5000,
    "categoryDelay": 15000
  }'

# O implementar backoff exponencial (TODO)
```

---

### G. Mejoras Futuras (Roadmap)

#### Prioridad Alta

1. **Autenticación de API**
    - Implementar API keys
    - Rate limiting por cliente
    - Logs de auditoría

2. **Sistema de Reintentos**
    - Retry automático con backoff exponencial
    - Queue de productos fallidos
    - Re-procesamiento manual

3. **Validación de Input**
    - Schema validation con Joi
    - Sanitización de webhookUrl
    - Límites de payload size

---

#### Prioridad Media

4. **Monitoreo y Observabilidad**
    - Integración con Prometheus
    - Dashboards de Grafana
    - Alertas automáticas

5. **Optimización de Performance**
    - Caching de categorías
    - Connection pooling
    - Paralelización controlada

6. **Gestión de Imágenes Mejorada**
    - Upload automático a Cloudinary
    - Optimización de imágenes
    - Detección de duplicados

---

#### Prioridad Baja

7. **Interface de Administración**
    - Panel web para iniciar scrapers
    - Visualización de progreso en tiempo real
    - Gestión de configuración

8. **Sistema de Notificaciones**
    - Email alerts
    - Slack integration
    - Discord webhooks

9. **Reportes Avanzados**
    - Análisis de tendencias de precios
    - Detección de productos descontinuados
    - Comparación histórica

---

### H. FAQ (Preguntas Frecuentes)

**Q1: ¿Puedo ejecutar múltiples scrapers simultáneamente?**

R: Sí, la API acepta múltiples requests concurrentes. Sin embargo, MongoDB maneja los upserts de forma segura. Considera el impacto en el servidor objetivo (Odoo) y ajusta delays apropiadamente.

---

**Q2: ¿Cómo puedo cancelar un scraping en progreso?**

R: Actualmente no hay endpoint de cancelación. Opciones:
- Reiniciar el servicio (`npm restart`)
- Matar el proceso (`pkill -f "node server.js"`)
- TODO: Implementar endpoint `/api/scraper/cancel`

---

**Q3: ¿Los datos se duplican si ejecuto el scraper múltiples veces?**

R: No. Se usa `upsert` basado en `product_id`, por lo que productos existentes se actualizan en lugar de duplicarse.

---

**Q4: ¿Cuánto espacio en disco necesito?**

R: Depende del catálogo:
- 1000 productos: ~5-10 MB (solo datos)
- 10000 productos: ~50-100 MB
- Imágenes NO se guardan en MongoDB (solo URLs)
- Logs pueden crecer indefinidamente (implementar rotación)

---

**Q5: ¿Cómo actualizo solo productos de una marca?**

R: Actualmente no hay filtro por marca en los scrapers. Workaround:
1. Usar Sitemap Scraper con productos específicos
2. Filtrar URLs por marca en código antes de pasar a strategy
3. TODO: Implementar `BrandProductStrategy`

---

**Q6: ¿El scraper funciona con otros e-commerce además de Odoo?**
# Web Scraping API - Documentation

API REST para scraping automatizado de productos desde plataformas Odoo con soporte para procesamiento asíncrono y notificaciones vía webhooks.

---

## 📋 Tabla de Contenidos

- [Información General](#información-general)
- [Configuración](#configuración)
- [Endpoints](#endpoints)
- [Modelos de Datos](#modelos-de-datos)
- [Ejemplos de Uso](#ejemplos-de-uso)
- [Flujos de Trabajo](#flujos-de-trabajo)

---

## Información General

### Base URL
```
http://localhost:3001
```

### Características
- ✅ Scraping por categorías con auto-discovery
- ✅ Scraping basado en sitemap.xml
- ✅ Procesamiento asíncrono (respuestas 202 Accepted)
- ✅ Notificaciones vía webhook
- ✅ Persistencia en MongoDB con upsert
- ✅ Delays configurables entre requests

### Tecnologías
- Node.js + Express.js
- MongoDB
- Axios (HTTP client)
- Cheerio (HTML parsing)

---

## Configuración

### Variables de Entorno Requeridas

```env
# MongoDB
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/
MONGO_DB=mydb
MONGO_COLLECTION=products
SITEMAP_COLLECTION=sitemap_analysis

# Autenticación Odoo
ODOO_USER=test@web.com
ODOO_PASS=test123
ODOO_DB=OdooSite

# Scraping
BASE_URL=https://web.com
PAGE_DELAY_MS=1500
CATEGORY_DELAY_MS=5000
SITEMAP_URL=http://web.com/sitemap.xml

# Webhook (opcional)
WEBHOOK_URL=http://backend.com/webhook/scraper-result

# Servidor
PORT=3001
```

---

## Endpoints

### 1. Health Check

Verifica el estado del servicio.

```http
GET /
```

**Response 200**
```
Welcome to Scraping API!
```

---

### 2. Analizar Sitemap

Descarga y analiza el sitemap.xml, extrayendo estructura de categorías, marcas y productos.

```http
POST /api/scraper/sitemap/analysis
Content-Type: application/json

{
  "webhookUrl": "http://backend.com/webhook/analysis-complete"  // opcional
}
```

**Response 202**
```json
{
  "status": "accepted",
  "message": "Sitemap analysis started"
}
```

**Webhook Callback**
```json
{
  "source": "sitemapAnalysis",
  "status": "success",
  "processed": 1547,
  "stats": {
    "durationMs": null,
    "totalErrors": 0,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T15:35:20.123Z"
}
```

**Comportamiento**
1. Descarga sitemap desde `SITEMAP_URL`
2. Extrae y clasifica URLs (productos, categorías, marcas)
3. Almacena en colección `sitemap_analysis`
4. Notifica vía webhook (si configurado)

---

### 3. Category Scraper

Scrapea productos navegando por categorías. Detecta automáticamente páginas por categoría.

```http
POST /api/scraper/category
Content-Type: application/json

{
  "categoryIds": "all",           // "all" o ID específico (ej: 42)
  "pageDelay": 1500,              // opcional, default: PAGE_DELAY_MS
  "categoryDelay": 5000,          // opcional, default: CATEGORY_DELAY_MS
  "webhookUrl": "http://..."      // opcional
}
```

**Response 202**
```json
{
  "status": "accepted",
  "message": "Category scraper started"
}
```

**Webhook Callback**
```json
{
  "source": "categoryScraper",
  "status": "success",
  "processed": 1547,
  "stats": {
    "durationMs": null,
    "totalErrors": 23,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T16:45:30.456Z"
}
```

**Proceso**
1. Login en Odoo
2. Auto-discovery de categorías y páginas
3. Itera por cada categoría → página → producto
4. Extrae detalles desde API de Odoo
5. Aplica margen de ganancia
6. Guarda/actualiza en MongoDB

---

### 4. Sitemap Scraper

Scrapea productos usando URLs del sitemap previamente analizado.

```http
POST /api/scraper/sitemap
Content-Type: application/json

{
  "sitemapSource": "http://web.com/sitemap.xml",  // opcional
  "limitProducts": 100,                           // opcional, default: 1000
  "pageDelay": 2000,                              // opcional, default: PAGE_DELAY_MS
  "webhookUrl": "http://..."                      // opcional
}
```

**Response 202**
```json
{
  "status": "accepted",
  "message": "Sitemap scraper started"
}
```

**Webhook Callback**
```json
{
  "source": "sitemapScraper",
  "status": "success",
  "processed": 100,
  "stats": {
    "durationMs": null,
    "totalErrors": 2,
    "startedAt": null,
    "finishedAt": null
  },
  "timestamp": "2025-11-01T17:20:15.789Z"
}
```

**Prerequisitos**
- Requiere análisis previo de sitemap
- Si no existe, lo ejecuta automáticamente

**Proceso**
1. Verifica/ejecuta análisis de sitemap
2. Selecciona N URLs de productos
3. Visita cada URL y extrae datos
4. Infiere categoría desde slug del producto
5. Guarda/actualiza en MongoDB

---

### Códigos de Error Comunes

| Código | Mensaje | Causa |
|--------|---------|-------|
| 500 | Login fallido a Odoo | Credenciales inválidas |
| 500 | Base de datos no inicializada | MongoDB desconectado |
| 500 | No se encontró ningún rubro válido | categoryId inexistente |
| 404 | Ruta no encontrada | Endpoint incorrecto |

---

## Modelos de Datos

### Colección: `products`

```javascript
{
  // Identificadores
  "product_id": 12345,
  "custom_product_id": "TOR-PHI-8X50",
  "product_template_id": 6789,
  
  // Información básica
  "display_name": "Tornillo Phillips 8x50mm",
  "description": "<p>Tornillo de acero...</p>",
  "list_price": 150.50,
  "final_price": 180.60,
  
  // Categorización
  "categoryId": 42,
  "categoryName": "Tornillos/Fijación",
  
  // Multimedia
  "image_url": "https://res.cloudinary.com/.../product.jpg",
  "carousel": ["https://...", "https://..."],
  
  // Metadata
  "source": "https://web.com/shop/12345",
  "scraped_at": "2025-11-01T15:30:45.123Z",
  "updated_at": "2025-11-01T15:30:45.123Z"
}
```

**Índices Recomendados**
```javascript
db.products.createIndex({ "product_id": 1 }, { unique: true })
db.products.createIndex({ "categoryId": 1 })
db.products.createIndex({ "scraped_at": -1 })
```

---

### Colección: `sitemap_analysis`

```javascript
{
  "source": "http://web.com/sitemap.xml",
  "analyzedAt": "2025-11-01T14:00:00.000Z",
  
  "summary": {
    "totalProducts": 1547,
    "totalBrands": 35,
    "totalCategories": 12,
    "lastPageDiscovery": "2025-11-01T14:15:00.000Z"
  },
  
  "categories": [
    {
      "id": 42,
      "name": "Tornillos/Fijación",
      "slug": "tornillos-fijacion",
      "products": 234,
      "pages": 10
    }
  ],
  
  "brands": [
    {
      "id": 15,
      "name": "bosch",
      "products": 89,
      "urls": ["http://..."]
    }
  ],
  
  "productUrls": ["http://web.com/shop/12345", "..."],
  "brandUrls": ["http://web.com/shop/category/por-marca-bosch-15"]
}
```

---

### Colección: `config`

```javascript
// Margen de ganancia (porcentaje)
{
  "key": "profitMargin",
  "value": 20,
  "updatedAt": "2025-11-01T10:00:00.000Z"
}

// Cache de categorías descubiertas
{
  "key": "discoveredCategories",
  "value": [
    { "id": 42, "name": "Tornillos", "slug": "tornillos", "pages": 10 }
  ],
  "updatedAt": "2025-11-01T14:15:00.000Z"
}
```

---

## Ejemplos de Uso

### Caso 1: Setup Inicial Completo

**Paso 1: Analizar Sitemap**
```bash
curl -X POST http://localhost:3001/api/scraper/sitemap/analysis \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "http://backend.com/webhook"}'
```

**Paso 2: Scrapear Todo el Catálogo**
```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{
    "categoryIds": "all",
    "pageDelay": 2000,
    "categoryDelay": 5000,
    "webhookUrl": "http://backend.com/webhook"
  }'
```

---

### Caso 2: Testing con Muestra Pequeña

```bash
curl -X POST http://localhost:3001/api/scraper/sitemap \
  -H "Content-Type: application/json" \
  -d '{
    "limitProducts": 10,
    "pageDelay": 1000,
    "webhookUrl": "http://backend.com/webhook"
  }'
```

---

### Caso 3: Actualizar Categoría Específica

**Identificar ID de categoría:**
```javascript
db.sitemap_analysis.findOne({}, { categories: 1 })
```

**Ejecutar scraper:**
```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{
    "categoryIds": 42,
    "pageDelay": 1500,
    "webhookUrl": "http://backend.com/webhook"
  }'
```

---

### Caso 4: Scraping sin Webhook

```bash
curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{
    "categoryIds": "all",
    "pageDelay": 2000
  }'
```

**Monitoreo manual:**
```javascript
// Ver productos scrapeados hoy
db.products.count({
  scraped_at: { $gte: new Date("2025-11-01T00:00:00Z") }
})

// Ver últimos productos
db.products.find().sort({ scraped_at: -1 }).limit(10)
```

---

## Flujos de Trabajo

### Flujo 1: Primera Ejecución Completa

![Flujo Primera Ejecución](./docs/diagrams/first-run-flow.png)

**Descripción:**
1. Cliente solicita análisis de sitemap
2. API descarga y procesa sitemap.xml
3. Guarda estructura en MongoDB
4. Cliente solicita scraping por categorías
5. Sistema ejecuta auto-discovery de páginas
6. Itera categorías → páginas → productos
7. Guarda en MongoDB con upsert
8. Notifica vía webhook

---

### Flujo 2: Actualización Incremental con Sitemap

![Flujo Actualización](./docs/diagrams/incremental-update-flow.png)

**Descripción:**
1. Cliente solicita sitemap scraper con límite
2. Sistema verifica existencia de análisis previo
3. Si no existe, ejecuta análisis automático
4. Selecciona N productos del sitemap
5. Procesa cada producto individualmente
6. Actualiza productos existentes (upsert)
7. Notifica resultados

---

### Flujo 3: Manejo de Errores

![Flujo Errores](./docs/diagrams/error-handling-flow.png)

**Comportamiento:**
- Errores individuales NO detienen el proceso
- Se continúa con el siguiente producto
- Errores se acumulan en contador
- Webhook incluye estadísticas de errores
- Logs registran detalles para debugging

---

## Auto-Discovery de Páginas

El sistema detecta automáticamente cuántas páginas tiene cada categoría:

**Estrategia:**
```
1. Solicita página 999 de la categoría
   GET /shop/category/por-rubro-{slug}-{id}/page/999

2. Odoo redirige automáticamente a la última página
   → Redirect to /page/15

3. Extrae número de página del HTML
   <li class="page-item active">
     <a class="page-link">15</a>
   </li>

4. Guarda resultado en colección sitemap_analysis
```

**Fallbacks:**
- Analiza hrefs de paginación
- Verifica estado de botones (siguiente/anterior)
- Default: 1 página si no hay paginación

---

## Configuración de Delays

Los delays previenen rate limiting y sobrecarga del servidor:

| Escenario | PAGE_DELAY_MS | CATEGORY_DELAY_MS |
|-----------|---------------|-------------------|
| Testing | 500-1000 | 2000 |
| Producción | 1500-2000 | 5000 |
| Servidor Lento | 3000-5000 | 10000 |
| Rate Limited | 5000+ | 15000+ |

**Cálculo de tiempo estimado:**
```
Tiempo = (productos × PAGE_DELAY_MS) + (categorías × CATEGORY_DELAY_MS)

Ejemplo: 1000 productos, 10 categorías, delays estándar
= (1000 × 1500ms) + (10 × 5000ms)
= 1,500,000ms + 50,000ms
= 1,550,000ms ≈ 26 minutos
```

---

## Troubleshooting

### Problema: "Login fallido a Odoo"

**Causa:** Credenciales incorrectas o Odoo cambió autenticación

**Solución:**
```bash
# Verificar variables
echo $ODOO_USER
echo $ODOO_PASS
echo $ODOO_DB

# Probar login manual
curl -X POST https://web.com/web/login \
  -d "login=$ODOO_USER&password=$ODOO_PASS&db=$ODOO_DB"
```

---

### Problema: "Base de datos no inicializada"

**Causa:** MongoDB desconectado

**Solución:**
```bash
# Verificar conectividad
mongo "$MONGO_URI"

# Ver logs de startup
tail -f logs/app.log | grep MongoDB

# Reiniciar servicio
npm restart
```

---

### Problema: Auto-Discovery retorna siempre 1

**Causa:** Estructura HTML cambió o categoría tiene 1 página

**Diagnóstico:**
```bash
# Inspeccionar HTML manualmente
curl https://web.com/shop/category/por-rubro-xxx-42/page/999 > page.html
# Buscar: <li class="page-item active">
```

---

### Problema: Productos sin categoría

**Causa:** Slugs no coinciden entre productos y categorías

**Solución:**
```bash
# Re-analizar sitemap
curl -X POST http://localhost:3001/api/scraper/sitemap/analysis

# O usar Category Scraper (categorías exactas)
curl -X POST http://localhost:3001/api/scraper/category \
  -d '{"categoryIds": "all"}'
```

---

### Problema: Webhook no se recibe

**Causa:** URL inaccesible o firewall bloqueando

**Diagnóstico:**
```bash
# Probar webhook manualmente
curl -X POST http://backend.com/webhook/scraper-result \
  -H "Content-Type: application/json" \
  -d '{"source":"test","status":"success","processed":1}'

# Ver logs
tail -f logs/app.log | grep webhook
```

---

## Métricas de Éxito

Cada operación retorna métricas:

```javascript
{
  total: 245,        // Productos guardados exitosamente
  errors: 5,         // Productos que fallaron
  uploaded: 240,     // Productos con imagen en Cloudinary
  processed: 250     // Total procesados
}
```

**Interpretación:**

| Tasa de Éxito | Estado | Acción |
|---------------|--------|--------|
| > 95% | ✅ Excelente | Continuar |
| 90-95% | ⚠️ Bueno | Revisar logs |
| 80-90% | 🔶 Regular | Investigar causas |
| < 80% | 🔴 Crítico | Revisar config |

**Cálculo:**
```javascript
successRate = (total / processed) * 100
// Ejemplo: (245 / 250) * 100 = 98%
```

---

## Cron Jobs

### Scraping Diario

```bash
# Crontab: scraping diario a las 3 AM
0 3 * * * curl -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{"categoryIds":"all","webhookUrl":"http://backend.com/webhook"}'
```

### Análisis Semanal de Sitemap

```bash
# Crontab: análisis semanal (Domingos 2 AM)
0 2 * * 0 curl -X POST http://localhost:3001/api/scraper/sitemap/analysis \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"http://backend.com/webhook"}'
```

---

## Process Manager (PM2)

Para producción, usar PM2 para reinicio automático:

```bash
# Instalar PM2
npm install -g pm2

# Iniciar servicio
pm2 start server.js --name scraper-api

# Guardar configuración
pm2 save

# Auto-start en reinicio del servidor
pm2 startup
```

**Comandos útiles:**
```bash
pm2 status           # Ver estado
pm2 logs scraper-api # Ver logs en tiempo real
pm2 restart scraper-api
pm2 stop scraper-api
pm2 delete scraper-api
```

---

## FAQ

**Q: ¿Los datos se duplican en múltiples ejecuciones?**  
R: No, se usa `upsert` basado en `product_id`.

**Q: ¿Puedo cancelar un scraping en progreso?**  
R: Actualmente no hay endpoint de cancelación. Reiniciar el servicio.

**Q: ¿Cuánto espacio necesito?**  
R: ~5-10 MB por 1000 productos (solo datos, sin imágenes).

**Q: ¿Funciona con otros e-commerce?**  
R: No, está diseñado específicamente para Odoo.

**Q: ¿Cómo actualizo solo una marca?**  
R: No hay filtro por marca. Workaround: filtrar URLs manualmente o implementar `BrandProductStrategy`.

---

## Recursos

- **MongoDB**: https://docs.mongodb.com/drivers/node/
- **Express.js**: https://expressjs.com/
- **Odoo API**: https://www.odoo.com/documentation/

---

**Versión**: 1.0.0  
**Última Actualización**: 2025-11-01