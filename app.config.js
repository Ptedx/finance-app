module.exports = ({ config }) => {
  const isDev = process.env.APP_ENV === 'development';

  return {
    ...config,
    // Muda o nome do app na tela do celular para você saber qual é qual
    name: isDev ? `${config.name} (Dev)` : config.name,
    ios: {
      ...config.ios,
      // Adiciona .dev no final do pacote no iOS
      bundleIdentifier: isDev 
        ? `${config.ios.bundleIdentifier}.dev` 
        : config.ios.bundleIdentifier,
    },
    android: {
      ...config.android,
      // Adiciona .dev no final do pacote no Android (isso permite instalar 2 apps)
      package: isDev 
        ? `${config.android.package}.dev` 
        : config.android.package,
    },
  };
};
