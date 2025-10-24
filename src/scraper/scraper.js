require('dotenv').config();
const config = require('../config/config');
const cheerio = require('cheerio');
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

const delay = ms => new Promise(res => setTimeout(res, ms));

const DEFAULT_PAGE_DELAY_MS = config.pageDelay;
const DEFAULT_CATEGORY_DELAY_MS = config.categoryDelay;
const RUBROS = require('../config/rubros');

// ============================================================================
// ESTRATEGIAS DE OBTENCIÓN DE PRODUCTOS
// ============================================================================

/**
 * Estrategia: Obtener productos desde páginas de categorías
 */
class CategoryProductStrategy {
    constructor(categoryIds = 'all') {
        this.categoryIds = categoryIds;
    }

    async getProductList() {
        const rubrosFiltrados = this.categoryIds === 'all'
            ? RUBROS
            : RUBROS.filter(r => r.id === parseInt(this.categoryIds));

        if (!rubrosFiltrados.length) {
            throw new Error('Ningún rubro coincide con el/los id/s especificado/s.');
        }

        const productList = [];

        for (const cat of rubrosFiltrados) {
            console.log(`📦 Rubro: ${cat.name} (${cat.id})`);
            logToFile(`== Rubro: ${cat.name} (${cat.id}) ==`);

            for (let page = 1; page <= cat.pages; page++) {
                console.log(`➡ Página ${page}/${cat.pages}`);
                logToFile(`→ Página ${page}/${cat.pages}`);

                const products = await this._getProductsFromCategoryPage(cat.id, page);

                // Agregar metadata de categoría a cada producto
                products.forEach(product => {
                    product.categoryId = cat.id;
                    product.categoryName = cat.name;
                });

                productList.push(...products);
            }
        }

        console.log(`📋 Total de productos encontrados: ${productList.length}`);
        logToFile(`📋 Total de productos encontrados: ${productList.length}`);

        return productList;
    }

    async _getProductsFromCategoryPage(categoryId, page = 1) {
        const url = `${BASE_URL}/shop/category/por-rubro-xxx-${categoryId}/page/${page}`;
        try {
            const res = await client.get(url);
            const $ = cheerio.load(res.data);
            const products = [];

            $('form.oe_product_cart').each((_, el) => {
                const product_id = $(el).find("input[name='product_id']").val();
                const product_template_id = $(el).find("input[name='product_template_id']").val();
                if (product_id && product_template_id) {
                    products.push({
                        product_id: Number(product_id),
                        product_template_id: Number(product_template_id),
                    });
                }
            });

            return products;
        } catch (error) {
            logToFile(`❌ Error página ${page} rubro ${categoryId}: ${error.message}`);
            return [];
        }
    }

    getName() {
        return `Category Scraper (${this.categoryIds === 'all' ? 'Todas las categorías' : `Categoría ${this.categoryIds}`})`;
    }
}

/**
 * Estrategia: Obtener productos desde sitemap
 */
class SitemapProductStrategy {
    constructor(sitemapSource = null, limitProducts = null) {
        this.sitemapSource = sitemapSource;
        this.limitProducts = limitProducts;
    }

