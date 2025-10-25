require('dotenv').config();
const cheerio = require('cheerio');
const config = require('../config/config');
const RUBROS = require('../config/rubros');
const logToFile = require('../utils/logToFile');
const { getConfigCollection, getSitemapCollection } = require('../database/mongo');
const {
    client,
    BASE_URL,
    loginToOdoo,
    extractProductIdFromUrl,
    fetchProductDetailsFromAPI,
    extractImageUrl,
    processProductData,
} = require('../utils/scraperUtils');

// ============================================================
// UTILS
// ============================================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function log(message, enableLogs = true) {
    if (enableLogs) {
        console.log(message);
        logToFile(message);
    }
}

// ============================================================
// ESTRATEGIAS
// ============================================================

class CategoryProductStrategy {
    constructor({ categoryIds = 'all', enableLogs = true } = {}) {
        this.categoryIds = categoryIds;
        this.enableLogs = enableLogs;
    }

    async getProductList() {
        const rubros = this.categoryIds === 'all'
            ? RUBROS
            : RUBROS.filter(r => r.id === parseInt(this.categoryIds));

        if (!rubros.length) throw new Error('No se encontró ningún rubro válido.');

        const productList = [];

        for (const rubro of rubros) {
            log(`📦 Rubro: ${rubro.name} (${rubro.id})`, this.enableLogs);

            for (let page = 1; page <= rubro.pages; page++) {
                log(`➡ Página ${page}/${rubro.pages}`, this.enableLogs);

                const products = await this._fetchProducts(rubro.id, page);
                for (const p of products) {
                    productList.push({
                        ...p,
                        categoryId: rubro.id,
                        categoryName: rubro.name,
                    });
                }
            }
        }

        log(`📋 Total productos encontrados: ${productList.length}`, this.enableLogs);
        return productList;
    }

    async _fetchProducts(categoryId, page) {
        const url = `${BASE_URL}/shop/category/por-rubro-xxx-${categoryId}/page/${page}`;
        try {
            const res = await client.get(url);
            const $ = cheerio.load(res.data);
            return $('form.oe_product_cart').map((_, el) => ({
                product_id: Number($(el).find("input[name='product_id']").val()),
                product_template_id: Number($(el).find("input[name='product_template_id']").val()),
            })).get().filter(p => p.product_id && p.product_template_id);
        } catch (error) {
            log(`❌ Error en rubro ${categoryId}, página ${page}: ${error.message}`, this.enableLogs);
            return [];
        }
    }

    getName() {
        return `Category Scraper (${this.categoryIds === 'all' ? 'Todas' : `ID ${this.categoryIds}`})`;
    }
}

class SitemapProductStrategy {
    constructor({ sitemapSource = null, limitProducts = null, enableLogs = true } = {}) {
        this.sitemapSource = sitemapSource;
        this.limitProducts = limitProducts;
        this.enableLogs = enableLogs;
    }

    async getProductList() {
        const sitemapCollection = await getSitemapCollection();
        const query = this.sitemapSource ? { source: this.sitemapSource } : {};
        const sitemapDoc = await sitemapCollection.findOne(query);

        if (!sitemapDoc) throw new Error('No se encontró documento de sitemap en DB.');

        const urls = sitemapDoc.productUrls || [];
        if (!urls.length) throw new Error('No se encontraron URLs de productos.');

        const selectedUrls = this.limitProducts ? urls.slice(0, this.limitProducts) : urls;

        const productList = selectedUrls.map(url => {
            const templateMatch = url.match(/-(\d+)$/);
            const categoryMatch = url.match(/\?category=(\d+)/);

            return {
                product_template_id: templateMatch ? Number(templateMatch[1]) : null,
                product_id: null,
                sourceUrl: url,
                categoryId: categoryMatch ? parseInt(categoryMatch[1]) : null,
                categoryName: null,
            };
        }).filter(p => p.product_template_id);

        log(`📋 Productos en sitemap: ${productList.length}`, this.enableLogs);
        return productList;
    }

