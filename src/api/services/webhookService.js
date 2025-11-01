const axios = require('axios');

/**
 * Envía una notificación al webhook con información del scraping.
 * @param {Object} params
 * @param {string} params.webhookUrl - URL destino del webhook
 * @param {string} params.source - Nombre del proceso (sitemapScraper | categoryScraper)
 * @param {string} params.status - Estado final del proceso (success | error)
 * @param {Object} [params.result] - Objeto devuelto por el scraper
 * @param {number} [params.processed] - Cantidad procesada (para compatibilidad)
 * @param {Date|string} [params.timestamp] - Marca temporal del evento
 */
async function notifyWebhook({
                                 webhookUrl,
                                 source,
                                 status,
                                 result = {},
                                 processed,
                                 timestamp = new Date().toISOString()
                             }) {
    if (!webhookUrl) return;

    // Unificar la data
    const payload = {
        source,
        status,
        processed: processed ?? result.processed ?? 0,
        stats: {
            durationMs: result.durationMs,
            totalErrors: result.totalErrors,
            startedAt: result.startTime,
            finishedAt: result.endTime,
        },
        timestamp,
    };

    try {
        await axios.post(webhookUrl, payload);
        console.log(`[webhookService] Webhook enviado (${source}):`, status);
    } catch (err) {
        console.error('[webhookService] Error notificando al webhook:', err.message);
    }
}

module.exports = { notifyWebhook };
