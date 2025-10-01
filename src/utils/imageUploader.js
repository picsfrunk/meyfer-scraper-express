const cloudinary = require('cloudinary').v2;
const axios = require('axios');
const logToFile = require('./logToFile');

// Configurar Cloudinary
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
        console.log('⚠️ No se proporcionó URL de imagen');
        return null;
    }

    try {
        // Configuración por defecto
        const folder = options.folder || 'products';
        const publicId = options.public_id || `product_${options.productId || Date.now()}`;

        console.log(`🔄 Intentando descargar imagen: ${imageUrl}`);
        logToFile(`🔄 Intentando descargar imagen: ${imageUrl}`);

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

        console.log(`🔄 Subiendo a Cloudinary con public_id: ${publicId}`);
        logToFile(`🔄 Subiendo a Cloudinary con public_id: ${publicId}`);

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
    console.log(`\n🖼️  Procesando imagen para producto ${productId}`);
    console.log(`   URL original: ${imageUrl}`);
    logToFile(`🖼️  Procesando imagen para producto ${productId}: ${imageUrl}`);

    if (!imageUrl) {
        console.log('   ⚠️  URL de imagen vacía o null');
        logToFile('   ⚠️  URL de imagen vacía para producto ' + productId);
        return null;
    }

    const cloudinaryUrl = await uploadImageToCloudinary(imageUrl, {
        folder: 'products-test',
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
    extractPublicIdFromUrl
};