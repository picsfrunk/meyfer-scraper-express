/**
 * scraperQueue.js
 *
 * Singleton que gestiona la cola de jobs del scraper.
 * Garantiza que solo un scraper corra a la vez; los demás se encolan.
 * Expone métricas de estado (running, pending, history) para consulta interna
 * y para notificaciones webhook.
 */

const { notifyWebhook } = require('./webhookService');
const logToFile = require('../../utils/logToFile');

// ─── Tipos de job aceptados ────────────────────────────────────────────────
const JOB_TYPES = {
    SITEMAP:               'sitemapScraper',
    CATEGORY:              'categoryScraper',
    ANALYZE:               'sitemapAnalysis',
    PRICE_CHECK:           'priceCheck',
    PRICE_LIST_IMPORT:     'priceListImport',
    CATEGORIES_RESTORE:    'categoriesRestore',
    CATEGORIES_REORGANIZE: 'categoriesReorganize',
};

// ─── Estado interno del singleton ─────────────────────────────────────────
let runningJob = null;          // { id, type, startedAt, params, signal }
const queue = [];               // Array de jobs pendientes: { id, type, params, enqueuedAt }
let jobCounter = 0;             // Autoincremental para IDs únicos

// ─── Historial (últimos N jobs completados) ────────────────────────────────
const HISTORY_MAX = 20;
const history = [];

// ──────────────────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ──────────────────────────────────────────────────────────────────────────

function generateJobId(type) {
    jobCounter += 1;
    return `${type}-${Date.now()}-${jobCounter}`;
}

/**
 * Snapshot inmutable del estado actual de la cola.
 * Se incluye en cada webhook y en el endpoint de status.
 */
function getQueueSnapshot() {
    return {
        isRunning: runningJob !== null,
        running: runningJob
            ? {
                  id: runningJob.id,
                  type: runningJob.type,
                  startedAt: runningJob.startedAt,
                  elapsedMs: Date.now() - new Date(runningJob.startedAt).getTime(),
              }
            : null,
        pending: queue.length,
        pendingJobs: queue.map((j) => ({
            id: j.id,
            type: j.type,
            enqueuedAt: j.enqueuedAt,
            waitingMs: Date.now() - new Date(j.enqueuedAt).getTime(),
        })),
    };
}

async function logQueueEvent(event, details = {}) {
    await logToFile.info(`[ScraperQueue] ${event}`, 'scraperQueue', {
        ...details,
        queue: getQueueSnapshot(),
    });
}

// ──────────────────────────────────────────────────────────────────────────
// NOTIFICACIÓN DE ESTADO DE COLA
// ──────────────────────────────────────────────────────────────────────────

/**
 * Emite un webhook de estado de cola si el job tiene webhookUrl.
 *
 * @param {'enqueued'|'started'|'completed'|'failed'|'canceled'} event
 * @param {object} job     - Job que dispara el evento
 * @param {object} [extra] - Resultado o detalle adicional
 */
async function notifyQueueStatus(event, job, extra = {}) {
    const webhookUrl = job?.params?.webhookUrl;
    if (!webhookUrl) return;

    const payload = {
        event,
        source: 'scraperQueue',
        status: event,
        job: {
            id:     job.id,
            type:   job.type,
            params: job.params ?? null,
        },
        queueSnapshot: getQueueSnapshot(),
        ...extra,
    };

    try {
        await notifyWebhook({ webhookUrl, source: 'scraperQueue', status: event, result: payload });
    } catch (err) {
        console.error('[ScraperQueue] Error notificando webhook de cola:', err.message);
    }
}

// ──────────────────────────────────────────────────────────────────────────
// EJECUCIÓN DE UN JOB
// ──────────────────────────────────────────────────────────────────────────

/**
 * Ejecuta el handler del job y gestiona su ciclo de vida completo:
 * running → completed/failed/canceled → dequeue → trigger next.
 *
 * El `signal` es un objeto { canceled: false } que se pasa al handler.
 * Cuando cancelJob() lo setea en true, el handler lo detecta en su próxima
 * iteración y corta el loop limpiamente.
 */
