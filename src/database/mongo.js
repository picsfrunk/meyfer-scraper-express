const { MongoClient } = require('mongodb');

let collection = null;

async function connectToMongo() {
    if (collection) return collection;

    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect(); // Falla si Mongo no esta correctamente configurado
    const db = client.db(process.env.MONGO_DB || 'scraping');
    collection = db.collection(process.env.MONGO_COLLECTION);
    return collection;
}

module.exports = { connectToMongo };
