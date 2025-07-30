const axios = require('axios');

const sendWebhook = async (webhookUrl, payload) => {
    try {
        console.log(`Enviando webhook a: ${webhookUrl}`, payload);
        const response = await axios.post(webhookUrl, payload);
        return response.data;
    } catch (error) {
        console.error('Error sending webhook to:', webhookUrl, "Error: ", error.message);
        throw new Error('Failed to send webhook');
    }
};

module.exports = {
    sendWebhook
};
