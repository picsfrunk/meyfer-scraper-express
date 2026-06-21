const { runPriceListImport } = require('../services/priceListImportService');
const { buildAcceptedResponse } = require('./scraperController');
const logToFile = require('../../utils/logToFile');

/**
 * POST /scraper/price-list-import/process/:jobId
 *
 * Dispara un import puntual de lista de precios para el job indicado por el backend.
 * El proceso reclama el job, obtiene el archivo, aplica cambios y reporta resultado.
 */
const processPriceListImportController = async (req, res) => {
    const { jobId } = req.params;

    if (!jobId) {
        return res.status(400).json({ status: 'error', message: 'jobId requerido' });
    }

    try {
        const enqueueResult = await runPriceListImport({ jobId });
        const body = buildAcceptedResponse(enqueueResult, 'Price list import');
        res.status(202).json(body);

        await logToFile.info('Importacion de lista encolada/iniciada', 'controller', {
            jobId: enqueueResult.jobId,
            backendJobId: jobId,
            queued: enqueueResult.queued,
            position: enqueueResult.position,
        });
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

module.exports = { processPriceListImportController };
