const mongoose = require('mongoose');

const scrapedProductSchema = new mongoose.Schema({
    product_id: {
        type: String,
        required: true,
        unique: true
    },
    base_unit_name: {
        type: String,
        required: true
    },
    category_id: {
        type: Number,
        required: true,
        index: true
    },
    display_name: {
        type: String,
        required: true
    },
    image_url: {
        type: String
    },
    list_price: {
        type: Number,
        required: true
    },
    final_price: {
        type: Number,
        required: true
    },
    product_type: {
        type: String
    },
    brand: {
        type: String
    },
    category_name: {
        type: String
    }
}, {
    collection: 'scraped-products',
    timestamps: true
});

scrapedProductSchema.index({
    display_name: 'text',
    brand: 'text',
    product_type: 'text'
});

module.exports = mongoose.model('ScrapedProduct', scrapedProductSchema);