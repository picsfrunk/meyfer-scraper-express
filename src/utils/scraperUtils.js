//scraperUtils.js
require('dotenv').config();
const config = require('../config/config');
const axios = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const logToFile = require('./logToFile');
const { processProductImage } = require('./imageUploader');

const BASE_URL = config.baseUrl;
const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;

// Cookie jar y cliente compartidos
const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

/**
 * Inicia sesión en Odoo y mantiene la sesión en el cookie jar
 * @returns {Promise<boolean>} true si el login fue exitoso
 */
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

/**
 * Extrae el product_id (código de referencia) del slug de la URL
 * @param {string} url - URL del producto
 * @returns {string|null} El product_id extraído o null
 */
function extractProductIdFromUrl(url) {
    const urlMatch = url.match(/\/shop\/(\d+)-/);
    return urlMatch && urlMatch[1] ? urlMatch[1] : null;
}

/**
 * Extrae los IDs necesarios del HTML de la página del producto
 * @param {string} productUrl - URL del producto
 * @returns {Promise<Object|null>} {product_id, product_template_id} o null
 */
async function extractProductIdsFromHtml(productUrl) {
    try {
        const response = await client.get(productUrl);
        const $ = cheerio.load(response.data);

        // Intentar múltiples estrategias para encontrar los IDs

        // Estrategia 1: Buscar en formulario con clase oe_product_cart
        let product_id = $('form.oe_product_cart').find("input[name='product_id']").val();
        let product_template_id = $('form.oe_product_cart').find("input[name='product_template_id']").val();

        // Estrategia 2: Buscar inputs directamente en toda la página
        if (!product_id || !product_template_id) {
            product_id = $("input[name='product_id']").val();
            product_template_id = $("input[name='product_template_id']").val();
        }

        // Estrategia 3: Buscar en cualquier formulario
        if (!product_id || !product_template_id) {
            product_id = $('form').find("input[name='product_id']").val();
            product_template_id = $('form').find("input[name='product_template_id']").val();
        }

        if (product_id && product_template_id) {
            return {
                product_id: Number(product_id),
                product_template_id: Number(product_template_id),
            };
        }

        return null;
    } catch (error) {
        logToFile(`❌ Error extrayendo IDs del HTML de ${productUrl}: ${error.message}`);
        return null;
    }
}

/**
 * Obtiene los detalles del producto desde el API de Odoo
 * @param {Object} params - Parámetros necesarios
 * @param {number} params.product_id - ID del producto
 * @param {number} params.product_template_id - ID del template
 * @param {string} params.refererUrl - URL para usar como Referer
 * @returns {Promise<Object|null>} Datos del producto o null
 */
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

/**
 * Extrae la URL de la imagen desde el carousel HTML
 * @param {string} carouselHtml - HTML del carousel
 * @returns {string|null} URL completa de la imagen o null
 */
function extractImageUrl(carouselHtml) {
    if (!carouselHtml) return null;

    const $ = cheerio.load(carouselHtml);
    const imgSrc = $('img').attr('src');

    return imgSrc ? `${BASE_URL}${imgSrc}` : null;
}

/**
 * Extrae la marca del nombre del producto
 * @param {string} displayName - Nombre completo del producto
 * @returns {string} Nombre de la marca o 'generico'
 */
function extractBrand(displayName) {
    const brandMatch = displayName.match(/"([^"]+)"$/);
    return brandMatch ? brandMatch[1].trim() : 'generico';
}

/**
 * Procesa toda la información del producto y retorna el objeto completo
 * @param {Object} params - Parámetros del producto
 * @returns {Promise<Object|null>} Objeto del producto completo o null
 */
async function processProductData({
                                      customProductId,
                                      productApiData,
                                      imageUrl,
                                      categoryId = null,
                                      categoryName = null,
                                      profitMargin,
                                      collection,
                                      sourceUrl = null
                                  }) {
    try {
        // Buscar si el producto ya existe en BD
        const existingProduct = await collection.findOne({
            product_id: parseInt(customProductId)
        });
        const existingImageUrl = existingProduct?.image_url || null;

        // Procesar imagen
        const cloudinaryImageUrl = await processProductImage(
            imageUrl,
            customProductId,
            existingImageUrl
        );

        // Extraer marca
        const brand = extractBrand(productApiData.display_name);

        // Calcular precio final
        const finalPrice = productApiData.list_price * (1 + profitMargin);

        const productData = {
            product_id: parseInt(customProductId),
            display_name: productApiData.display_name,
            final_price: finalPrice,
            list_price: productApiData.list_price,
            base_unit_name: productApiData.base_unit_name,
            image_url: cloudinaryImageUrl,
            original_image_url: imageUrl,
            product_type: productApiData.product_type,
            category_id: categoryId,
            category_name: categoryName,
            brand: brand,
        };

        // Agregar source_url si está disponible (para sitemap scraper)
        if (sourceUrl) {
            productData.source_url = sourceUrl;
        }

        return productData;
    } catch (error) {
        logToFile(`❌ Error procesando datos del producto ${customProductId}: ${error.message}`);
        return null;
    }
}

module.exports = {
    client,
    BASE_URL,
    loginToOdoo,
    extractProductIdFromUrl,
    extractProductIdsFromHtml,
    fetchProductDetailsFromAPI,
    extractImageUrl,
    extractBrand,
    processProductData,
};