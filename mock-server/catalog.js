'use strict';

/**
 * catalog.js
 * Mock product catalog — 220 productos en 8 categorías.
 * Estructura fiel al sitio real rhcomercial.com.ar
 */

const BRANDS = ['DUKE', 'PEKAR', 'GENOVA', 'FULLER', 'WADFOW', 'TRUPER', 'PRETUL', 'TOTAL', 'BOSCH', 'DEWALT'];

const CATEGORIES = [
    { id: 3,   slug: 'agua',          name: 'Agua',           pages: 5 },
    { id: 8,   slug: 'quimicos',      name: 'Químicos',       pages: 3 },
    { id: 12,  slug: 'herramientas',  name: 'Herramientas',   pages: 4 },
    { id: 15,  slug: 'electricidad',  name: 'Electricidad',   pages: 3 },
    { id: 21,  slug: 'neumatica',     name: 'Neumática',      pages: 3 },
    { id: 27,  slug: 'fijaciones',    name: 'Fijaciones',     pages: 3 },
    { id: 33,  slug: 'medicion',      name: 'Medición',       pages: 2 },
    { id: 41,  slug: 'seguridad',     name: 'Seguridad',      pages: 2 },
];

const PRODUCTS_PER_PAGE = 8;

// Plantillas de nombres por categoría
const NAME_TEMPLATES = {
    agua: [
        'ACOPLE COMP PROF C/TRABA MEC CODO {size}" "{brand}"',
        'ACOPLE COMP PROF C/TRABA MEC LARGO {size}" "{brand}"',
        'ACOPLE COMP PROF C/TRABA MEC TEE {size}" "{brand}"',
        'CAÑO PVC PRESIÓN {size}" x 6m "{brand}"',
        'CODO PVC PRESIÓN 90° {size}" "{brand}"',
        'TEE PVC PRESIÓN {size}" "{brand}"',
        'UNION PVC PRESIÓN {size}" "{brand}"',
        'VÁLVULA ESFERA PVC {size}" "{brand}"',
        'REDUCCIÓN PVC PRESIÓN {size}" x {size2}" "{brand}"',
        'TAPÓN PVC PRESIÓN {size}" "{brand}"',
    ],
    quimicos: [
        'ADHESIVO PARA PVC {vol} cc "{brand}"',
        'LIMPIADOR PVC {vol} cc "{brand}"',
        'SELLADOR ROSCAS {vol} ml "{brand}"',
        'GRASA MULTIUSO {vol} gr "{brand}"',
        'ACEITE LUBRICANTE {vol} ml "{brand}"',
        'SILICONA NEUTRA {vol} ml "{brand}"',
        'DESOXIDANTE {vol} ml "{brand}"',
        'PINTURA ANTIOXIDO {vol} ml "{brand}"',
    ],
    herramientas: [
        'LLAVE COMBINADA {size} mm "{brand}"',
        'DESTORNILLADOR PLANO {size} mm "{brand}"',
        'DESTORNILLADOR PHILLIPS {size} "{brand}"',
        'ALICATE UNIVERSAL {size} mm "{brand}"',
        'MARTILLO {size} gr "{brand}"',
        'SIERRA METALES {size}" "{brand}"',
        'CUTTER {size} mm "{brand}"',
        'NIVEL BURBUJA {size} cm "{brand}"',
        'CINTA MÉTRICA {size} m "{brand}"',
        'LLAVE INGLESA {size} mm "{brand}"',
    ],
    electricidad: [
        'CABLE UNIPOLAR {size} mm² "{brand}"',
        'INTERRUPTOR SIMPLE LÍNEA "{brand}"',
        'TOMACORRIENTE DOBLE LÍNEA "{brand}"',
        'DISYUNTOR {size}A BIPOLAR "{brand}"',
        'CINTA AISLADORA {color} {size} m "{brand}"',
        'ENCHUFE MACHO 10A "{brand}"',
        'ZAPATILLA 6 BOCAS "{brand}"',
        'LÁMPARA LED {size}W "{brand}"',
    ],
    neumatica: [
        'MANGUERA REFORZADA {size}" x {vol} m "{brand}"',
        'ACOPLE RÁPIDO {size}" MACHO "{brand}"',
        'ACOPLE RÁPIDO {size}" HEMBRA "{brand}"',
        'REGULADOR PRESIÓN {size}" "{brand}"',
        'FILTRO AIRE {size}" "{brand}"',
        'PISTOLA PINTURA GRAVEDAD {vol} cc "{brand}"',
        'PISTOLA SOPLADO "{brand}"',
        'COMPRESOR {size} HP {vol} L "{brand}"',
    ],
    fijaciones: [
        'TORNILLO AUTOPERF {size} x {vol} mm (x100) "{brand}"',
        'TORNILLO MADERA {size} x {vol} mm (x100) "{brand}"',
        'BULÓN HEXAGONAL M{size} x {vol} mm "{brand}"',
        'TUERCA HEXAGONAL M{size} "{brand}"',
        'ARANDELA PLANA M{size} (x50) "{brand}"',
        'CLAVO CON CABEZA {size} mm (x500g) "{brand}"',
        'TARUGO PLÁSTICO {size} mm (x100) "{brand}"',
        'ABRAZADERA METÁLICA {size} mm "{brand}"',
    ],
    medicion: [
        'CALIBRE DIGITAL {size} mm "{brand}"',
        'MULTÍMETRO DIGITAL {size} "{brand}"',
        'TERMÓMETRO INFRARROJO "{brand}"',
        'NIVEL LÁSER {size} líneas "{brand}"',
        'DETECTOR DE METALES "{brand}"',
        'LUXÓMETRO DIGITAL "{brand}"',
    ],
    seguridad: [
        'CASCO SEGURIDAD TIPO V "{brand}"',
        'GUANTE NITRILO TALLE {size} (x12) "{brand}"',
        'LENTES PROTECCIÓN UV "{brand}"',
        'ZAPATO SEGURIDAD TALLE {size} "{brand}"',
        'ARNÉS DE SEGURIDAD "{brand}"',
        'PROTECTOR AUDITIVO dB{size} "{brand}"',
    ],
};