async function executeJob(job) {
    const signal = { canceled: false };

    runningJob = {
        id: job.id,
        type: job.type,
        startedAt: new Date().toISOString(),
        params: job.params,
        signal,   // ← referencia al signal para que cancelJob() pueda mutar canceled
    };

    await logQueueEvent('job_started', { jobId: job.id, type: job.type });
    await notifyQueueStatus('started', job);

    let result = null;
    let status = 'completed';

    try {
        result = await job.handler(job.params, signal);  // ← signal como segundo argumento
    } catch (err) {
        status = 'failed';
        result = { error: err.message };
        console.error(`[ScraperQueue] Job ${job.id} falló:`, err.message);
    } finally {
        // Si el signal fue activado durante la ejecución, registrar como 'canceled'
        if (signal.canceled) {
            status = 'canceled';
        }

        // Registrar en historial — sanitizar result para no guardar arrays
        // masivos de productos (ej: price check con 1500+ items en changed/new/removed)
        history.unshift({
            id: job.id,
            type: job.type,
            status,
            startedAt: runningJob.startedAt,
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - new Date(runningJob.startedAt).getTime(),
            result: _sanitizeResult(result, job.type),
        });
        if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;

        runningJob = null;

        await logQueueEvent(`job_${status}`, { jobId: job.id, type: job.type, result });
        await notifyQueueStatus(status, job, { result });

        // Procesar el siguiente job en la cola (si lo hay)
        processNext();
    }
}

/**
 * Toma el próximo job de la cola y lo ejecuta (sin await — es fire-and-forget).
 */
function processNext() {
    if (runningJob !== null || queue.length === 0) return;
    const next = queue.shift();
    executeJob(next); // intencionalmente sin await
}

// ──────────────────────────────────────────────────────────────────────────
// API PÚBLICA
// ──────────────────────────────────────────────────────────────────────────

/**
 * Encola un nuevo job de scraper.
 *
 * @param {object} options
 * @param {string}   options.type     - Uno de JOB_TYPES
 * @param {object}   options.params   - Parámetros originales del controller (incluye webhookUrl)
 * @param {Function} options.handler  - async (params, signal) => result
 *
 * @returns {{ jobId: string, queued: boolean, position: number, queueSnapshot: object }}
 */
async function enqueue({ type, params, handler }) {
    const job = {
        id: generateJobId(type),
        type,
        params,
        handler,
        enqueuedAt: new Date().toISOString(),
    };

    const isRunning = runningJob !== null;

    if (isRunning) {
        // Hay un scraper corriendo → encolar
        queue.push(job);
        const position = queue.length; // 1-indexed

        await logQueueEvent('job_enqueued', {
            jobId: job.id,
            type: job.type,
            position,
            pendingTotal: queue.length,
        });

        await notifyQueueStatus('enqueued', job, {
            message: `Hay un scraper en ejecución. Tu job está en posición ${position} de ${queue.length} en espera.`,
        });

        return { jobId: job.id, queued: true, position, queueSnapshot: getQueueSnapshot() };
    }

    // No hay scraper corriendo → ejecutar inmediatamente (fire-and-forget)
    executeJob(job);

    return { jobId: job.id, queued: false, position: 0, queueSnapshot: getQueueSnapshot() };
}

/**
 * Sanitiza el result antes de guardarlo en el historial en memoria.
 * Elimina arrays de productos para evitar que /scraper/status devuelva
 * payloads masivos (ej: price check con 1500+ productos en changed/new/removed).
 * Solo guarda conteos y stats — el detalle completo queda en MongoDB.
 */
