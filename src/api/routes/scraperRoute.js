const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');
const {scraperStatusController} = require("../controllers/scraperController");
const { checkPricesController } = require('../controllers/priceCheckerController');

router.post('/check-prices', checkPricesController);
router.post('/category', scraperController.categoryScraperController );
router.post('/sitemap', scraperController.sitemapScraperController );
router.post('/sitemap/analysis', scraperController.analyzeSitemapController );
router.get('/status', scraperStatusController);

module.exports = router;