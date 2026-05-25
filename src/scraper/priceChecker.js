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
 *  4. Resuelve cada producto igual que el scraper principal para obtener el product_id persistido
 *  5. Consulta list_price en Odoo en batches concurrentes
 *  6. Clasifica: changed / new / removed usando IDs consistentes
 *  7. Persiste resultado en DB (colección price_check_results)
 *  8. Loguea eventos con logToFile
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const { wrapper } = require('axios-cookiejar-support');
const tough   = require('tough-cookie');
const logToFile = require('../utils/logToFile');
const { getSitemapCollection, getScrapedCollection, getDB } = require('../database/mongo');

const BASE_URL  = process.env.BASE_URL;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;
const ODOO_DB   = process.env.ODOO_DB;

const CONCURRENCY = Number(process.env.PRICE_CHECK_CONCURRENCY || 2);
const REQUEST_DELAY = Number(process.env.PRICE_CHECK_REQUEST_DELAY || 800);

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
// HELPERS DE RESOLUCIÓN DE PRODUCTO
// ─────────────────────────────────────────────────────────────────────────────

function buildAbsoluteUrl(urlOrPath) {
    if (!urlOrPath) return null;
    return urlOrPath.startsWith('http') ? urlOrPath : `${BASE_URL}${urlOrPath}`;
}

function extractProductIdFromUrl(url) {
    const match = String(url || '').match(/\/shop\/(\d+)-/);
    return match?.[1] ?? null;
}

function extractTemplateIdFromUrl(url) {
    const match = String(url || '').match(/-(\d+)$/);
    return match ? Number(match[1]) : null;
}

