const cheerio = require('cheerio');
const config = require('../config/config');
const RUBROS = require('../config/rubros');
const { client, BASE_URL } = require('./scraper');
const { getConfigCollection } = require('../database/mongo');

const DEFAULT_BATCH_SIZE = 100;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isCanceled(signal) {
    return signal?.canceled || signal?.cancelled;
}

function normalizeOfficialRubros() {
    return RUBROS.map((rubro) => ({
        id: rubro.id,
        name: rubro.name,
        pages: rubro.pages,
        slug: rubro.slug ?? null,
        source: 'rubros.js',
    }));
}

function filterRubros(categoryIds = 'all') {
    const officialRubros = normalizeOfficialRubros();
    const isAll = !categoryIds || categoryIds === 'all';

    if (isAll) return officialRubros;

    const idsInput = Array.isArray(categoryIds) ? categoryIds : [categoryIds];
    const targetIds = idsInput.map((id) => parseInt(id, 10)).filter((id) => !Number.isNaN(id));
    return officialRubros.filter((rubro) => targetIds.includes(rubro.id));
}

function extractProductIdFromHref(href) {
    if (!href) return null;
    const match = href.match(/\/shop\/(\d+)-/);
    return match?.[1] ?? null;
}

function normalizeCandidateIds(ids) {
    return [...new Set(ids.filter(Boolean).map((id) => String(id)))];
}

function extractProductsFromCategoryHtml(html) {
    const $ = cheerio.load(html);

    return $('form.oe_product_cart').map((_, el) => {
        const $form = $(el);
        const container = $form.closest('.oe_product, .o_wsale_product_grid_wrapper, .oe_product_cart');
        const productId = $form.find("input[name='product_id']").val();
        const productTemplateId = $form.find("input[name='product_template_id']").val();
        const href = container.find('a[href*="/shop/"]').first().attr('href')
            || $form.find('a[href*="/shop/"]').first().attr('href');
        const customProductId = extractProductIdFromHref(href);

        return {
            product_id: productId ? String(productId) : null,
            product_template_id: productTemplateId ? String(productTemplateId) : null,
            custom_product_id: customProductId,
            source_href: href || null,
            candidate_ids: normalizeCandidateIds([customProductId, productTemplateId, productId]),
        };
    }).get().filter((p) => p.candidate_ids.length > 0);
}

async function fetchCategoryProducts({ categoryId, page, slug = null }) {
    const urlPart = slug ? `por-rubro-${slug}-${categoryId}` : `por-rubro-xxx-${categoryId}`;
    const url = `${BASE_URL}/shop/category/${urlPart}/page/${page}`;
    const response = await client.get(url);
    return extractProductsFromCategoryHtml(response.data).map((product) => ({ ...product, category_page_url: url }));
}

async function restoreOfficialCategoriesConfig() {
    const configCollection = await getConfigCollection();
    const officialCategories = normalizeOfficialRubros();
    const now = new Date();

    await configCollection.updateOne(
        { key: 'discoveredCategories' },
        {
            $set: {
                value: officialCategories,
                source: 'rubros.js',
                updatedAt: now,
                restoredAt: now,
                note: 'Restored from official rubros.js to avoid sitemap partial category discovery.',
            },
        },
        { upsert: true }
    );

    return {
        total: officialCategories.length,
        processed: officialCategories.length,
        categories: officialCategories.map(({ id, name, pages }) => ({ id, name, pages })),
        restoredAt: now,
    };
}

async function reorganizeProductCategories({
    collection,
    categoryIds = 'all',
    pageDelay = config.pageDelay,
    dryRun = false,
    signal,
} = {}) {
    if (!collection) throw new Error('Falta colección MongoDB para reorganizar categorías.');

    const rubrosToProcess = filterRubros(categoryIds);
    if (!rubrosToProcess.length) {
        throw new Error(`No se encontraron rubros válidos para los IDs proporcionados: ${JSON.stringify(categoryIds)}`);
    }

    const startedAt = new Date();
    const categoryIndex = new Map();
    let pagesVisited = 0;
    let detectedProducts = 0;
    let errors = 0;

    for (const rubro of rubrosToProcess) {
        for (let page = 1; page <= rubro.pages; page++) {
            if (isCanceled(signal)) {
                return {
                    total: categoryIndex.size,
                    processed: detectedProducts,
                    pagesVisited,
                    errors,
                    dryRun,
                    canceled: true,
                    durationMs: Date.now() - startedAt.getTime(),
                };
            }

            try {
                const products = await fetchCategoryProducts({ categoryId: rubro.id, page, slug: rubro.slug });
                pagesVisited += 1;
                detectedProducts += products.length;

                for (const product of products) {
                    for (const candidateId of product.candidate_ids) {
                        if (!categoryIndex.has(candidateId)) {
                            categoryIndex.set(candidateId, {
                                category_id: rubro.id,
                                category_name: rubro.name,
                                category_reorganized_at: startedAt,
                                category_reorganized_source: 'category-listing-rubros.js',
                            });
                        }
                    }
                }
            } catch (error) {
                errors += 1;
                console.error(`[categoryMaintenance] Error leyendo rubro ${rubro.id}, página ${page}:`, error.message);
            }

            if (pageDelay > 0) await delay(Number(pageDelay));
        }
    }

    if (dryRun) {
        return {
            total: categoryIndex.size,
            processed: detectedProducts,
            pagesVisited,
            errors,
            dryRun: true,
            matched: 0,
            modified: 0,
            durationMs: Date.now() - startedAt.getTime(),
        };
    }

    let matched = 0;
    let modified = 0;
    const entries = [...categoryIndex.entries()];

    for (let i = 0; i < entries.length; i += DEFAULT_BATCH_SIZE) {
        const chunk = entries.slice(i, i + DEFAULT_BATCH_SIZE);
        const operations = chunk.map(([productId, categoryData]) => ({
            updateOne: {
                filter: { product_id: productId },
                update: { $set: categoryData },
                upsert: false,
            },
        }));

        if (!operations.length) continue;
        const result = await collection.bulkWrite(operations, { ordered: false });
        matched += result.matchedCount ?? 0;
        modified += result.modifiedCount ?? 0;
    }

    return {
        total: categoryIndex.size,
        processed: detectedProducts,
        pagesVisited,
        errors,
        dryRun: false,
        matched,
        modified,
        durationMs: Date.now() - startedAt.getTime(),
    };
}

module.exports = {
    restoreOfficialCategoriesConfig,
    reorganizeProductCategories,
    normalizeOfficialRubros,
};