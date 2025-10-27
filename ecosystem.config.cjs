module.exports = {
  apps: [
    {
      name: "telegramBot",
      script: "./server/bots/telegramBot.js",
      watch: true,
      env: {
        NODE_ENV: "development"
      },
      env_production: {
        NODE_ENV: "production"
      }
    }
  ]
}
