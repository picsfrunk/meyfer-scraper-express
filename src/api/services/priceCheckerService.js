const axios     = require('axios');
const logToFile = require('../../utils/logToFile');
const { checkPrices } = require('../../scraper/priceChecker');
const { enqueue, JOB_TYPES } = require('./scraperQueue');

// ──────────────────────────────────────────────────────────────────────────
// HANDLER INTERNO
// Lógica pura del price check — no sabe nada de cola ni webhooks.
// La cola (scraperQueue) es la responsable de los webhooks de ciclo de vida
// (started, completed, failed). El webhook con el resultado del price check
// lo envía este service al terminar.
// ──────────────────────────────────────────────────────────────────────────

async function _runPriceCheck({ webhookUrl }) {
    const result = await checkPrices();

    if (webhookUrl) {
        await _notifyWebhook(webhookUrl, {
            source:     'priceChecker',
            status:     'success',
            summary:    result.summary,
            changed:    result.changed,
            newIds:     result.newIds,
            removedIds: result.removedIds,
        });
    }

    return result;
}

// ──────────────────────────────────────────────────────────────────────────
// API PÚBLICA — pasa por la cola
// ──────────────────────────────────────────────────────────────────────────

/**
 * Encola el price check.
 * Si hay un scraper corriendo, espera su turno.
 * Retorna la info de encolamiento inmediatamente (igual que los scrapers).
 */
async function runPriceCheck({ webhookUrl } = {}) {
    return enqueue({
        type:    JOB_TYPES.PRICE_CHECK,
        params:  { webhookUrl },
        handler: _runPriceCheck,
    });
}

async function _notifyWebhook(webhookUrl, payload) {
    try {
        await axios.post(webhookUrl, { ...payload, timestamp: new Date().toISOString() });
        await logToFile.info('Webhook de price check enviado', 'priceCheckerService', { status: payload.status });
    } catch (err) {
        await logToFile.error(`Error enviando webhook de price check: ${err.message}`, 'priceCheckerService');
    }
}

module.exports = { runPriceCheck };
