const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhook.controller');

router.post('/notify', webhookController.notifyCompletion);

module.exports = router;
