const assert = require('assert');
const writeXlsxFile = require('write-excel-file/node');

const {
    parsePriceListBuffer,
    processPriceListImportJob,
    getProfitMargin,
} = require('../src/api/services/priceListImportWorkerService');
const mongo = require('../src/database/mongo');

class MockCollection {
    constructor(products) {
        this.products = new Map(products.map((product) => [product.product_id, { ...product }]));
        this.operations = [];
    }

    async findOne(filter) {
        const product = this.products.get(filter.product_id);
        return product ? { ...product } : null;
    }

    async bulkWrite(operations) {
        this.operations.push(...operations);
        for (const operation of operations) {
            const update = operation.updateOne;
            const product = this.products.get(update.filter.product_id);
            if (product) Object.assign(product, update.update.$set);
        }
        return { modifiedCount: operations.length };
    }
}

async function buildXlsxBuffer(rows) {
    const data = rows.map((row) => row.map((value) => ({ value })));
    const file = await writeXlsxFile(data, { buffer: true });
    const buffer = typeof file.toBuffer === 'function' ? await file.toBuffer() : file;
    return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
}

async function testXlsxImportSummary() {
    const buffer = await buildXlsxBuffer([
        ['product_id', 'list_price'],
        ['A1', 100],
        ['B2', 200],
        ['MISSING', 300],
        ['BAD', 'abc'],
        ['A1', 120],
    ]);

    const collection = new MockCollection([
        { product_id: 'A1', list_price: 80, final_price: 160 },
        { product_id: 'B2', list_price: 200, final_price: 400 },
    ]);

    const result = await processPriceListImportJob(
        { jobId: 'pli_test', source: 'manual_upload' },
        {
            collection,
            profitMargin: 1,
            file: {
                buffer,
                metadata: { extension: '.xlsx', originalName: 'fixture.xlsx' },
            },
        }
    );

    assert.strictEqual(result.status, 'completed');
    assert.deepStrictEqual(result.summary, {
        totalRows: 5,
        validRows: 3,
        updatedProducts: 1,
        unchangedProducts: 1,
        notFoundProducts: 1,
        invalidRows: 2,
        duplicatedProductIds: 1,
        errors: 3,
    });
    assert.strictEqual(collection.products.get('A1').list_price, 100);
    assert.strictEqual(collection.products.get('A1').final_price, 200);
    assert.strictEqual(collection.products.get('B2').list_price, 200);
    assert.strictEqual(collection.products.has('MISSING'), false);
    assert.strictEqual(collection.operations.length, 1);
}

async function testCsvParsing() {
    const csv = Buffer.from('codigo;precio\nP1;"1.234,50"\nP2;$ 99.90\n', 'utf8');
    const parsed = await parsePriceListBuffer(csv, { extension: '.csv' });
    assert.deepStrictEqual(parsed.errors, []);
    assert.deepStrictEqual(parsed.entries.map((entry) => ({
        product_id: entry.product_id,
        list_price: entry.list_price,
    })), [
        { product_id: 'P1', list_price: 1234.5 },
        { product_id: 'P2', list_price: 99.9 },
    ]);
}

async function testSupplierCodeHeaderOnFourthRowPadsNumericCodes() {
    const buffer = await buildXlsxBuffer([
        ['Lista de precios proveedor'],
        ['Actualizada', '2026-06-21'],
        [],
        ['Descripcion', 'Codigo de proveedor', 'Precio'],
        ['Producto 442', 442, 10],
        ['Producto 0441', '0441', 11],
        ['Producto 697', 697, 12],
        ['Producto 828', 828, 13],
        ['Producto 1112', 1112, 14],
        ['Producto alfa', 'A828', 15],
    ]);

    const parsed = await parsePriceListBuffer(buffer, { extension: '.xlsx', originalName: 'supplier-price-list.xlsx' });
    assert.deepStrictEqual(parsed.errors, []);
    assert.deepStrictEqual(parsed.entries.map((entry) => entry.product_id), [
        '0442',
        '0441',
        '0697',
        '0828',
        '1112',
        'A828',
    ]);
}

async function testInvalidFile() {
    await assert.rejects(
        () => parsePriceListBuffer(Buffer.from('not-json'), { extension: '.json' }),
        /Formato no soportado/
    );
}

async function testMissingOrInvalidProfitMarginFails() {
    const originalGetConfigCollection = mongo.getConfigCollection;

    try {
        mongo.getConfigCollection = async () => ({
            findOne: async () => null,
        });
        await assert.rejects(
            () => getProfitMargin(),
            /profitMargin no esta configurado o no es numerico/
        );

        mongo.getConfigCollection = async () => ({
            findOne: async () => ({ key: 'profitMargin', value: 'not-a-number' }),
        });
        await assert.rejects(
            () => getProfitMargin(),
            /profitMargin no esta configurado o no es numerico/
        );
    } finally {
        mongo.getConfigCollection = originalGetConfigCollection;
    }
}

async function run() {
    await testXlsxImportSummary();
    await testCsvParsing();
    await testSupplierCodeHeaderOnFourthRowPadsNumericCodes();
    await testInvalidFile();
    await testMissingOrInvalidProfitMarginFails();
    console.log('priceListImportWorker tests passed');
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