    getName() {
        return `Sitemap Scraper${this.limitProducts ? ` (${this.limitProducts} productos)` : ''}`;
    }
}

// ============================================================
// RUNNER PRINCIPAL
// ============================================================

class ScraperRunner {
    constructor({ strategy, collection, pageDelay, categoryDelay, enableLogs = true }) {
        this.strategy = strategy;
        this.collection = collection;
        this.pageDelay = pageDelay || config.pageDelay;
        this.categoryDelay = categoryDelay || config.categoryDelay;
        this.enableLogs = enableLogs;
        this.profitMargin = 1;
    }

    async initialize() {
        if (!await loginToOdoo()) throw new Error('Login fallido a Odoo.');

        const configCollection = await getConfigCollection();
        const profitDoc = await configCollection.findOne({ key: 'profitMargin' });
        this.profitMargin = profitDoc ? profitDoc.value / 100 : 1;

        log(`🚀 Iniciando: ${this.strategy.getName()}`, this.enableLogs);
    }

    async run() {
        await this.initialize();

        const products = await this.strategy.getProductList();
        let total = 0, uploaded = 0, errors = 0;

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            const progress = `[${i + 1}/${products.length}]`;
            log(`${progress} Procesando template ID: ${product.product_template_id}`, this.enableLogs);

            const details = await this._fetchAndProcessProduct(product);
            if (details) {
                await this.collection.updateOne(
                    { product_id: details.product_id },
                    { $set: details },
                    { upsert: true }
                );
                total++;
                if (details.image_url?.includes('cloudinary.com')) uploaded++;
                log(`✔ ${progress} Guardado: ${details.product_id} - ${details.display_name}`, this.enableLogs);
            } else {
                errors++;
                log(`✘ ${progress} Error procesando producto`, this.enableLogs);
            }

            await delay(this.pageDelay);
        }

        const summary = `
✅ Finalizado: ${this.strategy.getName()}
   Total: ${total}
   Errores: ${errors}
   Cloudinary: ${uploaded}
   Éxito: ${((total / products.length) * 100).toFixed(2)}%
    `;

        log(summary, this.enableLogs);

        return { total, errors, uploaded, processed: products.length };
    }

    async _fetchAndProcessProduct(product) {
        try {
            const productUrl = `${BASE_URL}/shop/${product.product_template_id}`;
            const response = await client.get(productUrl);
            const finalUrl = response.request.res.responseUrl;

            const customId = extractProductIdFromUrl(finalUrl);
            if (!customId) return null;

            let productId = product.product_id;
            if (!productId) {
                const $ = cheerio.load(response.data);
                productId = Number($("input[name='product_id']").val());
                if (!productId) return null;
            }

            const apiData = await fetchProductDetailsFromAPI({
                product_id: productId,
                product_template_id: product.product_template_id,
                refererUrl: finalUrl,
            });

            if (!apiData) return null;

            const imageUrl = extractImageUrl(apiData.carousel);
            const productData = await processProductData({
                customProductId: customId,
                productApiData: apiData,
                imageUrl,
                categoryId: product.categoryId,
                categoryName: product.categoryName,
                profitMargin: this.profitMargin,
                collection: this.collection,
                sourceUrl: product.sourceUrl,
            });

            return productData;
        } catch (err) {
            log(`❌ Error detalle ${product.product_template_id}: ${err.message}`, this.enableLogs);
            return null;
        }
    }
}

// ============================================================
// FUNCIONES PÚBLICAS
// ============================================================

async function runCategoryScraper(options) {
    const strategy = new CategoryProductStrategy(options);
    const runner = new ScraperRunner({
        ...options,
        strategy,
    });
    return runner.run();
}

async function runSitemapScraper(options) {
    const strategy = new SitemapProductStrategy(options);
    const runner = new ScraperRunner({
        ...options,
        strategy,
    });
    return runner.run();
}

module.exports = {
    runCategoryScraper,
    runSitemapScraper,
    CategoryProductStrategy,
    SitemapProductStrategy,
    ScraperRunner,
};
