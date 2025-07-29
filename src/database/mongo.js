const { MongoClient } = require('mongodb');

let collection = null;

async function connectToMongo() {
    if (collection) return collection;

    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    const db = client.db(process.env.MONGO_DB || 'scraping');
    collection = db.collection(process.env.MONGO_COLLECTION);
    return collection;
}

connectToMongo().catch(err => {
    console.error('Error conectando a MongoDB:', err);
    process.exit(1);
});

module.exports = { connectToMongo };
