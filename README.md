# MeyFer Scraper — Microservicio de Extracción de Datos

![Node.js](https://img.shields.io/badge/Node.js-20-339933?logo=nodedotjs&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-4.19-000000?logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-6-47A248?logo=mongodb&logoColor=white)
![Cheerio](https://img.shields.io/badge/Cheerio-HTML_Parser-E88C1F?logo=data:image/svg+xml;base64,&logoColor=white)
![Cloudinary](https://img.shields.io/badge/Cloudinary-CDN-3448C5?logo=cloudinary&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)

Microservicio REST especializado en la extracción, sincronización y monitoreo de catálogos de productos desde plataformas e-commerce Odoo. Diseñado para operar de forma autónoma con procesamiento asíncrono, cola serializada de trabajos y notificaciones mediante webhooks protegidos.

Forma parte del ecosistema **MeyFer** (4 microservicios), operando como worker dedicado orquestado por `meyfer-backend-expressjs`.

---

## 🛠️ Stack Tecnológico

| Categoría | Tecnología |
|---|---|
| **Runtime / Framework** | Node.js 20 + Express.js 4.19 |
| **Parsing HTML** | Cheerio (DOM querying sobre páginas Odoo) |
| **Parsing XML** | xml2js (sitemap.xml) |
| **HTTP Client** | Axios + tough-cookie (sesiones con cookies stateful) |
| **Base de Datos** | MongoDB driver nativo 6 (bulkWrite) + Mongoose 9 (esquemas) |
| **Imágenes** | Cloudinary SDK (pipeline: download → MD5 hash → WebP → upload) |
| **Archivos** | csv-parse (CSV) + read-excel-file (XLSX) |
| **Containerización** | Docker + Docker Compose |
| **Deploy** | Railway |

---

## ✨ Funcionalidades Principales

### 🕷️ Estrategias de Scraping

El microservicio implementa dos estrategias intercambiables (Strategy Pattern) para la extracción de datos:

**Scraping por Categorías (`categoryScraper`)**
- Navega por las páginas de cada rubro/categoría del catálogo del proveedor.
- Auto-discovery de paginación: detecta automáticamente la cantidad total de páginas por categoría.
- Extrae identificadores de producto desde los formularios HTML de cada listado.
- Ideal para sincronización de producción — garantiza categorización exacta.

**Scraping por Sitemap (`sitemapScraper`)**
- Analiza y parsea el archivo `sitemap.xml` del proveedor.
- Extrae URLs de productos, categorías y marcas directamente del XML.
- Más rápido que el scraping por categorías (acceso directo a URLs).
- Ideal para recuperación masiva y auditorías de cobertura.

Ambas estrategias comparten el mismo pipeline de procesamiento:
1. Autenticación en la plataforma Odoo (JSON-RPC con sesión de cookies).
2. Resolución de detalles del producto (nombre, precio, unidad, tipo, imagen).
3. Aplicación del margen de ganancia configurado (`final_price = list_price × (1 + margen)`).
4. Persistencia en MongoDB mediante `bulkWrite` en lotes de 50.

### ⏳ Cola Serializada de Trabajos

- **Concurrencia controlada:** máximo 1 trabajo ejecutándose a la vez, protegiendo al proveedor de sobrecarga.
- **Tipos de jobs:** `categoryScraper`, `sitemapScraper`, `sitemapAnalysis`, `priceCheck`, `priceListImport`, `categoriesRestore`, `categoriesReorganize`.
- **Encolamiento automático:** si un job está activo, los nuevos se agregan a la cola con posición asignada.
- **Cancelación graceful:** señal de cancelación que detiene el procesamiento tras completar el producto actual y hacer flush del batch parcial.
- **Purga de cola:** eliminación masiva de todos los jobs pendientes sin afectar el job activo.
- **Historial:** las últimas 20 ejecuciones se mantienen en memoria para consulta rápida.

### 💰 Verificación de Precios (Price Checker)

- Comparación ligera y concurrente de precios internos vs proveedor upstream.
- Detecta productos con precios modificados, productos nuevos y productos eliminados.
- Concurrencia y delay configurables (`PRICE_CHECK_CONCURRENCY`, `PRICE_CHECK_REQUEST_DELAY`).
- No modifica la base de datos — solo reporta diferencias.
- Notifica resultados al backend para envío de alertas por email.

### 📥 Importación de Listas de Precios

- Parseo de archivos CSV y Excel (XLSX) con detección dinámica de columnas (código, precio).
- Actualización masiva de precios con aplicación automática del margen de ganancia.
- Dos modos: descarga desde URL remota configurada o procesamiento de archivo subido manualmente.
- Reporte de resultados: productos actualizados, sin cambios, no encontrados, errores.

### 🖼️ Pipeline de Imágenes

- Descarga de imágenes del proveedor.
- Hash MD5 para detección de cambios — evita re-uploads redundantes.
- Conversión automática a formato WebP con calidad optimizada.
- Almacenamiento en Cloudinary CDN con URLs seguras.
- Fallback a URL original si la descarga o el upload fallan.

### 📂 Mantenimiento de Categorías

- Restauración de categorías oficiales desde definición interna (`rubros.js`).
- Reorganización de categorías en productos existentes con soporte `dryRun` (preview sin cambios).
- Limpieza de productos huérfanos en corridas completas no canceladas ni limitadas.

### 📡 Webhooks y Comunicación

- Notificación automática al backend de cada cambio de estado del job: `enqueued`, `started`, `completed`, `failed`, `canceled`.
- Header de seguridad `X-Webhook-Secret` en cada notificación.
- Sanitización de payloads para evitar referencias circulares y errores 413.

### 🧪 Modo Test / Limitado

- Parámetros opcionales para corridas reducidas: `limitProducts`, `limitCategories`, `skipImages`.
- Ideal para validación rápida de webhooks, cancelación y flujos de integración.
- En modo limitado se omite la limpieza de huérfanos.

---

## 📋 Requisitos Previos

- Node.js 18 o superior
- MongoDB (local o Atlas)
- Credenciales de acceso a la plataforma Odoo del proveedor
- Cuenta de Cloudinary (opcional para desarrollo sin imágenes)

---

## 🚀 Instalación y Ejecución

```bash
# Instalar dependencias
npm install

# Iniciar el servidor (puerto 3001)
node src/server.js

# O con nodemon para desarrollo
npx nodemon start
```

El servicio estará disponible en `http://localhost:3001`.

### 🐳 Docker

```bash
# Levantar MongoDB local
docker-compose up -d

# Detener
docker-compose down
```

### Mock Server para Testing

El proyecto incluye un mock server que simula la plataforma del proveedor Odoo para desarrollo y testing sin tocar servidores de producción:

```bash
cd mock-server
npm install
npm start
# Disponible en http://localhost:3099
```

---

## ⚙️ Variables de Entorno

Crear un archivo `.env` en la raíz:

```env
# Servidor
PORT=3001

# MongoDB
MONGO_URI=mongodb://root:root@localhost:27017
MONGO_DB=meyfer-catalog
MONGO_COLLECTION=scraped-products
SITEMAP_COLLECTION=sitemap_analysis

# Plataforma Odoo del proveedor
BASE_URL=http://localhost:3099    # Mock en desarrollo
ODOO_USER=usuario@email.com
ODOO_PASS=contraseña
ODOO_DB=nombre_db

# Delays de scraping (protección contra rate-limiting)
PAGE_DELAY_MS=1000
CATEGORY_DELAY_MS=3000
PRICE_CHECK_REQUEST_DELAY=1000
PRICE_CHECK_CONCURRENCY=1

# Integración con backend
BACKEND_API_URL=http://localhost:3000
SCRAPER_WEBHOOK_SECRET=secreto_compartido

# Cloudinary (imágenes)
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=

# Logging
ENABLE_LOGS=true
```

---

## 🏗️ Estructura del Proyecto

```text
meyfer-scraper/
├── src/
│   ├── server.js                     # Entry point (listen en PORT)
│   ├── app.js                        # Express app + MongoDB gate middleware
│   ├── api/
│   │   ├── controllers/
│   │   │   ├── scraperController.js          # Scraping y categorías
│   │   │   ├── priceCheckerController.js     # Verificación de precios
│   │   │   └── priceListImportController.js  # Importación de listas
│   │   ├── routes/
│   │   │   └── scraperRoute.js               # Montaje en /api/scraper
│   │   └── services/
│   │       ├── scraperQueue.js               # Cola serializada (singleton)
│   │       ├── scraperService.js             # Mapeo de rutas a runners
│   │       ├── priceCheckerService.js        # Orquestación de price check
│   │       ├── priceListImportService.js     # Parser CSV/XLSX + bulk update
│   │       └── webhookService.js             # HTTP client con secret header
│   ├── scraper/
│   │   ├── scraper.js                # Core: estrategias, runners, pipeline
│   │   ├── priceChecker.js           # Detector de diferencias de precios
│   │   └── categoryMaintenance.js    # Restore y reorganización de categorías
│   ├── config/
│   │   ├── config.js                 # Variables de entorno centralizadas
│   │   └── rubros.js                 # Lista oficial de categorías (fallback)
│   ├── database/
│   │   └── mongo.js                  # Conexión Mongoose + MongoClient nativo
│   ├── models/
│   │   └── ScrapedProduct.model.js   # Schema Mongoose con text index
│   └── utils/
│       ├── imageUploader.js          # Pipeline Cloudinary (hash, WebP, upload)
│       └── logToFile.js              # Logging a MongoDB (application_logs)
├── mock-server/                      # Simulador Odoo para testing
├── scripts/
│   └── audit-category-coverage.js    # Auditoría de cobertura categoría vs sitemap
├── tests/
│   ├── test_price_list_import.js     # Tests de importación XLSX/CSV
│   └── test_webhook_sanitize.js      # Tests de sanitización de payloads
├── ENDPOINTS.md                      # Documentación detallada de endpoints
├── MeyFer.postman_collection.json    # Colección Postman
├── Dockerfile                        # node:20-alpine
└── docker-compose.yml                # MongoDB local
```

---

## 🗺️ Endpoints de la API

Todos los endpoints se montan bajo `/api/scraper`:

| Método | Endpoint | Descripción |
|---|---|---|
| `POST` | `/api/scraper/category` | Ejecutar scraping por categorías |
| `POST` | `/api/scraper/sitemap` | Ejecutar scraping por sitemap |
| `POST` | `/api/scraper/sitemap/analysis` | Analizar sitemap.xml del proveedor |
| `POST` | `/api/scraper/check-prices` | Verificar precios contra proveedor |
| `POST` | `/api/scraper/price-list-import` | Importar lista de precios CSV/XLSX |
| `POST` | `/api/scraper/categories/restore-official` | Restaurar categorías oficiales |
| `POST` | `/api/scraper/categories/reorganize` | Reorganizar categorías (soporta dryRun) |
| `GET` | `/api/scraper/status` | Estado actual de la cola de trabajos |
| `DELETE` | `/api/scraper/jobs/:jobId` | Cancelar job específico |
| `DELETE` | `/api/scraper/jobs/all` | Purgar todos los jobs pendientes |

> Todos los endpoints de scraping responden `202 Accepted` de forma inmediata y procesan de forma asíncrona. Los resultados se notifican vía webhook.

📖 Documentación detallada de payloads y respuestas en [`ENDPOINTS.md`](./ENDPOINTS.md)

📬 Colección Postman: `MeyFer.postman_collection.json`

---

## 🔄 Patrones de Diseño Implementados

| Patrón | Implementación |
|---|---|
| **Strategy** | Estrategias intercambiables de scraping (`CategoryProductStrategy`, `SitemapProductStrategy`) |
| **Template Method** | `ScraperRunner` define el flujo: `initialize → getProductList → process → notify` |
| **Singleton** | Cola de jobs in-memory con concurrencia controlada |
| **Observer/Webhook** | Notificación asíncrona de eventos de ciclo de vida del job |

---

## 🔁 Automatización y Scheduling

El servicio no incluye cron interno. Las ejecuciones se disparan por HTTP desde:

1. **Panel Admin (React):** triggers manuales o selectivos desde la interfaz.
2. **Backend (Express):** orquestación programática vía endpoints admin.
3. **Crontab del sistema (producción):**

```bash
# Scraping diario completo (3 AM)
0 3 * * * curl -s -X POST http://localhost:3001/api/scraper/category \
  -H "Content-Type: application/json" \
  -d '{"categoryIds":"all","webhookUrl":"http://localhost:3000/api/webhook/scraper/result"}'

# Análisis semanal de sitemap (domingos 2 AM)
0 2 * * 0 curl -s -X POST http://localhost:3001/api/scraper/sitemap/analysis \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"http://localhost:3000/api/webhook/scraper/result"}'
```

---

## ☁️ Despliegue

El proyecto está configurado para despliegue en **Railway** mediante Dockerfile (`node:20-alpine`).

Variables críticas en producción:
- `BASE_URL` → URL real del proveedor Odoo
- `SCRAPER_WEBHOOK_SECRET` → mismo valor que en el backend
- `BACKEND_API_URL` → URL del backend en producción
- Credenciales de Cloudinary y Odoo

---

## 📄 Licencia

ISC
