const ScraperService = require('../services/scraperService');

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

        const result = await ScraperService.sitemapScraper({
            sitemapSource,
            limitProducts,
            pageDelay,
            webhookUrl,
            collection,
        });

        console.log(`[controller] Sitemap scraper finished:`, result);

    } catch (error) {
        console.error('[controller] Error en sitemapScraperController:', error);
        res.status(500).json({ status: 'error', message: error.message });
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

        const result = await ScraperService.categoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            webhookUrl,
            collection,
        });

        console.log(`[controller] Category scraper finished:`, result);

    } catch (error) {
        console.error('[controller] Error en categoryScraperController:', error);
        res.status(500).json({ status: 'error', message: error.message });
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

        const result = await ScraperService.analyzeSitemapService({ webhookUrl });

        console.log(`[controller] Sitemap analysis finished:`, result);

    } catch (error) {
        console.error('[controller] Error en analyzeSitemapController:', error);
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