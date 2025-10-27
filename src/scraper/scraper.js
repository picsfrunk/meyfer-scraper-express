require('dotenv').config();
const cheerio = require('cheerio');
const xml2js = require('xml2js');
const https = require('https');
const http = require('http');

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

/**
 * ============================================================
 * SCRAPER PRINCIPAL - FLUJO DE USO
 * ============================================================
 *
 * 1. ANÁLISIS DE SITEMAP (ejecutar primero, una sola vez o periódicamente):
 *    const { analyzeSitemap } = require('./scrapers/scraper');
 *    await analyzeSitemap();
 *
 *    → Descarga sitemap.xml y guarda categorías/productos/marcas en MongoDB
 *
 * 2. SCRAPERS (ejecutar después del análisis):
 *
 *    A) Category Scraper - Scrapea por categorías específicas:
 *       const { runCategoryScraper } = require('./scrapers/scraper');
 *       await runCategoryScraper({
 *           collection,
 *           categoryIds: 'all',  // o un ID específico
 *           enableLogs: true
 *       });
 *
 *    B) Sitemap Scraper - Scrapea todos los productos del sitemap:
 *       const { runSitemapScraper } = require('./scrapers/scraper');
 *       await runSitemapScraper({
 *           collection,
 *           limitProducts: 10,  // opcional
 *           enableLogs: true
 *       });
 *
 * ============================================================
 */

// ============================================================
// AUTO-DISCOVERY DE CATEGORÍAS
// ============================================================

/**
 * Auto-descubre categorías y sus páginas scrapeando el sitemap y las páginas de categorías.
 * Esto reemplaza la necesidad de tener RUBROS hardcodeado.
 *
 * @returns {Promise<Array>} Array de categorías con { id, name, slug, pages }
 */
