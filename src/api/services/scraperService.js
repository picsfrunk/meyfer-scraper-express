const { runCategoryScraper, runSitemapScraper, analyzeSitemap } = require('../../scraper/scraper');
const { notifyWebhook } = require('./webhookService');
const { enqueue, JOB_TYPES } = require('./scraperQueue');

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

// ──────────────────────────────────────────────────────────────────────────
// HANDLERS INTERNOS (lógica pura, sin gestión de cola)
// Estos son los que ScraperQueue ejecuta como "job.handler"
// ──────────────────────────────────────────────────────────────────────────

async function _runAnalyzeSitemap({ webhookUrl }) {
    const source = JOB_TYPES.ANALYZE;
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

async function _runSitemapScraper({
                                      sitemapSource,
                                      limitProducts = 1000,
                                      pageDelay = process.env.PAGE_DELAY_MS,
                                      webhookUrl,
                                      collection,
                                  }) {
    const source = JOB_TYPES.SITEMAP;
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

async function _runCategoryScraper({
                                       categoryIds,
                                       pageDelay = process.env.PAGE_DELAY_MS,
                                       categoryDelay,
                                       webhookUrl,
                                       collection,
                                   }) {
    const source = JOB_TYPES.CATEGORY;
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
            await notifyWebhook({ webhookUrl, source, status, result });
        }
    }

    return result;
}

// ──────────────────────────────────────────────────────────────────────────
// API PÚBLICA — ahora pasan por la cola
// ──────────────────────────────────────────────────────────────────────────

/**
 * Analiza el sitemap.xml
 * Retorna información de encolamiento inmediatamente.
 */
async function analyzeSitemapService(params) {
    return enqueue({
        type: JOB_TYPES.ANALYZE,
        params,
        handler: _runAnalyzeSitemap,
    });
}

/**
 * Ejecuta el scraper basado en sitemap.
 * Retorna información de encolamiento inmediatamente.
 */
async function sitemapScraper(params) {
    return enqueue({
        type: JOB_TYPES.SITEMAP,
        params,
        handler: _runSitemapScraper,
    });
}

/**
 * Ejecuta el scraper basado en categorías.
 * Retorna información de encolamiento inmediatamente.
 */
async function categoryScraper(params) {
    return enqueue({
        type: JOB_TYPES.CATEGORY,
        params,
        handler: _runCategoryScraper,
    });
}

module.exports = {
    analyzeSitemapService,
    sitemapScraper,
    categoryScraper,
};