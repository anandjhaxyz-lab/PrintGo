const readOnlyGuard = (req, res, next) => {
  if (process.env.ADMIN_READ_ONLY === 'true') {
    const mutationMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
    if (mutationMethods.includes(req.method)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Cloud Admin Dashboard is operating in Read-Only Monitoring Mode. Remote mutations are disabled.'
      });
    }
  }
  next();
};

module.exports = { readOnlyGuard };
