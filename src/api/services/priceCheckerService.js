const axios = require('axios');
const { checkPrices } = require('../../scraper/priceChecker');

/**
 * Ejecuta el check de precios y notifica por webhook si se provee URL.
 */
async function runPriceCheck({ webhookUrl } = {}) {
    try {
        const result = await checkPrices();

        if (webhookUrl) {
            await _notifyWebhook(webhookUrl, { source: 'priceChecker', status: 'success', result });
        }

        return result;
    } catch (error) {
        if (webhookUrl) {
            await _notifyWebhook(webhookUrl, { source: 'priceChecker', status: 'error', error: error.message });
        }
        throw error;
    }
}

async function _notifyWebhook(webhookUrl, payload) {
    try {
        await axios.post(webhookUrl, { ...payload, timestamp: new Date().toISOString() });
    } catch (err) {
        console.error('[priceCheckerService] Error enviando webhook:', err.message);
    }
}

module.exports = { runPriceCheck };