const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const crypto = require('crypto');
const logToFile = require('./logToFile');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Verificar configuración al cargar el módulo
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    logToFile.error('Cloudinary no está completamente configurado en .env', 'imageUploader');
}

/**
 * Genera un hash MD5 de una URL para usar como identificador único
 * @param {string} url - URL de la imagen
 * @returns {string} - Hash MD5
 */
function generateImageHash(url) {
    return crypto.createHash('md5').update(url).digest('hex');
}

/**
 * Verifica si una imagen ya existe en Cloudinary
 * @param {string} publicId - ID público de la imagen en Cloudinary
 * @returns {Promise<boolean>} - true si existe
 */
async function imageExistsInCloudinary(publicId) {
    try {
        const result = await cloudinary.api.resource(publicId, {
            resource_type: 'image'
        });
        return !!result;
    } catch (error) {
        // Si el error es 404, la imagen no existe
        if (error.error?.http_code === 404) {
            return false;
        }
        // Cualquier otro error, asumir que no existe para reintentar
        logToFile.error(`Error verificando existencia de imagen: ${error.message}`, 'imageUploader');
        return false;
    }
}

/**
 * Verifica si la URL de la imagen cambió comparando con la almacenada
 * @param {string} currentImageUrl - URL actual de la imagen
 * @param {string} storedImageUrl - URL almacenada en BD (puede ser Cloudinary u original)
 * @returns {boolean} - true si la imagen cambió
 */
function imageUrlChanged(currentImageUrl, storedImageUrl) {
    if (!storedImageUrl) return true; // No hay imagen previa, es nueva
    if (!currentImageUrl) return false; // No hay imagen actual, no subir nada

    // Si ambas son de Cloudinary y son iguales, no cambió
    if (storedImageUrl.includes('cloudinary.com') && currentImageUrl === storedImageUrl) {
        return false;
    }

    // Si la URL original cambió, necesitamos actualizar
    return currentImageUrl !== storedImageUrl;
}

/**
 * Descarga una imagen desde una URL y la sube a Cloudinary
 * @param {string} imageUrl - URL de la imagen original
 * @param {object} options - Opciones de subida
 * @param {string} options.folder - Carpeta en Cloudinary (ej: 'products')
 * @param {string} options.public_id - ID público personalizado (opcional)
 * @param {number} options.productId - ID del producto para generar public_id
 * @param {boolean} options.forceUpload - Forzar subida aunque exista
 * @returns {Promise<string|null>} - URL de Cloudinary o null si falla
 */
async function uploadImageToCloudinary(imageUrl, options = {}) {
    if (!imageUrl) {
        return null;
    }

    try {
        // Configuración por defecto
        const folder = options.folder || 'products';
        const imageHash = generateImageHash(imageUrl);
        const publicId = options.public_id || `product_${options.productId}_${imageHash}`;
        const fullPublicId = `${folder}/${publicId}`;

        // Verificar si la imagen ya existe en Cloudinary (a menos que se fuerce)
        if (!options.forceUpload) {
            const exists = await imageExistsInCloudinary(fullPublicId);
            if (exists) {
                const existingUrl = cloudinary.url(fullPublicId, {
                    secure: true,
                    format: 'webp',
                    quality: 'auto:good',
                    fetch_format: 'auto'
                });
                return existingUrl;
            }
        }

        // Descargar la imagen como buffer
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 10000, // 10 segundos de timeout
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        // Convertir a base64
        const imageBuffer = Buffer.from(response.data);
        const base64Image = `data:${response.headers['content-type']};base64,${imageBuffer.toString('base64')}`;

        // Subir a Cloudinary
        const result = await cloudinary.uploader.upload(base64Image, {
            folder: folder,
            public_id: publicId,
            overwrite: true,
            resource_type: 'image',
            // Optimizaciones automáticas
            format: 'webp', // Convertir a WebP para mejor compresión
            quality: 'auto:good',
            fetch_format: 'auto'
        });

        return result.secure_url;

    } catch (error) {
        logToFile.error(`Error subiendo imagen a Cloudinary: ${error.message}`, 'imageUploader', {
            imageUrl: imageUrl,
            statusCode: error.response?.status
        });

        // Si falla, intentar guardar la URL original como fallback
        if (error.response?.status === 404) {
            logToFile.warn('Imagen no encontrada en origen, usando URL original', 'imageUploader');
        }

        return null;
    }
}

/**
 * Procesa una imagen: intenta subirla a Cloudinary, si falla devuelve la URL original
 * Solo sube si es necesario (imagen nueva o cambió la URL)
 * @param {string} imageUrl - URL de la imagen original
 * @param {number} productId - ID del producto
 * @param {string} existingImageUrl - URL de imagen ya almacenada en BD (opcional)
 * @returns {Promise<string>} - URL de Cloudinary o URL original
 */
async function processProductImage(imageUrl, productId, existingImageUrl = null) {
    if (!imageUrl) {
        return null;
    }

    // Verificar si la imagen ya está en Cloudinary y no cambió
    if (existingImageUrl && existingImageUrl.includes('cloudinary.com')) {
        // Generar el hash de la URL actual
        const currentHash = generateImageHash(imageUrl);
        const existingHash = existingImageUrl.includes(currentHash);

        if (existingHash) {
            return existingImageUrl;
        }
    }

    // Si no existe o cambió, subir a Cloudinary
    const cloudinaryUrl = await uploadImageToCloudinary(imageUrl, {
        folder: 'meyfer-products',
        productId: productId
    });

    // Si falla la subida, mantener la URL original
    return cloudinaryUrl || imageUrl;
}

/**
 * Elimina una imagen de Cloudinary (útil para limpieza)
 * @param {string} publicId - ID público de la imagen en Cloudinary
 * @returns {Promise<boolean>} - true si se eliminó correctamente
 */
async function deleteImageFromCloudinary(publicId) {
    try {
        const result = await cloudinary.uploader.destroy(publicId);
        return result.result === 'ok';
    } catch (error) {
        logToFile.error(`Error eliminando imagen de Cloudinary: ${error.message}`, 'imageUploader');
        return false;
    }
}

/**
 * Extrae el public_id de una URL de Cloudinary
 * @param {string} cloudinaryUrl - URL completa de Cloudinary
 * @returns {string|null} - public_id extraído
 */
function extractPublicIdFromUrl(cloudinaryUrl) {
    if (!cloudinaryUrl || !cloudinaryUrl.includes('cloudinary.com')) {
        return null;
    }

    try {
        // Ejemplo: https://res.cloudinary.com/demo/image/upload/v1234567890/products/product_123.webp
        const parts = cloudinaryUrl.split('/upload/');
        if (parts.length < 2) return null;

        const pathWithVersion = parts[1];
        const pathParts = pathWithVersion.split('/');

        // Remover la versión (v1234567890)
        const pathWithoutVersion = pathParts.slice(1).join('/');

        // Remover la extensión
        const publicId = pathWithoutVersion.replace(/\.[^/.]+$/, '');

        return publicId;
    } catch (error) {
        logToFile.error(`Error extrayendo public_id: ${error.message}`, 'imageUploader');
        return null;
    }
}

module.exports = {
    uploadImageToCloudinary,
    processProductImage,
    deleteImageFromCloudinary,
    extractPublicIdFromUrl,
    imageExistsInCloudinary,
    generateImageHash
};