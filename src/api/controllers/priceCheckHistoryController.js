const { getDB } = require('../../database/mongo');
const { ObjectId } = require('mongodb');

/**
 * Endpoints de consulta de resultados de price check.
 * Leen directamente de la colección price_check_results.
 *
 * GET /scraper/price-check/latest
 * GET /scraper/price-check/history?page=1&limit=20&hasChanges=true
 * GET /scraper/price-check/history/:id
 */

exports.getLatest = async (req, res) => {
    try {
        const db = await getDB();
        const result = await db.collection('price_check_results')
            .findOne({}, { sort: { checkedAt: -1 } });

        if (!result) return res.status(404).json({ message: 'No hay resultados aún' });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getHistory = async (req, res) => {
    try {
        const page       = parseInt(req.query.page)  || 1;
        const limit      = parseInt(req.query.limit) || 20;
        const hasChanges = req.query.hasChanges;
        const skip       = (page - 1) * limit;

        const filter = {};
        if (hasChanges === 'true')  filter['summary.changed'] = { $gt: 0 };
        if (hasChanges === 'false') filter['summary.changed'] = 0;

        // En el listado omitimos changedDetail para mantener el payload liviano
        const projection = { changedDetail: 0 };

        const db = await getDB();
        const col = db.collection('price_check_results');

        const [results, total] = await Promise.all([
            col.find(filter, { projection }).sort({ checkedAt: -1 }).skip(skip).limit(limit).toArray(),
            col.countDocuments(filter),
        ]);

        res.json({
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            results,
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

exports.getById = async (req, res) => {
    try {
        const { id } = req.params;

        let objectId;
        try {
            objectId = new ObjectId(id);
        } catch {
            return res.status(400).json({ message: 'ID inválido' });
        }

        const db = await getDB();
        const result = await db.collection('price_check_results').findOne({ _id: objectId });

        if (!result) return res.status(404).json({ message: 'Resultado no encontrado' });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
