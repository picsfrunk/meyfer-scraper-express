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
const { getConfigCollection, getSitemapCollection } = require('../database/mongo');

// ============================================================
// CONFIGURACIÓN Y CLIENTE HTTP
// ============================================================

const BASE_URL = config.baseUrl;
const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;

const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

// ============================================================
// UTILIDADES
// ============================================================

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

function log(message, enableLogs = true) {
    if (enableLogs) {
        logToFile(message);
    }
}

async function fetchSitemap(url) {
    return new Promise((resolve, reject) => {
        const httpClient = url.startsWith('https') ? https : http;
        httpClient.get(url, (res) => {
            let data = '';
            if (res.statusCode === 301 || res.statusCode === 302) {
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
            params: {
                db: ODOO_DB,
                login: ODOO_USER,
                password: ODOO_PASS,
            },
        }, {
            headers: { 'Content-Type': 'application/json' },
        });

        if (res.data.result?.uid) {
            return true;
        } else {
            logToFile('❌ Falló el login.');
            return false;
        }
    } catch (err) {
        logToFile(`❌ Error durante login: ${err.message}`);
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
            {
                headers: {
                    'Content-Type': 'application/json',
                    Referer: refererUrl,
                },
            }
        );

        return response.data.result;
    } catch (error) {
        logToFile(`❌ Error obteniendo detalles del API para product_id ${product_id}: ${error.message}`);
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

async function processProductData({
                                      customProductId,
                                      productApiData,
                                      imageUrl,
                                      categoryId = null,
                                      categoryName = null,
                                      profitMargin,
                                      collection,
                                      sourceUrl = null,
                                      brand = null
                                  }) {
    try {
        const existingProduct = await collection.findOne({
            product_id: customProductId
        });
        const existingImageUrl = existingProduct?.image_url || null;

        const cloudinaryImageUrl = await processProductImage(
            imageUrl,
            customProductId,
            existingImageUrl
        );

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

        if (sourceUrl) {
            productData.source_url = sourceUrl;
        }

        return productData;
    } catch (error) {
        await logToFile(`❌ Error procesando datos del producto ${customProductId}: ${error.message}`);
        return null;
    }
}

// ============================================================
// ANÁLISIS DE SITEMAP
// ============================================================

async function analyzeSitemap() {
    const sitemapUrl = process.env.SITEMAP_URL;

    if (!sitemapUrl) {
        throw new Error('Falta variable de entorno: SITEMAP_URL');
    }

    try {
        let content = await fetchSitemap(sitemapUrl);
        content = content.replace('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"', '');

        const parser = new xml2js.Parser();
        const result = await parser.parseStringPromise(content);
        const urls = result.urlset.url.map(url => url.loc[0].trim());

        const products = [];
        const brands = [];
        const categoriesData = {};
        const brandsData = {};
        const productsByCategory = {};
        const productsByBrand = {};

        const productPattern = /\/shop\/[A-Za-z0-9\-]+/i;
        const brandPattern = /\/shop\/category\/por-marca-?([A-Za-z0-9\-]*)/i;
        const categoryPattern = /\/shop\/category\/por-rubro-([A-Za-z0-9\-]+)/i;

        for (const url of urls) {
            if (
                url.includes('/shop/') &&
                !url.includes('/shop/category/') &&
                !url.replace(/\/$/, '').endsWith('/shop') &&
                productPattern.test(url)
            ) {
                products.push(url);
                try {
                    const slug = url.split('/shop/')[1];
                    const matchCategoryProduct = slug.match(/^([A-Za-z\-]+)-\d+/);
                    if (matchCategoryProduct) {
                        const categoryName = matchCategoryProduct[1];
                        productsByCategory[categoryName] = (productsByCategory[categoryName] || 0) + 1;
                    }
                } catch (_) {}
                for (const brandSlug in brandsData) {
                    if (url.includes(brandSlug)) {
                        productsByBrand[brandSlug] = (productsByBrand[brandSlug] || 0) + 1;
                    }
                }
            } else if (brandPattern.test(url)) {
                const match = url.match(brandPattern);
                const brandSlug = match[1];
                if (!brandSlug) continue;

                const parts = brandSlug.split('-');
                let brandId = null;
                let brandName = brandSlug;

                if (parts.length > 1 && !isNaN(parts[parts.length - 1])) {
                    brandId = parseInt(parts[parts.length - 1]);
                    brandName = parts.slice(0, -1).join('-');
                }

                brandsData[brandName] = brandId;
                brands.push(url);
            } else if (categoryPattern.test(url)) {
                const match = url.match(categoryPattern);
                const categorySlug = match[1];
                if (!isNaN(categorySlug)) continue;

                const parts = categorySlug.split('-');
                let categoryId = null;
                let categoryName = categorySlug;

                if (parts.length > 1 && !isNaN(parts[parts.length - 1])) {
                    categoryId = parseInt(parts[parts.length - 1]);
                    categoryName = parts.slice(0, -1).join('-');
                }

                categoriesData[categoryName] = categoryId;
            }
        }

        const sortedCategories = Object.entries(categoriesData).sort((a, b) => (a[1] || 0) - (b[1] || 0));
        const sortedBrands = Object.entries(brandsData).sort((a, b) => (a[1] || 0) - (b[1] || 0));

        const categoriesArray = sortedCategories.map(([name, id]) => ({
            id,
            name: name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('/'),
            slug: name,
            products: productsByCategory[name] || 0,
        }));

        const brandsArray = sortedBrands.map(([slug, id]) => ({
            id,
            slug,
            name: slug
                .split('-')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                .join(' '),
            products: productsByBrand[slug] || 0,
            urls: brands.filter(url => url.includes(slug))
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
        await sitemapCollection.replaceOne(
            { source: sitemapUrl },
            catalogDocument,
            { upsert: true }
        );

        return catalogDocument;
    } catch (error) {
        log(`❌ Error analizando sitemap: ${error.message}`, true);
        throw error;
    }
}

// ============================================================
// AUTO-DISCOVERY DE CATEGORÍAS
// ============================================================

async function detectCategoryPages(categoryId, categorySlug, enableLogs = true) {
    try {
        const testUrl = `${BASE_URL}/shop/category/por-rubro-${categorySlug}-${categoryId}/page/999`;

        const response = await client.get(testUrl);
        const $ = cheerio.load(response.data);

        const productsOnPage = $('form.oe_product_cart').length;

        if (productsOnPage === 0) {
            return 1;
        }

        const paginationExists = $('.pagination').length > 0;

        if (!paginationExists) {
            return 1;
        }

        const activePage = $('.pagination li.page-item.active a.page-link').text().trim();
        const activePageNum = parseInt(activePage);
        if (!isNaN(activePageNum) && activePageNum > 0) {
            return activePageNum;
        }

        const pageNumbers = [];
        $('.pagination li.page-item:not(.disabled) a.page-link').each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
                const match = href.match(/\/page\/(\d+)/);
                if (match) {
                    const pageNum = parseInt(match[1]);
                    if (!isNaN(pageNum)) {
                        pageNumbers.push(pageNum);
                    }
                }
            }
        });

        if (pageNumbers.length > 0) {
            return Math.max(...pageNumbers);
        }

        return 1;
    } catch (error) {
        log(`⚠️ Error detectando páginas para categoría ${categoryId}: ${error.message}`, enableLogs);
        return 1;
    }
}

async function discoverCategories({ enableLogs = true } = {}) {
    try {
        const sitemapCollection = await getSitemapCollection();
        let sitemapDoc = await sitemapCollection.findOne({});

        if (!sitemapDoc) {
            await analyzeSitemap();
            sitemapDoc = await sitemapCollection.findOne({});
        }

        if (!sitemapDoc || !sitemapDoc.categories) {
            throw new Error('No se pudieron obtener categorías del sitemap');
        }

        const categories = sitemapDoc.categories;
        const categoriesWithPages = [];

        for (const cat of categories) {
            const pages = await detectCategoryPages(cat.id, cat.slug, enableLogs);

            categoriesWithPages.push({
                id: cat.id,
                name: cat.name,
                slug: cat.slug,
                pages: pages,
                products: cat.products || 0
            });
        }

        await sitemapCollection.updateOne(
            { source: sitemapDoc.source },
            {
                $set: {
                    categories: categoriesWithPages,
                    'summary.lastPageDiscovery': new Date()
                }
            }
        );

        const configCollection = await getConfigCollection();
        await configCollection.updateOne(
            { key: 'discoveredCategories' },
            {
                $set: {
                    value: categoriesWithPages,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );

        return categoriesWithPages;
    } catch (error) {
        log(`❌ Error en auto-discovery: ${error.message}`, enableLogs);
        throw error;
    }
}

async function getDiscoveredCategories({ forceRefresh = false, enableLogs = true } = {}) {
    const sitemapCollection = await getSitemapCollection();

    if (!forceRefresh) {
        const sitemapDoc = await sitemapCollection.findOne({});

        if (sitemapDoc && sitemapDoc.categories && sitemapDoc.categories.length > 0) {
            const hasPageInfo = sitemapDoc.categories.some(cat => cat.pages !== undefined);

            if (hasPageInfo) {
                return sitemapDoc.categories;
            }
        }

        const configCollection = await getConfigCollection();
        const cachedCategories = await configCollection.findOne({ key: 'discoveredCategories' });

        if (cachedCategories && cachedCategories.value) {
            return cachedCategories.value;
        }
    }

    return await discoverCategories({ enableLogs });
}

// ============================================================
// ESTRATEGIAS DE SCRAPING
// ============================================================

class CategoryProductStrategy {
    constructor({ categoryIds = 'all', useAutoDiscovery = true, enableLogs = true } = {}) {
        this.categoryIds = categoryIds;
        this.useAutoDiscovery = useAutoDiscovery;
        this.enableLogs = enableLogs;
        this.brandsCache = null;
    }

    async _loadBrands() {
        if (this.brandsCache) return this.brandsCache;

        try {
            const sitemapCollection = await getSitemapCollection();
            const sitemapDoc = await sitemapCollection.findOne({});

            if (sitemapDoc && sitemapDoc.brands) {
                this.brandsCache = sitemapDoc.brands
                    .filter(b => b.name && b.id !== null)
                    .map(b => ({
                        name: b.name,
                        slug: b.slug,
                        id: b.id
                    }))
                    .sort((a, b) => b.name.length - a.name.length);

                log(`✅ Cargadas ${this.brandsCache.length} marcas para matching`, this.enableLogs);
            } else {
                this.brandsCache = [];
                log(`⚠️ No se encontraron marcas en sitemap_analysis`, this.enableLogs);
            }
        } catch (error) {
            log(`⚠️ Error cargando marcas: ${error.message}`, this.enableLogs);
            this.brandsCache = [];
        }

        return this.brandsCache;
    }

    _extractBrandFromProductName(productName) {
        if (!productName || !this.brandsCache || this.brandsCache.length === 0) {
            return null;
        }

        const normalizedName = productName.toLowerCase().trim();

        for (const brand of this.brandsCache) {
            const brandLower = brand.name.toLowerCase();
            const regex = new RegExp(`\\b${brandLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

            if (regex.test(normalizedName)) {
                return brand.name;
            }
        }

        return null;
    }

    async getProductList() {
        await this._loadBrands();

        let rubros;

        if (this.useAutoDiscovery) {
            const discoveredCategories = await getDiscoveredCategories({ enableLogs: this.enableLogs });

            rubros = this.categoryIds === 'all'
                ? discoveredCategories
                : discoveredCategories.filter(r => r.id === parseInt(this.categoryIds));
        } else {
            const RUBROS = require('../config/rubros');
            rubros = this.categoryIds === 'all'
                ? RUBROS
                : RUBROS.filter(r => r.id === parseInt(this.categoryIds));
        }

        if (!rubros.length) throw new Error('No se encontró ningún rubro válido.');

        const productList = [];

        for (const rubro of rubros) {
            for (let page = 1; page <= rubro.pages; page++) {
                const products = await this._fetchProducts(rubro.id, page, rubro.slug);
                for (const p of products) {
                    productList.push({
                        ...p,
                        categoryId: rubro.id,
                        categoryName: rubro.name,
                        brand: p.brand || null
                    });
                }
            }
        }

        return productList;
    }

    async _fetchProducts(categoryId, page, slug = null) {
        const urlPart = slug
            ? `por-rubro-${slug}-${categoryId}`
            : `por-rubro-xxx-${categoryId}`;

        const url = `${BASE_URL}/shop/category/${urlPart}/page/${page}`;

        try {
            const res = await client.get(url);
            const $ = cheerio.load(res.data);

            return $('form.oe_product_cart').map((_, el) => {
                const $form = $(el);

                const productId = $form.find("input[name='product_id']").val();
                const productTemplateId = $form.find("input[name='product_template_id']").val();

                let productName = null;
                const nameSelectors = [
                    '.o_wsale_product_name',
                    'h6.card-title',
                    '.product-name',
                    'h6',
                    '.card-body h6'
                ];

                for (const selector of nameSelectors) {
                    const nameEl = $form.closest('.oe_product, .o_wsale_product_grid_wrapper').find(selector);
                    if (nameEl.length) {
                        productName = nameEl.text().trim();
                        break;
                    }
                }

                const brand = this._extractBrandFromProductName(productName);

                return {
                    product_id: productId,
                    product_template_id: productTemplateId,
                    brand: brand,
                    display_name: productName
                };
            }).get().filter(p => p.product_id && p.product_template_id);

        } catch (error) {
            log(`❌ Error en rubro ${categoryId}, página ${page}: ${error.message}`, this.enableLogs);
            return [];
        }
    }

    getName() {
        const mode = this.useAutoDiscovery ? 'Auto-discovery' : 'Manual';
        return `Category Scraper [${mode}] (${this.categoryIds === 'all' ? 'Todas' : `ID ${this.categoryIds}`})`;
    }
}

class SitemapProductStrategy {
    constructor({ sitemapSource = null, limitProducts = null, enableLogs = true } = {}) {
        this.sitemapSource = sitemapSource;
        this.limitProducts = limitProducts;
        this.enableLogs = enableLogs;
        this.categoriesMap = null;
    }

    async getProductList() {
        const sitemapCollection = await getSitemapCollection();
        const query = this.sitemapSource ? { source: this.sitemapSource } : {};
        let sitemapDoc = await sitemapCollection.findOne(query);

        if (!sitemapDoc) {
            try {
                await analyzeSitemap();
                sitemapDoc = await sitemapCollection.findOne(query);

                if (!sitemapDoc) {
                    throw new Error('No se pudo crear el documento de sitemap después del análisis');
                }
            } catch (error) {
                throw new Error(`Error al analizar sitemap: ${error.message}`);
            }
        }

        const urls = sitemapDoc.productUrls || [];
        if (!urls.length) throw new Error('No se encontraron URLs de productos.');

        this.categoriesMap = {};
        if (sitemapDoc.categories && Array.isArray(sitemapDoc.categories)) {
            sitemapDoc.categories.forEach(cat => {
                if (cat.slug) {
                    this.categoriesMap[cat.slug] = {
                        id: cat.id,
                        name: cat.name
                    };
                }
            });
        }

        const selectedUrls = this.limitProducts ? urls.slice(0, this.limitProducts) : urls;

        const productList = selectedUrls.map(url => {
            const templateMatch = url.match(/-(\d+)$/);
            const categoryMatch = url.match(/\?category=(\d+)/);

            const slugMatch = url.match(/\/shop\/\d+-([a-z\-]+)/);
            let categoryId = categoryMatch ? parseInt(categoryMatch[1]) : null;
            let categoryName = null;

            if (slugMatch && slugMatch[1] && this.categoriesMap) {
                const productSlugParts = slugMatch[1].split('-');

                for (const catSlug in this.categoriesMap) {
                    const catSlugParts = catSlug.split('-');
                    const matchCount = catSlugParts.filter(part =>
                        productSlugParts.includes(part)
                    ).length;

                    if (matchCount > 0) {
                        categoryId = this.categoriesMap[catSlug].id;
                        categoryName = this.categoriesMap[catSlug].name;
                        break;
                    }
                }
            }

            return {
                product_template_id: templateMatch ? Number(templateMatch[1]) : null,
                product_id: null,
                sourceUrl: url,
                categoryId: categoryId,
                categoryName: categoryName,
            };
        }).filter(p => p.product_template_id);

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
    }

    async run() {
        await this.initialize();
        const products = await this.strategy.getProductList();
        let total = 0, uploaded = 0, errors = 0;

        for (let i = 0; i < products.length; i++) {
            const product = products[i];

            const details = await this._fetchAndProcessProduct(product);
            if (details) {
                await this.collection.updateOne(
                    { product_id: details.product_id },
                    { $set: details },
                    { upsert: true }
                );
                total++;
                if (details.image_url?.includes('cloudinary.com')) uploaded++;
            } else {
                errors++;
            }

            await delay(this.pageDelay);
        }

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
                productId = $("input[name='product_id']").val();
                if (!productId) return null;
            }

            const apiData = await fetchProductDetailsFromAPI({
                product_id: productId,
                product_template_id: product.product_template_id,
                refererUrl: finalUrl,
            });

            if (!apiData) return null;

            const imageUrl = extractImageUrl(apiData.carousel);
            return await processProductData({
                customProductId: customId,
                productApiData: apiData,
                imageUrl,
                categoryId: product.categoryId,
                categoryName: product.categoryName,
                profitMargin: this.profitMargin,
                collection: this.collection,
                sourceUrl: product.sourceUrl,
                brand: product.brand || null,
            });
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
    const runner = new ScraperRunner({ ...options, strategy });
    return runner.run();
}

async function runSitemapScraper(options) {
    const strategy = new SitemapProductStrategy(options);
    const runner = new ScraperRunner({ ...options, strategy });
    return runner.run();
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Cliente HTTP
    client,
    BASE_URL,

    // Autenticación
    loginToOdoo,

    // Análisis
    analyzeSitemap,
    discoverCategories,
    getDiscoveredCategories,

    // Scrapers
    runCategoryScraper,
    runSitemapScraper,

    // Clases
    CategoryProductStrategy,
    SitemapProductStrategy,
    ScraperRunner,

    // Utilidades (por compatibilidad)
    extractProductIdFromUrl,
    fetchProductDetailsFromAPI,
    extractImageUrl,
    extractBrand,
    processProductData,
};