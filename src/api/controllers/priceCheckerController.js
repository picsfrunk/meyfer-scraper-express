const { runPriceCheck } = require('../services/priceCheckerService');

/**
 * POST /scraper/check-prices
 *
 * Body: { webhookUrl?: string, sync?: boolean }
 *
 * - sync: false (default) → responde 202, procesa en background
 * - sync: true            → responde 200 con resultado completo (testing)
 */
const checkPricesController = async (req, res) => {
    const { webhookUrl, sync = false } = req.body ?? {};

    if (sync) {
        try {
            const result = await runPriceCheck({ webhookUrl });
            return res.status(200).json(result);
        } catch (error) {
            return res.status(500).json({ status: 'error', message: error.message });
        }
    }

    res.status(202).json({
        status:  'processing',
        message: 'Verificación de precios iniciada.',
    });

    runPriceCheck({ webhookUrl })
        .then(r  => console.log('[priceChecker] Done:', JSON.stringify(r.summary)))
        .catch(e => console.error('[priceChecker] Error:', e.message));
};

module.exports = { checkPricesController };