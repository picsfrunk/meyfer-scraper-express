const ScraperService = require('../services/scraper.service');
const { sendWebhook } = require('../services/webhook.service');

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
        const { webhookUrl } = req.body;

        res.status(202).json({ status: 'accepted', message: 'Sitemap scraper started' });

        ScraperService.sitemapScraper()
            .then(result => {
                if (webhookUrl) {
                    sendWebhook(webhookUrl, {
                        status: 'completed',
                        source: 'sitemap',
                        result,
                        timestamp: new Date().toISOString()
                    });
                }
            })
            .catch(err => {
                console.error('Sitemap scraper error:', err);
                if (webhookUrl) {
                    sendWebhook(webhookUrl, {
                        status: 'error',
                        source: 'sitemap',
                        message: err.message,
                        timestamp: new Date().toISOString()
                    });
                }
            });

    } catch (error) {
        console.error('Error en controller (sitemap):', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

module.exports = {
    runCategoryScraper,
    runSitemapScraper,
};
