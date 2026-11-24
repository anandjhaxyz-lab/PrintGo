const companiesService = require('./companies.service');

const getCompanies = async (req, res, next) => {
  try {
    const companies = await companiesService.getCompanies();
    res.json({ success: true, companies });
  } catch (error) {
    next(error);
  }
};

const createCompany = async (req, res, next) => {
  try {
    const result = await companiesService.createCompany(req.body);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCompanies,
  createCompany
};
