const { withAppBuildGradle } = require('@expo/config-plugins');
const path = require('path');

// Load .env for local builds; in CI the vars are injected directly
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

module.exports = function withAndroidSigning(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = applySigningConfig(config.modResults.contents);
    return config;
  });
};

function applySigningConfig(contents) {
  const storePassword = process.env.ANDROID_KEYSTORE_PASSWORD;
  const keyAlias = process.env.ANDROID_KEY_ALIAS;
  const keyPassword = process.env.ANDROID_KEY_PASSWORD;

  if (!storePassword || !keyAlias || !keyPassword) {
    throw new Error(
      '[withAndroidSigning] Missing env vars: ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD'
    );
  }

  // Inject release signingConfig block if not already present
  if (!contents.includes('prod.keystore')) {
    contents = contents.replace(
      /(signingConfigs\s*\{[\s\S]*?)(debug\s*\{[\s\S]*?\})\s*\}/,
      (_, prefix, debugBlock) =>
        `${prefix}${debugBlock}\n        release {\n            storeFile file('../../prod.keystore')\n            storePassword '${storePassword}'\n            keyAlias '${keyAlias}'\n            keyPassword '${keyPassword}'\n        }\n    }`
    );
  }

  // Point the release buildType to signingConfigs.release
  contents = contents.replace(
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/,
    '$1signingConfig signingConfigs.release'
  );

  return contents;
}
