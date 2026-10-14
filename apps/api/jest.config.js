/**
 * unit:        pure logic, no services needed.
 * integration: real Postgres (TEST_DATABASE_URL); Redis/S3 are replaced by in-process
 *              implementations of the same interfaces (see test/support).
 * @type {import('jest').Config}
 */
const common = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: { "^@uo/shared$": "<rootDir>/../../packages/shared/src" },
};
module.exports = {
  projects: [
    { ...common, displayName: "unit", testMatch: ["<rootDir>/test/unit/**/*.test.ts"] },
    { ...common, displayName: "integration", testMatch: ["<rootDir>/test/integration/**/*.test.ts"] },
  ],
};