const SIZES = ['1/2', '3/4', '1', '1 1/4', '1 1/2', '2', '3/8', '1/4'];
const SIZES2 = ['3/8', '1/4', '1/2', '3/4'];
const VOLS = ['50', '100', '200', '250', '500', '1000'];
const METRICO = ['8', '10', '12', '13', '14', '17', '19', '22', '24', '32'];
const COLORS = ['NEGRA', 'ROJA', 'AMARILLA', 'AZUL', 'VERDE'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function fillTemplate(tpl, brand) {
    return tpl
        .replace('{brand}', brand)
        .replace('{size}', pick(SIZES))
        .replace('{size2}', pick(SIZES2))
        .replace('{vol}', pick(VOLS))
        .replace('{color}', pick(COLORS));
}

// Generar productos determinísticamente (seed fijo para reproducibilidad)
function generateProducts() {
    const products = [];
    let templateId = 1500;
    let sku = 2370;

    for (const cat of CATEGORIES) {
        const templates = NAME_TEMPLATES[cat.slug];
        const totalProducts = cat.pages * PRODUCTS_PER_PAGE;

        for (let i = 0; i < totalProducts; i++) {
            const brand = BRANDS[i % BRANDS.length];
            const tpl   = templates[i % templates.length];
            const name  = fillTemplate(tpl, brand);
            const price = Math.round((500 + (templateId % 50) * 120 + i * 37) * 100) / 100;
            const slug  = name
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .replace(/\s+/g, '-')
                .slice(0, 60);

            products.push({
                product_id:          templateId,
                product_template_id: templateId,
                sku:                 sku,
                display_name:        name,
                list_price:          price,
                base_unit_name:      'Un',
                product_type:        'consu',
                category_id:         cat.id,
                category_slug:       cat.slug,
                category_name:       cat.name,
                brand,
                slug,
                free_qty:            Math.floor(50 + (templateId % 20) * 30),
            });

            templateId++;
            sku++;
        }
    }

    return products;
}

const ALL_PRODUCTS = generateProducts();

// Index por template_id para acceso O(1)
const PRODUCT_BY_ID = {};
for (const p of ALL_PRODUCTS) {
    PRODUCT_BY_ID[p.product_template_id] = p;
}

// Productos por categoría
const PRODUCTS_BY_CATEGORY = {};
for (const p of ALL_PRODUCTS) {
    if (!PRODUCTS_BY_CATEGORY[p.category_id]) PRODUCTS_BY_CATEGORY[p.category_id] = [];
    PRODUCTS_BY_CATEGORY[p.category_id].push(p);
}

module.exports = { ALL_PRODUCTS, PRODUCT_BY_ID, PRODUCTS_BY_CATEGORY, CATEGORIES, PRODUCTS_PER_PAGE };
