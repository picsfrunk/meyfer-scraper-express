const axios = require('axios');

/**
 * Envía un webhook al backend app.
 *
 * Soporta dos modos:
 *
 * 1. MODO COLA (llamado desde scraperQueue.notifyQueueStatus):
 *    `result` contiene el payload completo de la cola:
 *    { event, job, queueSnapshot, ... }
 *    → se reenvía tal cual para que el backend pueda persistir el job.
 *
 * 2. MODO SCRAPER (llamado desde scraperService al terminar):
 *    `result` contiene las stats del scraper: { total, processed, errors, ... }
 *    → se arma el payload de stats como antes.
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

    let payload;

    // ── Modo cola: el result viene con `event` y `job` ──────────────────
    // scraperQueue llama notifyWebhook con result = { event, job, queueSnapshot, ... }
    if (result.event && result.job) {
        payload = {
            // Campos de primer nivel que webhook.controller.js necesita
            event:         result.event,
            job:           result.job,
            queueSnapshot: result.queueSnapshot ?? null,
            result:        result.result ?? null,   // stats del scraper (solo en completed/failed)
            message:       result.message ?? null,

            // Campos legacy por si acaso
            source,
            status,
            timestamp,
        };
    } else {
        // ── Modo scraper: stats finales del run ──────────────────────────
        const duration = result.durationMs || result.duration || 0;
        const errors   = result.totalErrors ?? result.errors ?? 0;

        payload = {
            source,
            status,
            processed: processed ?? result.processed ?? result.total ?? 0,
            stats: {
                durationMs:    duration,
                totalErrors:   errors,
                orphansDeleted: result.orphansDeleted ?? 0,
                uploaded:      result.uploaded ?? 0,
                startedAt:     result.startTime  || result.startedAt,
                finishedAt:    result.endTime    || result.finishedAt,
            },
            timestamp,
        };
    }

    try {
        await axios.post(webhookUrl, payload);
        console.log(`[webhookService] Webhook enviado → event:${payload.event ?? '-'} source:${source} status:${status}`);
    } catch (err) {
        console.error('[webhookService] Error notificando al webhook:', err.message);
    }
}

module.exports = { notifyWebhook };
