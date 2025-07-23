const ScraperService = require('../services/scraperService');
const { sendWebhook } = require('../services/webhookService');

const runCategoryScraper = async (req, res) => {
    try {
        const { rubros = 'all', pageDelay, categoryDelay, webhookUrl } = req.body;

        res.status(202).json({ status: 'accepted', message: 'Scraper started' });

        await ScraperService.categoryScraper({rubros, pageDelay, categoryDelay, webhookUrl});

    } catch (error) {
        console.error('Error en controller:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

const runSitemapScraper = async (req, res) => {
    try {
        const { pageDelay, webhookUrl } = req.body;

        res.status(202).json({ status: 'accepted', message: 'Sitemap scraper started' });

        await ScraperService.sitemapScraper({ pageDelay, webhookUrl });

    } catch (error) {
        console.error('Error en controller (sitemap):', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

module.exports = {
    runCategoryScraper,
    runSitemapScraper,
};
