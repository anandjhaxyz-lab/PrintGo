/**
 * Test Suite: Render Cloud Deployment Readiness — CORS & WebSocket Authentication
 * 
 * Verifies:
 * 1. Express CORS allows exact FRONTEND_URL origin.
 * 2. Express CORS allows local development origins (localhost:5173, etc.).
 * 3. Express CORS allows local LAN subnet (http://192.168.x.x:5173).
 * 4. Express CORS strictly blocks unauthorized origins (https://malicious-site.com).
 * 5. Express CORS strictly blocks blanket wildcards (*.onrender.com).
 * 6. Non-browser requests (no Origin header) proceed cleanly.
 * 7. Socket.IO connects and authenticates printer agents via valid machineKey.
 * 8. Socket.IO rejects printer agent connection with invalid machineKey.
 * 9. Socket.IO rejects client connection with missing credentials.
 * 10. Socket.IO authenticates customer/admin JWT token sessions.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: Client } = require(path.resolve(__dirname, '../../printer-agent/node_modules/socket.io-client'));
const prisma = require('../src/utils/prisma');
const setupSockets = require('../src/socket');

// Test runner helpers
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  âœ“ ${message}`);
    passed++;
  } else {
    console.error(`  âœ— FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n--- 1. Testing CORS Validator & Express Integration ---');

  // Set configured frontend URL
  const testFrontendOrigin = 'https://printgo-admin.onrender.com';
  process.env.FRONTEND_URL = testFrontendOrigin;

  // Build origin validator exactly as configured in server.js
  const defaultDevOrigins = [
    'https://print-go-steel.vercel.app',
    'http://localhost:5173',
    'http://localhost:4173',
    'http://localhost:5174',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
    'http://192.168.1.2:5173'
  ];

  const configuredFrontendOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const allowedOriginsSet = new Set([...defaultDevOrigins, ...configuredFrontendOrigins]);

  const testCorsValidator = (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOriginsSet.has(origin)) return callback(null, true);
    if (/^http:\/\/192\.168\.\d+\.\d+:5173$/.test(origin)) return callback(null, true);
    return callback(new Error(`Origin '${origin}' not allowed by CORS policy`), false);
  };

  const app = express();
  app.use(cors({
    origin: testCorsValidator,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }));

  app.get('/api/test-cors', (req, res) => {
    res.json({ ok: true });
  });

  // Error handler matching backend/src/middlewares/error.js
  app.use((err, req, res, next) => {
    if (err.message && err.message.includes('CORS')) {
      return res.status(403).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal Error' });
  });

  const testServer = http.createServer(app);
  const ioServer = new Server(testServer, {
    cors: {
      origin: testCorsValidator,
      methods: ['GET', 'POST', 'PUT'],
      credentials: true
    }
  });

  setupSockets(ioServer);

  await new Promise((resolve) => testServer.listen(0, resolve));
  const port = testServer.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // Test 1: Configured FRONTEND_URL allowed
    const res1 = await fetch(`${baseUrl}/api/test-cors`, {
      headers: { Origin: testFrontendOrigin }
    });
    assert(
      res1.status === 200 && res1.headers.get('access-control-allow-origin') === testFrontendOrigin,
      `CORS allows exact FRONTEND_URL (${testFrontendOrigin}) with 200 OK`
    );

    // Test 2: Localhost dev origin allowed
    const res2 = await fetch(`${baseUrl}/api/test-cors`, {
      headers: { Origin: 'http://localhost:5173' }
    });
    assert(
      res2.status === 200 && res2.headers.get('access-control-allow-origin') === 'http://localhost:5173',
      'CORS allows local development origin (http://localhost:5173)'
    );

    // Test 3: Local LAN subnet allowed
    const res3 = await fetch(`${baseUrl}/api/test-cors`, {
      headers: { Origin: 'http://192.168.1.150:5173' }
    });
    assert(
      res3.status === 200 && res3.headers.get('access-control-allow-origin') === 'http://192.168.1.150:5173',
      'CORS allows local mobile testing LAN IP (http://192.168.1.150:5173)'
    );

    // Test 4: Unauthorized external origin blocked
    const res4 = await fetch(`${baseUrl}/api/test-cors`, {
      headers: { Origin: 'https://malicious-site.com' }
    });
    assert(
      res4.status === 403,
      `CORS rejects unauthorized origin with 403 Forbidden (status=${res4.status})`
    );

    // Test 5: Blanket *.onrender.com wildcard rejected
    const res5 = await fetch(`${baseUrl}/api/test-cors`, {
      headers: { Origin: 'https://unauthorized-app.onrender.com' }
    });
    assert(
      res5.status === 403,
      'CORS rejects blanket *.onrender.com wildcard domain with 403 Forbidden'
    );

    // Test 6: Non-browser request (no Origin header) allowed
    const res6 = await fetch(`${baseUrl}/api/test-cors`);
    assert(
      res6.status === 200,
      'CORS allows non-browser requests (no Origin header, e.g. printer agent, curl)'
    );

    console.log('\n--- 2. Testing WebSocket & Printer Agent Authentication ---');

    // Retrieve active machine key from DB
    const activeMachine = await prisma.machine.findFirst({ where: { status: 'ACTIVE' } });
    assert(!!activeMachine, `Database contains active printer machine record (${activeMachine?.id})`);

    // Test 7: Valid machineKey connects successfully
    const validAgentClient = Client(baseUrl, {
      transports: ['websocket'],
      auth: { machineKey: activeMachine.machineKey }
    });

    const registeredPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Printer registration timeout')), 4000);
      validAgentClient.on('printer_registered_success', (data) => {
        clearTimeout(timeout);
        resolve(data);
      });
      validAgentClient.on('connect_error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    const regData = await registeredPromise;
    assert(
      regData && regData.machineId === activeMachine.id,
      `Printer agent with valid machineKey authenticated and received printer_registered_success`
    );
    validAgentClient.close();

    // Test 8: Invalid machineKey is rejected
    const invalidAgentClient = Client(baseUrl, {
      transports: ['websocket'],
      auth: { machineKey: 'fake_invalid_machine_key_99999' }
    });

    const rejectPromise = new Promise((resolve) => {
      invalidAgentClient.on('connect_error', (err) => resolve(err.message));
      invalidAgentClient.on('connect', () => resolve('unexpected_connection'));
    });

    const rejectMsg = await rejectPromise;
    assert(
      rejectMsg.includes('Invalid machine key') || rejectMsg.includes('Authentication error'),
      `Printer agent with invalid machineKey rejected (${rejectMsg})`
    );
    invalidAgentClient.close();

    // Test 9: Missing credentials is rejected
    const noAuthClient = Client(baseUrl, {
      transports: ['websocket'],
      auth: {}
    });

    const noAuthPromise = new Promise((resolve) => {
      noAuthClient.on('connect_error', (err) => resolve(err.message));
      noAuthClient.on('connect', () => resolve('unexpected_connection'));
    });

    const noAuthMsg = await noAuthPromise;
    assert(
      noAuthMsg.includes('Missing token or machineKey') || noAuthMsg.includes('Authentication error'),
      `WebSocket connection without credentials rejected (${noAuthMsg})`
    );
    noAuthClient.close();

    // Test 10: Valid customer session JWT token connects
    const testSessionToken = jwt.sign(
      { type: 'session', sessionId: 'test-session-123' },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    const sessionClient = Client(baseUrl, {
      transports: ['websocket'],
      auth: { token: testSessionToken }
    });

    const sessionConnected = await new Promise((resolve) => {
      sessionClient.on('connect', () => resolve(true));
      sessionClient.on('connect_error', () => resolve(false));
    });

    assert(
      sessionConnected === true,
      'Customer session with valid JWT token successfully connected via WebSocket'
    );
    sessionClient.close();

  } finally {
    testServer.close();
    await prisma.$disconnect();
  }

  console.log(`\n================================`);
  console.log(`TEST SUMMARY: ${passed} Passed, ${failed} Failed`);
  console.log(`================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution fatal error:', err);
  process.exit(1);
});
