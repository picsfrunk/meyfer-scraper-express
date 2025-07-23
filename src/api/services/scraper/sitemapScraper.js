// sitemapScraper.js
require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const logToFile = require('../../../utils/logToFile');
const config = require('../../../config/config');

const delay = ms => new Promise(res => setTimeout(res, ms));

const BASE_URL = config.baseUrl;
const MONGO_URI = config.mongoUrl;
const MONGO_DB = config.mongoDbName;
const MONGO_COLLECTION = config.mongoCollection;
const PAGE_DELAY_MS = config.pageDelay;

async function fetchSitemapUrls() {
    try {
        const { data } = await axios.get(`${BASE_URL}/sitemap.xml`);
        const urls = [];
        const $ = cheerio.load(data, { xmlMode: true });

        $('url > loc').each((_, el) => {
            const loc = $(el).text();
            if (loc.includes('/shop/')) {
                urls.push(loc);
                if (urls.length === 10) return false; // corta el .each de cheerio
            }
        });
        console.log(urls);

        return urls;
    } catch (err) {
        logToFile(`❌ Error al obtener sitemap: ${err.message}`);
        return [];
    }
}


async function scrapeProductFromUrl(url) {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);

        const jsonData = JSON.parse($('#product_details').attr('data-product') || '{}');
        const name = jsonData.name || $('h1.product_name').text();
        const price = jsonData.price || $('span.oe_price').text();
        const productId = jsonData.product_id || url.split('-').pop();
        const imageUrl = $('#product_detail img').attr('src')
            ? `${BASE_URL}${$('#product_detail img').attr('src')}`
            : null;

        return {
            product_id: Number(productId),
            display_name: name,
            list_price: parseFloat(price) || 0,
            image_url: imageUrl,
            source_url: url
        };
    } catch (err) {
        logToFile(`❌ Error scrapeando ${url}: ${err.message}`);
        return null;
    }
}

async function runSitemapScraper(pageDelay = PAGE_DELAY_MS) {
    const urls = await fetchSitemapUrls();
    if (!urls.length) return 0;

    const mongo = new MongoClient(MONGO_URI);
    await mongo.connect();
    const db = mongo.db(MONGO_DB);
    const collection = db.collection(MONGO_COLLECTION);

    let processed = 0;
    for (const url of urls) {
        const data = await scrapeProductFromUrl(url);
        if (data) {
            console.log(data)
            await collection.updateOne(
                { product_id: data.product_id },
                { $set: data },
                { upsert: true }
            );
            processed++;
            logToFile(`✔ Guardado desde sitemap: ${data.product_id} - ${data.display_name}`);
        }
        await delay(pageDelay);
    }

    await mongo.close();
    return processed;
}

module.exports = { runSitemapScraper };
