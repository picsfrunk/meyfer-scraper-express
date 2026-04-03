const { notifyWebhook } = require('../src/api/services/webhookService');
const axios = require('axios');

// Monkeypatch axios.post to capture payload instead of doing network I/O
axios.post = async (url, data) => {
  console.log('POST to:', url);
  console.log('Payload:', JSON.stringify(data, null, 2));
  return { status: 200 };
};

async function run() {
  // Create a fake job with circular refs and a fake MongoClient-like object
  function MongoClient() { this.s = { info: 'client' }; }

  const job = { id: 'job1', name: 'test-job', data: { items: [1,2,3] } };
  job.nested = { parent: job };
  job.client = new MongoClient();

  const result = {
    event: 'completed',
    job,
    queueSnapshot: { length: 5, head: job },
    result: { total: 3, errors: 0 }
  };

  await notifyWebhook({ webhookUrl: 'http://example.invalid/webhook', source: 'test', status: 'ok', result });
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});


