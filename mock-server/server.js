'use strict';

/**
 * server.js — Mock Odoo para testear el scraper MeyFer
 *
 * Endpoints simulados:
 *   POST /web/session/authenticate         → login JSON-RPC (usado por scraper)
 *   POST /web/login                        → login form (redirige a /my)
 *   GET  /sitemap.xml                      → sitemap con todos los productos
 *   GET  /shop/category/por-rubro-:slug-:id/page/:page  → grilla de productos
 *   GET  /shop/category/por-rubro-:slug-:id             → grilla página 1
 *   GET  /shop/:templateId                 → redirige a URL canónica del producto
 *   GET  /shop/:sku-:slug-:id              → página de detalle del producto
 *   POST /website_sale/get_combination_info → datos del producto (precio, imagen, etc.)
 *   GET  /web/image/...                    → imagen placeholder
 */

require('dotenv').config();
const express    = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');

const { ALL_PRODUCTS, PRODUCT_BY_ID, PRODUCTS_BY_CATEGORY, CATEGORIES, PRODUCTS_PER_PAGE } = require('./catalog');
const { renderCategoryPage, renderProductDetailPage, renderLoginPage } = require('./templates');
const { generateSitemap } = require('./sitemap');

const app  = express();
const PORT = process.env.MOCK_PORT || 3099;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Sesiones en memoria (session_id → { uid, login })
const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────────

