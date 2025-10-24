require('dotenv').config();
const config = require('../config/config');
const cheerio = require('cheerio');
const logToFile = require('../utils/logToFile');
const { getConfigCollection } = require('../database/mongo');
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

async function getProductsFromCategoryPage(categoryId, page = 1) {
    const url = `${BASE_URL}/shop/category/por-rubro-xxx-${categoryId}/page/${page}`;
    try {
        const res = await client.get(url);
        console.log(res)
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

async function getProductDetails(product, categoryId, categoryName, profitMargin, collection) {
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
            logToFile(`⚠️ Advertencia: No se pudo extraer la Referencia Interna de la URL para template ID ${product.product_template_id}. Usando product_id original.`);
            return null;
        }

        // 5. Obtener detalles del producto via API
        const productApiData = await fetchProductDetailsFromAPI({
            product_id: product.product_id,
            product_template_id: product.product_template_id,
            refererUrl: finalProductUrl,
        });

        if (!productApiData) return null;

        // 6. Extraer URL de imagen
        const imageUrl = extractImageUrl(productApiData.carousel);

        // 7. Procesar todos los datos del producto
        const productData = await processProductData({
            customProductId,
            productApiData,
            imageUrl,
            categoryId,
            categoryName,
            profitMargin,
            collection,
        });

        return productData;
    } catch (error) {
        logToFile(`❌ Error detalle producto ${product.product_id} (Template ID ${product.product_template_id}): ${error.message}`);
        return null;
    }
}

async function runCategoryScraper({
                                      categoryId = 'all',
                                      pageDelay = DEFAULT_PAGE_DELAY_MS,
                                      categoryDelay = DEFAULT_CATEGORY_DELAY_MS,
                                      collection
                                  }) {
    const rubrosFiltrados = categoryId === "all"
        ? RUBROS
        : RUBROS.filter(r => r.id === parseInt(categoryId));

    if (!rubrosFiltrados.length) {
        throw new Error('Ningún rubro coincide con el/los id/s especificado/s.');
    }

    const loggedIn = await loginToOdoo();
    if (!loggedIn) throw new Error('Login fallido');

    const configCollection = await getConfigCollection();
    const configDoc = await configCollection.findOne({ key: 'profitMargin' });
    const profitMargin = configDoc ? configDoc.value / 100 : 1;

    let total = 0;
    let uploaded = 0;

    for (const cat of rubrosFiltrados) {
        console.log(`📦 Rubro: ${cat.name} (${cat.id})`);
        logToFile(`== Rubro: ${cat.name} (${cat.id}) ==`);

        for (let page = 1; page <= cat.pages; page++) {
            console.log(`➡ Página ${page}/${cat.pages}`);
            logToFile(`→ Página ${page}/${cat.pages}`);

            const products = await getProductsFromCategoryPage(cat.id, page);

            for (const product of products) {
                const details = await getProductDetails(product, cat.id, cat.name, profitMargin, collection);
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

                    logToFile(`✔ Guardado: ${details.product_id} - ${details.display_name}`);
                    console.log(`\t\t✔ Guardado: ${details.product_id} - ${details.display_name}`);
                }
                await delay(pageDelay);
            }
        }
        await delay(categoryDelay);
    }

    logToFile(`✅ Finalizado. Total productos: ${total} | Imágenes en Cloudinary: ${uploaded}`);
    console.log(`✅ Imágenes en Cloudinary: ${uploaded}/${total}`);
    return total;
}

module.exports = { runCategoryScraper };