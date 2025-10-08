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
console.log('🔧 Configuración de Cloudinary:');
console.log(`   Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME ? '✓ Configurado' : '✗ NO CONFIGURADO'}`);
console.log(`   API Key: ${process.env.CLOUDINARY_API_KEY ? '✓ Configurado' : '✗ NO CONFIGURADO'}`);
console.log(`   API Secret: ${process.env.CLOUDINARY_API_SECRET ? '✓ Configurado (oculto)' : '✗ NO CONFIGURADO'}`);

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    console.error('❌ ADVERTENCIA: Cloudinary no está completamente configurado en .env');
    logToFile('❌ ADVERTENCIA: Cloudinary no está completamente configurado en .env');
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
        logToFile(`⚠️ Error verificando existencia de imagen: ${error.message}`);
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
        logToFile('⚠️ No se proporcionó URL de imagen');
        console.log('⚠️ No se proporcionó URL de imagen');
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
                console.log(`♻️  Imagen ya existe en Cloudinary, reutilizando: ${existingUrl}`);
                logToFile(`♻️  Imagen ya existe en Cloudinary para producto ${options.productId}`);
                return existingUrl;
            }
        }

        console.log(`🔄 Descargando imagen desde: ${imageUrl}`);
        logToFile(`🔄 Descargando imagen desde: ${imageUrl}`);

        // Descargar la imagen como buffer
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 10000, // 10 segundos de timeout
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        console.log(`✔ Imagen descargada, tamaño: ${response.data.length} bytes, tipo: ${response.headers['content-type']}`);
        logToFile(`✔ Imagen descargada, tamaño: ${response.data.length} bytes`);

        // Convertir a base64
        const imageBuffer = Buffer.from(response.data);
        const base64Image = `data:${response.headers['content-type']};base64,${imageBuffer.toString('base64')}`;

        console.log(`🔄 Subiendo a Cloudinary con public_id: ${fullPublicId}`);
        logToFile(`🔄 Subiendo a Cloudinary con public_id: ${fullPublicId}`);

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

        console.log(`✅ Imagen subida exitosamente a Cloudinary: ${result.secure_url}`);
        logToFile(`✔ Imagen subida a Cloudinary: ${result.secure_url}`);
        return result.secure_url;

    } catch (error) {
        console.error(`❌ ERROR DETALLADO subiendo imagen a Cloudinary:`);
        console.error(`   URL origen: ${imageUrl}`);
        console.error(`   Mensaje: ${error.message}`);
        console.error(`   Stack: ${error.stack}`);

        logToFile(`❌ Error subiendo imagen a Cloudinary: ${error.message}`);
        logToFile(`   URL origen: ${imageUrl}`);

        // Más detalles del error
        if (error.response) {
            console.error(`   Status HTTP: ${error.response.status}`);
            console.error(`   Respuesta: ${JSON.stringify(error.response.data)}`);
            logToFile(`   Status HTTP: ${error.response.status}`);
        }

        // Si falla, intentar guardar la URL original como fallback
        if (error.response?.status === 404) {
            logToFile('⚠️ Imagen no encontrada en origen, usando URL original');
            console.log('⚠️ Imagen no encontrada en origen');
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
    console.log(`\n🖼️  Procesando imagen para producto ${productId}`);
    console.log(`   URL original: ${imageUrl}`);
    logToFile(`🖼️  Procesando imagen para producto ${productId}: ${imageUrl}`);

    if (!imageUrl) {
        console.log('   ⚠️  URL de imagen vacía o null');
        logToFile('   ⚠️  URL de imagen vacía para producto ' + productId);
        return null;
    }

    // Verificar si la imagen ya está en Cloudinary y no cambió
    if (existingImageUrl && existingImageUrl.includes('cloudinary.com')) {
        // Generar el hash de la URL actual
        const currentHash = generateImageHash(imageUrl);
        const existingHash = existingImageUrl.includes(currentHash);

        if (existingHash) {
            console.log(`   ♻️  Imagen ya procesada previamente, reutilizando URL`);
            console.log(`   URL existente: ${existingImageUrl}\n`);
            logToFile(`   ♻️  Reutilizando imagen existente para producto ${productId}`);
            return existingImageUrl;
        } else {
            console.log(`   🔄 URL de origen cambió, actualizando imagen...`);
            logToFile(`   🔄 URL de origen cambió para producto ${productId}`);
        }
    }

    // Si no existe o cambió, subir a Cloudinary
    const cloudinaryUrl = await uploadImageToCloudinary(imageUrl, {
        folder: 'meyfer-products',
        productId: productId
    });

    if (cloudinaryUrl) {
        console.log(`   ✅ Imagen procesada exitosamente`);
        console.log(`   Nueva URL: ${cloudinaryUrl}\n`);
    } else {
        console.log(`   ⚠️  Falló subida, usando URL original\n`);
        logToFile(`   ⚠️  Usando URL original para producto ${productId}`);
    }

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
    extractPublicIdFromUrl,
    imageExistsInCloudinary,
    generateImageHash
};