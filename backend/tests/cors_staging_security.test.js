/**
 * Automated Test Suite: S3K Phase 1A — Staging & Production CORS + Socket.IO Origin Hardening
 *
 * Tests `createCorsOriginValidator` from `backend/src/server.js` directly with:
 * - Allowed staging frontend origin via ALLOWED_ORIGINS (comma-separated)
 * - Unauthorized origin rejection (HTTP 403)
 * - Wildcard origin rejection (* and *.vercel.app / *.onrender.com)
 * - Production localhost & 127.0.0.1 & LAN subnet rejection (even if mistakenly listed)
 * - Legacy print-go-steel.vercel.app rejected in production unless explicitly configured
 * - Development localhost access preserved when NODE_ENV=development
 * - Server-to-server webhook access (no Origin header) preserved
 * - Socket.IO handshake origin validation (allowed staging origin connects; unauthorized/localhost rejected)
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: ClientIo } = require(path.resolve(__dirname, '../../printer-agent/node_modules/socket.io-client'));

process.env.NODE_ENV = 'test';
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createCorsOriginValidator } = require('../src/server');
const setupSockets = require('../src/socket');
const { errorHandler } = require('../src/middlewares/error');

let passed = 0;
let failed = 0;

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL: ${name} -> ${err.message}`);
    failed++;
  }
}

function buildTestApp(envOverrides) {
  const { allowedOriginsSet, corsOriginValidator } = createCorsOriginValidator(envOverrides);
  const app = express();
  app.use(cors({
    origin: corsOriginValidator,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }));
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/payments/webhook', (req, res) => res.json({ received: true }));
  app.use(errorHandler);

  const httpServer = http.createServer(app);
  const ioServer = new Server(httpServer, {
    cors: {
      origin: corsOriginValidator,
      methods: ['GET', 'POST', 'PUT'],
      credentials: true
    }
  });
  setupSockets(ioServer);

  return { app, httpServer, ioServer, allowedOriginsSet };
}

async function runTests() {
  console.log('=== S3K Phase 1A CORS & Socket.IO Origin Hardening Tests ===');

  const stagingOrigin = 'https://s3k-print-staging.vercel.app';
  const secondaryStagingOrigin = 'https://s3k-preview-staging.vercel.app';

  const prodEnv = {
    NODE_ENV: 'production',
    ALLOWED_ORIGINS: ` ${stagingOrigin}/ , ${secondaryStagingOrigin} , https://*.vercel.app , * , http://localhost:5173 `,
    FRONTEND_URL: '',
    PUBLIC_APP_URL: '',
    PUBLIC_FRONTEND_URL: ''
  };

  const { httpServer, ioServer, allowedOriginsSet } = buildTestApp(prodEnv);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await runCase('1. ALLOWED_ORIGINS parsed cleanly without wildcards or localhost in production', () => {
      assert(allowedOriginsSet.has(stagingOrigin), 'Primary staging origin included');
      assert(allowedOriginsSet.has(secondaryStagingOrigin), 'Secondary comma-separated staging origin included');
      assert(!allowedOriginsSet.has('*'), 'Blanket wildcard stripped');
      assert(!allowedOriginsSet.has('https://*.vercel.app'), 'Subdomain wildcard stripped');
      assert(!allowedOriginsSet.has('http://localhost:5173'), 'Localhost stripped in production runtime');
      assert(!allowedOriginsSet.has('https://print-go-steel.vercel.app'), 'Legacy print-go-steel.vercel.app excluded unless explicitly configured');
    });

    await runCase('2. Express CORS allows configured staging frontend origin', async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: stagingOrigin }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), stagingOrigin);
      assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
    });

    await runCase('3. Express CORS rejects unauthorized origin with 403', async () => {
      const res = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: 'https://evil-attacker.example.com' }
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    });

    await runCase('4. Express CORS rejects wildcard origins (* and https://*.vercel.app)', async () => {
      const res1 = await fetch(`${baseUrl}/api/health`, { headers: { Origin: '*' } });
      const res2 = await fetch(`${baseUrl}/api/health`, { headers: { Origin: 'https://*.vercel.app' } });
      assert.strictEqual(res1.status, 403);
      assert.strictEqual(res2.status, 403);
    });

    await runCase('5. Express CORS rejects localhost, 127.0.0.1, LAN subnet, and unconfigured legacy Vercel origin in production', async () => {
      for (const blocked of [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://192.168.1.150:5173',
        'https://print-go-steel.vercel.app'
      ]) {
        const res = await fetch(`${baseUrl}/api/health`, { headers: { Origin: blocked } });
        assert.strictEqual(res.status, 403, `Expected 403 for ${blocked}, got ${res.status}`);
      }
    });

    await runCase('6. Server-to-server Cashfree webhook without Origin header remains accessible', async () => {
      const res = await fetch(`${baseUrl}/api/payments/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'PAYMENT_SUCCESS_WEBHOOK' })
      });
      assert.strictEqual(res.status, 200);
    });

    const sessionToken = jwt.sign(
      { type: 'session', sessionId: 'cors-socket-test-sess' },
      process.env.JWT_SECRET,
      { expiresIn: '10m' }
    );

    await runCase('7. Socket.IO allows connection from authorized staging origin', async () => {
      const client = ClientIo(baseUrl, {
        transports: ['polling', 'websocket'],
        auth: { token: sessionToken },
        extraHeaders: { Origin: stagingOrigin },
        reconnection: false
      });

      const connected = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 3000);
        client.on('connect', () => { clearTimeout(t); resolve(true); });
        client.on('connect_error', () => { clearTimeout(t); resolve(false); });
      });
      client.close();
      assert.strictEqual(connected, true);
    });

    await runCase('8. Socket.IO rejects unauthorized origin and production localhost origin', async () => {
      for (const badOrigin of ['https://evil-attacker.example.com', 'http://localhost:5173', 'https://print-go-steel.vercel.app']) {
        const client = ClientIo(baseUrl, {
          transports: ['polling', 'websocket'],
          auth: { token: sessionToken },
          extraHeaders: { Origin: badOrigin },
          reconnection: false
        });

        const rejected = await new Promise((resolve) => {
          const t = setTimeout(() => resolve('timeout'), 3000);
          client.on('connect', () => { clearTimeout(t); resolve('connected'); });
          client.on('connect_error', () => { clearTimeout(t); resolve('rejected'); });
        });
        client.close();
        assert.strictEqual(rejected, 'rejected', `Expected Socket.IO rejection for ${badOrigin}, got ${rejected}`);
      }
    });

    await runCase('9. Development runtime keeps localhost:5173 and LAN testing working while still rejecting unauthorized domains', async () => {
      const devSetup = buildTestApp({ NODE_ENV: 'development', ALLOWED_ORIGINS: '' });
      await new Promise((resolve) => devSetup.httpServer.listen(0, resolve));
      const devUrl = `http://127.0.0.1:${devSetup.httpServer.address().port}`;
      try {
        const okLocal = await fetch(`${devUrl}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
        assert.strictEqual(okLocal.status, 200);
        assert.strictEqual(okLocal.headers.get('access-control-allow-origin'), 'http://localhost:5173');

        const okLan = await fetch(`${devUrl}/api/health`, { headers: { Origin: 'http://192.168.1.44:5173' } });
        assert.strictEqual(okLan.status, 200);

        const badExternal = await fetch(`${devUrl}/api/health`, { headers: { Origin: 'https://evil-attacker.example.com' } });
        assert.strictEqual(badExternal.status, 403);

        const legacyUnconfigured = await fetch(`${devUrl}/api/health`, { headers: { Origin: 'https://print-go-steel.vercel.app' } });
        assert.strictEqual(legacyUnconfigured.status, 403);
      } finally {
        devSetup.ioServer.close();
        await new Promise((resolve) => devSetup.httpServer.close(resolve));
      }
    });
  } finally {
    ioServer.close();
    await new Promise((resolve) => httpServer.close(resolve));
  }

  console.log(`\nCORS HARDENING SUMMARY: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
