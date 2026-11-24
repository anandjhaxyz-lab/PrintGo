const express = require('express');
const router = express.Router();
const authController = require('./auth.controller');
const { protect } = require('../../middlewares/auth');
const { validate } = require('../../middlewares/validate');
const { loginSchema, activateSchema, sessionSchema } = require('../../utils/schemas');

router.post('/login', validate(loginSchema), authController.login);
router.post('/activate', validate(activateSchema), authController.activateAccount);
router.post('/logout', authController.logout);
router.get('/me', protect, authController.getMe);

// New session endpoints (P0-006)
router.post('/session/create', validate(sessionSchema), authController.createSession);  // Kiosk creates session
router.post('/session/join', validate(sessionSchema), authController.joinSession);      // Mobile joins session

// Backward compatibility: old /session endpoint redirects to /session/join
// This allows the mobile frontend to work while being migrated
router.post('/session', validate(sessionSchema), authController.joinSession);

// Permanent Printer QR session endpoints (Phase 2)
router.post('/session/from-printer-qr', authController.createSessionFromPrinterQr);
router.get('/printer-qr/:publicCode', authController.getPublicPrinterQrInfo);
router.get('/pricing', authController.getPublicPricing);

module.exports = router;
