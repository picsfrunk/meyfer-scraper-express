require('dotenv').config();

module.exports = {
  mongoUrl: process.env.MONGO_URI,
  mongoDbName: process.env.MONGO_DB,
  mongoCollection: process.env.MONGO_COLLECTION,
  odooUser: process.env.ODOO_USER,
  odooPass: process.env.ODOO_PASS,
  odooDb: process.env.ODOO_DB,
  baseUrl: process.env.BASE_URL,
  pageDelay: parseInt(process.env.PAGE_DELAY_MS || "1500"),
  categoryDelay: parseInt(process.env.CATEGORY_DELAY_MS || "5000")
};
