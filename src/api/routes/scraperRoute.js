const express = require('express');
const router = express.Router();
const scraperController = require('../controllers/scraperController');

router.post('/category', scraperController.runCategoryScraper );
router.post('/sitemap', scraperController.runSitemapScraper );

module.exports = router;