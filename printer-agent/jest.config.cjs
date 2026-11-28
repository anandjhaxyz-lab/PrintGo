'use strict';

module.exports = {
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', {
      configFile: false,
      babelrc: false
    }]
  }
};
