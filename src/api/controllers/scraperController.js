const ScraperService = require('../services/scraperService');
const { getStatus } = require('../services/scraperQueue');
const logToFile = require('../../utils/logToFile');

// ──────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────

/**
 * Construye la respuesta 202 enriquecida con info de la cola.
 * Si el job fue encolado informa posición y cuántos están en espera.
 */
function buildAcceptedResponse(enqueueResult, scraperName) {
    const { jobId, queued, position, queueSnapshot } = enqueueResult;

    if (queued) {
        return {
            status: 'queued',
            jobId,
            message: `Hay un scraper en ejecución. ${scraperName} fue encolado en posición ${position}. Jobs en espera: ${queueSnapshot.pending}.`,
            queue: {
                pending: queueSnapshot.pending,
                position,
                running: queueSnapshot.running,
            },
        };
    }

    return {
        status: 'accepted',
        jobId,
        message: `${scraperName} iniciado.`,
        queue: {
            pending: 0,
            position: 0,
            running: queueSnapshot.running,
        },
    };
}

// ──────────────────────────────────────────────────────────────────────────
// CONTROLLERS
// ──────────────────────────────────────────────────────────────────────────

const sitemapScraperController = async (req, res) => {
    try {
        const { sitemapSource, limitProducts, pageDelay, webhookUrl } = req.body;
        const collection = req.collection;

        const enqueueResult = await ScraperService.sitemapScraper({
            sitemapSource,
            limitProducts,
            pageDelay,
            webhookUrl,
            collection,
        });

        const body = buildAcceptedResponse(enqueueResult, 'Sitemap scraper');
        res.status(202).json(body);

        await logToFile.info('Sitemap scraper encolado/iniciado', 'controller', {
            jobId: enqueueResult.jobId,
            queued: enqueueResult.queued,
            position: enqueueResult.position,
            sitemapSource,
            limitProducts,
            pageDelay,
            webhookUrl: !!webhookUrl,
            collection: collection.collectionName,
        });

    } catch (error) {
        console.error('Error en sitemapScraperController', { error: error.message, stack: error.stack, body: req.body });
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

const categoryScraperController = async (req, res) => {
    try {
        const { categoryIds, pageDelay, categoryDelay, webhookUrl } = req.body;
        const collection = req.collection;

        const enqueueResult = await ScraperService.categoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            webhookUrl,
            collection,
        });

        const body = buildAcceptedResponse(enqueueResult, 'Category scraper');
        res.status(202).json(body);

        await logToFile.info('Category scraper encolado/iniciado', 'controller', {
            jobId: enqueueResult.jobId,
            queued: enqueueResult.queued,
            position: enqueueResult.position,
            categoryIds: Array.isArray(categoryIds) ? categoryIds : [categoryIds],
            pageDelay,
            categoryDelay,
            webhookUrl: !!webhookUrl,
            collection: collection.collectionName,
        });

    } catch (error) {
        console.error('Error en categoryScraperController', { error: error.message, stack: error.stack, body: req.body });
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

const analyzeSitemapController = async (req, res) => {
    try {
        const { webhookUrl } = req.body;

        const enqueueResult = await ScraperService.analyzeSitemapService({ webhookUrl });

        const body = buildAcceptedResponse(enqueueResult, 'Sitemap analysis');
        res.status(202).json(body);

        await logToFile.info('Análisis de sitemap encolado/iniciado', 'controller', {
            jobId: enqueueResult.jobId,
            queued: enqueueResult.queued,
            position: enqueueResult.position,
            webhookUrl: !!webhookUrl,
        });

    } catch (error) {
        console.error('Error en analyzeSitemapController', { error: error.message, stack: error.stack, body: req.body });
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

/**
 * GET /scraper/status
 * Retorna el estado actual de la cola: job corriendo, jobs en espera, historial reciente.
 *
 * Ejemplo de respuesta:
 * {
 *   "isRunning": true,
 *   "running": { "id": "sitemapScraper-...", "type": "sitemapScraper", "startedAt": "...", "elapsedMs": 12000 },
 *   "pending": 2,
 *   "pendingJobs": [...],
 *   "recentHistory": [...]
 * }
 */
const scraperStatusController = (req, res) => {
    res.status(200).json(getStatus());
};

module.exports = {
    categoryScraperController,
    sitemapScraperController,
    analyzeSitemapController,
    scraperStatusController,
};