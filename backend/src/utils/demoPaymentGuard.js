/**
 * Staging Demo Payment Authorization Guard
 *
 * Enforces strict environment boundaries for simulated payments:
 * Demo Payment is permitted ONLY when ALL of the following conditions match:
 * 1. APP_ENV === 'staging'
 * 2. ENABLE_DEMO_PAYMENT === 'true'
 * 3. RENDER === 'true'
 * 4. RENDER_SERVICE_ID === 'srv-dbqpapon74is73csbc80'
 * 5. RENDER_SERVICE_NAME === 'printgo-backend-staging'
 * 6. RENDER_GIT_BRANCH === 'feature/printgo-production-readiness'
 *
 * Fail closed if any condition is missing, falsy, or mismatched.
 * Never uses NODE_ENV because Render services default to NODE_ENV=production.
 * Production render.yaml must remain demo-disabled.
 */

const STAGING_SERVICE_ID = 'srv-dbqpapon74is73csbc80';
const STAGING_SERVICE_NAME = 'printgo-backend-staging';
const STAGING_GIT_BRANCH = 'feature/printgo-production-readiness';

/**
 * Evaluates whether Demo Payment is authorized for the given environment.
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
const isDemoPaymentPermitted = (env = process.env) => {
  if (!env || typeof env !== 'object') return false;

  const appEnv = String(env.APP_ENV || '').trim();
  const enableDemo = String(env.ENABLE_DEMO_PAYMENT || '').trim();
  const isRender = String(env.RENDER || '').trim();
  const serviceId = String(env.RENDER_SERVICE_ID || '').trim();
  const serviceName = String(env.RENDER_SERVICE_NAME || '').trim();
  const gitBranch = String(env.RENDER_GIT_BRANCH || '').trim();

  return (
    appEnv === 'staging' &&
    enableDemo === 'true' &&
    isRender === 'true' &&
    serviceId === STAGING_SERVICE_ID &&
    serviceName === STAGING_SERVICE_NAME &&
    gitBranch === STAGING_GIT_BRANCH
  );
};

module.exports = {
  isDemoPaymentPermitted,
  STAGING_SERVICE_ID,
  STAGING_SERVICE_NAME,
  STAGING_GIT_BRANCH
};
