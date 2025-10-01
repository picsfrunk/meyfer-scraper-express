require('dotenv').config();
const config = require('../config/config');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const logToFile = require('../utils/logToFile');
const { getConfigCollection } = require('../database/mongo');
const { processProductImage } = require('../utils/imageUploader'); // ← NUEVA IMPORTACIÓN

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

async function getProductDetails(product, categoryId, categoryName, profitMargin) {
    try {
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
                    Referer: `${BASE_URL}/shop/${product.product_template_id}`,
                },
            }
        );

        const data = response.data.result;
        const $ = cheerio.load(data.carousel || '');
        const imageUrl = $('img').attr('src') ? `${BASE_URL}${$('img').attr('src')}` : null;

        console.log(`   📸 Imagen encontrada: ${imageUrl ? 'SÍ' : 'NO'}`);
        if (imageUrl) {
            console.log(`      URL: ${imageUrl}`);
        }

        // ← NUEVA LÓGICA: Subir imagen a Cloudinary
        const cloudinaryImageUrl = await processProductImage(imageUrl, data.product_id);

        const brandMatch = data.display_name.match(/"(.*?)"/);
        const brand = brandMatch ? brandMatch[1].trim() : 'generico';

        const finalPrice = data.list_price * (1 + profitMargin);

        return {
            product_id: data.product_id,
            display_name: data.display_name,
            list_price: finalPrice,
            base_unit_name: data.base_unit_name,
            image_url: cloudinaryImageUrl, // ← AHORA USA LA URL DE CLOUDINARY
            original_image_url: imageUrl, // ← OPCIONAL: Guardar la URL original como backup
            product_type: data.product_type,
            category_id: categoryId,
            category_name: categoryName,
            brand: brand,
        };
    } catch (error) {
        logToFile(`❌ Error detalle producto ${product.product_id}: ${error.message}`);
        return null;
    }
}

async function runCategoryScraper({ categoryId = 'all', pageDelay = DEFAULT_PAGE_DELAY_MS, categoryDelay = DEFAULT_CATEGORY_DELAY_MS, collection }) {
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
    let uploaded = 0; // ← NUEVO: Contador de imágenes subidas

    for (const cat of rubrosFiltrados) {
        console.log(`📦 Rubro: ${cat.name} (${cat.id})`);
        logToFile(`== Rubro: ${cat.name} (${cat.id}) ==`);

        for (let page = 1; page <= cat.pages; page++) {
            console.log(`➡ Página ${page}/${cat.pages}`);
            logToFile(`→ Página ${page}/${cat.pages}`);

            const products = await getProductsFromCategoryPage(cat.id, page);

            for (const product of products) {
                const details = await getProductDetails(product, cat.id, cat.name, profitMargin);
                if (details) {
                    await collection.updateOne(
                        { product_id: details.product_id },
                        { $set: details },
                        { upsert: true }
                    );
                    total++;

                    // ← NUEVO: Verificar si se subió a Cloudinary
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
    console.log(`✅ Imágenes subidas a Cloudinary: ${uploaded}/${total}`);
    return total;
}

module.exports = { runCategoryScraper };