require('dotenv').config();
const config = require('../config/config');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const logToFile = require('../utils/logToFile');
const { getConfigCollection, getSitemapCollection } = require('../database/mongo');
const { processProductImage } = require('../utils/imageUploader');

const delay = ms => new Promise(res => setTimeout(res, ms));

const BASE_URL = config.baseUrl;
const DEFAULT_PAGE_DELAY_MS = config.pageDelay;

const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;

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

async function extractProductIdsFromUrl(productUrl) {
    try {
        // Hacer request para obtener los IDs desde la página
        const response = await client.get(productUrl);
        const $ = cheerio.load(response.data);

        // Buscar el formulario del producto
        const productForm = $('form.oe_product_cart').first();
        const product_id = productForm.find("input[name='product_id']").val();
        const product_template_id = productForm.find("input[name='product_template_id']").val();

        if (product_id && product_template_id) {
            return {
                product_id: Number(product_id),
                product_template_id: Number(product_template_id),
            };
        }

        return null;
    } catch (error) {
        logToFile(`❌ Error extrayendo IDs de ${productUrl}: ${error.message}`);
        return null;
    }
}

async function getProductDetailsFromUrl(productUrl, profitMargin, collection) {
    try {
        // 1. Extraer los IDs del producto desde la URL
        const productIds = await extractProductIdsFromUrl(productUrl);

        if (!productIds) {
            logToFile(`⚠️ No se pudieron extraer IDs de: ${productUrl}`);
            return null;
        }

        // 2. Obtener la URL final (después de redirecciones)
        const productPageResponse = await client.get(productUrl);
        const finalProductUrl = productPageResponse.request.res.responseUrl;

        // 3. Extraer el código de referencia del slug de la URL
        const urlMatch = finalProductUrl.match(/\/shop\/(\d+)-/);

        let customProductId;
        if (urlMatch && urlMatch[1]) {
            customProductId = urlMatch[1];
        } else {
            logToFile(`⚠️ Advertencia: No se pudo extraer la Referencia Interna de la URL ${finalProductUrl}. Usando product_id original.`);
            customProductId = productIds.product_id;
        }

        // 4. Extraer categoría de la URL si está disponible
        const categoryMatch = finalProductUrl.match(/\?category=(\d+)/);
        const categoryId = categoryMatch ? parseInt(categoryMatch[1]) : null;

        // 5. Obtener detalles del producto via API
        const response = await client.post(
            `${BASE_URL}/website_sale/get_combination_info`,
            {
                id: 3,
                jsonrpc: '2.0',
                method: 'call',
                params: {
                    product_template_id: productIds.product_template_id,
                    product_id: productIds.product_id,
                    combination: [],
                    add_qty: 1,
                    parent_combination: [],
                },
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Referer: finalProductUrl,
                },
            }
        );

        const data = response.data.result;
        const $ = cheerio.load(data.carousel || '');
        const imageUrl = $('img').attr('src') ? `${BASE_URL}${$('img').attr('src')}` : null;

        // 6. Buscar producto existente en BD
        const existingProduct = await collection.findOne({ product_id: customProductId });
        const existingImageUrl = existingProduct?.image_url || null;

        // 7. Procesar imagen
        const cloudinaryImageUrl = await processProductImage(imageUrl, customProductId, existingImageUrl);

        // 8. Extraer marca
        const brandMatch = data.display_name.match(/"([^"]+)"$/);
        const brand = brandMatch ? brandMatch[1].trim() : 'generico';

        // 9. Calcular precio final
        const finalPrice = data.list_price * (1 + profitMargin);

        // 10. Intentar obtener nombre de categoría si tenemos el ID
        let categoryName = null;
        if (categoryId && existingProduct?.category_name) {
            categoryName = existingProduct.category_name;
        }

        return {
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
            source_url: finalProductUrl,
        };
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