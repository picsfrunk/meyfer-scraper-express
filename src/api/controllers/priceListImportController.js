const { runPriceListImport } = require('../services/priceListImportService');
const { buildAcceptedResponse } = require('./scraperController');
const logToFile = require('../../utils/logToFile');

/**
 * POST /scraper/price-list-import
 *
 * Dispara un import puntual de lista de precios.
 * El scraper crea el job operativo, igual que category/sitemap/price check.
 */
function createProcessPriceListImportController(runImport = runPriceListImport) {
    return async (req, res) => {
        try {
            const {
                source,
                fileId,
                sourceUrl,
                metadata,
                webhookUrl,
                backendImportJobId,
                requestId,
            } = req.body ?? {};

            const enqueueResult = await runImport({
                source,
                fileId,
                sourceUrl,
                metadata,
                webhookUrl,
                backendImportJobId,
                requestId,
            });
            const body = buildAcceptedResponse(enqueueResult, 'Price list import');
            res.status(202).json(body);

            await logToFile.info('Importacion de lista encolada/iniciada', 'controller', {
                jobId: enqueueResult.jobId,
                queued: enqueueResult.queued,
                position: enqueueResult.position,
                source,
                fileId: fileId || null,
                sourceUrl: sourceUrl || null,
                backendImportJobId: backendImportJobId || null,
                requestId: requestId || null,
            });
        } catch (error) {
            if (!res.headersSent) {
                const statusCode = error.statusCode || 500;
                res.status(statusCode).json({ status: 'error', message: error.message });
            }
        }
    };
}

const processPriceListImportController = createProcessPriceListImportController();

module.exports = {
    processPriceListImportController,
    createProcessPriceListImportController,
};