async function discoverCategories({ enableLogs = true } = {}) {
    try {
        // 1. Obtener categorías del sitemap (si existe)
        const sitemapCollection = await getSitemapCollection();
        let sitemapDoc = await sitemapCollection.findOne({});

        // Si no existe, analizar sitemap primero
        if (!sitemapDoc) {
            log('⚠️ No se encontró sitemap. Analizando...', enableLogs);
            await analyzeSitemap();
            sitemapDoc = await sitemapCollection.findOne({});
        }

        if (!sitemapDoc || !sitemapDoc.categories) {
            throw new Error('No se pudieron obtener categorías del sitemap');
        }

        const categories = sitemapDoc.categories;
        log(`📂 Categorías encontradas en sitemap: ${categories.length}`, enableLogs);

        // 2. Para cada categoría, descubrir cantidad de páginas
        const categoriesWithPages = [];

        for (const cat of categories) {
            log(`   🔍 Detectando páginas para: ${cat.name} (ID: ${cat.id})`, enableLogs);

            const pages = await detectCategoryPages(cat.id, cat.slug, enableLogs);

            categoriesWithPages.push({
                id: cat.id,
                name: cat.name,
                slug: cat.slug,
                pages: pages,
                products: cat.products || 0
            });

            log(`      ✅ ${cat.name}: ${pages} página(s)`, enableLogs);
        }

        log(`\n✅ Auto-discovery completado: ${categoriesWithPages.length} categorías`, enableLogs);

        // 3. Guardar en colección para uso futuro
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

/**
 * Detecta cuántas páginas tiene una categoría específica.
 * Estrategia optimizada: Ir a página 999, Odoo redirige a la última página automáticamente.
 *
 * @param {number} categoryId - ID de la categoría
 * @param {string} categorySlug - Slug de la categoría
 * @param {boolean} enableLogs - Habilitar logs
 * @returns {Promise<number>} Cantidad de páginas
 */
async function detectCategoryPages(categoryId, categorySlug, enableLogs = true) {
    try {
        // Estrategia: Pedir página 999, Odoo nos lleva a la última automáticamente
        const testUrl = `${BASE_URL}/shop/category/por-rubro-${categorySlug}-${categoryId}/page/999`;

        const response = await client.get(testUrl);
        const finalUrl = response.request?.res?.responseUrl || testUrl;
        const $ = cheerio.load(response.data);

        // DEBUG: Log de URL final
        log(`   🔍 DEBUG - URL solicitada: /page/999`, enableLogs);
        log(`   🔍 DEBUG - URL final: ${finalUrl}`, enableLogs);

        // Verificar que hay productos (no es una categoría vacía)
        const productsOnPage = $('form.oe_product_cart').length;
        log(`   🔍 DEBUG - Productos en página: ${productsOnPage}`, enableLogs);

        if (productsOnPage === 0) {
            return 1; // Categoría vacía
        }

        // Verificar si existe paginación
        const paginationExists = $('.pagination').length > 0;
        log(`   🔍 DEBUG - ¿Existe paginación?: ${paginationExists}`, enableLogs);

        if (!paginationExists) {
            log(`   🔍 DEBUG - No hay paginación → Retornando 1`, enableLogs);
            return 1;
        }

        // Estrategia 1: Buscar la página activa
        const activePage = $('.pagination li.page-item.active a.page-link').text().trim();
        log(`   🔍 DEBUG - Página activa (texto): "${activePage}"`, enableLogs);

        const activePageNum = parseInt(activePage);
        if (!isNaN(activePageNum) && activePageNum > 0) {
            log(`   🔍 DEBUG - Página activa válida → Retornando ${activePageNum}`, enableLogs);
            return activePageNum;
        }

        // Estrategia 2: Extraer de hrefs
        const pageNumbers = [];
        $('.pagination li.page-item:not(.disabled) a.page-link').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            log(`   🔍 DEBUG - Link encontrado: href="${href}", text="${text}"`, enableLogs);

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

        log(`   🔍 DEBUG - Números de página extraídos: [${pageNumbers.join(', ')}]`, enableLogs);

        if (pageNumbers.length > 0) {
            const maxPage = Math.max(...pageNumbers);
            log(`   🔍 DEBUG - Máxima página encontrada → Retornando ${maxPage}`, enableLogs);
            return maxPage;
        }

        // Estrategia 3: Verificar estado de botones
        const nextButtonDisabled = $('.pagination li.page-item.disabled .fa-chevron-right').length > 0;
        const prevButtonExists = $('.pagination li.page-item:not(.disabled) .fa-chevron-left').length > 0;

        log(`   🔍 DEBUG - Botón siguiente deshabilitado: ${nextButtonDisabled}`, enableLogs);
        log(`   🔍 DEBUG - Botón anterior existe: ${prevButtonExists}`, enableLogs);

        if (nextButtonDisabled && !prevButtonExists) {
            log(`   🔍 DEBUG - Solo hay 1 página → Retornando 1`, enableLogs);
            return 1;
        }

        log(`   🔍 DEBUG - No se pudo determinar, fallback → Retornando 1`, enableLogs);
        return 1;
    } catch (error) {
        log(`⚠️ Error detectando páginas para categoría ${categoryId}: ${error.message}`, enableLogs);
        return 1;
    }
}

/**
 * Obtiene las categorías auto-descubiertas (o las descubre si no existen).
 *
 * @param {boolean} forceRefresh - Forzar re-discovery incluso si existen
 * @returns {Promise<Array>} Array de categorías
 */
async function getDiscoveredCategories({ forceRefresh = false, enableLogs = true } = {}) {
    const configCollection = await getConfigCollection();

    if (!forceRefresh) {
        const cachedCategories = await configCollection.findOne({ key: 'discoveredCategories' });

        if (cachedCategories && cachedCategories.value) {
            log(`📂 Usando categorías cacheadas (${cachedCategories.value.length} categorías)`, enableLogs);
            return cachedCategories.value;
        }
    }

    log('🔍 Ejecutando auto-discovery de categorías...', enableLogs);
    return await discoverCategories({ enableLogs });
}

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
// ANALIZADOR DE SITEMAP
// ============================================================

async function analyzeSitemap() {
    const sitemapUrl = process.env.SITEMAP_URL;

    if (!sitemapUrl) {
        throw new Error('Falta variable de entorno: SITEMAP_URL');
    }

    try {
        log(`📥 Descargando sitemap desde: ${sitemapUrl}`);

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

        log(`📊 Procesando ${urls.length} URLs...`);

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
            products: productsByCategory[name] || 0
        }));

        const brandsArray = sortedBrands.map(([name, id]) => ({
            id,
            name,
            products: productsByBrand[name] || 0,
            urls: brands.filter(url => url.includes(name))
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

        // Usar la función de mongo.js
        const sitemapCollection = await getSitemapCollection();
        await sitemapCollection.replaceOne(
            { source: sitemapUrl },
            catalogDocument,
            { upsert: true }
        );

        log(`✅ Sitemap guardado en colección: ${process.env.SITEMAP_COLLECTION || 'sitemap_analysis'}`);
        log(`   📦 Productos: ${products.length}`);
        log(`   🏷️  Marcas: ${Object.keys(brandsData).length}`);
        log(`   🧰 Categorías: ${Object.keys(categoriesData).length}`);

        return catalogDocument;
    } catch (error) {
        log(`❌ Error analizando sitemap: ${error.message}`, true);
        throw error;
    }
}

// ============================================================
// ESTRATEGIAS
// ============================================================

class CategoryProductStrategy {
    constructor({ categoryIds = 'all', useAutoDiscovery = false, enableLogs = true } = {}) {
        this.categoryIds = categoryIds;
        this.useAutoDiscovery = useAutoDiscovery;
        this.enableLogs = enableLogs;
    }

    async getProductList() {
        let rubros;

        // Decidir si usar auto-discovery o RUBROS hardcodeado
        if (this.useAutoDiscovery) {
            log('🤖 Usando auto-discovery de categorías', this.enableLogs);
            const discoveredCategories = await getDiscoveredCategories({ enableLogs: this.enableLogs });

            rubros = this.categoryIds === 'all'
                ? discoveredCategories
                : discoveredCategories.filter(r => r.id === parseInt(this.categoryIds));
        } else {
            log('📋 Usando configuración manual de RUBROS', this.enableLogs);
            rubros = this.categoryIds === 'all'
                ? RUBROS
                : RUBROS.filter(r => r.id === parseInt(this.categoryIds));
        }

        if (!rubros.length) throw new Error('No se encontró ningún rubro válido.');

        const productList = [];

        for (const rubro of rubros) {
            log(`📦 Rubro: ${rubro.name} (${rubro.id})`, this.enableLogs);

            for (let page = 1; page <= rubro.pages; page++) {
                log(`➡ Página ${page}/${rubro.pages}`, this.enableLogs);

                const products = await this._fetchProducts(rubro.id, page, rubro.slug);
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

    async _fetchProducts(categoryId, page, slug = null) {
        // Construir URL usando slug si está disponible, sino usar el formato antiguo
        const urlPart = slug
            ? `por-rubro-${slug}-${categoryId}`
            : `por-rubro-xxx-${categoryId}`;

        const url = `${BASE_URL}/shop/category/${urlPart}/page/${page}`;

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

        // Si no existe el documento, analizar sitemap automáticamente
        if (!sitemapDoc) {
            log('⚠️ No se encontró documento de sitemap en DB. Ejecutando análisis automático...', this.enableLogs);

            try {
                await analyzeSitemap();
                log('✅ Análisis de sitemap completado', this.enableLogs);

                // Intentar obtener el documento nuevamente
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

        // Crear un mapa de categorías por slug para hacer matching
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

            // Intentar extraer categoría del slug del producto
            const slugMatch = url.match(/\/shop\/\d+-([a-z\-]+)/);
            let categoryId = categoryMatch ? parseInt(categoryMatch[1]) : null;
            let categoryName = null;

            // Si tenemos un slug, buscar en el mapa de categorías
            if (slugMatch && slugMatch[1] && this.categoriesMap) {
                const productSlugParts = slugMatch[1].split('-');

                // Intentar matchear con categorías conocidas
                for (const catSlug in this.categoriesMap) {
                    const catSlugParts = catSlug.split('-');
                    const matchCount = catSlugParts.filter(part =>
                        productSlugParts.includes(part)
                    ).length;

                    // Si hay match significativo
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

        log(`📋 Productos en sitemap: ${productList.length}`, this.enableLogs);

        const withCategory = productList.filter(p => p.categoryId).length;
        log(`📂 Productos con categoría detectada: ${withCategory}/${productList.length}`, this.enableLogs);

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
    const runner = new ScraperRunner({ ...options, strategy });
    return runner.run();
}

async function runSitemapScraper(options) {
    const strategy = new SitemapProductStrategy(options);
    const runner = new ScraperRunner({ ...options, strategy });
    return runner.run();
}

module.exports = {
    // Análisis
    analyzeSitemap,
    discoverCategories,

    getDiscoveredCategories,
    // Scrapers
    runCategoryScraper,
    runSitemapScraper,

    // Clases (por si se necesitan para extensión)
    CategoryProductStrategy,
    SitemapProductStrategy,
    ScraperRunner,
};