function _sanitizeResult(result, jobType) {
    if (!result) return null;
    if (result.error) return { error: result.error };

    if (jobType === JOB_TYPES.PRICE_CHECK) {
        return {
            summary:    result.summary ?? null,
            durationMs: result.summary?.durationMs ?? result.durationMs ?? null,
        };
    }

    if (jobType === JOB_TYPES.PRICE_LIST_IMPORT) {
        return {
            backendImportJobId: result.backendImportJobId ?? null,
            requestId:          result.requestId          ?? null,
            summary:            result.summary            ?? null,
            durationMs:         result.durationMs         ?? null,
        };
    }

    if ([JOB_TYPES.CATEGORIES_RESTORE, JOB_TYPES.CATEGORIES_REORGANIZE].includes(jobType)) {
        return {
            total:        result.total        ?? null,
            processed:    result.processed    ?? null,
            errors:       result.errors       ?? result.totalErrors ?? null,
            pagesVisited: result.pagesVisited ?? null,
            matched:      result.matched      ?? null,
            modified:     result.modified     ?? null,
            dryRun:       result.dryRun       ?? null,
            durationMs:   result.durationMs   ?? null,
        };
    }

    // Scrapers estándar — ya no tienen arrays grandes, solo stats
    return {
        total:          result.total          ?? null,
        processed:      result.processed      ?? null,
        errors:         result.errors         ?? result.totalErrors ?? null,
        uploaded:       result.uploaded       ?? null,
        orphansDeleted: result.orphansDeleted ?? null,
        durationMs:     result.durationMs     ?? null,
    };
}

/**
 * Retorna el estado actual de la cola (para endpoint GET /scraper/status).
 */
function getStatus() {
    return {
        ...getQueueSnapshot(),
        recentHistory: history.slice(0, 5),
    };
}

// ──────────────────────────────────────────────────────────────────────────
// CANCELACIÓN DE JOBS
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cancela un job por su ID.
 *
 * - Si está en la cola de espera: lo elimina y ajusta las posiciones.
 * - Si está en ejecución: activa signal.canceled = true (graceful shutdown).
 *   El handler lo detecta en su próxima iteración y corta el loop.
 *   El job será registrado como 'canceled' en el finally de executeJob.
 * - Si ya está completado/fallido (en historial): retorna `{ alreadyDone: true, status }`.
 * - Si no existe: retorna `null`.
 *
 * @param {string} jobId
 * @returns {{ canceled: boolean, wasQueued?: boolean, wasRunning?: boolean,
 *             alreadyDone?: boolean, status?: string } | null}
 */
async function cancelJob(jobId) {
    // 1. Buscar en cola de espera
    const queueIndex = queue.findIndex((j) => j.id === jobId);
    if (queueIndex !== -1) {
        const [removed] = queue.splice(queueIndex, 1);
        await logQueueEvent('job_canceled_queued', { jobId, type: removed.type });
        await notifyQueueStatus('canceled', removed, { reason: 'canceled_from_queue' });
        return { canceled: true, wasQueued: true };
    }

    // 2. Verificar si está en ejecución — activar el signal
    if (runningJob && runningJob.id === jobId) {
        runningJob.signal.canceled = true;  // ← el handler lo verá en su próxima iteración
        await logQueueEvent('job_cancel_requested', { jobId, type: runningJob.type });
        return { canceled: true, wasRunning: true };
    }

    // 3. Buscar en historial
    const historyEntry = history.find((h) => h.id === jobId);
    if (historyEntry) {
        return { canceled: false, alreadyDone: true, status: historyEntry.status };
    }

    // 4. No encontrado
    return null;
}

/**
 * Cancela todos los jobs pendientes de la cola.
 * El job en ejecución (si lo hay) NO se interrumpe.
 *
 * @returns {{ canceledCount: number, queueSnapshot: object }}
 */
async function cancelAllJobs() {
    const canceledCount = queue.length;
    const canceledJobs = queue.splice(0, queue.length); // vaciar cola

    await logQueueEvent('queue_purged', { canceledCount });

    // Notificar webhook por cada job cancelado (si tiene webhookUrl)
    for (const job of canceledJobs) {
        await notifyQueueStatus('canceled', job, { reason: 'queue_purged' });
    }

    return { canceledCount, queueSnapshot: getQueueSnapshot() };
}

module.exports = {
    JOB_TYPES,
    enqueue,
    getStatus,
    cancelJob,
    cancelAllJobs,
};
