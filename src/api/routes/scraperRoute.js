const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');
const { scraperStatusController, cancelJobController, cancelAllJobsController } = require('../controllers/scraperController');
const { checkPricesController } = require('../controllers/priceCheckerController');

// ── Scraper jobs ───────────────────────────────────────────────────────────
router.post('/category',         scraperController.categoryScraperController);
router.post('/sitemap',          scraperController.sitemapScraperController);
router.post('/sitemap/analysis', scraperController.analyzeSitemapController);
router.get('/status',            scraperStatusController);

// ── Price check ────────────────────────────────────────────────────────────
router.post('/check-prices', checkPricesController);

// ── Job cancellation ───────────────────────────────────────────────────────
// IMPORTANT: /jobs/all must be registered before /jobs/:jobId to prevent
// Express from interpreting "all" as a jobId parameter.
router.delete('/jobs/all',      cancelAllJobsController);
router.delete('/jobs/:jobId',   cancelJobController);

module.exports = router;