function log(method, path, note = '') {
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] ${method.padEnd(4)} ${path}${note ? '  →  ' + note : ''}`);
}

function isAuthenticated(req) {
    const sid = req.cookies?.session_id;
    return sid && sessions.has(sid);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — POST /web/session/authenticate  (JSON-RPC, usado por el scraper)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/web/session/authenticate', (req, res) => {
    const { login, password, db } = req.body?.params || {};
    log('POST', '/web/session/authenticate', `login=${login}`);

    // Acepta cualquier credencial — es un mock
    if (!login || !password) {
        return res.json({
            jsonrpc: '2.0',
            id: req.body?.id ?? 0,
            result: { uid: false, message: 'Credenciales requeridas' },
        });
    }

    const sessionId = uuidv4();
    const uid = 1000 + sessions.size;
    sessions.set(sessionId, { uid, login, db: db || 'mock_db' });

    res.cookie('session_id', sessionId, { httpOnly: true });

    res.json({
        jsonrpc: '2.0',
        id: req.body?.id ?? 0,
        result: {
            uid,
            login,
            db: db || 'mock_db',
            session_id: sessionId,
            name: 'Mock User',
            partner_id: [uid, 'Mock User'],
            company_id: [1, 'Mock Company'],
        },
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — POST /web/login  (form POST, redirige a /my)
// ─────────────────────────────────────────────────────────────────────────────

app.post('/web/login', (req, res) => {
    const { login, password } = req.body;
    log('POST', '/web/login', `login=${login}`);

    const sessionId = uuidv4();
    sessions.set(sessionId, { uid: 1001, login });
    res.cookie('session_id', sessionId, { httpOnly: true });
    res.redirect(303, '/my');
});

app.get('/my', (req, res) => {
    res.send('<html><body><h1>Mock — Portal del usuario</h1><a href="/shop">Ver tienda</a></body></html>');
});

app.get('/web/login', (req, res) => {
    res.send(renderLoginPage());
});

// ─────────────────────────────────────────────────────────────────────────────
// SITEMAP
// ─────────────────────────────────────────────────────────────────────────────

app.get('/sitemap.xml', (req, res) => {
    log('GET', '/sitemap.xml', `${ALL_PRODUCTS.length} productos`);
    res.type('application/xml').send(generateSitemap());
});

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORÍAS — GET /shop/category/por-rubro-:slug-:id[/page/:page]
// ─────────────────────────────────────────────────────────────────────────────

function handleCategoryPage(req, res) {
    const { slug, id } = req.params;
    const page     = parseInt(req.params.page) || 1;
    const catId    = parseInt(id);
    const category = CATEGORIES.find(c => c.id === catId);

    if (!category) {
        log('GET', req.path, `404 — categoría ${catId} no encontrada`);
        return res.status(404).send('<html><body><h1>Categoría no encontrada</h1></body></html>');
    }

    const allCatProducts = PRODUCTS_BY_CATEGORY[catId] || [];
    const totalPages     = Math.ceil(allCatProducts.length / PRODUCTS_PER_PAGE);

    // page=999 → scraper detecta número máximo de páginas
    if (page > totalPages) {
        const lastPageProducts = allCatProducts.slice(
            (totalPages - 1) * PRODUCTS_PER_PAGE,
            totalPages * PRODUCTS_PER_PAGE
        );
        log('GET', req.path, `page=${page} > totalPages=${totalPages} → devolviendo última`);
        // Renderizamos con currentPage=totalPages para que la paginación
        // muestre la última página como activa — el scraper lee eso para
        // determinar cuántas páginas tiene la categoría
        return res.send(renderCategoryPage(lastPageProducts, category, totalPages, totalPages));
    }

    const start    = (page - 1) * PRODUCTS_PER_PAGE;
    const products = allCatProducts.slice(start, start + PRODUCTS_PER_PAGE);

    log('GET', req.path, `cat=${category.name} page=${page}/${totalPages} productos=${products.length}`);
    res.send(renderCategoryPage(products, category, page, totalPages));
}

app.get('/shop/category/por-rubro-:slug-:id/page/:page', handleCategoryPage);
app.get('/shop/category/por-rubro-:slug-:id', handleCategoryPage);

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTO INDIVIDUAL — GET /shop/:templateId  → redirect a URL canónica
// El scraper hace GET /shop/{product_template_id} y sigue el redirect
// para obtener la URL final de la que extrae el customId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /shop/:param
 *
 * Dos casos:
 *   1. Puramente numérico (/shop/1503) → el scraper viene acá desde SitemapStrategy.
 *      Redirige a la URL canónica /shop/sku-slug-id para que el scraper
 *      pueda extraer el customId desde la responseUrl.
 *
 *   2. Con slug (/shop/2374-acople-...-1503) → URL canónica del producto.
 *      Devuelve la página de detalle con los inputs product_id/product_template_id.
 */
app.get('/shop/:param', (req, res) => {
    const param = req.params.param;

    // ── Caso 1: numérico puro → redirect ────────────────────────────────────
    if (/^\d+$/.test(param)) {
        const templateId = parseInt(param);
        const product    = PRODUCT_BY_ID[templateId];

        if (!product) {
            log('GET', req.path, `404 — templateId ${templateId}`);
            return res.status(404).send('<html><body><h1>Producto no encontrado</h1></body></html>');
        }

        const canonicalUrl = `/shop/${product.sku}-${product.slug}-${product.product_template_id}`;
        log('GET', req.path, `redirect → ${canonicalUrl}`);
        return res.redirect(302, canonicalUrl);
    }

    // ── Caso 2: slug → extraer templateId del final de la URL ───────────────
    const match = param.match(/-(\d+)$/);
    if (!match) {
        return res.status(404).send('<html><body><h1>Producto no encontrado</h1></body></html>');
    }

    const templateId = parseInt(match[1]);
    const product    = PRODUCT_BY_ID[templateId];

    if (!product) {
        log('GET', req.path, `404 — templateId ${templateId}`);
        return res.status(404).send('<html><body><h1>Producto no encontrado</h1></body></html>');
    }

    log('GET', req.path, product.display_name);
    res.send(renderProductDetailPage(product));
});

// ─────────────────────────────────────────────────────────────────────────────
// API PRECIO — POST /website_sale/get_combination_info
// Replica exactamente el JSON del sitio real
// ─────────────────────────────────────────────────────────────────────────────

app.post('/website_sale/get_combination_info', (req, res) => {
    const { product_template_id, product_id } = req.body?.params || {};
    const tid     = parseInt(product_template_id || product_id);
    const product = PRODUCT_BY_ID[tid];

    if (!product) {
        log('POST', '/website_sale/get_combination_info', `404 — templateId ${tid}`);
        return res.json({
            jsonrpc: '2.0',
            id: req.body?.id ?? 0,
            result: null,
        });
    }

    log('POST', '/website_sale/get_combination_info', `${product.display_name} → $${product.list_price}`);

    const imgPath = `/web/image/product.product/${product.product_id}/image_1024/mock?unique=abc123`;
    const carousel = `
        <div id="o-carousel-product" data-bs-ride="true" class=" carousel slide position-sticky mb-3 overflow-hidden" data-name="Carrusel de productos">
            <div class="o_carousel_product_outer carousel-outer position-relative d-flex align-items-center w-100 overflow-hidden">
                <div class="carousel-inner h-100">
                        <div class="carousel-item h-100 text-center active">
        <div class="position-relative d-inline-flex overflow-hidden m-auto w-100">
            <span class="o_ribbon d-none z-1" style=""></span>
            <div name="o_img_with_max_suggested_width" class="d-flex align-items-start justify-content-center w-100 oe_unmovable"><img src="${imgPath}" class="img img-fluid oe_unmovable product_detail_img w-100" alt="${product.display_name}" loading="lazy"/></div>
        </div>
                        </div>
                </div>
            </div>
        </div>`;

    res.json({
        jsonrpc: '2.0',
        id: req.body?.id ?? 0,
        result: {
            product_id:              product.product_id,
            product_template_id:     product.product_template_id,
            display_name:            product.display_name,
            display_image:           true,
            is_combination_possible: true,
            parent_exclusions:       {},
            list_price:              product.list_price,
            price:                   product.list_price,
            has_discounted_price:    false,
            compare_list_price:      null,
            price_extra:             0.0,
            prevent_zero_price_sale: false,
            base_unit_name:          product.base_unit_name,
            base_unit_price:         0.0,
            product_type:            product.product_type,
            allow_out_of_stock_order: true,
            available_threshold:     5.0,
            free_qty:                product.free_qty,
            cart_qty:                0,
            uom_name:                product.base_unit_name,
            uom_rounding:            0.01,
            show_availability:       false,
            out_of_stock_message:    false,
            has_stock_notification:  false,
            stock_notification_email: '',
            is_in_wishlist:          false,
            currency_precision:      2,
            carousel,
            product_tags:            '<div class="o_product_tags o_field_tags d-flex flex-wrap align-items-center gap-2 mb-2 mt-1"></div>',
            is_storable:             true,
        },
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// IMÁGENES — placeholder SVG
// ─────────────────────────────────────────────────────────────────────────────

app.get('/web/image/*', (req, res) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#f0f0f0"/>
  <text x="100" y="105" text-anchor="middle" font-family="Arial" font-size="14" fill="#999">MOCK IMG</text>
</svg>`;
    res.type('image/svg+xml').send(svg);
});

