const { Worker } = require('bullmq');
const { connection } = require('./redisClient');
const uploadService = require('../modules/upload/upload.service');

const isRedisRequired =
  process.env.NODE_ENV === 'production' ||
  process.env.QUEUE_REDIS_REQUIRED === 'true';

let uploadWorker = null;
let workerReady = false;

const initUploadWorker = async () => {
  if (!connection) {
    if (isRedisRequired) {
      throw new Error('PrintGo production upload worker requires Redis; uploads cannot silently bypass the durable queue.');
    }
    console.warn('No Redis configured; upload background worker disabled in development/test.');
    return null;
  }

  if (uploadWorker && workerReady) return uploadWorker;

  try {
    uploadWorker = new Worker('uploadQueue', async (job) => {
      const { fileUrl, mimetype } = job.data;
      try {
        const pages = await uploadService.getPageCount(fileUrl, mimetype);
        return pages;
      } catch (error) {
        console.error(`Upload worker failed for job ${job.id}:`, error);
        throw error;
      }
    }, { connection, concurrency: 5 });

    uploadWorker.on('failed', (job, err) => {
      console.error(`Upload Job ${job.id} failed with error ${err.message}`);
    });

    await uploadWorker.waitUntilReady();
    workerReady = true;
    return uploadWorker;
  } catch (error) {
    workerReady = false;
    if (uploadWorker) {
      await uploadWorker.close().catch(() => {});
      uploadWorker = null;
    }
    if (isRedisRequired) {
      throw new Error(`Durable upload worker failed to become ready: ${error.message}`);
    }
    console.warn('Upload worker failed to start in development/test:', error.message);
    return null;
  }
};

const getUploadWorkerHealth = () => {
  const running = Boolean(
    uploadWorker &&
    typeof uploadWorker.isRunning === 'function' &&
    uploadWorker.isRunning()
  );
  return {
    configured: Boolean(connection),
    ready: Boolean(connection && connection.status === 'ready' && workerReady && running)
  };
};

const closeUploadWorker = async () => {
  workerReady = false;
  const worker = uploadWorker;
  uploadWorker = null;
  if (worker) await worker.close();
};

module.exports = {
  initUploadWorker,
  getUploadWorkerHealth,
  closeUploadWorker
};
