const usersService = require('./users.service');

const getUsers = async (req, res, next) => {
  try {
    const users = await usersService.getUsers();
    res.json({ success: true, users });
  } catch (error) {
    next(error);
  }
};

const getUserById = async (req, res, next) => {
  try {
    const user = await usersService.getUserById(req.params.id);
    res.json({ success: true, user });
  } catch (error) {
    next(error);
  }
};

const updateUser = async (req, res, next) => {
  try {
    const updatedUser = await usersService.updateUser(req.params.id, req.body, req.user);
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    next(error);
  }
};

const toggleUserActive = async (req, res, next) => {
  try {
    const updatedUser = await usersService.toggleUserActive(req.params.id, req.body.isActive, req.user);
    res.json({ success: true, user: updatedUser });
  } catch (error) {
    next(error);
  }
};

const deleteUser = async (req, res, next) => {
  try {
    const result = await usersService.deleteUser(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUsers,
  getUserById,
  updateUser,
  toggleUserActive,
  deleteUser
};
