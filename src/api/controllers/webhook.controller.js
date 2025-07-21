const webhookService = require('../services/webhook.service');

const notifyCompletion = async (req, res) => {
    try {
        const { task, result } = req.body;

        await webhookService.sendWebhook({ task, result });

        res.status(200).json({ status: 'ok', message: 'Webhook sent' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
};

module.exports = {
    notifyCompletion
};
