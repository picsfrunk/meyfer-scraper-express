const ScraperService = require('../services/scraperService');

const categoryScraperController = async (req, res) => {
    try {
        const {
            categoryId = 'all',
            pageDelay,
            categoryDelay,
            webhookUrl
        } = req.body,

            collection = req.collection;

        res.status(202).json({ status: 'accepted', message: 'Scraper started' });

        await ScraperService.categoryScraper({
            categoryDelay,
            collection,
            pageDelay,
            categoryId,
            webhookUrl
        });

    } catch (error) {
        console.error('Error en controller:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

const sitemapScraperController = async (req, res) => {
    try {
        const { pageDelay, webhookUrl } = req.body;
        const collection = req.collection;

        res.status(202).json({ status: 'accepted', message: 'Sitemap scraper started' });

        await ScraperService.sitemapScraper({
            pageDelay,
            webhookUrl,
            collection,
        });

    } catch (error) {
        console.error('Error en controller (sitemap):', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

module.exports = {
    categoryScraperController,
    sitemapScraperController,
};