    async getProductList() {
        const sitemapCollection = await getSitemapCollection();

        const query = this.sitemapSource ? { source: this.sitemapSource } : {};
        const sitemapDoc = await sitemapCollection.findOne(query);

        if (!sitemapDoc) {
            throw new Error('No se encontró documento de sitemap en la base de datos');
        }

        const productUrls = sitemapDoc.productUrls || [];

        if (!productUrls.length) {
            throw new Error('No se encontraron URLs de productos en el sitemap');
        }

        console.log(`📋 Total de productos en sitemap: ${productUrls.length}`);
        logToFile(`📋 Total de productos en sitemap: ${productUrls.length}`);

        // Limitar productos si se especifica
        const urlsToProcess = this.limitProducts
            ? productUrls.slice(0, this.limitProducts)
            : productUrls;

        // Convertir URLs a objetos de producto con product_template_id
        const productList = urlsToProcess.map(url => {
            // Extraer product_template_id del final de la URL
            // Ejemplo: .../shop/0697-abrazadera-perfecto-b1-08-10-mm-1472
            const templateIdMatch = url.match(/-(\d+)$/);
            const product_template_id = templateIdMatch ? Number(templateIdMatch[1]) : null;

            // Extraer categoryId si existe en query params
            const categoryMatch = url.match(/\?category=(\d+)/);
            const categoryId = categoryMatch ? parseInt(categoryMatch[1]) : null;

            return {
                product_template_id,
                product_id: null, // No lo tenemos aún, se obtendrá en getProductDetails
                sourceUrl: url,
                categoryId,
                categoryName: null, // Se intentará obtener luego
            };
        }).filter(p => p.product_template_id); // Filtrar si no se pudo extraer el ID

        console.log(`🚀 Procesando ${productList.length} productos...`);
        logToFile(`🚀 Procesando ${productList.length} productos...`);

        return productList;
    }

    getName() {
        return `Sitemap Scraper${this.limitProducts ? ` (Limitado a ${this.limitProducts})` : ''}`;
    }
}

// ============================================================================
// CLASE PRINCIPAL DEL SCRAPER
// ============================================================================

class ProductScraper {
    constructor(strategy, collection, options = {}) {
        this.strategy = strategy;
        this.collection = collection;
        this.pageDelay = options.pageDelay || DEFAULT_PAGE_DELAY_MS;
        this.categoryDelay = options.categoryDelay || DEFAULT_CATEGORY_DELAY_MS;
        this.profitMargin = null;
    }

    async initialize() {
        // Login a Odoo
        const loggedIn = await loginToOdoo();
        if (!loggedIn) throw new Error('Login fallido');

        // Obtener configuración de margen de ganancia
        const configCollection = await getConfigCollection();
        const configDoc = await configCollection.findOne({ key: 'profitMargin' });
        this.profitMargin = configDoc ? configDoc.value / 100 : 1;

        console.log(`🚀 Iniciando: ${this.strategy.getName()}`);
        logToFile(`🚀 Iniciando: ${this.strategy.getName()}`);
    }

    async run() {
        await this.initialize();

        // Obtener lista de productos según la estrategia
        const productList = await this.strategy.getProductList();

        let total = 0;
        let uploaded = 0;
        let errors = 0;

        // Procesar cada producto
        for (let i = 0; i < productList.length; i++) {
            const product = productList[i];
            const progress = `[${i + 1}/${productList.length}]`;

            console.log(`${progress} Procesando producto template ID: ${product.product_template_id}`);

            const details = await this._getProductDetails(
                product,
                product.categoryId,
                product.categoryName
            );

            if (details) {
                await this.collection.updateOne(
                    { product_id: details.product_id },
                    { $set: details },
                    { upsert: true }
                );
                total++;

                if (details.image_url && details.image_url.includes('cloudinary.com')) {
                    uploaded++;
                }

                logToFile(`✔ ${progress} Guardado: ${details.product_id} - ${details.display_name}`);
                console.log(`\t✔ Guardado: ${details.product_id} - ${details.display_name}`);
            } else {
                errors++;
                logToFile(`✘ ${progress} Error procesando producto template ID: ${product.product_template_id}`);
                console.log(`\t✘ Error procesando producto`);
            }

            await delay(this.pageDelay);
        }

        const summary = `
✅ Scraping finalizado: ${this.strategy.getName()}
   Total procesados: ${total}
   Errores: ${errors}
   Imágenes en Cloudinary: ${uploaded}
   Tasa de éxito: ${((total / productList.length) * 100).toFixed(2)}%
        `;

        logToFile(summary);
        console.log(summary);

        return {
            total,
            errors,
            uploaded,
            processed: productList.length
        };
    }

