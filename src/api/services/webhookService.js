const axios = require('axios');

async function notifyWebhook({
                                 webhookUrl,
                                 source,
                                 status,
                                 result = {},
                                 processed,
                                 timestamp = new Date().toISOString()
                             }) {
    if (!webhookUrl) return;

    const duration = result.durationMs || result.duration || 0;
    const errors = result.totalErrors ?? result.errors ?? 0;

    const payload = {
        source,
        status,
        processed: processed ?? result.processed ?? result.total ?? 0,
        stats: {
            durationMs: duration,
            totalErrors: errors,
            startedAt: result.startTime || result.startedAt,
            finishedAt: result.endTime || result.finishedAt,
        },
        timestamp,
    };

    try {
        await axios.post(webhookUrl, payload);
        console.log(`[webhookService] Webhook enviado (${source}): ${status} | ${duration}ms`);
    } catch (err) {
        console.error('[webhookService] Error notificando al webhook:', err.message);
    }
}

module.exports = { notifyWebhook };
