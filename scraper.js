require('dotenv').config();
const config = require('./config');


const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');
const { wrapper } = require('axios-cookiejar-support');
const tough = require('tough-cookie');
const fs = require('fs');
const path = require('path');


// Delay helper
const delay = ms => new Promise(res => setTimeout(res, ms));

// Cargar variables de entorno correctamente
const BASE_URL = config.baseUrl;
const PAGE_DELAY_MS = config.pageDelay;
const CATEGORY_DELAY_MS = config.categoryDelay;
const MONGO_URI = config.mongoUrl;
const MONGO_DB = config.mongoDbName;
const MONGO_COLLECTION = config.mongoCollection;
const ODOO_USER = config.odooUser;
const ODOO_PASS = config.odooPass;
const ODOO_DB = config.odooDb;



// Rubros base
const RUBROS = [
    { id: 3, name: "Agua", pages: 26 },
    { id: 4, name: "Electricidad", pages: 1 },
    { id: 5, name: "Fijaciones", pages: 15 },
    { id: 6, name: "Gas", pages: 2 },
    { id: 118, name: "Grifería", pages: 2 },
    { id: 2, name: "Herramientas", pages: 22 },
    { id: 1, name: "Hogar/Jardin", pages: 9 },
    { id: 7, name: "Pinturería", pages: 6 },
    { id: 8, name: "Químicos", pages: 3 },
    { id: 116, name: "Repuestos", pages: 1 },
    { id: 10, name: "Zinguería", pages: 5 },
    { id: 9, name: "Saldos", pages: 1 },
];

// CLI parsing
const args = process.argv.slice(2);
const options = {
    rubros: [], // por defecto, todos
    pageDelay: PAGE_DELAY_MS,
    categoryDelay: CATEGORY_DELAY_MS
};

args.forEach(arg => {
    if (arg.startsWith("--rubros=")) {
        const val = arg.split("=")[1];
        options.rubros = val === 'all' ? 'all' : val.split(',').map(Number);
    }
    if (arg.startsWith("--pageDelay=")) {
        options.pageDelay = parseInt(arg.split("=")[1]);
    }
    if (arg.startsWith("--categoryDelay=")) {
        options.categoryDelay = parseInt(arg.split("=")[1]);
    }
});

// Logging
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
const LOG_FILE = path.join(LOG_DIR, `update-${new Date().toISOString().slice(0, 10)}.log`);
function logToFile(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`);
}

// Axios con cookies
const jar = new tough.CookieJar();
const client = wrapper(axios.create({ jar, withCredentials: true }));

async function loginToOdoo() {
    try {
        const res = await client.post(`${BASE_URL}/web/session/authenticate`, {
            jsonrpc: "2.0",
            method: "call",
            params: {
                db: ODOO_DB,
                login: ODOO_USER,
                password: ODOO_PASS,
            }
        }, {
            headers: { "Content-Type": "application/json" }
        });

        if (res.data.result?.uid) {
            console.log("✔ Login exitoso como:", ODOO_USER);
            logToFile(`✔ Login exitoso como: ${ODOO_USER}`);
            return true;
        } else {
            logToFile("❌ Falló el login.");
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

        $("form.oe_product_cart").each((_, el) => {
            const product_id = $(el).find("input[name='product_id']").val();
            const product_template_id = $(el).find("input[name='product_template_id']").val();
            if (product_id && product_template_id) {
                products.push({
                    product_id: Number(product_id),
                    product_template_id: Number(product_template_id)
                });
            }
        });

        return products;
    } catch (error) {
        logToFile(`❌ Error página ${page} rubro ${categoryId}: ${error.message}`);
        return [];
    }
}

async function getProductDetails(product, categoryId, categoryName) {
    try {
        const response = await client.post(
            `${BASE_URL}/website_sale/get_combination_info`,
            {
                id: 3,
                jsonrpc: "2.0",
                method: "call",
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
                    "Content-Type": "application/json",
                    Referer: `${BASE_URL}/shop/${product.product_template_id}`,
                },
            }
        );

        const data = response.data.result;
        const $ = cheerio.load(data.carousel || "");
        const imageUrl = $("img").attr("src")
            ? `${BASE_URL}${$("img").attr("src")}`
            : null;

        const brandMatch = data.display_name.match(/"(.*?)"/);
        const brand = brandMatch ? brandMatch[1].trim() : "generico";

        return {
            product_id: data.product_id,
            display_name: data.display_name,
            list_price: data.list_price,
            base_unit_name: data.base_unit_name,
            image_url: imageUrl,
            product_type: data.product_type,
            category_id: categoryId,
            category_name: categoryName,
            brand: brand
        };
    } catch (error) {
        logToFile(`❌ Error detalle producto ${product.product_id}: ${error.message}`);
        return null;
    }
}

// MAIN
async function main() {
    const rubrosFiltrados =
        options.rubros === 'all' || options.rubros.length === 0
            ? RUBROS
            : RUBROS.filter(r => options.rubros.includes(r.id));

    if (!rubrosFiltrados.length) {
        console.error("⚠️ Ningún rubro coincide.");
        return;
    }

    const loggedIn = await loginToOdoo();
    if (!loggedIn) return;

    const mongo = new MongoClient(MONGO_URI);
    await mongo.connect();
    const db = mongo.db(MONGO_DB);
    const collection = db.collection(MONGO_COLLECTION);

    let total = 0;

    for (const cat of rubrosFiltrados) {
        console.log(`📦 Rubro: ${cat.name} (${cat.id})`);
        logToFile(`== Rubro: ${cat.name} (${cat.id}) ==`);

        for (let page = 1; page <= cat.pages; page++) {
            console.log(`➡ Página ${page}/${cat.pages}`);
            logToFile(`→ Página ${page}/${cat.pages}`);

            const products = await getProductsFromCategoryPage(cat.id, page);

            for (const product of products) {
                const details = await getProductDetails(product, cat.id, cat.name);
                if (details) {
                    await collection.updateOne(
                        { product_id: details.product_id },
                        { $set: details },
                        { upsert: true }
                    );
                    total++;
                    logToFile(`✔ Guardado: ${details.product_id} - ${details.display_name}`);
                }
                await delay(options.pageDelay);
            }
        }
        await delay(options.categoryDelay);
    }

    await mongo.close();
    logToFile(`✅ Finalizado. Total productos: ${total}`);
    console.log("✅ Finalizado. Productos procesados:", total);
}

main().catch(err => {
    logToFile(`❌ Error general: ${err.message}`);
    console.error(err);
})