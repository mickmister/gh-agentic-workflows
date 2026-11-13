const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
module.exports = phase => {
  const env = {...process.env, OTEL_SDK_DISABLED: 'true'};
  for (const suffix of ['URL', 'REGION', 'BUCKET', 'PREFIX', 'PATH_STYLE', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY']) {
    env['S3_CACHE_' + suffix] = env['INPUT_S3-' + suffix.replaceAll('_', '-')];
  }
  // Thoth installs the OTLP SDK/decoder before its post-hook. Pre must remain
  // stdlib-only so capture can begin before observer dependency installation.
  const sdkPython = '/opt/opentelemetry_shell/venv/bin/python';
  const python = phase === 'post' && fs.existsSync(sdkPython) ? sdkPython : 'python3';
  const result = spawnSync(python, [path.join(__dirname, '../../scripts/private-observability.py'), phase], {
    env, stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
};
