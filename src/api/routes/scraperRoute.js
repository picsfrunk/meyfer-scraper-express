const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');

router.post('/category', scraperController.categoryScraperController );
router.post('/sitemap', scraperController.sitemapScraperController );
router.post('/sitemap/analysis', scraperController.analyzeSitemapController );

module.exports = router;