const express = require('express');
const router = express.Router();
const usersController = require('./users.controller');
const { protect, restrictTo } = require('../../middlewares/auth');
const { readOnlyGuard } = require('../../middlewares/readOnlyGuard');
const { validate } = require('../../middlewares/validate');
const { updateUserSchema, toggleUserActiveSchema, deleteUserSchema } = require('../../utils/schemas');

// All user management routes require SUPERADMIN authorization
router.use(protect);
router.use(restrictTo('SUPERADMIN'));

router.get('/', usersController.getUsers);
router.get('/:id', usersController.getUserById);

router.put('/:id', readOnlyGuard, validate(updateUserSchema), usersController.updateUser);
router.patch('/:id/toggle-active', readOnlyGuard, validate(toggleUserActiveSchema), usersController.toggleUserActive);
router.delete('/:id', readOnlyGuard, validate(deleteUserSchema), usersController.deleteUser);

module.exports = router;
