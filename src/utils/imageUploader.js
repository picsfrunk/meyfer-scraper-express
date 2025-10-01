const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const logToFile = require('./logToFile');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Descarga una imagen desde una URL y la sube a Cloudinary
 * @param {string} imageUrl - URL de la imagen original
 * @param {object} options - Opciones de subida
 * @param {string} options.folder - Carpeta en Cloudinary (ej: 'products')
 * @param {string} options.public_id - ID público personalizado (opcional)
 * @param {number} options.productId - ID del producto para generar public_id
 * @returns {Promise<string|null>} - URL de Cloudinary o null si falla
 */
async function uploadImageToCloudinary(imageUrl, options = {}) {
    if (!imageUrl) {
        logToFile('⚠️ No se proporcionó URL de imagen');
        return null;
    }

    try {
        // Configuración por defecto
        const folder = options.folder || 'products';
        const publicId = options.public_id || `product_${options.productId || Date.now()}`;

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

        logToFile(`✔ Imagen subida a Cloudinary: ${result.secure_url}`);
        return result.secure_url;

    } catch (error) {
        logToFile(`❌ Error subiendo imagen a Cloudinary: ${error.message}`);

        // Si falla, intentar guardar la URL original como fallback
        if (error.response?.status === 404) {
            logToFile('⚠️ Imagen no encontrada en origen, usando URL original');
        }

        return null; // Devolver null para que se use la URL original si es necesario
    }
}

/**
 * Procesa una imagen: intenta subirla a Cloudinary, si falla devuelve la URL original
 * @param {string} imageUrl - URL de la imagen original
 * @param {number} productId - ID del producto
 * @returns {Promise<string>} - URL de Cloudinary o URL original
 */
async function processProductImage(imageUrl, productId) {
    if (!imageUrl) return null;

    const cloudinaryUrl = await uploadImageToCloudinary(imageUrl, {
        folder: 'meyfer-products',
        productId: productId
    });

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
        logToFile(`✔ Imagen eliminada de Cloudinary: ${publicId}`);
        return result.result === 'ok';
    } catch (error) {
        logToFile(`❌ Error eliminando imagen de Cloudinary: ${error.message}`);
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
        logToFile(`❌ Error extrayendo public_id: ${error.message}`);
        return null;
    }
}

module.exports = {
    uploadImageToCloudinary,
    processProductImage,
    deleteImageFromCloudinary,
    extractPublicIdFromUrl
};