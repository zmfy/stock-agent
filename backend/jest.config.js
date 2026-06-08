module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  testTimeout: 15000,
  // Each test file gets its own throwaway DB via DATA_DIR (set in tests)
};
