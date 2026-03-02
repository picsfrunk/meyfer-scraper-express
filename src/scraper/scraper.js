require('dotenv').config();
const config = require('../config/config');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const xml2js = require('xml2js');
const https = require('https');
const http = require('http');

const logToFile = require('../utils/logToFile');
const { processProductImage } = require('../utils/imageUploader');
const { connectDB, getConfigCollection, getSitemapCollection } = require('../database/mongo');
const ScrapedProduct = require('../models/ScrapedProduct.model');

// ============================================================
// CONFIGURACIÓN Y CLIENTE HTTP
// ============================================================

const BASE_URL = config.baseUrl;
const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;
// Carga desde entorno. Convierte string "true" a booleano real.
const ENABLE_LOGS = process.env.ENABLE_LOGS === 'true';

const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

// ============================================================
// UTILIDADES
// ============================================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function log(message) {
    if (ENABLE_LOGS) {
        console.log(message);
    }
}

function formatTime(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

async function fetchSitemap(url) {
    return new Promise((resolve, reject) => {
        const httpClient = url.startsWith('https') ? https : http;
        httpClient.get(url, (res) => {
            let data = '';
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchSitemap(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch sitemap: HTTP ${res.statusCode}`));
            }
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ============================================================
// AUTENTICACIÓN ODOO
// ============================================================

async function loginToOdoo() {
    try {
        const res = await client.post(`${BASE_URL}/web/session/authenticate`, {
            jsonrpc: '2.0',
            method: 'call',
            params: { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS },
        });
        if (res.data.result?.uid) return true;
        log('❌ Falló el login.');
        return false;
    } catch (err) {
        log(`❌ Error durante login: ${err.message}`);
        return false;
    }
}

// ============================================================
// EXTRACCIÓN DE DATOS DE PRODUCTOS
// ============================================================

function extractProductIdFromUrl(url) {
    const urlMatch = url.match(/\/shop\/(\d+)-/);
    return urlMatch && urlMatch[1] ? urlMatch[1] : null;
}

async function fetchProductDetailsFromAPI({ product_id, product_template_id, refererUrl }) {
    try {
        const response = await client.post(
            `${BASE_URL}/website_sale/get_combination_info`,
            {
                id: 3,
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    product_template_id,
                    product_id,
                    combination: [],
                    add_qty: 1,
                    parent_combination: [],
                },
            },
            { headers: { 'Content-Type': 'application/json', Referer: refererUrl } }
        );
        return response.data.result;
    } catch (error) {
        log(`❌ Error API detalles product_id ${product_id}: ${error.message}`);
        return null;
    }
}

function extractImageUrl(carouselHtml) {
    if (!carouselHtml) return null;
    const $ = cheerio.load(carouselHtml);
    const imgSrc = $('img').attr('src');
    return imgSrc ? `${BASE_URL}${imgSrc}` : null;
}

function extractBrand(displayName) {
    const brandMatch = displayName.match(/"([^"]+)"$/);
    return brandMatch ? brandMatch[1].trim() : 'generico';
}

async function processProductData({ customProductId, productApiData, imageUrl, categoryId, categoryName, profitMargin, collection, sourceUrl, brand }) {
    try {
        const existingProduct = await collection.findOne({ product_id: customProductId });
        const existingImageUrl = existingProduct?.image_url || null;

        const cloudinaryImageUrl = await processProductImage(imageUrl, customProductId, existingImageUrl);
        const productBrand = brand || extractBrand(productApiData.display_name);
        const finalPrice = productApiData.list_price * (1 + profitMargin);

        const productData = {
            product_id: customProductId,
            display_name: productApiData.display_name,
            final_price: finalPrice,
            list_price: productApiData.list_price,
            base_unit_name: productApiData.base_unit_name,
            image_url: cloudinaryImageUrl,
            original_image_url: imageUrl,
            product_type: productApiData.product_type,
            category_id: categoryId,
            category_name: categoryName,
            brand: productBrand,
        };

        if (sourceUrl) productData.source_url = sourceUrl;
        return productData;
    } catch (error) {
        log(`❌ Error procesando datos ${customProductId}: ${error.message}`);
        return null;
    }
}

// ============================================================
// ANÁLISIS DE SITEMAP
// ============================================================

async function analyzeSitemap() {
    const sitemapUrl = process.env.SITEMAP_URL;
    if (!sitemapUrl) throw new Error('Falta variable de entorno: SITEMAP_URL');

    try {
        let content = await fetchSitemap(sitemapUrl);
        // Limpieza de namespace para facilitar parsing
        content = content.replace('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"', '');

        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(content);
        const urls = result.urlset.url.map(url => url.loc[0].trim());

        // Estructuras de datos para análisis
        const products = [], brands = [];
        const categoriesData = {}, brandsData = {};
        const productsByCategory = {}, productsByBrand = {};

        const productPattern = /\/shop\/[A-Za-z0-9\-]+/i;
        const brandPattern = /\/shop\/category\/por-marca-?([A-Za-z0-9\-]*)/i;
        const categoryPattern = /\/shop\/category\/por-rubro-([A-Za-z0-9\-]+)/i;

        for (const url of urls) {
            if (url.includes('/shop/') && !url.includes('/shop/category/') && productPattern.test(url)) {
                products.push(url);
                const slug = url.split('/shop/')[1];
                const matchCategory = slug.match(/^([A-Za-z\-]+)-\d+/);
                if (matchCategory) {
                    const cName = matchCategory[1];
                    productsByCategory[cName] = (productsByCategory[cName] || 0) + 1;
                }
                for (const bSlug in brandsData) {
                    if (url.includes(bSlug)) productsByBrand[bSlug] = (productsByBrand[bSlug] || 0) + 1;
                }
            } else if (brandPattern.test(url)) {
                const match = url.match(brandPattern);
                const brandSlug = match[1];
                if (brandSlug) {
                    const parts = brandSlug.split('-');
                    let bId = null, bName = brandSlug;
                    if (parts.length > 1 && !isNaN(parts[parts.length - 1])) {
                        bId = parseInt(parts[parts.length - 1]);
                        bName = parts.slice(0, -1).join('-');
                    }
                    brandsData[bName] = bId;
                    brands.push(url);
                }
            } else if (categoryPattern.test(url)) {
                const match = url.match(categoryPattern);
                const catSlug = match[1];
                if (!isNaN(catSlug)) continue;

                const parts = catSlug.split('-');
                let cId = null, cName = catSlug;
                if (parts.length > 1 && !isNaN(parts[parts.length - 1])) {
                    cId = parseInt(parts[parts.length - 1]);
                    cName = parts.slice(0, -1).join('-');
                }
                categoriesData[cName] = cId;
            }
        }

        // Transformación a Arrays para MongoDB
        const categoriesArray = Object.entries(categoriesData)
            .sort((a, b) => (a[1] || 0) - (b[1] || 0))
            .map(([name, id]) => ({
                id,
                name: name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('/'),
                slug: name,
                products: productsByCategory[name] || 0,
            }));

        const brandsArray = Object.entries(brandsData)
            .sort((a, b) => (a[1] || 0) - (b[1] || 0))
            .map(([slug, id]) => ({
                id,
                slug,
                name: slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' '),
                products: productsByBrand[slug] || 0,
                urls: brands.filter(u => u.includes(slug))
            }));

        const catalogDocument = {
            source: sitemapUrl,
            analyzedAt: new Date(),
            summary: {
                totalProducts: products.length,
                totalBrands: Object.keys(brandsData).length,
                totalCategories: Object.keys(categoriesData).length,
            },
            categories: categoriesArray,
            brands: brandsArray,
            productUrls: products,
            brandUrls: brands,
        };

        const sitemapCollection = await getSitemapCollection();
        await sitemapCollection.replaceOne({ source: sitemapUrl }, catalogDocument, { upsert: true });

        return catalogDocument;
    } catch (error) {
        log(`❌ Error analizando sitemap: ${error.message}`);
        throw error;
    }
}

// ============================================================
// AUTO-DISCOVERY DE CATEGORÍAS
// ============================================================

async function detectCategoryPages(categoryId, categorySlug) {
    try {
        // Page 999 fuerza a Odoo/Pagination a mostrar límites o vacío
        const testUrl = `${BASE_URL}/shop/category/por-rubro-${categorySlug}-${categoryId}/page/999`;
        const response = await client.get(testUrl);
        const $ = cheerio.load(response.data);

        if ($('form.oe_product_cart').length === 0) return 1;
        if ($('.pagination').length === 0) return 1;

        const activePage = $('.pagination li.page-item.active a.page-link').text().trim();
        const activePageNum = parseInt(activePage);
        if (!isNaN(activePageNum) && activePageNum > 0) return activePageNum;

        // Fallback: buscar el número más alto en links
        const pageNumbers = [];
        $('.pagination li.page-item:not(.disabled) a.page-link').each((_, el) => {
            const match = $(el).attr('href')?.match(/\/page\/(\d+)/);
            if (match) pageNumbers.push(parseInt(match[1]));
        });

        return pageNumbers.length ? Math.max(...pageNumbers) : 1;
    } catch (error) {
        log(`⚠️ Error detectando páginas cat ${categoryId}: ${error.message}`);
        return 1;
    }
}

async function discoverCategories() {
    try {
        const sitemapCollection = await getSitemapCollection();
        let sitemapDoc = await sitemapCollection.findOne({});
        if (!sitemapDoc) sitemapDoc = await analyzeSitemap();

        const categoriesWithPages = [];
        for (const cat of sitemapDoc.categories) {
            const pages = await detectCategoryPages(cat.id, cat.slug);
            categoriesWithPages.push({ ...cat, pages });
        }

        // Actualizar caché de discovery
        await sitemapCollection.updateOne(
            { source: sitemapDoc.source },
            { $set: { categories: categoriesWithPages, 'summary.lastPageDiscovery': new Date() } }
        );
        const configCollection = await getConfigCollection();
        await configCollection.updateOne(
            { key: 'discoveredCategories' },
            { $set: { value: categoriesWithPages, updatedAt: new Date() } },
            { upsert: true }
        );

        return categoriesWithPages;
    } catch (error) {
        log(`❌ Error en auto-discovery: ${error.message}`);
        throw error;
    }
}

async function getDiscoveredCategories({ forceRefresh = false } = {}) {
    if (!forceRefresh) {
        const configCollection = await getConfigCollection();
        const cached = await configCollection.findOne({ key: 'discoveredCategories' });
        if (cached?.value) return cached.value;
    }
    return await discoverCategories();
}

// ============================================================
// ESTRATEGIAS DE SCRAPING
// ============================================================

class CategoryProductStrategy {
    constructor({ categoryIds = 'all', useAutoDiscovery = true } = {}) {
        this.categoryIds = categoryIds;
        this.useAutoDiscovery = useAutoDiscovery;
        this.brandsCache = null;
    }

    async _loadBrands() {
        if (this.brandsCache) return this.brandsCache;
        try {
            const sitemapCollection = await getSitemapCollection();
            const sitemapDoc = await sitemapCollection.findOne({});

            if (sitemapDoc?.brands) {
                this.brandsCache = sitemapDoc.brands
                    .filter(b => b.name && b.id !== null)
                    .map(b => ({ name: b.name, slug: b.slug, id: b.id }))
                    .sort((a, b) => b.name.length - a.name.length); // Longest first for regex
                log(`✅ Cargadas ${this.brandsCache.length} marcas para matching`);
            } else {
                this.brandsCache = [];
            }
        } catch (error) {
            log(`⚠️ Error cargando marcas: ${error.message}`);
            this.brandsCache = [];
        }
        return this.brandsCache;
    }

    _extractBrandFromProductName(productName) {
        if (!productName || !this.brandsCache?.length) return null;
        const normalizedName = productName.toLowerCase().trim();

        for (const brand of this.brandsCache) {
            const regex = new RegExp(`\\b${brand.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(normalizedName)) return brand.name;
        }
        return null;
    }

    async getProductList() {
        await this._loadBrands();

        // 1. Obtener la fuente de rubros
        const allRubros = this.useAutoDiscovery
            ? await getDiscoveredCategories()
            : require('../config/rubros');

        // 2. Normalizar filtro de IDs (Number, Array, String 'all' o undefined)
        let rubrosToProcess = [];
        const isAll = !this.categoryIds || this.categoryIds === 'all';

        if (isAll) {
            rubrosToProcess = allRubros;
        } else {
            // Aseguramos que sea un array de números, manejando input string o number
            const idsInput = Array.isArray(this.categoryIds) ? this.categoryIds : [this.categoryIds];
            const targetIds = idsInput.map(id => parseInt(id)).filter(id => !isNaN(id));

            rubrosToProcess = allRubros.filter(r => targetIds.includes(r.id));
        }

        if (!rubrosToProcess.length) {
            throw new Error(`No se encontraron rubros válidos para los IDs proporcionados: ${JSON.stringify(this.categoryIds)}`);
        }

        log(`📋 Estrategia Category: Procesando ${rubrosToProcess.length} rubros.`);

        const productList = [];
        for (const rubro of rubrosToProcess) {
            for (let page = 1; page <= rubro.pages; page++) {
                const products = await this._fetchProducts(rubro.id, page, rubro.slug);
                products.forEach(p => {
                    productList.push({
                        ...p,
                        categoryId: rubro.id,
                        categoryName: rubro.name,
                        brand: p.brand || null
                    });
                });
            }
        }

        return productList;
    }

    async _fetchProducts(categoryId, page, slug = null) {
        const urlPart = slug ? `por-rubro-${slug}-${categoryId}` : `por-rubro-xxx-${categoryId}`;
        const url = `${BASE_URL}/shop/category/${urlPart}/page/${page}`;

        try {
            const res = await client.get(url);
            const $ = cheerio.load(res.data);

            return $('form.oe_product_cart').map((_, el) => {
                const $form = $(el);
                const productId = $form.find("input[name='product_id']").val();
                const productTemplateId = $form.find("input[name='product_template_id']").val();

                let productName = null;
                const nameSelectors = ['.o_wsale_product_name', 'h6.card-title', '.product-name', 'h6'];

                const container = $form.closest('.oe_product, .o_wsale_product_grid_wrapper');
                for (const selector of nameSelectors) {
                    if (container.find(selector).length) {
                        productName = container.find(selector).text().trim();
                        break;
                    }
                }

                return {
                    product_id: productId,
                    product_template_id: productTemplateId,
                    brand: this._extractBrandFromProductName(productName),
                    display_name: productName
                };
            }).get().filter(p => p.product_id && p.product_template_id);

        } catch (error) {
            log(`❌ Error en rubro ${categoryId}, página ${page}: ${error.message}`);
            return [];
        }
    }

    getName() {
        const mode = this.useAutoDiscovery ? 'Auto' : 'Manual';
        const scope = (!this.categoryIds || this.categoryIds === 'all')
            ? 'Todas'
            : `IDs: ${Array.isArray(this.categoryIds) ? this.categoryIds.join(',') : this.categoryIds}`;
        return `Category Scraper [${mode}] (${scope})`;
    }
}

class SitemapProductStrategy {
    constructor({ sitemapSource = null, limitProducts = null } = {}) {
        this.sitemapSource = sitemapSource;
        this.limitProducts = limitProducts;
        this.categoriesMap = null;
    }

    async getProductList() {
        const sitemapCollection = await getSitemapCollection();
        const query = this.sitemapSource ? { source: this.sitemapSource } : {};
        let sitemapDoc = await sitemapCollection.findOne(query);

        if (!sitemapDoc) {
            await analyzeSitemap(); // Auto-heal
            sitemapDoc = await sitemapCollection.findOne(query);
            if (!sitemapDoc) throw new Error('No se pudo obtener sitemap tras análisis.');
        }

        const urls = sitemapDoc.productUrls || [];
        if (!urls.length) throw new Error('No se encontraron URLs de productos en sitemap.');

        // Crear mapa de categorías para búsqueda rápida
        this.categoriesMap = {};
        if (Array.isArray(sitemapDoc.categories)) {
            sitemapDoc.categories.forEach(cat => {
                if (cat.slug) this.categoriesMap[cat.slug] = { id: cat.id, name: cat.name };
            });
        }

        const selectedUrls = this.limitProducts ? urls.slice(0, this.limitProducts) : urls;

        return selectedUrls.map(url => {
            const templateMatch = url.match(/-(\d+)$/);
            const slugMatch = url.match(/\/shop\/\d+-([a-z\-]+)/);

            let categoryId = null, categoryName = null;

            // Inferencia básica de categoría basada en URL slug
            if (slugMatch?.[1] && this.categoriesMap) {
                const productSlugParts = slugMatch[1].split('-');
                for (const catSlug in this.categoriesMap) {
                    if (catSlug.split('-').some(part => productSlugParts.includes(part))) {
                        categoryId = this.categoriesMap[catSlug].id;
                        categoryName = this.categoriesMap[catSlug].name;
                        break;
                    }
                }
            }

            return {
                product_template_id: templateMatch ? Number(templateMatch[1]) : null,
                sourceUrl: url,
                categoryId,
                categoryName,
            };
        }).filter(p => p.product_template_id);
    }

    getName() {
        return `Sitemap Scraper${this.limitProducts ? ` (Limit: ${this.limitProducts})` : ''}`;
    }
}

// ============================================================
// RUNNER PRINCIPAL
// ============================================================

class ScraperRunner {
    constructor({ strategy, collection, pageDelay, categoryDelay }) {
        this.strategy = strategy;
        this.collection = collection;
        this.pageDelay = pageDelay || config.pageDelay;
        this.profitMargin = 1;
    }

    async initialize() {
        await connectDB();
        if (!await loginToOdoo()) throw new Error('Login fallido a Odoo.');
        const configCollection = await getConfigCollection();
        const profitDoc = await configCollection.findOne({ key: 'profitMargin' });
        this.profitMargin = profitDoc ? profitDoc.value / 100 : 1;
    }

    async run() {
        const startTime = Date.now();
        await this.initialize();

        const products = await this.strategy.getProductList();
        let total = 0, uploaded = 0, errors = 0, updatedPrices = 0;;

        log(`🚀 Iniciando ejecución: ${this.strategy.getName()} - ${products.length} productos detectados.`);

        for (let i = 0; i < products.length; i++) {
            const product = products[i];
            const details = await this._fetchAndProcessProduct(product);

            if (details) {
                const currentProduct = await ScrapedProduct.findOne({ product_id: details.product_id });

                if (currentProduct) {
                    if (currentProduct.list_price !== details.list_price) {
                        details.priceUpdatedAt = new Date();
                        updatedPrices++;
                        if (ENABLE_LOGS) {
                            console.log(`💰 Cambio de precio lista: ${details.display_name} (${currentProduct.list_price} -> ${details.list_price})`);
                        }
                    } else {
                        details.priceUpdatedAt = currentProduct.priceUpdatedAt || currentProduct.updatedAt;
                    }
                } else {
                    details.priceUpdatedAt = new Date();
                }

                await ScrapedProduct.findOneAndUpdate(
                    { product_id: details.product_id },
                    details,
                    {
                        upsert: true,
                        runValidators: true
                    }
                );

                total++;
                if (details.image_url?.includes('cloudinary.com')) uploaded++;
            } else {
                errors++;
            }
            await delay(this.pageDelay);
        }

        const endTime = Date.now();
        const totalTime = endTime - startTime;

        const stats = {
            total,
            updatedPrices,
            errors,
            uploaded,
            processed: products.length,
            duration: totalTime
        };

        await logToFile({
            type: 'scraper_execution',
            strategy: this.strategy.getName(),
            timestamp: new Date(),
            stats
        });

        if (ENABLE_LOGS) {
            console.log(`📊 Stats: ${total} OK | ${updatedPrices} Precios Cambiados | ${errors} Errores`);
        }

        return stats;
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
                productId = cheerio.load(response.data)("input[name='product_id']").val();
            }
            if (!productId) return null;

            const apiData = await fetchProductDetailsFromAPI({
                product_id: productId,
                product_template_id: product.product_template_id,
                refererUrl: finalUrl,
            });

            if (!apiData) return null;

            return await processProductData({
                customProductId: customId,
                productApiData: apiData,
                imageUrl: extractImageUrl(apiData.carousel),
                categoryId: product.categoryId,
                categoryName: product.categoryName,
                profitMargin: this.profitMargin,
                collection: this.collection,
                sourceUrl: product.sourceUrl,
                brand: product.brand || null,
            });
        } catch (err) {
            log(`❌ Error detalle ${product.product_template_id}: ${err.message}`);
            return null;
        }
    }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    client, BASE_URL, loginToOdoo, analyzeSitemap, discoverCategories, getDiscoveredCategories,
    runCategoryScraper: async (opts) => new ScraperRunner({ ...opts, strategy: new CategoryProductStrategy(opts) }).run(),
    runSitemapScraper: async (opts) => new ScraperRunner({ ...opts, strategy: new SitemapProductStrategy(opts) }).run(),
    CategoryProductStrategy, SitemapProductStrategy, ScraperRunner
};