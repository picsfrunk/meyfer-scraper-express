const { runCategoryScraper } = require('../../scraper/categoryScraper');
const { runSitemapScraper } = require('../../scraper/sitemapScraper');
const { notifyWebhook } = require('./webhookService');

async function sitemapScraper({ pageDelay = 250, webhookUrl, collection }) {
    let processed = 0;
    let status = 'success';
    const source = 'sitemapScraper';
    try {
        processed = await runSitemapScraper(pageDelay, collection);
    } catch (error) {
        status = 'error';
        console.error('[scraperService] Error en sitemapScraper:', error);
    } finally {
        await notifyWebhook({ webhookUrl, source, status, processed });
    }
}

async function categoryScraper({ rubros, pageDelay = 100, categoryDelay = 300, webhookUrl, collection }) {
    let processed = 0;
    let status = 'success';
    const source = 'categoryScraper';
    try {
        processed = await runCategoryScraper({ rubros, pageDelay, categoryDelay, collection });
    } catch (error) {
        status = 'error';
        console.error('[scraperService] Error en categoryScraper:', error);
    } finally {
        await notifyWebhook({ webhookUrl, source, status, processed });
    }
}

module.exports = {
    sitemapScraper,
    categoryScraper,
};