const {spawnSync} = require('node:child_process');
const path = require('node:path');
module.exports = phase => {
  const env = {...process.env, OTEL_SDK_DISABLED: 'true'};
  for (const suffix of ['URL', 'REGION', 'BUCKET', 'PREFIX', 'PATH_STYLE', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
    env['S3_CACHE_' + suffix] = env['INPUT_S3-' + suffix.replaceAll('_', '-')];
  }
  const result = spawnSync('python3', [path.join(__dirname, '../../scripts/private-observability.py'), phase], {
    env, stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
};
