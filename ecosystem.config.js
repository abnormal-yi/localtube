module.exports = {
  apps: [{
    name: 'localtube',
    script: 'server.js',
    instances: 1,
    max_memory_restart: '512M',
    restart_delay: 3000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
