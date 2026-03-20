const axios   = require('axios');
const logToFile = require('../../utils/logToFile');
const { checkPrices } = require('../../scraper/priceChecker');

/**
 * Ejecuta el check de precios y notifica por webhook si se provee URL.
 *
 * El webhook recibe un payload liviano con solo IDs + summary.
 * El detalle completo (precios viejos/nuevos, nombres) queda persistido
 * en la colección price_check_results de MongoDB.
 */
async function runPriceCheck({ webhookUrl } = {}) {
    try {
        const result = await checkPrices();

        if (webhookUrl) {
            await _notifyWebhook(webhookUrl, {
                source:  'priceChecker',
                status:  'success',
                // Payload liviano: no incluye los arrays completos con nombres y precios
                summary:    result.summary,
                changedIds: result.changedIds,
                newIds:     result.newIds,
                removedIds: result.removedIds,
            });
        }

        return result;
    } catch (error) {
        await logToFile.error(`Error en runPriceCheck: ${error.message}`, 'priceCheckerService');

        if (webhookUrl) {
            await _notifyWebhook(webhookUrl, {
                source: 'priceChecker',
                status: 'error',
                error:  error.message,
            });
        }
        throw error;
    }
}

async function _notifyWebhook(webhookUrl, payload) {
    try {
        await axios.post(webhookUrl, { ...payload, timestamp: new Date().toISOString() });
        await logToFile.info('Webhook enviado', 'priceCheckerService', { status: payload.status });
    } catch (err) {
        await logToFile.error(`Error enviando webhook: ${err.message}`, 'priceCheckerService');
    }
}

module.exports = { runPriceCheck };
