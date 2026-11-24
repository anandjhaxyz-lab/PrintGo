const express = require('express');
const router = express.Router();
const machinesController = require('./machines.controller');
const { protect, restrictTo, protectMachine } = require('../../middlewares/auth');
const { readOnlyGuard } = require('../../middlewares/readOnlyGuard');
const { validate } = require('../../middlewares/validate');
const { createMachineSchema, updateMachineSchema } = require('../../utils/schemas');

router.get('/', protect, restrictTo('SUPERADMIN'), machinesController.getMachines);
router.post('/', protect, restrictTo('SUPERADMIN'), readOnlyGuard, validate(createMachineSchema), machinesController.createMachine);
router.put('/:id', protect, restrictTo('SUPERADMIN'), readOnlyGuard, validate(updateMachineSchema), machinesController.updateMachine);

router.get('/my-machines', protect, restrictTo('FRANCHISEE', 'STAFF'), machinesController.getMyMachines);
router.get('/agent-version', protectMachine, machinesController.getAgentVersion); // Protected OTA updater endpoint

router.get('/:id/public-key', machinesController.getPublicKey);

// Machine Payment Mode Configuration (Cash at Counter / Demo Simulation / Cashfree Online)
router.get('/:id/payment-mode', protect, restrictTo('SUPERADMIN', 'FRANCHISEE', 'STAFF'), machinesController.getPaymentMode);
router.put('/:id/payment-mode', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, machinesController.updatePaymentMode);
// Machine Advertisement Suppression (Silence Ads)
router.post('/:id/ad-suppression', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, machinesController.setAdSuppression);
router.delete('/:id/ad-suppression', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), readOnlyGuard, machinesController.cancelAdSuppression);
router.get('/:id/ad-suppression', protect, restrictTo('SUPERADMIN', 'FRANCHISEE'), machinesController.getAdSuppressionStatus);

module.exports = router;
