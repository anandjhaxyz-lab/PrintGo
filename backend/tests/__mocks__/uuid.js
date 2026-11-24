const crypto = require('crypto');

module.exports = {
  v4: () => crypto.randomUUID(),
  v1: () => crypto.randomUUID(),
  v7: () => crypto.randomUUID(),
  validate: (str) => typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str),
  parse: (str) => Buffer.from(str.replace(/-/g, ''), 'hex'),
  stringify: (buf) => buf.toString('hex')
};
