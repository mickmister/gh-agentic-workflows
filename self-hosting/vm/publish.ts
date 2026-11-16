/** Private S3 VM distribution. Uses the existing explicit S3_CACHE_* binding.
 * No workflow artifacts, signed public links, Python wrapper, or npm dependency.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const operation = process.argv[2];
const id = process.argv[3] ?? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
if (!['upload', 'download'].includes(operation) || !/^\d+-\d+$/.test(id)) {
  throw new Error('Usage: publish.ts upload|download RUN_ID-ATTEMPT [DIRECTORY]');
}
const directory = resolve(process.argv[4] ?? 'self-hosting/runtime/vm');
const required = ['URL', 'REGION', 'BUCKET', 'PREFIX', 'PATH_STYLE', 'ACCESS_KEY_ID', 'SECRET_ACCESS_KEY'];
for (const name of required) if (!process.env['S3_CACHE_' + name]) throw new Error(`Missing S3_CACHE_${name}`);
const endpoint = new URL(process.env.S3_CACHE_URL!);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
  throw new Error('Expected explicit HTTPS S3 origin');
}
const bucket = process.env.S3_CACHE_BUCKET!;
const prefix = process.env.S3_CACHE_PREFIX!.replace(/^\/+|\/+$/g, '');
const region = process.env.S3_CACHE_REGION!;
if (!/^[a-zA-Z0-9._-]+$/.test(bucket) || !/^[a-z0-9-]+$/.test(region) || !prefix || prefix.split('/').some(p => !/^[a-zA-Z0-9._-]+$/.test(p) || p === '.' || p === '..')) {
  throw new Error('Invalid S3 namespace');
}
if (!['true', 'false'].includes(process.env.S3_CACHE_PATH_STYLE!)) throw new Error('Invalid path-style setting');
const temporary = await mkdtemp(join(tmpdir(), 'agentic-vm-s3-'));
const config = join(temporary, 'config');
await writeFile(config, `[default]\nregion = ${region}\ns3 =\n    addressing_style = ${process.env.S3_CACHE_PATH_STYLE === 'true' ? 'path' : 'virtual'}\n`, { mode: 0o600 });
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_')));
Object.assign(env, { AWS_ACCESS_KEY_ID: process.env.S3_CACHE_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.S3_CACHE_SECRET_ACCESS_KEY,
  AWS_SESSION_TOKEN: process.env.S3_CACHE_SESSION_TOKEN ?? '', AWS_CONFIG_FILE: config, AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '', AWS_MAX_ATTEMPTS: '3',
  AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' });
const location = `s3://${bucket}/${prefix}/vm-images/${id}`;
const imageName = 'agentic-proxmox-amd64.qcow2';

async function aws(args: string[]) {
  const child = spawn('aws', ['--endpoint-url', endpoint.origin, '--region', region, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [];
  child.stdout.on('data', part => output.push(part));
  child.stderr.resume(); // Never log destinations, signed requests or provider bodies.
  const timer = setTimeout(() => child.kill('SIGKILL'), 1800000);
  try {
    await new Promise<void>((ok, fail) => {
      child.on('error', fail); child.on('close', code => code === 0 ? ok() : fail(new Error('Private S3 transfer failed')));
    });
    return Buffer.concat(output).toString().trim();
  } finally { clearTimeout(timer); }
}
async function checksum(path: string) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
try {
  if (operation === 'download') {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await aws(['s3', 'cp', `${location}/manifest.json`, resolve(directory, 'manifest.json'), '--only-show-errors']);
  }
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || manifest.image !== imageName || manifest.passed !== true ||
      manifest.test !== 'qemu-kvm-fresh-overlay-guest-native-compose-e2e' || !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
      !/^[a-f0-9]{40}$/.test(manifest.engine_sha)) throw new Error('Invalid or untested VM manifest');
  const image = resolve(directory, imageName);
  if (operation === 'download') await aws(['s3', 'cp', `${location}/${imageName}`, image, '--only-show-errors']);
  if (await checksum(image) !== manifest.sha256) throw new Error('VM disk SHA256 mismatch');
  if (operation === 'upload') {
    await aws(['s3', 'cp', image, `${location}/${imageName}`, '--only-show-errors', '--metadata', `sha256=${manifest.sha256}`]);
    const size = await aws(['s3api', 'head-object', '--bucket', bucket, '--key', `${prefix}/vm-images/${id}/${imageName}`, '--query', 'ContentLength', '--output', 'text']);
    if (Number(size) !== (await stat(image)).size) throw new Error('Uploaded VM length mismatch');
    // Publish the manifest last; consumers never accept an untested/partial release.
    await aws(['s3', 'cp', resolve(directory, 'manifest.json'), `${location}/manifest.json`, '--only-show-errors']);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Proxmox VM passed E2E and was published privately\n\nImage ID: \`${id}\`\n\nEngine: \`${manifest.engine_sha}\`\n\nSHA256: \`${manifest.sha256}\`\n\nDownload with configured S3_CACHE credentials:\n\n\`node --experimental-strip-types self-hosting/vm/publish.ts download ${id}\`\n\nSee self-hosting/vm/README.md for Proxmox import. No build keys or test state are included.\n`);
  }
  console.log(`VM ${operation} verified; image ID ${id}, SHA256 ${manifest.sha256}`);
} finally { await rm(temporary, { recursive: true, force: true }); }
