const ScraperService = require('../services/scraperService');
const logToFile = require('../../utils/logToFile');

const sitemapScraperController = async (req, res) => {
    try {
        const {
            sitemapSource,
            limitProducts,
            pageDelay,
            webhookUrl
        } = req.body;

        const collection = req.collection;

        res.status(202).json({ status: 'accepted', message: 'Sitemap scraper started' });

        // Log del inicio del proceso
        await logToFile.info('Iniciando sitemap scraper', 'controller', {
            sitemapSource,
            limitProducts,
            pageDelay,
            webhookUrl: !!webhookUrl,
            collection: collection.collectionName
        });

        const result = await ScraperService.sitemapScraper({
            sitemapSource,
            limitProducts,
            pageDelay,
            webhookUrl,
            collection,
        });

        // Log del resultado exitoso
        await logToFile.info('Sitemap scraper finalizado exitosamente', 'controller', {
            total: result.total,
            errors: result.errors,
            uploaded: result.uploaded,
            processed: result.processed,
            successRate: ((result.total / result.processed) * 100).toFixed(2) + '%'
        });

    } catch (error) {
        // Log del error
        console.error('Error en sitemapScraperController', 'controller', {
            error: error.message,
            stack: error.stack,
            body: req.body
        });

        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

const categoryScraperController = async (req, res) => {
    try {
        const {
            categoryIds,
            pageDelay,
            categoryDelay,
            webhookUrl
        } = req.body;

        const collection = req.collection;

        res.status(202).json({ status: 'accepted', message: 'Category scraper started' });

        // Log del inicio del proceso
        await logToFile.info('Iniciando category scraper', 'controller', {
            categoryIds: Array.isArray(categoryIds) ? categoryIds : [categoryIds],
            pageDelay,
            categoryDelay,
            webhookUrl: webhookUrl,
            collection: collection.collectionName
        });

        const result = await ScraperService.categoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            webhookUrl,
            collection,
        });

        // Log del resultado exitoso
        await logToFile.info('Category scraper finalizado exitosamente', 'controller', {
            total: result.total,
            errors: result.errors,
            uploaded: result.uploaded,
            processed: result.processed,
            successRate: ((result.total / result.processed) * 100).toFixed(2) + '%'
        });

    } catch (error) {
        // Log del error
        console.error('Error en categoryScraperController', 'controller', {
            error: error.message,
            stack: error.stack,
            body: req.body
        });

        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

/**
 * Nuevo Controller para iniciar el análisis del Sitemap.
 * Solo necesita el webhookUrl y responde inmediatamente (202 Accepted).
 */
const analyzeSitemapController = async (req, res) => {
    try {
        const { webhookUrl } = req.body;

        res.status(202).json({ status: 'accepted', message: 'Sitemap analysis started' });

        // Log del inicio del proceso
        await logToFile.info('Iniciando análisis de sitemap', 'controller', {
            webhookUrl: !!webhookUrl
        });

        const result = await ScraperService.analyzeSitemapService({ webhookUrl });

        // Log del resultado exitoso
        await logToFile.info('Análisis de sitemap finalizado exitosamente', 'controller', {
            totalProducts: result.summary?.totalProducts,
            totalBrands: result.summary?.totalBrands,
            totalCategories: result.summary?.totalCategories
        });

    } catch (error) {
        // Log del error
        console.error('Error en analyzeSitemapController', 'controller', {
            error: error.message,
            stack: error.stack,
            body: req.body
        });

        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

module.exports = {
    categoryScraperController,
    sitemapScraperController,
    analyzeSitemapController,
};