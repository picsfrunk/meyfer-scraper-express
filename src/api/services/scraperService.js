const { runCategoryScraper } = require('../../scraper/categoryScraper');
const { runSitemapScraper } = require('../../scraper/sitemapScraper');
const { sendWebhook } = require('./webhookService');

async function categoryScraper({
                                   categoryDelay,
                                   collection,
                                   pageDelay,
                                   rubros,
                                   webhookUrl
    }){
    try {
        const total = await runCategoryScraper({ rubros, pageDelay, categoryDelay, collection });

        if (webhookUrl) {
            await sendWebhook(webhookUrl, {
                status: 'completed',
                source: 'category',
                processed: total,
                timestamp: new Date().toISOString()
            });
        }
    } catch (err) {
        console.error('Scraper error:', err);
        if (webhookUrl) {
            await sendWebhook(webhookUrl, {
                status: 'error',
                source: 'category',
                message: err.message,
                timestamp: new Date().toISOString()
            });
        }
    }
}

async function sitemapScraper({ pageDelay, webhookUrl, collection }) {
    try {
        const result = await runSitemapScraper(pageDelay, collection);

        if (webhookUrl) {
            await sendWebhook(webhookUrl, {
                status: 'completed',
                source: 'sitemap',
                result,
                timestamp: new Date().toISOString()
            });
        }
    } catch (err) {
        console.error('Sitemap scraper error:', err);
        if (webhookUrl) {
            await sendWebhook(webhookUrl, {
                status: 'error',
                source: 'sitemap',
                message: err.message,
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = {
    categoryScraper,
    sitemapScraper,
};
