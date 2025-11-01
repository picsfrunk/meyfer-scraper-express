// mongo.js
const { MongoClient } = require('mongodb');

let db = null;

async function getDB() {
    if (db) return db;

    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    db = client.db(process.env.MONGO_DB || 'meyfer-scraping');
    return db;
}

async function getConfigCollection() {
    const database = await getDB();
    return database.collection('configs');
}

async function getScrapedCollection() {
    const database = await getDB();
    return database.collection(process.env.MONGO_COLLECTION || 'scraped-products');
}

async function getSitemapCollection() {
    const database = await getDB();
    return database.collection(process.env.SITEMAP_COLLECTION || 'sitemap_analysis');
}

async function getLogsCollection() {
    const database = await getDB();
    return database.collection('application_logs');
}

module.exports = {
    getDB,
    getConfigCollection,
    getScrapedCollection,
    getSitemapCollection,
    getLogsCollection
};