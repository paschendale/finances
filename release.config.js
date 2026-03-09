/** @type {import('semantic-release').GlobalConfig} */
module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/github",
    [
      "@semantic-release/exec",
      {
        successCmd:
          'python scripts/run_migration_with_notify.py "${nextRelease.version}"',
      },
    ],
  ],
};
