const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');

router.post('/category', scraperController.categoryScraperController );
router.post('/sitemap', scraperController.sitemapScraperController );

module.exports = router;