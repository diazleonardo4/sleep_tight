// Shared Redis client for serverless functions.
// Reused across warm invocations — do NOT open a new connection per request.
const Redis = require('ioredis');

let client;

function getRedis() {
  if (!client) {
    client = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      lazyConnect: true,
    });
  }
  return client;
}

module.exports = { getRedis };
