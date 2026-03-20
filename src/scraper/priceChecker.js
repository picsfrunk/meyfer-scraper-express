/**
 * priceChecker.js
 *
 * Servicio liviano de detección de cambios de precios.
 * Tiene su propio cliente HTTP con CookieJar independiente del scraper principal.
 *
 * Flujo:
 *  1. Login propio a Odoo
 *  2. Carga productos actuales de MongoDB (product_id + list_price, proyección mínima)
 *  3. Lee product_template_ids del sitemap cacheado (sin HTTP)
 *  4. Consulta list_price en Odoo en batches concurrentes con barra de progreso
 *  5. Clasifica: changed / new / removed
 *  6. Persiste resultado en DB (colección price_check_results)
 *  7. Loguea eventos con logToFile
 */

const axios   = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const tough   = require('tough-cookie');
const logToFile = require('../utils/logToFile');
const { getSitemapCollection, getScrapedCollection, getDB } = require('../database/mongo');

const BASE_URL  = process.env.BASE_URL;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;
const ODOO_DB   = process.env.ODOO_DB;

const CONCURRENCY   = 3;    // requests paralelos — conservador para no saturar Odoo
const REQUEST_DELAY = 400;  // ms entre batches

const delay = (ms) => new Promise(res => setTimeout(res, ms));

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE HTTP PROPIO
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
            await logToFile.info(`Login OK — uid: ${uid}`, 'priceChecker');
            return true;
        }
        await logToFile.error('Login fallido — respuesta sin uid', 'priceChecker', { result: res.data?.result });
        return false;
    } catch (err) {
        await logToFile.error(`Error en login: ${err.message}`, 'priceChecker');
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BARRA DE PROGRESO EN CONSOLA
// ─────────────────────────────────────────────────────────────────────────────

function renderProgress(current, total, startTime) {
    const pct      = Math.floor((current / total) * 100);
    const filled   = Math.floor(pct / 2);           // barra de 50 chars
    const empty    = 50 - filled;
    const bar      = '█'.repeat(filled) + '░'.repeat(empty);
    const elapsedS = ((Date.now() - startTime) / 1000).toFixed(1);
    const eta      = current > 0
        ? (((Date.now() - startTime) / current) * (total - current) / 1000).toFixed(0)
        : '?';

    process.stdout.write(
        `\r[priceChecker] ${bar} ${pct}% | ${current}/${total} | ${elapsedS}s | ETA: ${eta}s   `
    );
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
        if (!result?.list_price) return null;

        return {
            product_template_id,
            list_price:   result.list_price,
            display_name: result.display_name ?? null,
        };
    } catch (err) {
        // Error silencioso por producto — el caller maneja el null
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHES CON PROGRESO
// ─────────────────────────────────────────────────────────────────────────────

async function runInBatchesWithProgress(tasks, concurrency, delayMs) {
    const results  = [];
    const total    = tasks.length;
    const startTime = Date.now();
    let completed  = 0;

    for (let i = 0; i < tasks.length; i += concurrency) {
        const batch       = tasks.slice(i, i + concurrency);
        const batchResult = await Promise.all(batch.map(t => t()));
        results.push(...batchResult);
        completed += batch.length;
        renderProgress(completed, total, startTime);
        if (i + concurrency < tasks.length) await delay(delayMs);
    }

    // Salto de línea al terminar la barra
    process.stdout.write('\n');
    return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCIA DEL RESULTADO
// ─────────────────────────────────────────────────────────────────────────────

async function persistResult(result) {
    try {
        const db         = await getDB();
        const collection = db.collection('price_check_results');

        // Guardamos solo los IDs en los arrays para no saturar la DB.
        // El resultado completo (con nombres y precios) lo recibe el webhook.
        const doc = {
            checkedAt:   new Date(result.summary.checkedAt),
            durationMs:  result.summary.durationMs,
            summary:     result.summary,
            changedIds:  result.changed.map(p => p.product_id),
            newIds:      result.new.map(p => String(p.product_template_id)),
            removedIds:  result.removed.map(p => p.product_id),
            // Guardamos los detalles completos de changed ya que son los más útiles
            changedDetail: result.changed,
        };

        await collection.insertOne(doc);
        await logToFile.info('Resultado persistido en price_check_results', 'priceChecker', {
            summary: result.summary,
        });
    } catch (err) {
        await logToFile.error(`Error persistiendo resultado: ${err.message}`, 'priceChecker');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

    await logToFile.info('Iniciando price check', 'priceChecker');

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

    await logToFile.info(`Comparando precios`, 'priceChecker', {
        totalOdoo: sitemapProducts.length,
        totalDB:   dbMap.size,
    });
    console.log(`\n[priceChecker] ${sitemapProducts.length} en Odoo | ${dbMap.size} en DB`);

    // ── 4. Consultar precios en Odoo (batches con barra de progreso) ─────────
    const tasks = sitemapProducts.map(p => () => fetchPriceFromOdoo(client, p));
    const odooResults = await runInBatchesWithProgress(tasks, CONCURRENCY, REQUEST_DELAY);

    const odooMap = new Map();
    for (const r of odooResults) {
        if (r) odooMap.set(String(r.product_template_id), r);
    }

    const failedCount = sitemapProducts.length - odooMap.size;
    if (failedCount > 0) {
        await logToFile.warn(`${failedCount} productos no respondieron desde Odoo`, 'priceChecker');
    }

    // ── 5. Clasificar diferencias ────────────────────────────────────────────
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

    const result = {
        summary: {
            changed:    changed.length,
            new:        newProds.length,
            removed:    removed.length,
            total_odoo: odooMap.size,
            total_db:   dbMap.size,
            failed:     failedCount,
            checkedAt:  new Date().toISOString(),
            durationMs,
        },
        // Solo IDs en el webhook para no superar límites de payload
        changedIds:  changed.map(p => p.product_id),
        newIds:      newProds.map(p => String(p.product_template_id)),
        removedIds:  removed.map(p => p.product_id),
        // Detalle completo disponible en la DB
        changed,
        new:     newProds,
        removed,
    };

    await logToFile.info('Price check finalizado', 'priceChecker', { summary: result.summary });
    console.log(`[priceChecker] Done ${durationMs}ms — changed:${changed.length} new:${newProds.length} removed:${removed.length} failed:${failedCount}`);

    // ── 6. Persistir en DB ───────────────────────────────────────────────────
    await persistResult(result);

    return result;
}

module.exports = { checkPrices };