async function resolveProductFromOdoo(client, sitemapProduct) {
    try {
        const initialUrl = buildAbsoluteUrl(sitemapProduct.sourceUrl)
            || `${BASE_URL}/shop/${sitemapProduct.product_template_id}`;

        const response = await client.get(initialUrl);
        const finalUrl = response.request?.res?.responseUrl || initialUrl;
        const $ = cheerio.load(response.data);

        const persistedProductId = extractProductIdFromUrl(finalUrl)
            || extractProductIdFromUrl(initialUrl);
        const odooProductId = $("input[name='product_id']").val();
        const templateInput = $("input[name='product_template_id']").val();
        const productTemplateId = Number(
            templateInput
            || sitemapProduct.product_template_id
            || extractTemplateIdFromUrl(finalUrl)
            || extractTemplateIdFromUrl(initialUrl)
        );

        if (!persistedProductId || !odooProductId || !Number.isFinite(productTemplateId)) {
            return null;
        }

        return {
            product_id: String(persistedProductId),
            odoo_product_id: String(odooProductId),
            product_template_id: productTemplateId,
            sourceUrl: sitemapProduct.sourceUrl,
            finalUrl,
        };
    } catch (err) {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH DE PRECIO INDIVIDUAL
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPriceFromOdoo(client, product) {
    try {
        const refererUrl = product.finalUrl || buildAbsoluteUrl(product.sourceUrl) || `${BASE_URL}/shop/${product.product_template_id}`;

        const response = await client.post(
            `${BASE_URL}/website_sale/get_combination_info`,
            {
                id:      3,
                jsonrpc: '2.0',
                method:  'call',
                params:  {
                    product_template_id: product.product_template_id,
                    product_id:         product.odoo_product_id,
                    combination:        [],
                    add_qty:            1,
                    parent_combination: [],
                },
            },
            { headers: { 'Content-Type': 'application/json', Referer: refererUrl } }
        );

        const result = response.data?.result;
        if (result?.list_price == null) return null;

        return {
            product_id:           product.product_id,
            product_template_id:  product.product_template_id,
            odoo_product_id:      product.odoo_product_id,
            list_price:           result.list_price,
            display_name:         result.display_name ?? null,
            finalUrl:             product.finalUrl,
        };
    } catch (err) {
        // Error silencioso por producto — el caller maneja el null
        return null;
    }
}

async function resolveAndFetchPrice(client, sitemapProduct) {
    const resolvedProduct = await resolveProductFromOdoo(client, sitemapProduct);
    if (!resolvedProduct) {
        return { status: 'resolve_failed', product: sitemapProduct };
    }

    const priceData = await fetchPriceFromOdoo(client, resolvedProduct);
    if (!priceData) {
        return { status: 'price_failed', product: resolvedProduct };
    }

    return { status: 'ok', product: priceData };
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHES CONCURRENTES CON SOPORTE DE CANCELACIÓN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta tasks en batches concurrentes.
 *
 * @param {Function[]} tasks      - Array de funciones async () => result
 * @param {number}     concurrency
 * @param {number}     delayMs    - Delay entre batches
 * @param {object}     [signal]   - { cancelled: false } — mutado por cancelJob()
 *
 * Si signal.cancelled es true al inicio de un batch, lanza un error para
 * interrumpir el loop. El error es capturado por checkPrices() y relanzado
 * para que scraperQueue lo registre como status 'cancelled'.
 */
async function runInBatchesWithProgress(tasks, concurrency, delayMs, signal) {
    const results = [];

    for (let i = 0; i < tasks.length; i += concurrency) {

        // ── Chequeo de cancelación ─────────────────────────────────────────
        if (signal?.cancelled) {
            throw new Error('Price check cancelado por solicitud del usuario.');
        }
        // ──────────────────────────────────────────────────────────────────

        const batch       = tasks.slice(i, i + concurrency);
        const batchResult = await Promise.all(batch.map(t => t()));
        results.push(...batchResult);

        if (i + concurrency < tasks.length) await delay(delayMs);
    }

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
            newIds:      result.new.map(p => p.product_id),
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
        const productTemplateId = extractTemplateIdFromUrl(url);
        return productTemplateId ? { product_template_id: productTemplateId, sourceUrl: url } : null;
    }).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARACIÓN PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta el price check completo.
 *
 * @param {object} [signal] - { cancelled: false } propagado desde scraperQueue.
 *   Si cancelJob() lo muta a true durante el loop de batches, se lanza un error
 *   que aborta el proceso. scraperQueue lo captura y registra el job como 'cancelled'.
 */
async function checkPrices(signal) {
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
        totalSitemap: sitemapProducts.length,
        totalDB:      dbMap.size,
        concurrency:  CONCURRENCY,
        requestDelay: REQUEST_DELAY,
    });
    console.log(`\n[priceChecker] ${sitemapProducts.length} URLs en sitemap | ${dbMap.size} productos en DB | concurrency:${CONCURRENCY} delay:${REQUEST_DELAY}ms`);

    // ── 4. Resolver IDs como scraper principal y consultar precios en Odoo ────
    const tasks = sitemapProducts.map(p => () => resolveAndFetchPrice(client, p));
    const checkResults = await runInBatchesWithProgress(tasks, CONCURRENCY, REQUEST_DELAY, signal);

    const odooMap = new Map();
    let resolveFailedCount = 0;
    let priceFailedCount = 0;

    for (const item of checkResults) {
        if (item.status === 'ok' && item.product) {
            odooMap.set(String(item.product.product_id), item.product);
        } else if (item.status === 'resolve_failed') {
            resolveFailedCount++;
        } else if (item.status === 'price_failed') {
            priceFailedCount++;
        }
    }

    const failedCount = resolveFailedCount + priceFailedCount;
    if (failedCount > 0) {
        await logToFile.warn(`${failedCount} productos no pudieron verificarse desde Odoo`, 'priceChecker', {
            resolveFailed: resolveFailedCount,
            priceFailed: priceFailedCount,
        });
    }

    // ── 5. Clasificar diferencias ────────────────────────────────────────────
    const changed  = [];
    const newProds = [];
    const removed  = [];

    for (const [productId, odooData] of odooMap) {
        const dbEntry = dbMap.get(productId);

        if (!dbEntry) {
            newProds.push({
                product_id:           productId,
                product_template_id:  odooData.product_template_id,
                odoo_product_id:      odooData.odoo_product_id,
                display_name:         odooData.display_name,
                list_price:           odooData.list_price,
                finalUrl:             odooData.finalUrl,
            });
            continue;
        }

        const oldPrice = Number(dbEntry.list_price);
        const newPrice = Number(odooData.list_price);

        if (Math.abs(oldPrice - newPrice) > 0.001) {
            const diff = newPrice - oldPrice;
            changed.push({
                product_id:           productId,
                product_template_id:  odooData.product_template_id,
                display_name:         dbEntry.display_name ?? odooData.display_name,
                old_price:            oldPrice,
                new_price:            newPrice,
                diff:                 parseFloat(diff.toFixed(2)),
                diff_percent: oldPrice > 0
                    ? parseFloat(((diff / oldPrice) * 100).toFixed(2))
                    : null,
            });
        }
    }

    const removedSkippedDueToFailures = failedCount > 0;
    if (!removedSkippedDueToFailures) {
        for (const [productId, dbEntry] of dbMap) {
            if (!odooMap.has(productId)) {
                removed.push({
                    product_id:   productId,
                    display_name: dbEntry.display_name,
                    list_price:   dbEntry.list_price,
                });
            }
        }
    } else {
        await logToFile.warn('Se omite cálculo de removed por fallos de resolución/precio para evitar falsos positivos.', 'priceChecker');
    }

    const durationMs = Date.now() - start;

    const result = {
        summary: {
            changed:    changed.length,
            new:        newProds.length,
            removed:    removed.length,
            total_odoo: odooMap.size,
            total_db:   dbMap.size,
            total_sitemap: sitemapProducts.length,
            failed:     failedCount,
            resolve_failed: resolveFailedCount,
            price_failed: priceFailedCount,
            removed_skipped: removedSkippedDueToFailures,
            checkedAt:  new Date().toISOString(),
            durationMs,
        },
        // Solo IDs en el webhook para no superar límites de payload
        changedIds:  changed.map(p => p.product_id),
        newIds:      newProds.map(p => p.product_id),
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