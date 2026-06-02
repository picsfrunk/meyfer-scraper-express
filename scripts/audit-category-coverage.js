#!/usr/bin/env node

require('dotenv').config();

const { auditCategoryCoverage } = require('../src/scraper/scraper');

const DEFAULT_ISSUE_57_PRODUCT_IDS = [
    { product_id: '1027', product_template_id: '3587', name: 'tapa tanque 50 x 50 ultima unidad' },
    { product_id: '1673', product_template_id: '3007', name: 'aplicador de silicona reforzado aligas' },
    { product_id: '2008', product_template_id: '3559', name: 'silicona acetica blanca 250ml telplast' },
    { product_id: '2009', product_template_id: '3560', name: 'silicona acetica transparente 250ml telplast' },
    { product_id: '2043', product_template_id: '3558', name: 'silicona acetica negra 250ml telplast' },
    { product_id: '2434', product_template_id: '3729', name: 'termofusion llave de paso 20mm c cam poliamid' },
    { product_id: '2435', product_template_id: '3730', name: 'termofusion llave de paso 25mm c cam poliamid' },
    { product_id: '2470', product_template_id: '3788', name: 'base inodoro aro goma eco' },
    { product_id: '2543', product_template_id: '3925', name: 'valvula descarga doble acc aq d plus dealer' },
    { product_id: '2586', product_template_id: '4022', name: 'masilla p madera lapacho 90g congo' },
    { product_id: '2597', product_template_id: '4027', name: 'bomba centrifuga 1 2hp pluvius cpm130' },
    { product_id: '2598', product_template_id: '3984', name: 'bomba periferica 3 4hp pluvius qb70' },
    { product_id: '2599', product_template_id: '4023', name: 'masilla p madera nogal 220g mastic wood' },
    { product_id: '2600', product_template_id: '4024', name: 'masilla p madera roble 220g mastic wood' },
    { product_id: '2607', product_template_id: '4055', name: 'fratacho algarrobo 30 cm eco' },
    { product_id: '2608', product_template_id: '4056', name: 'fratacho algarrobo 35 cm eco' },
    { product_id: '2609', product_template_id: '4057', name: 'fratacho pino 30cm eco' },
    { product_id: '2610', product_template_id: '4058', name: 'fratacho pino 35 cm eco' },
    { product_id: '2623', product_template_id: '3989', name: 'barral p cortina madera kit 22mm x3 0mt' },
];

function readArg(name) {
    const prefix = `--${name}=`;
    const match = process.argv.find(arg => arg.startsWith(prefix));
    return match ? match.slice(prefix.length) : null;
}

function readBooleanArg(name, defaultValue) {
    const value = readArg(name);
    if (value === null) return defaultValue;
    return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function printUsage() {
    console.log(`
Uso:
  node scripts/audit-category-coverage.js [opciones]

Opciones:
  --product-ids=1027,1673   Audita IDs puntuales. Por defecto usa los 19 productos del issue #57.
  --all-missing=true        Audita todos los productos del sitemap ausentes en Mongo.
  --category-ids=all        Limita rubros, igual que CategoryProductStrategy.
  --limit-products=20       Limita productos recolectados desde páginas de categoría.
  --limit-categories=1      Limita rubros recorridos por CategoryProductStrategy.
  --auto-discovery=false    Usa src/config/rubros.js en vez de categorías descubiertas.
  --refresh-sitemap=true    Reanaliza SITEMAP_URL antes de comparar cobertura.
  --page-delay=250          Delay en ms entre validaciones de detalle/API.
  --no-mongo=true           Omite comparación contra Mongo; útil si solo se quiere cobertura sitemap/categorías.
  --help                    Muestra esta ayuda.
`);
}

async function main() {
    if (process.argv.includes('--help')) {
        printUsage();
        return;
    }

    const allMissing = readBooleanArg('all-missing', false);
    const productIdsArg = readArg('product-ids');
    const productIds = allMissing
        ? []
        : (productIdsArg ? productIdsArg.split(',') : []);
    const targetProducts = allMissing || productIdsArg ? [] : DEFAULT_ISSUE_57_PRODUCT_IDS;

    const report = await auditCategoryCoverage({
        categoryIds: readArg('category-ids') || 'all',
        useAutoDiscovery: readBooleanArg('auto-discovery', true),
        targetProductIds: productIds,
        targetProducts,
        pageDelay: Number(readArg('page-delay') || 0),
        limitProducts: readArg('limit-products'),
        limitCategories: readArg('limit-categories'),
        includeMongo: !readBooleanArg('no-mongo', false),
        forceRefreshSitemap: readBooleanArg('refresh-sitemap', false),
    });

    console.log(JSON.stringify(report, null, 2));
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch(error => {
        console.error('[category-audit] failed', error);
        process.exit(1);
    });
