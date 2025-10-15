require('dotenv').config();
const config = require('../config/config');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const logToFile = require('../utils/logToFile');
const { getConfigCollection } = require('../database/mongo');
const { processProductImage } = require('../utils/imageUploader');

const delay = ms => new Promise(res => setTimeout(res, ms));

const BASE_URL = config.baseUrl;
const DEFAULT_PAGE_DELAY_MS = config.pageDelay;
const DEFAULT_CATEGORY_DELAY_MS = config.categoryDelay;
const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;

const RUBROS = require('../config/rubros');

const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

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
            console.log('✔ Login exitoso como:', ODOO_USER);
            logToFile(`✔ Login exitoso como: ${ODOO_USER}`);
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

async function getProductsFromCategoryPage(categoryId, page = 1) {
    const url = `${BASE_URL}/shop/category/por-rubro-xxx-${categoryId}/page/${page}`;
    try {
        const res = await client.get(url);
        const cheerioAPI = cheerio.load(res.data);
        const products = [];

        cheerioAPI('form.oe_product_cart').each((_, el) => {
            const product_id = cheerioAPI(el).find("input[name='product_id']").val();
            const product_template_id = cheerioAPI(el).find("input[name='product_template_id']").val();
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
        // Esto asume que el slug se genera con el product_template_id
        const productUrl = `${BASE_URL}/shop/${product.product_template_id}`;

        // 2. Hacer una petición GET a la página del producto para obtener la URL final con el slug
        const productPageResponse = await client.get(productUrl);

        // 3. OBTENER LA URL FINAL (después de la redirección) para asegurar que tiene el slug
        // Nota: Odoo a menudo redirige de /shop/{template_id} a /shop/{slug}-{template_id}
        const finalProductUrl = productPageResponse.request.res.responseUrl;

        // 4. EXTRAER el código de referencia (Referencia Interna) del slug de la URL
        // Ejemplo: /shop/0502-bajada-conex-flex-40-50-mm-bomonini-1562?category=71
        // Queremos '0502'
        const urlMatch = finalProductUrl.match(/\/shop\/(\d+)-/);

        let customProductId;

        if (urlMatch && urlMatch[1]) {
            // Usar el valor encontrado en la URL (e.g., '0502')
            customProductId = urlMatch[1];
        } else {
            // Si la extracción falla, recurrir al product_id original como fallback.
            logToFile(`⚠️ Advertencia: No se pudo extraer la Referencia Interna de la URL para template ID ${product.product_template_id}. Usando product_id original.`);
            customProductId = product.product_id;
        }

        // Ahora el Referer debe usar la URL completa con el slug
        const response = await client.post(
            `${BASE_URL}/website_sale/get_combination_info`,
            {
                id: 3,
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    product_template_id: product.product_template_id,
                    product_id: product.product_id,
                    combination: [],
                    add_qty: 1,
                    parent_combination: [],
                },
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    // Usar la URL completa con el slug como Referer
                    Referer: finalProductUrl,
                },
            }
        );

        const data = response.data.result;
        const cheerioAPI = cheerio.load(data.carousel || '');
        const imageUrl = cheerioAPI('img').attr('src') ? `${BASE_URL}${cheerioAPI('img').attr('src')}` : null;

        // Buscar si el producto ya existe en BD para obtener la URL existente
        // IMPORTANTE: Ahora buscamos con el customProductId
        const existingProduct = await collection.findOne({ product_id: customProductId });
        const existingImageUrl = existingProduct?.image_url || null;

        // Procesar imagen, usando el customProductId para el nombre
        const cloudinaryImageUrl = await processProductImage(imageUrl, customProductId, existingImageUrl);

        const brandMatch = data.display_name.match(/"([^"]+)"$/);
        const brand = brandMatch ? brandMatch[1].trim() : 'generico';

        const finalPrice = data.list_price * (1 + profitMargin);

        return {
            // ¡CAMBIO CLAVE AQUÍ! Usamos la referencia extraída de la URL
            product_id: parseInt(customProductId),
            display_name: data.display_name,
            final_price: finalPrice,
            list_price: data.list_price,
            base_unit_name: data.base_unit_name,
            image_url: cloudinaryImageUrl,
            original_image_url: imageUrl,
            product_type: data.product_type,
            category_id: categoryId,
            category_name: categoryName,
            brand: brand,
        };
    } catch (error) {
        logToFile(`❌ Error detalle producto ${product.product_id} (Template ID ${product.product_template_id}): ${error.message}`);
        return null;
    }
}
<<<<<<< Updated upstream

async function runCategoryScraper({ categoryId = 'all', pageDelay = DEFAULT_PAGE_DELAY_MS, categoryDelay = DEFAULT_CATEGORY_DELAY_MS, collection }) {
=======
async function runCategoryScraper({   categoryId = 'all',
                                      pageDelay = DEFAULT_PAGE_DELAY_MS,
                                      categoryDelay = DEFAULT_CATEGORY_DELAY_MS,
                                      collection }) {

>>>>>>> Stashed changes
    const rubrosFiltrados = categoryId === "all"
        ? RUBROS
        : RUBROS.filter(r => r.id === parseInt(categoryId));

    if (!rubrosFiltrados.length) {
        throw new Error('⚠️ Ningún rubro coincide.');
    }

    const loggedIn = await loginToOdoo();
    if (!loggedIn) throw new Error('Login fallido');

    const configCollection = await getConfigCollection();
    const configDoc = await configCollection.findOne({ key: 'profitMargin' });
    const profitMargin = configDoc ? configDoc.value / 100 : 1;

    let total = 0;
    let uploaded = 0;
    let reused = 0;

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

                    // Contar imágenes subidas vs reutilizadas
                    if (details.image_url && details.image_url.includes('cloudinary.com')) {
                        // Verificar si es una imagen nueva o reutilizada
                        // (esto lo detectamos por los logs, pero podríamos mejorarlo)
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