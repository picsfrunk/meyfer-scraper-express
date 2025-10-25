const { runCategoryScraper, runSitemapScraper } = require('../../scraper/scraper');
const { notifyWebhook } = require('./webhookService');

/**
 * Ejecuta el scraper basado en sitemap.
 */
async function sitemapScraper({
                                  sitemapSource,
                                  limitProducts = 1000,
                                  pageDelay = process.env.PAGE_DELAY_MS,
                                  webhookUrl,
                                  collection,
                              }) {
    const source = 'sitemapScraper';
    let status = 'success';
    let result = { total: 0, errors: 0, uploaded: 0, processed: 0 };

    try {
        result = await runSitemapScraper({
            sitemapSource,
            limitProducts,
            pageDelay,
            collection,
        });
    } catch (error) {
        status = 'error';
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        await notifyWebhook({
            webhookUrl,
            source,
            status,
            processed: result.processed,
            total: result.total,
            errors: result.errors,
            uploaded: result.uploaded,
        });
    }

    return result;
}

/**
 * Ejecuta el scraper basado en categorías.
 */
async function categoryScraper({
                                   categoryIds,
                                   pageDelay,
                                   categoryDelay,
                                   webhookUrl,
                                   collection,
                               }) {
    const source = 'categoryScraper';
    let status = 'success';
    let result = { total: 0, errors: 0, uploaded: 0, processed: 0 };

    try {
        result = await runCategoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            collection,
        });
    } catch (error) {
        status = 'error';
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        await notifyWebhook({
            webhookUrl,
            source,
            status,
            processed: result.processed,
            total: result.total,
            errors: result.errors,
            uploaded: result.uploaded,
        });
    }

    return result;
}

module.exports = {
    sitemapScraper,
    categoryScraper,
};
