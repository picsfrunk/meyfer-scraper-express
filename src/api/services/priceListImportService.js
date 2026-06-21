const axios = require('axios');
const readXlsxFile = require('read-excel-file/node');
const { parse } = require('csv-parse/sync');
const path = require('path');
const { URL } = require('url');

const mongo = require('../../database/mongo');
const logToFile = require('../../utils/logToFile');
const { buildWebhookRequestConfig } = require('./webhookService');
const { enqueue, JOB_TYPES } = require('./scraperQueue');

const MODULE = 'priceListImportService';
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_REPORTED_ERRORS = 100;
const DIRECT_CONTENT_TYPES = [
    'text/csv',
    'application/csv',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/octet-stream',
];

function getBackendBaseUrl() {
    const value = process.env.BACKEND_API_URL
        || process.env.BACKEND_URL
        || process.env.PRICE_LIST_IMPORT_BACKEND_URL;

    return value ? value.replace(/\/+$/, '') : null;
}

function buildWorkerUrl(pathname) {
    const baseUrl = getBackendBaseUrl();
    if (!baseUrl) {
        throw new Error('BACKEND_API_URL no esta configurada');
    }
    return `${baseUrl}/api/webhook/price-list-import${pathname}`;
}

function getAxiosConfig(config = {}) {
    return buildWebhookRequestConfig({
        timeout: 30_000,
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
        ...config,
    });
}

