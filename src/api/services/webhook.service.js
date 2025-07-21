const axios = require('axios');

const WEBHOOK_URL = process.env.WEBHOOK_URL;

const sendWebhook = async (payload) => {
    try {
        const response = await axios.post(WEBHOOK_URL, payload);
        return response.data;
    } catch (error) {
        console.error('Error sending webhook:', error.message);
        throw new Error('Failed to send webhook');
    }
};

module.exports = {
    sendWebhook
};
