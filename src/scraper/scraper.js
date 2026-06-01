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
const { getConfigCollection, getScrapedCollection, getSitemapCollection } = require('../database/mongo');

// ============================================================
// CONFIGURACIÓN Y CLIENTE HTTP
// ============================================================

const BASE_URL = config.baseUrl;
const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;
const ENABLE_LOGS = process.env.ENABLE_LOGS === 'true';

// Cuántos upserts se acumulan antes de hacer un bulkWrite a MongoDB.
const BATCH_SIZE = 50;

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

function extractProductTemplateIdFromUrl(url) {
    const normalizedUrl = String(url).split(/[?#]/)[0].replace(/\/$/, '');
    const templateMatch = normalizedUrl.match(/-(\d+)$/);
    return templateMatch && templateMatch[1] ? templateMatch[1] : null;
}

function parseSitemapProductUrl(url) {
    const productId = extractProductIdFromUrl(url);
    const productTemplateId = extractProductTemplateIdFromUrl(url);

    if (!productId || !productTemplateId) return null;

    return {
        product_id: String(productId),
        product_template_id: String(productTemplateId),
        sourceUrl: url,
    };
}

function normalizeProductIdList(value) {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : String(value).split(',');
    return raw.map(id => String(id).trim()).filter(Boolean);
}

function normalizeTargetProducts(value) {
    if (!Array.isArray(value)) return [];

    return value
        .map(product => {
            if (!product || typeof product !== 'object') return null;
            const productId = product.product_id ?? product.productId;
            const productTemplateId = product.product_template_id ?? product.productTemplateId;

            if (!productId || !productTemplateId) return null;

            return {
                product_id: String(productId),
                product_template_id: String(productTemplateId),
                sourceUrl: product.sourceUrl || null,
                expectedName: product.name || product.expectedName || null,
            };
        })
        .filter(Boolean);
}

function categoryAuditLog(event, payload = {}) {
    console.log(`[category-audit] ${event} ${JSON.stringify(payload)}`);
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

async function processProductData({ customProductId, productApiData, imageUrl, categoryId, categoryName, profitMargin, sourceUrl, brand, existingImageUrl }) {
    try {
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
        content = content.replace('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"', '');

        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(content);
        const urls = result.urlset.url.map(url => url.loc[0].trim());

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
        const testUrl = `${BASE_URL}/shop/category/por-rubro-${categorySlug}-${categoryId}/page/999`;
        const response = await client.get(testUrl);
        const $ = cheerio.load(response.data);

        if ($('form.oe_product_cart').length === 0) return 1;
        if ($('.pagination').length === 0) return 1;

        const activePage = $('.pagination li.page-item.active a.page-link').text().trim();
        const activePageNum = parseInt(activePage);
        if (!isNaN(activePageNum) && activePageNum > 0) return activePageNum;

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
                    .sort((a, b) => b.name.length - a.name.length);
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

        const allRubros = this.useAutoDiscovery
            ? await getDiscoveredCategories()
            : require('../config/rubros');

        let rubrosToProcess = [];
        const isAll = !this.categoryIds || this.categoryIds === 'all';

        if (isAll) {
            rubrosToProcess = allRubros;
        } else {
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
            await analyzeSitemap();
            sitemapDoc = await sitemapCollection.findOne(query);
            if (!sitemapDoc) throw new Error('No se pudo obtener sitemap tras análisis.');
        }

        const urls = sitemapDoc.productUrls || [];
        if (!urls.length) throw new Error('No se encontraron URLs de productos en sitemap.');

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
    constructor({ strategy, collection, pageDelay, categoryDelay, signal }) {
        this.strategy = strategy;
        this.collection = collection;
        this.pageDelay = pageDelay || config.pageDelay;
        this.profitMargin = 1;
        this.existingImagesMap = new Map();
        // signal: objeto { cancelled: false } compartido con scraperQueue.
        // cancelJob() lo muta a { cancelled: true } para interrumpir el loop.
        this.signal = signal ?? null;
    }

    async initialize() {
        if (!await loginToOdoo()) throw new Error('Login fallido a Odoo.');

        const configCollection = await getConfigCollection();
        const profitDoc = await configCollection.findOne({ key: 'profitMargin' });
        this.profitMargin = profitDoc ? profitDoc.value / 100 : 1;

        log('🗄️  Cargando imágenes existentes desde la DB...');
        const existing = await this.collection
            .find({}, { projection: { product_id: 1, image_url: 1 } })
            .toArray();
        existing.forEach(p => {
            if (p.product_id) this.existingImagesMap.set(String(p.product_id), p.image_url || null);
        });
        log(`✅ ${this.existingImagesMap.size} productos existentes cargados en memoria.`);
    }

    async run() {
        const startTime = Date.now();
        await this.initialize();

        const products = await this.strategy.getProductList();
        let total = 0, uploaded = 0, errors = 0, orphansDeleted = 0;

        log(`🚀 Iniciando ejecución: ${this.strategy.getName()} - ${products.length} productos detectados.`);

        let batch = [];
        const scrapedIds = new Set();

        for (let i = 0; i < products.length; i++) {

            // ── Chequeo de cancelación ──────────────────────────────────
            // Si cancelJob() activó el signal, hacer flush del batch parcial
            // y salir del loop limpiamente antes de procesar el siguiente producto.
            if (this.signal?.cancelled) {
                log('\n🛑 Cancelación solicitada — deteniendo scraper.');
                if (batch.length > 0) {
                    await this.collection.bulkWrite(batch, { ordered: false });
                    total += batch.length;
                    log(`💾 Flush parcial: ${batch.length} productos guardados antes de cancelar.`);
                    batch = [];
                }
                break;
            }
            // ────────────────────────────────────────────────────────────

            const product = products[i];

            const details = await this._fetchAndProcessProduct(product);

            if (details) {
                scrapedIds.add(String(details.product_id));

                batch.push({
                    updateOne: {
                        filter: { product_id: details.product_id },
                        update: { $set: details },
                        upsert: true,
                    }
                });

                if (details.image_url?.includes('cloudinary.com')) uploaded++;

                this.existingImagesMap.set(String(details.product_id), details.image_url);
            } else {
                errors++;
            }

            // Flush: cuando el batch está lleno, o al llegar al último producto.
            const isLast = i === products.length - 1;
            if (batch.length >= BATCH_SIZE || (isLast && batch.length > 0)) {
                await this.collection.bulkWrite(batch, { ordered: false });
                total += batch.length;
                log(`💾 Batch guardado: ${total}/${products.length} productos.`);
                batch = [];
            }

            await delay(this.pageDelay);
        }

        // ── Limpieza de huérfanos ──────────────────────────────────────────
        // Solo se ejecuta en corridas completas (categoryIds === 'all') y cuando
        // el scraper NO fue cancelado (una corrida cancelada es parcial por definición).
        const isFullRun = !this.strategy.categoryIds || this.strategy.categoryIds === 'all';
        const wasCancelled = this.signal?.cancelled ?? false;

        if (isFullRun && !wasCancelled) {
            const orphanIds = [...this.existingImagesMap.keys()].filter(id => !scrapedIds.has(id));

            if (orphanIds.length) {
                log(`🧹 Eliminando ${orphanIds.length} productos huérfanos (presentes en DB pero ausentes en Odoo)...`);
                await this.collection.deleteMany({ product_id: { $in: orphanIds } });
                orphansDeleted = orphanIds.length;
                log(`✅ ${orphansDeleted} huérfanos eliminados.`);
            } else {
                log('✅ Sin productos huérfanos. DB sincronizada con Odoo.');
            }
        } else if (wasCancelled) {
            log('⚠️  Corrida cancelada: limpieza de huérfanos omitida.');
        } else {
            log('⚠️  Corrida parcial: limpieza de huérfanos omitida para evitar falsos positivos.');
        }
        // ─────────────────────────────────────────────────────────────────────

        const endTime = Date.now();
        const totalTime = endTime - startTime;

        const logData = {
            type: 'scraper_execution',
            strategy: this.strategy.getName(),
            timestamp: new Date(),
            stats: {
                productsProcessed: products.length,
                savedSuccessfully: total,
                imagesUploaded: uploaded,
                errors: errors,
                orphansDeleted: orphansDeleted,
                cancelled: wasCancelled,
                duration: totalTime,
                durationFormatted: formatTime(totalTime)
            }
        };

        await logToFile(logData);

        if (ENABLE_LOGS) {
            console.log('\n' + '='.repeat(60));
            console.log(wasCancelled ? '🛑 SCRAPER CANCELADO' : '✅ SCRAPER FINALIZADO');
            console.log(`📊 Stats: ${total} OK | ${errors} Errores | ${uploaded} Imágenes | 🧹 ${orphansDeleted} Huérfanos | ${formatTime(totalTime)}`);
            console.log('='.repeat(60) + '\n');
        }

        return { total, errors, uploaded, orphansDeleted, processed: products.length, duration: totalTime };
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

            const existingImageUrl = this.existingImagesMap.get(String(customId)) ?? null;

            return await processProductData({
                customProductId: customId,
                productApiData: apiData,
                imageUrl: extractImageUrl(apiData.carousel),
                categoryId: product.categoryId,
                categoryName: product.categoryName,
                profitMargin: this.profitMargin,
                sourceUrl: product.sourceUrl,
                brand: product.brand || null,
                existingImageUrl,
            });
        } catch (err) {
            log(`❌ Error detalle ${product.product_template_id}: ${err.message}`);
            return null;
        }
    }
}

// ============================================================
// AUDITORÍA NO DESTRUCTIVA DE COBERTURA CATEGORY VS SITEMAP
// ============================================================

async function auditCategoryCoverage({
    categoryIds = 'all',
    useAutoDiscovery = true,
    targetProductIds = [],
    targetProducts = [],
    pageDelay = 0,
    collection = null,
    includeMongo = true,
    forceRefreshSitemap = false,
} = {}) {
    if (!await loginToOdoo()) throw new Error('Login fallido a Odoo.');

    const sitemapCollection = await getSitemapCollection();
    const sitemapQuery = process.env.SITEMAP_URL ? { source: process.env.SITEMAP_URL } : {};
    let sitemapDoc = forceRefreshSitemap ? null : await sitemapCollection.findOne(sitemapQuery);
    if (!sitemapDoc) sitemapDoc = await analyzeSitemap();

    const sitemapProducts = (sitemapDoc.productUrls || [])
        .map(parseSitemapProductUrl)
        .filter(Boolean);

    const sitemapByProductId = new Map(sitemapProducts.map(p => [p.product_id, p]));
    let mongoProductIds = null;
    if (includeMongo) {
        const scrapedCollection = collection || await getScrapedCollection();
        const persistedProducts = await scrapedCollection
            .find({}, { projection: { product_id: 1 } })
            .toArray();
        mongoProductIds = new Set(persistedProducts.map(p => String(p.product_id)).filter(Boolean));
    }

    const explicitTargets = new Set(normalizeProductIdList(targetProductIds));
    const externalTargets = normalizeTargetProducts(targetProducts);
    const externalTargetByProductId = new Map(externalTargets.map(p => [p.product_id, p]));
    const missingInMongo = mongoProductIds
        ? sitemapProducts.filter(p => !mongoProductIds.has(p.product_id)).map(p => p.product_id)
        : [];
    const targetIds = explicitTargets.size || externalTargets.length
        ? [...new Set([...externalTargets.map(p => p.product_id), ...explicitTargets])]
        : missingInMongo;

    categoryAuditLog('sitemap_loaded', {
        totalProducts: sitemapProducts.length,
        targetProducts: targetIds.length,
        source: sitemapDoc.source,
    });

    const strategy = new CategoryProductStrategy({ categoryIds, useAutoDiscovery });
    const categoryProducts = await strategy.getProductList();

    const categoryByTemplateId = new Map();
    for (const product of categoryProducts) {
        const templateId = String(product.product_template_id);
        if (!categoryByTemplateId.has(templateId)) categoryByTemplateId.set(templateId, []);
        categoryByTemplateId.get(templateId).push(product);
    }

    const sitemapNotInCategoryPages = sitemapProducts
        .filter(p => !categoryByTemplateId.has(p.product_template_id))
        .map(p => p.product_id);

    const mongoNotInSitemap = mongoProductIds
        ? [...mongoProductIds].filter(id => !sitemapByProductId.has(id))
        : [];

    categoryAuditLog('category_pages_loaded', {
        totalProducts: categoryProducts.length,
        uniqueTemplates: categoryByTemplateId.size,
        sitemapNotInCategoryPages: sitemapNotInCategoryPages.length,
    });

    const auditedProducts = [];
    const idsToAudit = targetIds.length ? targetIds : sitemapNotInCategoryPages;

    for (const productId of idsToAudit) {
        const sitemapProduct = sitemapByProductId.get(String(productId)) || externalTargetByProductId.get(String(productId));
        if (!sitemapProduct) {
            auditedProducts.push({
                product_id: String(productId),
                status: 'not_found_in_sitemap',
                reason: 'El product_id solicitado no está en el sitemap analizado y no incluye product_template_id externo para auditar categoría.',
            });
            categoryAuditLog('not_found_in_sitemap', { product_id: String(productId) });
            continue;
        }

        const inSitemap = sitemapByProductId.has(sitemapProduct.product_id);
        const categoryMatches = categoryByTemplateId.get(sitemapProduct.product_template_id) || [];
        if (!categoryMatches.length) {
            const auditRecord = {
                ...sitemapProduct,
                status: 'found_in_sitemap_not_in_category_pages',
                reason: inSitemap
                    ? 'El template del sitemap no aparece en ningún form.oe_product_cart recorrido por CategoryProductStrategy.'
                    : 'El template informado para el target no aparece en ningún form.oe_product_cart recorrido por CategoryProductStrategy.',
                inSitemap,
                inMongo: mongoProductIds ? mongoProductIds.has(sitemapProduct.product_id) : null,
            };
            auditedProducts.push(auditRecord);
            categoryAuditLog('found_in_sitemap_not_in_category_pages', {
                product_id: sitemapProduct.product_id,
                product_template_id: sitemapProduct.product_template_id,
                sourceUrl: sitemapProduct.sourceUrl,
            });
            continue;
        }

        const categoryProduct = categoryMatches[0];
        categoryAuditLog('found_in_category_page', {
            product_id: sitemapProduct.product_id,
            product_template_id: sitemapProduct.product_template_id,
            category_id: categoryProduct.categoryId,
            category_name: categoryProduct.categoryName,
        });

        const auditRecord = {
            ...sitemapProduct,
            status: 'found_in_category_page',
            reason: 'Aparece en páginas de categoría; se valida detalle y get_combination_info sin persistir.',
            inSitemap,
            inMongo: mongoProductIds ? mongoProductIds.has(sitemapProduct.product_id) : null,
            category_id: categoryProduct.categoryId,
            category_name: categoryProduct.categoryName,
            category_page_product_id: String(categoryProduct.product_id),
            display_name_from_category: categoryProduct.display_name || null,
        };

        try {
            const productUrl = `${BASE_URL}/shop/${categoryProduct.product_template_id}`;
            const response = await client.get(productUrl);
            const finalUrl = response.request?.res?.responseUrl || productUrl;
            const customId = extractProductIdFromUrl(finalUrl);

            auditRecord.resolved_url = finalUrl;
            auditRecord.resolved_product_id = customId;

            if (!customId) {
                auditRecord.status = 'detail_fetch_failed';
                auditRecord.reason = 'El detalle respondió, pero la URL final no contiene product_id scrapeable.';
                categoryAuditLog('detail_fetch_failed', {
                    product_template_id: sitemapProduct.product_template_id,
                    reason: auditRecord.reason,
                    resolved_url: finalUrl,
                });
                auditedProducts.push(auditRecord);
                continue;
            }

            let apiProductId = categoryProduct.product_id;
            if (!apiProductId) {
                apiProductId = cheerio.load(response.data)("input[name='product_id']").val();
            }

            if (!apiProductId) {
                auditRecord.status = 'skipped_before_upsert';
                auditRecord.reason = 'No se encontró input product_id en categoría ni en detalle; el runner retornaría null antes del upsert.';
                categoryAuditLog('skipped_before_upsert', {
                    product_id: sitemapProduct.product_id,
                    product_template_id: sitemapProduct.product_template_id,
                    reason: auditRecord.reason,
                });
                auditedProducts.push(auditRecord);
                continue;
            }

            const apiData = await fetchProductDetailsFromAPI({
                product_id: apiProductId,
                product_template_id: categoryProduct.product_template_id,
                refererUrl: finalUrl,
            });

            if (!apiData) {
                auditRecord.status = 'combination_info_failed';
                auditRecord.reason = 'get_combination_info no devolvió result; el runner no llegaría al upsert.';
                categoryAuditLog('combination_info_failed', {
                    product_id: sitemapProduct.product_id,
                    product_template_id: sitemapProduct.product_template_id,
                    api_product_id: String(apiProductId),
                });
                auditedProducts.push(auditRecord);
                continue;
            }

            auditRecord.status = mongoProductIds?.has(sitemapProduct.product_id)
                ? 'persisted'
                : 'would_reach_upsert_but_missing_in_mongo';
            auditRecord.reason = mongoProductIds?.has(sitemapProduct.product_id)
                ? 'El producto aparece en categoría, resuelve detalle/API y está persistido en Mongo.'
                : 'El producto aparece en categoría y resuelve detalle/API; no se detecta un descarte no destructivo antes del upsert.';
            auditRecord.api_display_name = apiData.display_name || null;
            auditRecord.api_product_type = apiData.product_type || null;
            auditedProducts.push(auditRecord);
        } catch (error) {
            auditRecord.status = 'detail_fetch_failed';
            auditRecord.reason = error.message;
            auditedProducts.push(auditRecord);
            categoryAuditLog('detail_fetch_failed', {
                product_id: sitemapProduct.product_id,
                product_template_id: sitemapProduct.product_template_id,
                error: error.message,
            });
        }

        if (pageDelay > 0) await delay(pageDelay);
    }

    const statusCounts = auditedProducts.reduce((acc, product) => {
        acc[product.status] = (acc[product.status] || 0) + 1;
        return acc;
    }, {});
    const targetProductsNotInSitemap = auditedProducts.filter(product => product.inSitemap === false).length;

    return {
        generatedAt: new Date().toISOString(),
        strategy: strategy.getName(),
        summary: {
            sitemapProducts: sitemapProducts.length,
            categoryPageProducts: categoryProducts.length,
            uniqueCategoryTemplates: categoryByTemplateId.size,
            sitemapNotInCategoryPages: sitemapNotInCategoryPages.length,
            sitemapNotInMongo: missingInMongo.length,
            mongoNotInSitemap: mongoNotInSitemap.length,
            auditedProducts: auditedProducts.length,
            targetProductsNotInSitemap,
            statusCounts,
        },
        sitemapNotInCategoryPages,
        sitemapNotInMongo: missingInMongo,
        mongoNotInSitemap,
        auditedProducts,
        comparedBy: {
            sitemapVsCategoryPages: 'product_template_id, mapped back to sitemap product_id',
            sitemapVsMongo: 'product_id',
            detailValidation: 'resolved product_id from final detail URL',
        },
        note: 'Auditoría no destructiva: no ejecuta upserts, deletes ni procesamiento/subida de imágenes.',
    };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    client, BASE_URL, loginToOdoo, analyzeSitemap, discoverCategories, getDiscoveredCategories,
    runCategoryScraper: async (opts) => new ScraperRunner({ ...opts, strategy: new CategoryProductStrategy(opts) }).run(),
    runSitemapScraper:  async (opts) => new ScraperRunner({ ...opts, strategy: new SitemapProductStrategy(opts) }).run(),
    auditCategoryCoverage,
    CategoryProductStrategy, SitemapProductStrategy, ScraperRunner
};
