const { runPriceCheck } = require('../services/priceCheckerService');
const { buildAcceptedResponse } = require('./scraperController');

/**
 * POST /scraper/check-prices
 *
 * Body: { webhookUrl?: string, sync?: boolean }
 *
 * - sync: false (default) → responde 202, procesa en background via cola
 * - sync: true            → responde 200 con resultado completo (solo testing)
 *
 * El price check pasa por la cola de scrapers — si hay uno corriendo,
 * se encola y espera su turno para no saturar la API de Odoo.
 */
const checkPricesController = async (req, res) => {
    const { webhookUrl, sync = false } = req.body ?? {};

    // Modo sincrónico solo para testing — no recomendado en producción
    // ya que puede demorar 2+ minutos y bloquear la respuesta HTTP
    if (sync) {
        try {
            const enqueueResult = await runPriceCheck({ webhookUrl });
            // En modo sync esperamos que el job termine antes de responder.
            // Como ya pasó por la cola, el resultado real está en enqueueResult
            // solo si arrancó directo (queued: false). Si fue encolado, avisar.
            if (enqueueResult.queued) {
                return res.status(202).json({
                    ...buildAcceptedResponse(enqueueResult, 'Price check'),
                    note: 'El job fue encolado — sync:true no tiene efecto cuando hay otro scraper corriendo.',
                });
            }
            return res.status(202).json(buildAcceptedResponse(enqueueResult, 'Price check'));
        } catch (error) {
            return res.status(500).json({ status: 'error', message: error.message });
        }
    }

    try {
        const enqueueResult = await runPriceCheck({ webhookUrl });
        const body = buildAcceptedResponse(enqueueResult, 'Price check');
        res.status(202).json(body);
    } catch (error) {
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: error.message });
        }
    }
};

module.exports = { checkPricesController };
