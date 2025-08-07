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

// Database
const { connectToMongo } = require('./database/mongo');
let db_collection = null
connectToMongo()
    .then( (mongo_collection) => {
            db_collection = mongo_collection;
            console.log('🟢 Conectado a MongoDB');
        })
    .catch( (err) => {
            console.error('🔴 Error al conectar a MongoDB', err);
        });

app.use((req, res, next) => {
    if (!db_collection) {
        return res.status(500).json({ error: 'Base de datos en Scraper Microservice no inicializada aún' });
    }
    req.collection = db_collection;
    next();
});

// Routes
const scraperRoutes = require('./api/routes/scraperRoute');

app.get('/', (req, res) => {
    res.send('Welcome to Scraping API!');
});

// Scraper Routes
app.use('/api/scraper', scraperRoutes);

// Manejo de rutas no encontradas (404)
app.use((req, res, next) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

module.exports = app;