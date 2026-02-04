const { runCategoryScraper, runSitemapScraper, analyzeSitemap } = require('../../scraper/scraper');
const { notifyWebhook } = require('./webhookService');

/**
 * Helper para inicializar el objeto de resultado con valores por defecto
 */
const createInitialResult = () => ({
    total: 0,
    processed: 0,
    errors: 0,
    totalErrors: 0,
    uploaded: 0,
    durationMs: 0,
    startTime: new Date().toISOString()
});

/**
 * Analiza el sitemap.xml
 */
async function analyzeSitemapService({ webhookUrl }) {
    const source = 'sitemapAnalysis';
    let status = 'success';
    let result = createInitialResult();
    const start = Date.now();

    try {
        const catalogDocument = await analyzeSitemap();

        result.processed = catalogDocument.summary.totalProducts;
        result.total = catalogDocument.summary.totalProducts;
        result.metadata = {
            categories: catalogDocument.summary.totalCategories,
            brands: catalogDocument.summary.totalBrands,
            analyzedAt: catalogDocument.analyzedAt
        };

        console.log(`[scraperService] Sitemap analizado: ${result.processed} productos`);
    } catch (error) {
        status = 'error';
        result.totalErrors = 1;
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        result.durationMs = Date.now() - start;
        result.endTime = new Date().toISOString();

        if (webhookUrl) {
            await notifyWebhook({ webhookUrl, source, status, result });
        }
    }

    return result;
}

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
    let result = createInitialResult();

    try {
        const scraperResponse = await runSitemapScraper({
            sitemapSource,
            limitProducts,
            pageDelay,
            collection,
        });
        result = { ...result, ...scraperResponse };
    } catch (error) {
        status = 'error';
        result.totalErrors = 1;
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        if (webhookUrl) {
            await notifyWebhook({ webhookUrl, source, status, result });
        }
    }

    return result;
}

/**
 * Ejecuta el scraper basado en categorías.
 */
async function categoryScraper({
                                   categoryIds,
                                   pageDelay = process.env.PAGE_DELAY_MS,
                                   categoryDelay,
                                   webhookUrl,
                                   collection,
                               }) {
    const source = 'categoryScraper';
    let status = 'success';
    let result = createInitialResult();

    try {
        const scraperResponse = await runCategoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            collection,
            useAutoDiscovery: true,
        });

        result = { ...result, ...scraperResponse };

    } catch (error) {
        status = 'error';
        result.totalErrors = 1;
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        if (webhookUrl) {
            await notifyWebhook({
                webhookUrl,
                source,
                status,
                result
            });
        }
    }

    return result;
}

module.exports = {
    analyzeSitemapService,
    sitemapScraper,
    categoryScraper,
};