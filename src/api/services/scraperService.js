const { runCategoryScraper, runSitemapScraper, analyzeSitemap } = require('../../scraper/scraper');
const { notifyWebhook } = require('./webhookService');

/**
 * Analiza el sitemap.xml y guarda la estructura en MongoDB.
 * Esta función descarga y procesa el sitemap para extraer categorías, marcas y productos.
 */
async function analyzeSitemapService({ webhookUrl }) {
    const source = 'sitemapAnalysis';
    let status = 'success';
    let result = {
        totalProducts: 0,
        totalBrands: 0,
        totalCategories: 0,
        source: null,
        analyzedAt: null
    };

    try {
        const catalogDocument = await analyzeSitemap();

        result = {
            totalProducts: catalogDocument.summary.totalProducts,
            totalBrands: catalogDocument.summary.totalBrands,
            totalCategories: catalogDocument.summary.totalCategories,
            source: catalogDocument.source,
            analyzedAt: catalogDocument.analyzedAt
        };

        console.log(`[scraperService] Sitemap analizado exitosamente: ${result.totalProducts} productos, ${result.totalCategories} categorías, ${result.totalBrands} marcas`);
    } catch (error) {
        status = 'error';
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        if (webhookUrl) {
            await notifyWebhook({
                webhookUrl,
                source,
                status,
                processed: result.totalProducts,
                total: result.totalProducts,
                errors: status === 'error' ? 1 : 0,
                uploaded: 0,
                metadata: {
                    categories: result.totalCategories,
                    brands: result.totalBrands,
                    analyzedAt: result.analyzedAt
                }
            });
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
        if (webhookUrl) {
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
    let result = { total: 0, errors: 0, uploaded: 0, processed: 0 };

    try {
        result = await runCategoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            collection,
            useAutoDiscovery: false,
        });
    } catch (error) {
        status = 'error';
        console.error(`[scraperService] Error en ${source}:`, error);
    } finally {
        if (webhookUrl) {
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
    }

    return result;
}

module.exports = {
    analyzeSitemapService,
    sitemapScraper,
    categoryScraper,
};