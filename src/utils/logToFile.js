// logToFile.js
const { getDB } = require('../database/mongo');
// Niveles de log
const LOG_LEVELS = {
    ERROR: 'error',
    WARN: 'warn',
    INFO: 'info',
    DEBUG: 'debug'
};

/**
 * Guarda un log en la base de datos MongoDB
 * @param {string} message - Mensaje del log
 * @param {string} level - Nivel del log (error, warn, info, debug)
 * @param {string} module - Módulo de origen (opcional)
 * @param {Object} metadata - Metadatos adicionales (opcional)
 */
async function logToFile(message, level = LOG_LEVELS.INFO, module = null, metadata = null) {
    try {
        const database = await getDB();
        const logsCollection = database.collection('application_logs');

        const logEntry = {
            timestamp: new Date(),
            level: level,
            message: message,
            module: module,
            metadata: metadata
        };

        await logsCollection.insertOne(logEntry);

    } catch (error) {
        // Fallback: console.error si no se puede conectar a MongoDB
        console.error(`[${new Date().toISOString()}] ❌ Error guardando log en MongoDB: ${error.message}`);
        console.error(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${module ? `[${module}]` : ''} ${message}`);
    }
}

/**
 * Funciones helper para diferentes niveles de log
 */
const logger = {
    error: (message, module = null, metadata = null) =>
        logToFile(message, LOG_LEVELS.ERROR, module, metadata),

    warn: (message, module = null, metadata = null) =>
        logToFile(message, LOG_LEVELS.WARN, module, metadata),

    info: (message, module = null, metadata = null) =>
        logToFile(message, LOG_LEVELS.INFO, module, metadata),

    debug: (message, module = null, metadata = null) =>
        logToFile(message, LOG_LEVELS.DEBUG, module, metadata)
};

module.exports = Object.assign(logToFile, logger, { LOG_LEVELS });