// ─────────────────────────────────────────────────────────────────────────────
// HOME + SHOP
// ─────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    const catLinks = CATEGORIES
        .map(c => `<li><a href="/shop/category/por-rubro-${c.slug}-${c.id}">${c.name} (${(PRODUCTS_BY_CATEGORY[c.id] || []).length} productos)</a></li>`)
        .join('\n');

    res.send(`<!DOCTYPE html>
<html><head><title>Mock Odoo</title></head>
<body>
<h1>🔧 Mock Odoo — MeyFer Scraper Test</h1>
<p>Servidor mock corriendo en puerto ${PORT}</p>
<h2>Categorías disponibles</h2>
<ul>${catLinks}</ul>
<h2>Endpoints útiles</h2>
<ul>
    <li><a href="/sitemap.xml">sitemap.xml</a> — ${ALL_PRODUCTS.length} productos</li>
    <li>POST /web/session/authenticate — login JSON-RPC</li>
    <li>POST /website_sale/get_combination_info — precio/detalle</li>
</ul>
</body></html>`);
});

app.get('/shop', (req, res) => res.redirect('/'));

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`\n🔧 Mock Odoo corriendo en http://localhost:${PORT}`);
    console.log(`   Productos: ${ALL_PRODUCTS.length}`);
    console.log(`   Categorías: ${CATEGORIES.length}`);
    console.log(`   Sitemap: http://localhost:${PORT}/sitemap.xml\n`);
});

module.exports = app;
