const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');
const { scraperStatusController } = require('../controllers/scraperController');
const { checkPricesController } = require('../controllers/priceCheckerController');

// ── Scraper jobs ───────────────────────────────────────────────────────────
router.post('/category',         scraperController.categoryScraperController);
router.post('/sitemap',          scraperController.sitemapScraperController);
router.post('/sitemap/analysis', scraperController.analyzeSitemapController);
router.get('/status',            scraperStatusController);

// ── Price check ────────────────────────────────────────────────────────────
router.post('/check-prices', checkPricesController);

module.exports = router;
