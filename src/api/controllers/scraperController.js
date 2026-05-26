const ScraperService = require('../services/scraperService');
const { getStatus, cancelJob, cancelAllJobs } = require('../services/scraperQueue');
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
        const { categoryIds, pageDelay, categoryDelay, webhookUrl, useAutoDiscovery = true } = req.body;
        const collection = req.collection;

        const enqueueResult = await ScraperService.categoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            webhookUrl,
            collection,
            useAutoDiscovery,
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
            useAutoDiscovery,
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

const restoreOfficialCategoriesController = async (req, res) => {
    try {
        const { webhookUrl } = req.body;

        const enqueueResult = await ScraperService.restoreOfficialCategories({ webhookUrl });

        const body = buildAcceptedResponse(enqueueResult, 'Restore official categories');
        res.status(202).json(body);

        await logToFile.info('Restauración de categorías oficiales encolada/iniciada', 'controller', {
            jobId: enqueueResult.jobId,
            queued: enqueueResult.queued,
            position: enqueueResult.position,
            webhookUrl: !!webhookUrl,
        });

    } catch (error) {
        console.error('Error en restoreOfficialCategoriesController', { error: error.message, stack: error.stack, body: req.body });
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

const reorganizeCategoriesController = async (req, res) => {
    try {
        const { categoryIds = 'all', pageDelay, dryRun = false, webhookUrl } = req.body;
        const collection = req.collection;

        const enqueueResult = await ScraperService.reorganizeCategories({
            categoryIds,
            pageDelay,
            dryRun,
            webhookUrl,
            collection,
        });

        const body = buildAcceptedResponse(enqueueResult, 'Category reorganization');
        res.status(202).json(body);

        await logToFile.info('Reorganización de categorías encolada/iniciada', 'controller', {
            jobId: enqueueResult.jobId,
            queued: enqueueResult.queued,
            position: enqueueResult.position,
            categoryIds: Array.isArray(categoryIds) ? categoryIds : [categoryIds],
            pageDelay,
            dryRun,
            webhookUrl: !!webhookUrl,
            collection: collection.collectionName,
        });

    } catch (error) {
        console.error('Error en reorganizeCategoriesController', { error: error.message, stack: error.stack, body: req.body });
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

// ──────────────────────────────────────────────────────────────────────────
// CANCELACIÓN DE JOBS
// ──────────────────────────────────────────────────────────────────────────

/**
 * DELETE /scraper/jobs/:jobId
 *
 * Cancela un job específico por ID.
 * - 200: job cancelado (estaba pendiente o en ejecución).
 * - 400: el job ya está completado/fallido.
 * - 404: jobId no encontrado.
 */
const cancelJobController = async (req, res) => {
    const { jobId } = req.params;
    try {
        const result = await cancelJob(jobId);

        if (result === null) {
            return res.status(404).json({ status: 'error', message: `Job '${jobId}' no encontrado.` });
        }

        if (result.alreadyDone) {
            return res.status(400).json({
                status: 'error',
                message: `El job '${jobId}' ya finalizó con estado '${result.status}' y no puede ser cancelado.`,
                jobStatus: result.status,
            });
        }

        const message = result.wasRunning
            ? `Solicitud de cancelación enviada al job '${jobId}' en ejecución. Finalizará al completar la operación actual.`
            : `Job '${jobId}' eliminado de la cola de espera.`;

        return res.status(200).json({ status: 'cancelled', jobId, message, ...result });
    } catch (error) {
        console.error('Error en cancelJobController', { error: error.message, jobId });
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

/**
 * DELETE /scraper/jobs/all
 *
 * Purga todos los jobs pendientes de la cola.
 * El job en ejecución (si lo hay) no se ve afectado.
 * - 200: purga completada con conteo de jobs eliminados.
 */
const cancelAllJobsController = async (req, res) => {
    try {
        const result = await cancelAllJobs();
        return res.status(200).json({
            status: 'purged',
            message: `${result.cancelledCount} job(s) pendiente(s) eliminado(s) de la cola.`,
            cancelledCount: result.cancelledCount,
            queueSnapshot: result.queueSnapshot,
        });
    } catch (error) {
        console.error('Error en cancelAllJobsController', { error: error.message });
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

module.exports = {
    categoryScraperController,
    sitemapScraperController,
    analyzeSitemapController,
    restoreOfficialCategoriesController,
    reorganizeCategoriesController,
    scraperStatusController,
    cancelJobController,
    cancelAllJobsController,
    buildAcceptedResponse,   // exportada para reusar en otros controllers
};