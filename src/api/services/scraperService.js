const { runCategoryScraper } = require('../../scraper/scraper');
const { runSitemapScraper } = require('../../scraper/scraper');
const { notifyWebhook } = require('./webhookService');

async function sitemapScraper({ pageDelay = process.env.PAGE_DELAY_MS, webhookUrl, collection }) {
    let processed = 0;
    let status = 'success';
    const source = 'sitemapScraper';

    const options = {
        sitemapSource: 'https://rhcomercial.com.ar/sitemap.xml',
        limitProducts: 2,
        pageDelay: pageDelay,
        collection: collection,
    };
    try {
        processed = await runSitemapScraper(options);
    } catch (error) {
        status = 'error';
        console.error('[scraperService] Error en sitemapScraper:', error);
    } finally {
        await notifyWebhook({ webhookUrl, source, status, processed });
    }
}

async function categoryScraper({
        categoryId,
        pageDelay,
        categoryDelay,
        webhookUrl,
        collection
    }) {
    let processed = 0;
    let status = 'success';
    const source = 'categoryScraper';
    try {
        processed = await runCategoryScraper({
            categoryDelay,
            categoryId,
            collection,
            pageDelay
        });
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