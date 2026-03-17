/**
 * priceChecker.js
 *
 * Servicio liviano de detección de cambios de precios.
 * Usa su propio cliente HTTP con CookieJar independiente del scraper principal
 * para evitar conflictos de sesión entre procesos concurrentes.
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const { getSitemapCollection, getScrapedCollection } = require('../database/mongo');

const BASE_URL  = process.env.BASE_URL;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;
const ODOO_DB   = process.env.ODOO_DB;

const CONCURRENCY   = 3;    // requests paralelos — conservador para no saturar Odoo
const REQUEST_DELAY = 500;  // ms entre batches

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE HTTP PROPIO
// Instancia independiente con su propia CookieJar.
// El scraper principal tiene la suya — no compartimos sesión.
// ─────────────────────────────────────────────────────────────────────────────

function createHttpClient() {
    const jar = new tough.CookieJar();
    return wrapper(axios.create({ jar, withCredentials: true }));
}

async function loginToOdoo(client) {
    try {
        const res = await client.post(`${BASE_URL}/web/session/authenticate`, {
            jsonrpc: '2.0',
            method:  'call',
            params:  { db: ODOO_DB, login: ODOO_USER, password: ODOO_PASS },
        });

        const uid = res.data?.result?.uid;
        if (uid) {
            console.log(`[priceChecker] Login OK — uid: ${uid}`);
            return true;
        }

        console.error('[priceChecker] Login fallido — respuesta sin uid:', JSON.stringify(res.data?.result));
        return false;
    } catch (err) {
        console.error('[priceChecker] Error en login:', err.message);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH DE PRECIO INDIVIDUAL
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPriceFromOdoo(client, { product_template_id, sourceUrl }) {
    try {
        const refererUrl = sourceUrl.startsWith('http')
            ? sourceUrl
            : `${BASE_URL}${sourceUrl}`;

        const response = await client.post(
            `${BASE_URL}/website_sale/get_combination_info`,
            {
                id:      3,
                jsonrpc: '2.0',
                method:  'call',
                params:  {
                    product_template_id,
                    product_id:         product_template_id,
                    combination:        [],
                    add_qty:            1,
                    parent_combination: [],
                },
            },
            { headers: { 'Content-Type': 'application/json', Referer: refererUrl } }
        );

        const result = response.data?.result;

        if (!result?.list_price) {
            console.warn(`[priceChecker] Sin list_price para template_id ${product_template_id} — result:`, JSON.stringify(result)?.slice(0, 120));
            return null;
        }

        return {
            product_template_id,
            list_price:   result.list_price,
            display_name: result.display_name ?? null,
        };
    } catch (err) {
        console.error(`[priceChecker] Error fetching template_id ${product_template_id}:`, err.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function runInBatches(tasks, concurrency, delayMs) {
    const results = [];
    for (let i = 0; i < tasks.length; i += concurrency) {
        const batch       = tasks.slice(i, i + concurrency);
        const batchResult = await Promise.all(batch.map(t => t()));
        results.push(...batchResult);
        if (i + concurrency < tasks.length) await delay(delayMs);
    }
    return results;
}

async function getProductListFromSitemap() {
    const sitemapCollection = await getSitemapCollection();
    const sitemapDoc = await sitemapCollection.findOne({});

    if (!sitemapDoc?.productUrls?.length) {
        throw new Error('No hay sitemap cacheado. Ejecutá POST /scraper/sitemap/analysis primero.');
    }

    return sitemapDoc.productUrls.map(url => {
        const match = url.match(/-(\d+)$/);
        return match ? { product_template_id: Number(match[1]), sourceUrl: url } : null;
    }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARACIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

async function checkPrices() {
    const start  = Date.now();
    const client = createHttpClient();

    // ── 1. Login propio ──────────────────────────────────────────────────────
    const loggedIn = await loginToOdoo(client);
    if (!loggedIn) throw new Error('No se pudo autenticar en Odoo.');

    // ── 2. DB actual (proyección mínima) ─────────────────────────────────────
    const scrapedCollection = await getScrapedCollection();
    const dbProducts = await scrapedCollection
        .find({}, { projection: { product_id: 1, list_price: 1, display_name: 1, _id: 0 } })
        .toArray();

    const dbMap = new Map(
        dbProducts.map(p => [String(p.product_id), {
            list_price:   p.list_price,
            display_name: p.display_name,
        }])
    );

    // ── 3. Lista desde sitemap cacheado ──────────────────────────────────────
    const sitemapProducts = await getProductListFromSitemap();
    console.log(`[priceChecker] ${sitemapProducts.length} en Odoo | ${dbMap.size} en DB`);

    // ── 4. Consultar precios en Odoo (batches) ───────────────────────────────
    const tasks = sitemapProducts.map(p => () => fetchPriceFromOdoo(client, p));
    const odooResults = await runInBatches(tasks, CONCURRENCY, REQUEST_DELAY);

    const odooMap = new Map();
    for (const r of odooResults) {
        if (r) odooMap.set(String(r.product_template_id), r);
    }

    console.log(`[priceChecker] Odoo respondió ${odooMap.size}/${sitemapProducts.length} productos`);

    // ── 5. Clasificar ────────────────────────────────────────────────────────
    const changed  = [];
    const newProds = [];
    const removed  = [];

    for (const [templateId, odooData] of odooMap) {
        const dbEntry = dbMap.get(templateId);

        if (!dbEntry) {
            newProds.push({
                product_template_id: Number(templateId),
                display_name:        odooData.display_name,
                list_price:          odooData.list_price,
            });
            continue;
        }

        const oldPrice = dbEntry.list_price;
        const newPrice = odooData.list_price;

        if (Math.abs(oldPrice - newPrice) > 0.001) {
            const diff = newPrice - oldPrice;
            changed.push({
                product_id:   templateId,
                display_name: dbEntry.display_name ?? odooData.display_name,
                old_price:    oldPrice,
                new_price:    newPrice,
                diff:         parseFloat(diff.toFixed(2)),
                diff_percent: oldPrice > 0
                    ? parseFloat(((diff / oldPrice) * 100).toFixed(2))
                    : null,
            });
        }
    }

    for (const [productId, dbEntry] of dbMap) {
        if (!odooMap.has(productId)) {
            removed.push({
                product_id:   productId,
                display_name: dbEntry.display_name,
                list_price:   dbEntry.list_price,
            });
        }
    }

    const durationMs = Date.now() - start;
    console.log(`[priceChecker] Done ${durationMs}ms — changed:${changed.length} new:${newProds.length} removed:${removed.length}`);

    return {
        summary: {
            changed:    changed.length,
            new:        newProds.length,
            removed:    removed.length,
            total_odoo: odooMap.size,
            total_db:   dbMap.size,
            checkedAt:  new Date().toISOString(),
            durationMs,
        },
        changed,
        new:     newProds,
        removed,
    };
}

module.exports = { checkPrices };