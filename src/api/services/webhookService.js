const axios = require('axios');

let missingSecretWarningLogged = false;

function isProductionLikeEnvironment() {
    const environment = process.env.NODE_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT;
    return ['production', 'staging'].includes(String(environment || '').toLowerCase());
}

function buildWebhookRequestConfig(config = {}) {
    const secret = process.env.SCRAPER_WEBHOOK_SECRET;

    if (!secret) {
        if (isProductionLikeEnvironment() && !missingSecretWarningLogged) {
            missingSecretWarningLogged = true;
            console.warn('[webhookService] SCRAPER_WEBHOOK_SECRET no esta configurado; el backend puede rechazar webhooks protegidos con 401.');
        }

        return config;
    }

    return {
        ...config,
        headers: {
            ...(config.headers || {}),
            'X-Webhook-Secret': secret,
        },
    };
}

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

    // Helper para sanitizar objetos y evitar referencias circulares al serializar.
    // - Mantiene primitivos, arrays y objetos "plain".
    // - Para objetos no-plain intenta usar toString(), y para referencias circulares
    //   devuelve '[Circular]'.
    function isPlainObject(obj) {
        return Object.prototype.toString.call(obj) === '[object Object]';
    }

    function sanitize(value, seen = new WeakSet()) {
        if (value === null || value === undefined) return value;
        const t = typeof value;
        if (t === 'string' || t === 'number' || t === 'boolean') return value;
        if (value instanceof Date) return value.toISOString();
        if (t === 'function') return undefined;
        if (t !== 'object') return String(value);

        if (seen.has(value)) return '[Circular]';
        seen.add(value);

        if (Array.isArray(value)) {
            return value.map(v => sanitize(v, seen));
        }

        if (!isPlainObject(value)) {
            // Para objetos especiales (MongoClient, ObjectId, etc.) intentar convertir a string
            try {
                if (typeof value.toString === 'function') return value.toString();
            } catch (err) {
                return `[Unserializable:${value && value.constructor ? value.constructor.name : typeof value}]`;
            }
            return `[Object:${value && value.constructor ? value.constructor.name : 'Unknown'}]`;
        }

        const out = {};
        for (const key of Object.keys(value)) {
            try {
                const v = sanitize(value[key], seen);
                // Evitar añadir undefined
                if (v !== undefined) out[key] = v;
            } catch (err) {
                out[key] = '[Unserializable]';
            }
        }
        return out;
    }

    // ── Modo cola: el result viene con `event` y `job` ──────────────────
    // scraperQueue llama notifyWebhook con result = { event, job, queueSnapshot, ... }
    if (result.event && result.job) {
        // Evitar enviar objetos grandes o con referencias circulares (ej: job puede contener conexiones/mongo)
        // En lugar de reenviar el objeto `job` entero, enviar solo campos serializables y sanitizados.
        payload = {
            // Campos de primer nivel que webhook.controller.js necesita
            event:         result.event,
            job:           sanitize(result.job) || {
                id: result.job && (result.job.id || result.job._id) || null,
            },
            queueSnapshot: result.queueSnapshot ? sanitize(result.queueSnapshot) : null,
            result:        result.result ? sanitize(result.result) : null,   // stats del scraper (solo en completed/failed)
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
            stats: sanitize({
                durationMs:    duration,
                totalErrors:   errors,
                orphansDeleted: result.orphansDeleted ?? 0,
                uploaded:      result.uploaded ?? 0,
                startedAt:     result.startTime  || result.startedAt,
                finishedAt:    result.endTime    || result.finishedAt,
            }),
            timestamp,
        };
    }

    try {
        await axios.post(webhookUrl, payload, buildWebhookRequestConfig());
        console.log(`[webhookService] Webhook enviado → event:${payload.event ?? '-'} source:${source} status:${status}`);
    } catch (err) {
        console.error('[webhookService] Error notificando al webhook:', err.message);
    }
}

module.exports = { notifyWebhook, buildWebhookRequestConfig };
