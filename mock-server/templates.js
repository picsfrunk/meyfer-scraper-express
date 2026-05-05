'use strict';

/**
 * templates.js
 * Generadores de HTML que replican exactamente la estructura de rhcomercial.com.ar
 * Los selectores usados por el scraper son:
 *   - form.oe_product_cart
 *   - input[name='product_id']
 *   - input[name='product_template_id']
 *   - h6.o_wsale_products_item_title (nombre del producto)
 *   - .pagination li.page-item.active a.page-link (página activa)
 *   - .pagination li.page-item:not(.disabled) a.page-link (todas las páginas)
 */

const { PRODUCTS_PER_PAGE } = require('./catalog');
const BASE_URL = process.env.MOCK_BASE_URL || 'http://localhost:3099';

// ─────────────────────────────────────────────────────────────────────────────
// Producto individual dentro de la grilla
// ─────────────────────────────────────────────────────────────────────────────

function renderProductCard(product, categoryId) {
    const href = `/shop/${product.sku}-${product.slug}-${product.product_template_id}?category=${categoryId}`;
    const imgSrc = `/web/image/product.template/${product.product_template_id}/image_512/mock?unique=abc123`;

    return `
<div class="oe_product  g-col-6 g-col-md-3 g-col-lg-3 " data-name="Producto">
    <div class="o_wsale_product_grid_wrapper position-relative h-100 o_wsale_product_grid_wrapper_1_1">
        <form action="/shop/cart/update" method="post" class="oe_product_cart h-100 d-flex" itemscope="itemscope" itemtype="http://schema.org/Product" data-publish="on">
            <div class="oe_product_image position-relative flex-grow-0 overflow-hidden">
                <a class="oe_product_image_link d-block position-relative" itemprop="url" contenteditable="false" href="${href}">
                    <span class="oe_product_image_img_wrapper d-flex h-100 justify-content-center align-items-center position-absolute">
                        <img src="${imgSrc}" itemprop="image" class="img img-fluid h-100 w-100 position-absolute" alt="${product.display_name}" loading="lazy" style="">
                    </span>
                </a>
            </div>
            <div class="o_wsale_product_information d-flex flex-column justify-content-between flex-grow-1 overflow-hidden">
                <div class="o_wsale_product_information_top">
                    <h6 class="o_wsale_products_item_title mb-2 text-break">
                        <a class="text-primary text-decoration-none text-primary-emphasis" itemprop="name" href="${href}" content="${product.display_name}">${product.display_name}</a>
                    </h6>
                    <div class="o_wsale_product_price">
                        <span class="h6 mb-0" data-oe-type="monetary">$&nbsp;<span class="oe_currency_value">${product.list_price.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></span>
                    </div>
                </div>
                <div class="o_wsale_product_btn">
                    <a href="${href}" class="btn btn-secondary btn-sm d-block mt-2 a-submit">Ver producto</a>
                </div>
            </div>
            <input name="product_id" type="hidden" value="${product.product_id}">
            <input name="product_template_id" type="hidden" value="${product.product_template_id}">
            <input name="csrf_token" type="hidden" value="mock_csrf_token">
        </form>
    </div>
</div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paginación
// ─────────────────────────────────────────────────────────────────────────────

function renderPagination(categorySlug, categoryId, currentPage, totalPages) {
    if (totalPages <= 1) return '';

    const baseUrl = `/shop/category/por-rubro-${categorySlug}-${categoryId}`;

    let items = '';

    // Prev
    if (currentPage > 1) {
        const href = currentPage === 2 ? baseUrl : `${baseUrl}/page/${currentPage - 1}`;
        items += `<li class="page-item"><a href="${href}" class="page-link">&laquo;</a></li>`;
    } else {
        items += `<li class="page-item disabled"><a class="page-link">&laquo;</a></li>`;
    }

    // Pages
    for (let p = 1; p <= totalPages; p++) {
        const href = p === 1 ? baseUrl : `${baseUrl}/page/${p}`;
        const active = p === currentPage ? ' active' : '';
        items += `<li class="page-item${active}"><a href="${href}" class="page-link">${p}</a></li>`;
    }

    // Next
    if (currentPage < totalPages) {
        const href = `${baseUrl}/page/${currentPage + 1}`;
        items += `<li class="page-item"><a href="${href}" class="page-link">&raquo;</a></li>`;
    } else {
        items += `<li class="page-item disabled"><a class="page-link">&raquo;</a></li>`;
    }

    return `<ul class=" pagination m-0 ">${items}</ul>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Página de categoría completa
// ─────────────────────────────────────────────────────────────────────────────

function renderCategoryPage(products, category, currentPage, totalPages) {
    const productCards = products.map(p => renderProductCard(p, category.id)).join('\n');
    const pagination   = renderPagination(category.slug, category.id, currentPage, totalPages);

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mock Odoo — ${category.name}</title>
</head>
<body>
<header class="o_main_navbar">
    <nav class="navbar navbar-expand-lg">
        <a class="navbar-brand" href="/">RH Comercial MOCK</a>
    </nav>
</header>

<main>
    <div class="container">
        <div class="row">
            <!-- Sidebar de categorías -->
            <div class="col-lg-3">
                <div id="o_wsale_categories">
                    <h6 class="o_categories_collapse_title accordion-header">
                        <button class="accordion-button px-0 bg-transparent shadow-none" type="button">Categorías</button>
                    </h6>
                </div>
            </div>

            <!-- Grilla de productos -->
            <div class="col-lg-9">
                <div class="o_wsale_products_grid_table grid">
                    ${productCards}
                </div>

                <!-- Paginación -->
                <div class="o_wsale_products_page_controls text-center mt-4">
                    ${pagination}
                </div>
            </div>
        </div>
    </div>
</main>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Página de detalle de producto (/shop/:id → redirect a /shop/slug-id)
// ─────────────────────────────────────────────────────────────────────────────

function renderProductDetailPage(product) {
    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>${product.display_name}</title>
</head>
<body>
<main id="wrapwrap">
    <div class="container">
        <section id="product_detail">
            <div class="row">
                <div class="col-lg-7 o_product_images">
                    <!-- imagen -->
                </div>
                <div class="col-lg-5 o_product_info">
                    <h1 itemprop="name">${product.display_name}</h1>
                    <form action="/shop/cart/update" method="post">
                        <input name="product_id" type="hidden" value="${product.product_id}">
                        <input name="product_template_id" type="hidden" value="${product.product_template_id}">
                    </form>
                </div>
            </div>
        </section>
    </div>
</main>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Página de login
// ─────────────────────────────────────────────────────────────────────────────

function renderLoginPage(error = null) {
    const errorHtml = error
        ? `<div class="alert alert-danger">${error}</div>`
        : '';

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>Login — Mock Odoo</title>
    <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
        .login-card { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.1); width: 360px; }
        h2 { text-align: center; margin-bottom: 24px; color: #333; }
        .form-group { margin-bottom: 16px; }
        label { display: block; margin-bottom: 6px; font-weight: 600; color: #555; }
        input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
        button { width: 100%; padding: 12px; background: #714B67; color: white; border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
        button:hover { background: #5a3a52; }
        .alert-danger { background: #f8d7da; color: #721c24; padding: 10px; border-radius: 4px; margin-bottom: 16px; }
        .badge { text-align: center; margin-top: 16px; font-size: 12px; color: #999; }
    </style>
</head>
<body>
<div class="login-card">
    <h2>🔧 Mock Odoo</h2>
    ${errorHtml}
    <form method="POST" action="/web/login">
        <div class="form-group">
            <label>Usuario</label>
            <input type="text" name="login" placeholder="usuario@ejemplo.com" autocomplete="username">
        </div>
        <div class="form-group">
            <label>Contraseña</label>
            <input type="password" name="password" placeholder="••••••••" autocomplete="current-password">
        </div>
        <input type="hidden" name="db" value="mock_db">
        <button type="submit">Iniciar sesión</button>
    </form>
    <div class="badge">Mock server — cualquier usuario/contraseña funciona</div>
</div>
</body>
</html>`;
}

module.exports = { renderCategoryPage, renderProductDetailPage, renderLoginPage, PRODUCTS_PER_PAGE };
