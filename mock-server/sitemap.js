'use strict';

/**
 * sitemap.js
 * Genera un sitemap XML que replica el formato de rhcomercial.com.ar/sitemap.xml
 * El scraper usa estos patrones:
 *   - Productos:    /shop/\d+-slug (productPattern)
 *   - Marcas:       /shop/category/por-marca-slug-id
 *   - Categorías:   /shop/category/por-rubro-slug-id
 */

const { ALL_PRODUCTS, CATEGORIES } = require('./catalog');

const BASE = process.env.MOCK_BASE_URL || 'http://localhost:3099';

// Marcas extraídas de los productos
const BRANDS_USED = [...new Set(ALL_PRODUCTS.map(p => p.brand))];

function generateSitemap() {
    const urls = [];

    // Páginas estáticas
    urls.push(`${BASE}/`);
    urls.push(`${BASE}/shop`);

    // Categorías (por-rubro)
    for (const cat of CATEGORIES) {
        urls.push(`${BASE}/shop/category/por-rubro-${cat.slug}-${cat.id}`);
    }

    // Marcas (por-marca)
    BRANDS_USED.forEach((brand, idx) => {
        const slug = brand.toLowerCase().replace(/[^a-z0-9]/g, '-');
        urls.push(`${BASE}/shop/category/por-marca-${slug}-${100 + idx}`);
    });

    // Productos — formato: /shop/sku-slug-templateId
    for (const p of ALL_PRODUCTS) {
        urls.push(`${BASE}/shop/${p.sku}-${p.slug}-${p.product_template_id}`);
    }

    const urlEntries = urls
        .map(loc => `  <url>\n    <loc>${loc}</loc>\n  </url>`)
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlEntries}
</urlset>`;
}

module.exports = { generateSitemap };
