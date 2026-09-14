const path = require('path');
const os = require('os');

// Boot-durable registration is via ~/zylos/pm2/ecosystem.config.cjs (core reads
// only that file on resurrect); this file is the entry the component manager
// merges from. Ports: 3802 ext lane (Caddy /browser-remote/*), 3803 agent lane.
module.exports = {
  apps: [{
    name: 'zylos-browser-remote',
    script: 'relay/server.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/browser-remote'),
    env: {
      NODE_ENV: 'production',
    },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    error_file: path.join(os.homedir(), 'zylos/components/browser-remote/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/browser-remote/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
