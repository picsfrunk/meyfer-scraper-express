// Environment
require('dotenv').config();

// Basic
const express = require('express');
const morgan = require('morgan');
const cors = require('cors');

// App Init
const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

//Webhooks
const webhookRoutes = require('./api/routes/webhook.route');
app.use('/api/webhook', webhookRoutes);


// Routes
const scraperRoutes = require('./api/routes/scraper.route');

// Endpoint raíz
app.get('/', (req, res) => {
    res.send('¡Bienvenido a la API de Scraping!');
});

// Scraper Routes
app.use('/api/scraper', scraperRoutes);

// Manejo de rutas no encontradas (404)
app.use((req, res, next) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

module.exports = app;