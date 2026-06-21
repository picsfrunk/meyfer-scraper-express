const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');
const { scraperStatusController, cancelJobController, cancelAllJobsController } = require('../controllers/scraperController');
const { checkPricesController } = require('../controllers/priceCheckerController');
const { processPriceListImportController } = require('../controllers/priceListImportController');

// ── Scraper jobs ───────────────────────────────────────────────────────────
router.post('/category',         scraperController.categoryScraperController);
router.post('/sitemap',          scraperController.sitemapScraperController);
router.post('/sitemap/analysis', scraperController.analyzeSitemapController);
router.get('/status',            scraperStatusController);

// ── Category maintenance ───────────────────────────────────────────────────
router.post('/categories/restore-official', scraperController.restoreOfficialCategoriesController);
router.post('/categories/reorganize',       scraperController.reorganizeCategoriesController);

// ── Price check ────────────────────────────────────────────────────────────
router.post('/check-prices', checkPricesController);

// ── Price list import ──────────────────────────────────────────────────────
router.post('/price-list-import/process/:jobId', processPriceListImportController);

// ── Job cancellation ───────────────────────────────────────────────────────
// IMPORTANT: /jobs/all must be registered before /jobs/:jobId to prevent
// Express from interpreting "all" as a jobId parameter.
router.delete('/jobs/all',      cancelAllJobsController);
router.delete('/jobs/:jobId',   cancelJobController);

module.exports = router;
