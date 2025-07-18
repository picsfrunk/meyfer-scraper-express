const scraperService = require('../services/scraper.service');

const runCategoryScraper = async (req, res) => {
    try {
        const { rubros = 'all', pageDelay, categoryDelay } = req.body;
        const total = await scraperService.runCategoryScraper(rubros, pageDelay, categoryDelay);
        res.status(200).json({ status: 'ok', processed: total });
    } catch (error) {
        console.error('Error en controller:', error);
        res.status(500).json({ status: 'error', message: error.message });    }
}

async function runSitemapScraper(req, res) {
    try {
        const result = await scraperService.runSitemapScraper();
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

module.exports = {
    runCategoryScraper,
    runSitemapScraper,
};