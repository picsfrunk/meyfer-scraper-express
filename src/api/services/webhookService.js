const axios = require('axios');

async function notifyWebhook({ webhookUrl, source, status, processed, timestamp }) {
    if (!webhookUrl) return;
    try {
        await axios.post(webhookUrl, {
            source,
            status,
            processed,
            timestamp: timestamp || new Date().toISOString(),
        });
    } catch (err) {
        console.error('[scraperService] Error notificando al webhook:', err.message);
    }
}

module.exports = {
    notifyWebhook
};