    async _getProductDetails(product, categoryId, categoryName) {
        try {
            // 1. Construir la URL completa del producto a partir del template ID
            const productUrl = `${BASE_URL}/shop/${product.product_template_id}`;

            // 2. Hacer una petición GET a la página del producto para obtener la URL final con el slug
            const productPageResponse = await client.get(productUrl);

            // 3. OBTENER LA URL FINAL (después de la redirección)
            const finalProductUrl = productPageResponse.request.res.responseUrl;

            // 4. EXTRAER el código de referencia (Referencia Interna) del slug de la URL
            const customProductId = extractProductIdFromUrl(finalProductUrl);

            if (!customProductId) {
                logToFile(`⚠️ Advertencia: No se pudo extraer la Referencia Interna de la URL para template ID ${product.product_template_id}`);
                return null;
            }

            // 5. Si no tenemos product_id, obtenerlo del HTML (caso sitemap)
            let productId = product.product_id;
            if (!productId) {
                const $ = cheerio.load(productPageResponse.data);
                productId = Number($("input[name='product_id']").val());

                if (!productId) {
                    logToFile(`⚠️ No se pudo obtener product_id del HTML para template ID ${product.product_template_id}`);
                    return null;
                }
            }

            // 6. Obtener detalles del producto via API
            const productApiData = await fetchProductDetailsFromAPI({
                product_id: productId,
                product_template_id: product.product_template_id,
                refererUrl: finalProductUrl,
            });

            if (!productApiData) return null;

            // 7. Extraer URL de imagen
            const imageUrl = extractImageUrl(productApiData.carousel);

            // 8. Si es de sitemap y no tiene categoryName, intentar obtenerlo de BD
            if (product.sourceUrl && categoryId && !categoryName) {
                const existingProduct = await this.collection.findOne({
                    product_id: parseInt(customProductId)
                });
                if (existingProduct?.category_name) {
                    categoryName = existingProduct.category_name;
                }
            }

            // 9. Procesar todos los datos del producto
            const productData = await processProductData({
                customProductId,
                productApiData,
                imageUrl,
                categoryId,
                categoryName,
                profitMargin: this.profitMargin,
                collection: this.collection,
                sourceUrl: product.sourceUrl || null,
            });

            return productData;
        } catch (error) {
            logToFile(`❌ Error detalle producto template ID ${product.product_template_id}: ${error.message}`);
            return null;
        }
    }
}

// ============================================================================
// FUNCIONES PÚBLICAS PARA EJECUTAR LOS SCRAPERS
// ============================================================================

/**
 * Ejecuta el scraper de categorías
 * @param {Object} options - Opciones del scraper
 * @param {string|number} options.categoryId - ID de categoría o 'all'
 * @param {number} options.pageDelay - Delay entre productos (ms)
 * @param {number} options.categoryDelay - Delay entre categorías (ms)
 * @param {Object} options.collection - Colección de MongoDB
 */
async function runCategoryScraper(options) {
    const {
        categoryId = 'all',
        pageDelay = DEFAULT_PAGE_DELAY_MS,
        categoryDelay = DEFAULT_CATEGORY_DELAY_MS,
        collection
    } = options;

    const strategy = new CategoryProductStrategy(categoryId);
    const scraper = new ProductScraper(strategy, collection, {
        pageDelay,
        categoryDelay
    });

    return await scraper.run();
}

/**
 * Ejecuta el scraper de sitemap
 * @param {Object} options - Opciones del scraper
 * @param {string} options.sitemapSource - URL fuente del sitemap (opcional)
 * @param {number} options.limitProducts - Limitar cantidad de productos (opcional)
 * @param {number} options.pageDelay - Delay entre productos (ms)
 * @param {Object} options.collection - Colección de MongoDB
 */
async function runSitemapScraper(options) {
    const {
        sitemapSource = null,
        limitProducts = null,
        pageDelay = DEFAULT_PAGE_DELAY_MS,
        collection
    } = options;

    const strategy = new SitemapProductStrategy(sitemapSource, limitProducts);
    const scraper = new ProductScraper(strategy, collection, { pageDelay });

    return await scraper.run();
}

module.exports = {
    runCategoryScraper,
    runSitemapScraper,
    ProductScraper,
    CategoryProductStrategy,
    SitemapProductStrategy,
};