function normalizeHeader(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function getCellValue(value) {
    if (value == null) return '';
    if (typeof value === 'object') {
        if (value.text != null) return value.text;
        if (value.result != null) return value.result;
        if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
        if (value.hyperlink && value.text) return value.text;
    }
    return value;
}

function normalizeProductId(value) {
    const normalized = String(getCellValue(value) ?? '').trim();
    if (!normalized) return null;
    const withoutExcelDecimal = normalized.replace(/\.0$/, '');
    return /^\d+$/.test(withoutExcelDecimal)
        ? withoutExcelDecimal.padStart(4, '0')
        : withoutExcelDecimal;
}

function normalizePrice(value) {
    const raw = getCellValue(value);
    if (typeof raw === 'number') {
        return Number.isFinite(raw) && raw >= 0 ? raw : null;
    }

    let text = String(raw ?? '').trim();
    if (!text) return null;

    text = text
        .replace(/\s+/g, '')
        .replace(/[^0-9,.-]/g, '');

    if (!text || text === '-' || text === ',' || text === '.') return null;

    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');

    if (lastComma !== -1 && lastDot !== -1) {
        if (lastComma > lastDot) {
            text = text.replace(/\./g, '').replace(',', '.');
        } else {
            text = text.replace(/,/g, '');
        }
    } else if (lastComma !== -1) {
        const decimals = text.length - lastComma - 1;
        text = decimals > 0 && decimals <= 2
            ? text.replace(',', '.')
            : text.replace(/,/g, '');
    } else if (lastDot !== -1) {
        const decimals = text.length - lastDot - 1;
        if (decimals === 3 && text.indexOf('.') === lastDot) {
            text = text.replace(/\./g, '');
        }
    }

    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isProductIdHeader(header) {
    if (header.startsWith('codigo_')) return true;

    return [
        'product_id',
        'productid',
        'id_producto',
        'producto_id',
        'id',
        'codigo',
        'codigo_producto',
        'sku',
    ].includes(header);
}

function isPriceHeader(header) {
    return [
        'list_price',
        'precio',
        'price',
        'precio_lista',
        'precio_de_lista',
        'lista_precio',
        'public_price',
        'precio_publico',
    ].includes(header);
}

function findHeaderMapping(rows) {
    const maxHeaderScanRows = Math.min(rows.length, 10);

    for (let rowIndex = 0; rowIndex < maxHeaderScanRows; rowIndex += 1) {
        const headers = rows[rowIndex].map(normalizeHeader);
        const productIdIndex = headers.findIndex(isProductIdHeader);
        const priceIndex = headers.findIndex(isPriceHeader);

        if (productIdIndex !== -1 && priceIndex !== -1) {
            return { headerRowIndex: rowIndex, productIdIndex, priceIndex, headers };
        }
    }

    throw new Error('No se encontraron columnas requeridas product_id y precio/list_price');
}

function rowsToPriceEntries(rows) {
    const mapping = findHeaderMapping(rows);
    const entries = [];
    const errors = [];

    for (let index = mapping.headerRowIndex + 1; index < rows.length; index += 1) {
        const row = rows[index];
        const hasContent = row.some((value) => String(getCellValue(value) ?? '').trim() !== '');
        if (!hasContent) continue;

        const rowNumber = index + 1;
        const productId = normalizeProductId(row[mapping.productIdIndex]);
        const price = normalizePrice(row[mapping.priceIndex]);

        if (!productId || price === null) {
            errors.push({
                row: rowNumber,
                product_id: productId,
                error: !productId ? 'product_id requerido' : 'precio invalido',
            });
            continue;
        }

        entries.push({
            row: rowNumber,
            product_id: productId,
            list_price: price,
        });
    }

    return { entries, errors };
}

async function parseXlsxBuffer(buffer) {
    const parsed = await readXlsxFile(buffer);
    const rows = Array.isArray(parsed?.[0])
        ? parsed
        : (parsed.find((sheet) => Array.isArray(sheet?.data) && sheet.data.length > 0)?.data || []);
    if (!rows.length) throw new Error('El XLSX no contiene hojas con datos');
    return rowsToPriceEntries(rows);
}

function parseCsvBuffer(buffer) {
    const records = parse(buffer, {
        bom: true,
        delimiter: [',', ';', '\t'],
        relax_column_count: true,
        skip_empty_lines: false,
        trim: true,
    });

    return rowsToPriceEntries(records);
}

function getExtensionFromMetadata(metadata = {}) {
    const extension = String(metadata.extension || '').toLowerCase();
    if (['.csv', '.xlsx'].includes(extension)) return extension;

    const originalName = metadata.originalName || metadata.filename || metadata.name || '';
    const fromName = path.extname(originalName).toLowerCase();
    if (['.csv', '.xlsx'].includes(fromName)) return fromName;

    const mimeType = String(metadata.mimeType || metadata.contentType || '').toLowerCase();
    if (mimeType.includes('spreadsheetml')) return '.xlsx';
    if (mimeType.includes('csv') || mimeType.includes('excel')) return '.csv';

    return null;
}

async function parsePriceListBuffer(buffer, metadata = {}) {
    const extension = getExtensionFromMetadata(metadata);
    if (extension === '.xlsx') return parseXlsxBuffer(buffer);
    if (extension === '.csv') return parseCsvBuffer(buffer);
    throw new Error('Formato no soportado; se espera CSV o XLSX');
}

async function getProfitMargin() {
    const configCollection = await mongo.getConfigCollection();
    const profitDoc = await configCollection.findOne({ key: 'profitMargin' });
    const value = Number(profitDoc?.value);

    if (!profitDoc || !Number.isFinite(value)) {
        throw new Error('profitMargin no esta configurado o no es numerico; se cancela la importacion para evitar final_price incorrecto');
    }

    return value / 100;
}

function buildEmptySummary() {
    return {
        totalRows: 0,
        validRows: 0,
        updatedProducts: 0,
        unchangedProducts: 0,
        notFoundProducts: 0,
        invalidRows: 0,
        duplicatedProductIds: 0,
        errors: 0,
    };
}

function shouldUpdatePrice(existing, nextListPrice, nextFinalPrice) {
    const currentListPrice = Number(existing.list_price);
    const currentFinalPrice = Number(existing.final_price);
    return currentListPrice !== nextListPrice || currentFinalPrice !== nextFinalPrice;
}

async function applyPriceEntries(entries, rowErrors, { collection, profitMargin }) {
    const summary = buildEmptySummary();
    const errors = [...rowErrors];
    const seenProductIds = new Set();
    const duplicatedProductIds = new Set();
    const operations = [];
    const now = new Date();

    summary.totalRows = entries.length + rowErrors.length;
    summary.invalidRows = rowErrors.length;

    for (const entry of entries) {
        if (seenProductIds.has(entry.product_id)) {
            duplicatedProductIds.add(entry.product_id);
            summary.invalidRows += 1;
            errors.push({
                row: entry.row,
                product_id: entry.product_id,
                error: 'product_id duplicado en archivo',
            });
            continue;
        }
        seenProductIds.add(entry.product_id);
        summary.validRows += 1;

        const existing = await collection.findOne(
            { product_id: entry.product_id },
            { projection: { product_id: 1, list_price: 1, final_price: 1 } }
        );

        if (!existing) {
            summary.notFoundProducts += 1;
            errors.push({
                row: entry.row,
                product_id: entry.product_id,
                error: 'producto no encontrado',
            });
            continue;
        }

        const listPrice = entry.list_price;
        const finalPrice = listPrice * (1 + profitMargin);

        if (!shouldUpdatePrice(existing, listPrice, finalPrice)) {
            summary.unchangedProducts += 1;
            continue;
        }

        operations.push({
            updateOne: {
                filter: { product_id: entry.product_id },
                update: {
                    $set: {
                        list_price: listPrice,
                        final_price: finalPrice,
                        priceUpdatedAt: now,
                    },
                },
                upsert: false,
            },
        });
        summary.updatedProducts += 1;
    }

    if (operations.length > 0) {
        await collection.bulkWrite(operations, { ordered: false });
    }

    summary.duplicatedProductIds = duplicatedProductIds.size;
    summary.errors = errors.length;

    return {
        summary,
        errors: errors.slice(0, MAX_REPORTED_ERRORS),
        result: {
            duplicatedProductIds: Array.from(duplicatedProductIds),
            errorsTruncated: errors.length > MAX_REPORTED_ERRORS,
        },
    };
}

async function claimJob(jobId) {
    const response = await axios.post(buildWorkerUrl(`/jobs/${encodeURIComponent(jobId)}/claim`), {}, getAxiosConfig());
    return response.data?.job;
}

async function reportJob(jobId, payload) {
    await axios.patch(buildWorkerUrl(`/jobs/${encodeURIComponent(jobId)}`), payload, getAxiosConfig());
}

async function fetchManualUploadFile(fileId) {
    const response = await axios.get(buildWorkerUrl(`/files/${encodeURIComponent(fileId)}`), getAxiosConfig());
    const file = response.data;
    if (!file?.contentBase64) throw new Error('El backend no devolvio contentBase64 para el archivo manual');

    return {
        buffer: Buffer.from(file.contentBase64, 'base64'),
        metadata: file,
    };
}

function isProbablyInteractiveOdooUrl(sourceUrl) {
    const lowered = String(sourceUrl || '').toLowerCase();
    return lowered.includes('/spreadsheet')
        || lowered.includes('/documents')
        || lowered.includes('/web#')
        || lowered.includes('/odoo/');
}

function getExtensionFromUrl(sourceUrl) {
    try {
        const parsed = new URL(sourceUrl);
        return path.extname(parsed.pathname).toLowerCase();
    } catch (_error) {
        return null;
    }
}

async function fetchRemoteConfiguredUrl(sourceUrl) {
    if (!sourceUrl) throw new Error('sourceUrl requerido para remote_configured_url');
    if (isProbablyInteractiveOdooUrl(sourceUrl)) {
        throw new Error('URL remota interactiva de Odoo no soportada todavia');
    }

    const response = await axios.get(sourceUrl, {
        timeout: 30_000,
        responseType: 'arraybuffer',
        maxContentLength: MAX_DOWNLOAD_BYTES,
        maxBodyLength: MAX_DOWNLOAD_BYTES,
        validateStatus: (status) => status >= 200 && status < 300,
    });

    const contentType = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
    const extension = getExtensionFromUrl(response.request?.res?.responseUrl || sourceUrl);

    if (!['.csv', '.xlsx'].includes(extension) && !DIRECT_CONTENT_TYPES.includes(contentType)) {
        throw new Error(`URL remota no parece ser CSV/XLSX directo (content-type: ${contentType || 'desconocido'})`);
    }

    return {
        buffer: Buffer.from(response.data),
        metadata: {
            extension,
            mimeType: contentType,
            originalName: path.basename(sourceUrl),
        },
    };
}

async function loadJobFile(job) {
    if (job.source === 'manual_upload') {
        if (!job.fileId) throw new Error('Job manual_upload sin fileId');
        return fetchManualUploadFile(job.fileId);
    }

    if (job.source === 'remote_configured_url') {
        return fetchRemoteConfiguredUrl(job.sourceUrl);
    }

    throw new Error(`Source de importacion no soportado: ${job.source}`);
}

async function processPriceListImportJob(job, options = {}) {
    const collection = options.collection || await mongo.getScrapedCollection();
    const profitMargin = options.profitMargin ?? await getProfitMargin();
    const startedAt = new Date().toISOString();

    const { buffer, metadata } = options.file || await loadJobFile(job);
    const parsed = await parsePriceListBuffer(buffer, metadata);
    const applied = await applyPriceEntries(parsed.entries, parsed.errors, { collection, profitMargin });
    const finishedAt = new Date().toISOString();

    return {
        status: 'completed',
        summary: applied.summary,
        errors: applied.errors,
        result: {
            ...applied.result,
            source: job.source,
            startedAt,
            finishedAt,
        },
    };
}

async function runPriceListImportJobById(jobId, options = {}) {
    if (!jobId) throw new Error('jobId requerido para price-list-import');

    await logToFile.info('Job de importacion de lista recibido', MODULE, { jobId });

    let claimedJob = null;
    try {
        claimedJob = options.job || await claimJob(jobId);
        await logToFile.info('Job de importacion de lista reclamado', MODULE, {
            jobId,
            source: claimedJob?.source,
        });
    } catch (error) {
        await logToFile.warn(`No se pudo reclamar job ${jobId}: ${error.message}`, MODULE, {
            jobId,
            status: error.response?.status,
            details: error.response?.data,
        });
        throw error;
    }

    try {
        const startedMs = Date.now();
        const payload = await processPriceListImportJob(claimedJob, options);
        await reportJob(jobId, payload);
        await logToFile.info('Job de importacion de lista completado', MODULE, {
            jobId,
            summary: payload.summary,
        });
        return {
            backendJobId: jobId,
            summary: payload.summary,
            durationMs: Date.now() - startedMs,
        };
    } catch (error) {
        const payload = {
            status: 'failed',
            summary: buildEmptySummary(),
            errors: [{ error: error.message }],
            result: { error: error.message },
            details: {
                message: error.message,
                stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
            },
        };

        try {
            await reportJob(jobId, payload);
        } catch (reportError) {
            await logToFile.error(`Error reportando fallo de importacion: ${reportError.message}`, MODULE, {
                jobId,
                details: reportError.response?.data,
            });
        }

        await logToFile.error(`Job de importacion de lista fallo: ${error.message}`, MODULE, {
            jobId,
            stack: error.stack,
        });
        throw error;
    }
}

async function runPriceListImport({ jobId } = {}) {
    if (!jobId) throw new Error('jobId requerido para price-list-import');

    return enqueue({
        type: JOB_TYPES.PRICE_LIST_IMPORT,
        params: { jobId },
        handler: ({ jobId: backendJobId }) => runPriceListImportJobById(backendJobId),
    });
}

module.exports = {
    runPriceListImport,
    runPriceListImportJobById,
    processPriceListImportJob,
    parsePriceListBuffer,
    normalizePrice,
    normalizeProductId,
    getProfitMargin,
    applyPriceEntries,
};
