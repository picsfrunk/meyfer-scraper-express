require('dotenv').config();
const config = require('../config/config');
const logToFile = require('../utils/logToFile');
const { getConfigCollection, getSitemapCollection } = require('../database/mongo');
const {
    loginToOdoo,
    extractProductIdFromUrl,
    extractProductIdsFromHtml,
    fetchProductDetailsFromAPI,
    extractImageUrl,
    processProductData,
} = require('../utils/scraperUtils');

const delay = ms => new Promise(res => setTimeout(res, ms));

const DEFAULT_PAGE_DELAY_MS = config.pageDelay;

async function getProductDetailsFromUrl(productUrl, profitMargin, collection) {
    try {
        // 1. Extraer el código de referencia DIRECTAMENTE de la URL del sitemap
        const customProductId = extractProductIdFromUrl(productUrl);

        if (!customProductId) {
            logToFile(`⚠️ No se pudo extraer el product_id de la URL: ${productUrl}`);
            return null;
        }

        // 2. Extraer los IDs necesarios para el API desde el HTML
        const productIds = await extractProductIdsFromHtml(productUrl);

        if (!productIds) {
            logToFile(`⚠️ No se pudieron extraer IDs del HTML de: ${productUrl}`);
            return null;
        }

        // 3. Extraer categoría de la URL si está disponible
        const categoryMatch = productUrl.match(/\?category=(\d+)/);
        const categoryId = categoryMatch ? parseInt(categoryMatch[1]) : null;

        // 4. Obtener detalles del producto via API
        const productApiData = await fetchProductDetailsFromAPI({
            product_id: productIds.product_id,
            product_template_id: productIds.product_template_id,
            refererUrl: productUrl,
        });

        if (!productApiData) return null;

        // 5. Extraer URL de imagen
        const imageUrl = extractImageUrl(productApiData.carousel);

        // 6. Intentar obtener nombre de categoría si existe el producto
        let categoryName = null;
        if (categoryId) {
            const existingProduct = await collection.findOne({
                product_id: parseInt(customProductId)
            });
            if (existingProduct?.category_name) {
                categoryName = existingProduct.category_name;
            }
        }

        // 7. Procesar todos los datos del producto
        const productData = await processProductData({
            customProductId,
            productApiData,
            imageUrl,
            categoryId,
            categoryName,
            profitMargin,
            collection,
            sourceUrl: productUrl,
        });

        return productData;
    } catch (error) {
        logToFile(`❌ Error detalle producto ${productUrl}: ${error.message}`);
        return null;
    }
}

async function runSitemapScraper({
                                     pageDelay = DEFAULT_PAGE_DELAY_MS,
                                     collection,
                                     sitemapSource = null,
                                     limitProducts = null
                                 }) {
    const loggedIn = await loginToOdoo();
    if (!loggedIn) throw new Error('Login fallido');

    // Obtener configuración de margen de ganancia
    const configCollection = await getConfigCollection();
    const configDoc = await configCollection.findOne({ key: 'profitMargin' });
    const profitMargin = configDoc ? configDoc.value / 100 : 1;

    // Obtener URLs de productos desde la colección del sitemap
    const sitemapCollection = await getSitemapCollection();

    const query = sitemapSource ? { source: sitemapSource } : {};
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
    const urlsToProcess = limitProducts
        ? productUrls.slice(0, limitProducts)
        : productUrls;

    console.log(`🚀 Procesando ${urlsToProcess.length} productos...`);
    logToFile(`🚀 Procesando ${urlsToProcess.length} productos...`);

    let total = 0;
    let uploaded = 0;
    let errors = 0;

    for (let i = 0; i < urlsToProcess.length; i++) {
        const productUrl = urlsToProcess[i];
        const progress = `[${i + 1}/${urlsToProcess.length}]`;

        console.log(`${progress} Procesando: ${productUrl}`);

        const details = await getProductDetailsFromUrl(productUrl, profitMargin, collection);

        if (details) {
            await collection.updateOne(
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
            logToFile(`✘ ${progress} Error procesando: ${productUrl}`);
            console.log(`\t✘ Error procesando producto`);
        }

        await delay(pageDelay);
    }

    const summary = `
✅ Scraping de sitemap finalizado
   Total procesados: ${total}
   Errores: ${errors}
   Imágenes en Cloudinary: ${uploaded}
   Tasa de éxito: ${((total / urlsToProcess.length) * 100).toFixed(2)}%
    `;

    logToFile(summary);
    console.log(summary);

    return {
        total,
        errors,
        uploaded,
        processed: urlsToProcess.length
    };
}

module.exports = { runSitemapScraper };