// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * O `expo-sqlite` na web carrega o SQLite compilado para WebAssembly, e importa o
 * `.wasm` como um módulo:
 *
 *   import wasmModule from './wa-sqlite/wa-sqlite.wasm';
 *
 * O Metro não conhece essa extensão por padrão e falha com "Unable to resolve module",
 * o que derruba o bundle inteiro — não só a parte de banco. Registrar `wasm` como
 * asset faz o arquivo ser servido em vez de interpretado como JavaScript.
 *
 * Só afeta a web: no Android e no iOS o expo-sqlite usa o SQLite nativo e nunca toca
 * neste caminho.
 */
config.resolver.assetExts.push('wasm');

module.exports = config;
