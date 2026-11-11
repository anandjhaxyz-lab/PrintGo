const express = require('express');
const router = express.Router();
const paymentsController = require('./payments.controller');
const { requireSessionOrUser } = require('../../middlewares/session');
const { protect, restrictTo } = require('../../middlewares/auth');
const { readOnlyGuard } = require('../../middlewares/readOnlyGuard');

router.post('/order/:id', requireSessionOrUser, paymentsController.createCashfreeOrder);
router.post('/demo-pay/:id', requireSessionOrUser, paymentsController.demoPayment);
router.get('/verify/:id', requireSessionOrUser, paymentsController.verifyPayment);
router.post('/webhook', paymentsController.cashfreeWebhook); // Cashfree default webhook path
router.post('/webhook/cashfree', paymentsController.cashfreeWebhook); // Alternative path
router.post('/refund/:id', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, paymentsController.refundOrder);

module.exports = router;
