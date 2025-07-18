# Meyfer Scraper Microservice

Scraper para obtener productos desde RHComercial.com.ar y guardarlos en MongoDB.

## Uso

```bash
node categoryScraper.js --rubros=3,5 --pageDelay=800
```

## Variables de entorno

Ver `.env.example` para configurar correctamente.

## Docker

```bash
docker build -t scraper-service .
docker run --env-file .env scraper-service --rubros=all
```

## Cloud Run

```bash
gcloud builds submit --tag gcr.io/TU_PROYECTO_ID/scraper-service
gcloud run deploy scraper-service ...
```
