const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');
const { scraperStatusController } = require('../controllers/scraperController');
const { checkPricesController } = require('../controllers/priceCheckerController');
const priceCheckHistoryController = require('../controllers/priceCheckHistoryController');

// ── Scraper jobs ───────────────────────────────────────────────────────────
router.post('/category',         scraperController.categoryScraperController);
router.post('/sitemap',          scraperController.sitemapScraperController);
router.post('/sitemap/analysis', scraperController.analyzeSitemapController);
router.get('/status',            scraperStatusController);

// ── Price check ────────────────────────────────────────────────────────────
router.post('/check-prices',              checkPricesController);
router.get('/price-check/latest',         priceCheckHistoryController.getLatest);
router.get('/price-check/history',        priceCheckHistoryController.getHistory);
router.get('/price-check/history/:id',    priceCheckHistoryController.getById);

module.exports = router;