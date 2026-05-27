const { runCategoryScraper, runSitemapScraper, analyzeSitemap } = require('../../scraper/scraper');
const {
    restoreOfficialCategoriesConfig,
    reorganizeProductCategories,
} = require('../../scraper/categoryMaintenance');
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

/**
 * Normaliza el contrato de cancelación entre la cola y los handlers.
 *
 * La cola escribe `signal.canceled`, mientras que algunos runners históricos
 * todavía leen `signal.cancelled`. Este alias evita que un CategoryScraper en
 * ejecución ignore la solicitud de cancelación.
 */
function normalizeCancelSignal(signal) {
    if (!signal || Object.getOwnPropertyDescriptor(signal, 'cancelled')) {
        return signal;
    }

    Object.defineProperty(signal, 'cancelled', {
        enumerable: true,
        configurable: true,
        get() {
            return Boolean(this.canceled);
        },
        set(value) {
            this.canceled = Boolean(value);
        },
    });

    return signal;
}

// ──────────────────────────────────────────────────────────────────────────
// HANDLERS INTERNOS
// Lógica pura de scraping. NO llaman notifyWebhook — la cola (scraperQueue)
// es la única responsable de los webhooks. Si estos handlers lo hicieran
// también, el backend recibiría el evento 'completed' dos veces → email duplicado.
//
// Todos reciben `signal` como segundo argumento y lo propagan al runner.
// El signal canónico es { canceled: false }, con alias `cancelled` por compatibilidad.
// ──────────────────────────────────────────────────────────────────────────

async function _runAnalyzeSitemap({ }, signal) {
    let result = createInitialResult();
    const start = Date.now();

    try {
        // analyzeSitemap no tiene loop largo — el signal no es necesario aquí,
        // pero se recibe por consistencia con el resto de handlers.
        const catalogDocument = await analyzeSitemap();
        result.processed = catalogDocument.summary.totalProducts;
        result.total     = catalogDocument.summary.totalProducts;
        result.metadata  = {
            categories: catalogDocument.summary.totalCategories,
            brands:     catalogDocument.summary.totalBrands,
            analyzedAt: catalogDocument.analyzedAt,
        };
        console.log(`[scraperService] Sitemap analizado: ${result.processed} productos`);
    } catch (error) {
        result.totalErrors = 1;
        console.error(`[scraperService] Error en analyzeSitemap:`, error);
        throw error; // re-throw para que scraperQueue lo marque como 'failed'
    } finally {
        result.durationMs = Date.now() - start;
        result.endTime    = new Date().toISOString();
    }

    return result;
}

async function _runSitemapScraper({ sitemapSource, limitProducts = null, pageDelay = process.env.PAGE_DELAY_MS, collection }, signal) {
    let result = createInitialResult();

    try {
        const scraperResponse = await runSitemapScraper({
            sitemapSource,
            limitProducts,
            pageDelay,
            collection,
            signal: normalizeCancelSignal(signal),  // ← propagado al ScraperRunner
        });
        result = { ...result, ...scraperResponse };
    } catch (error) {
        result.totalErrors = 1;
        console.error(`[scraperService] Error en sitemapScraper:`, error);
        throw error;
    }

    return result;
}

async function _runCategoryScraper({
    categoryIds,
    pageDelay = process.env.PAGE_DELAY_MS,
    categoryDelay,
    collection,
    useAutoDiscovery = true,
}, signal) {
    let result = createInitialResult();

    try {
        const scraperResponse = await runCategoryScraper({
            categoryIds,
            pageDelay,
            categoryDelay,
            collection,
            useAutoDiscovery,
            signal: normalizeCancelSignal(signal),  // ← propagado al ScraperRunner
        });
        result = { ...result, ...scraperResponse };
    } catch (error) {
        result.totalErrors = 1;
        console.error(`[scraperService] Error en categoryScraper:`, error);
        throw error;
    }

    return result;
}

async function _runRestoreOfficialCategories({ }) {
    let result = createInitialResult();
    const start = Date.now();

    try {
        const response = await restoreOfficialCategoriesConfig();
        result = {
            ...result,
            ...response,
            durationMs: Date.now() - start,
            endTime: new Date().toISOString(),
        };
        console.log(`[scraperService] Categorías oficiales restauradas: ${response.total}`);
    } catch (error) {
        result.totalErrors = 1;
        console.error('[scraperService] Error restaurando categorías oficiales:', error);
        throw error;
    }

    return result;
}

async function _runReorganizeCategories({
    categoryIds = 'all',
    pageDelay = process.env.PAGE_DELAY_MS,
    dryRun = false,
    collection,
}, signal) {
    let result = createInitialResult();

    try {
        const response = await reorganizeProductCategories({
            collection,
            categoryIds,
            pageDelay,
            dryRun,
            signal: normalizeCancelSignal(signal),
        });
        result = { ...result, ...response };
    } catch (error) {
        result.totalErrors = 1;
        console.error('[scraperService] Error reorganizando categorías:', error);
        throw error;
    }

    return result;
}

// ──────────────────────────────────────────────────────────────────────────
// API PÚBLICA — todos los jobs pasan por la cola
// ──────────────────────────────────────────────────────────────────────────

async function analyzeSitemapService(params) {
    return enqueue({ type: JOB_TYPES.ANALYZE, params, handler: _runAnalyzeSitemap });
}

async function sitemapScraper(params) {
    return enqueue({ type: JOB_TYPES.SITEMAP, params, handler: _runSitemapScraper });
}

async function categoryScraper(params) {
    return enqueue({ type: JOB_TYPES.CATEGORY, params, handler: _runCategoryScraper });
}

async function restoreOfficialCategories(params) {
    return enqueue({ type: JOB_TYPES.CATEGORIES_RESTORE, params, handler: _runRestoreOfficialCategories });
}

async function reorganizeCategories(params) {
    return enqueue({ type: JOB_TYPES.CATEGORIES_REORGANIZE, params, handler: _runReorganizeCategories });
}

module.exports = {
    analyzeSitemapService,
    sitemapScraper,
    categoryScraper,
    restoreOfficialCategories,
    reorganizeCategories,
};