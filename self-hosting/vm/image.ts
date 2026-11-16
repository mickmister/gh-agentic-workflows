/** Build a credential-free Proxmox disk; test a separate bootable overlay.
 * Node >=22.18 with --experimental-strip-types; QEMU/KVM + cloud-localds.
 * Python is used only by the explicitly existing, unmigrated pilot test suite.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'self-hosting/runtime/vm');
const BASE_URL = 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img';
const BASE_SHA = '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

async function cmd(args: string[], options: { capture?: boolean; cwd?: string; input?: string; timeout?: number } = {}) {
  const child = spawn(args[0], args.slice(1), { cwd: options.cwd ?? ROOT,
    stdio: ['pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit'] });
  const output: Buffer[] = [];
  child.stdout?.on('data', b => output.push(b));
  // Captured SSH readiness errors never flood the log. Operational commands inherit stderr.
  child.stderr?.resume();
  child.stdin?.end(options.input);
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 1800000);
  try {
    await new Promise<void>((ok, fail) => {
      child.on('error', fail);
      child.on('close', code => code === 0 ? ok() : fail(new Error(`${args[0]} failed (${code})`)));
    });
    return Buffer.concat(output).toString().trim();
  } finally { clearTimeout(timer); }
}

async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}

async function boot(disk: string, stage: string, action: (ssh: (command: string) => Promise<string>) => Promise<void>) {
  const directory = resolve(OUT, stage);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const key = resolve(directory, 'identity');
  await cmd(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const userdata = '#cloud-config\n' + JSON.stringify({ ssh_pwauth: false,
    ssh_authorized_keys: [(await readFile(key + '.pub', 'utf8')).trim()] });
  await writeFile(resolve(directory, 'user-data'), userdata);
  await writeFile(resolve(directory, 'meta-data'), JSON.stringify({ 'instance-id': randomUUID(), 'local-hostname': 'agentic-vm' }));
  await cmd(['cloud-localds', resolve(directory, 'seed.img'), resolve(directory, 'user-data'), resolve(directory, 'meta-data')]);
  const port = stage === 'build' ? '19222' : '19223';
  const log = createWriteStream(resolve(directory, 'console.log'));
  const vm = spawn('qemu-system-x86_64', ['-enable-kvm', '-cpu', 'host', '-smp', '2', '-m', '4096',
    '-display', 'none', '-serial', 'stdio', '-monitor', 'none', '-no-reboot',
    '-drive', `file=${disk},format=qcow2,if=virtio,discard=unmap`,
    '-drive', `file=${resolve(directory, 'seed.img')},format=raw,if=virtio,readonly=on`,
    '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${port}-:22`, '-device', 'virtio-net-pci,netdev=net0',
    '-device', 'virtio-rng-pci'], { stdio: ['ignore', 'pipe', 'pipe'] });
  vm.stdout.pipe(log); vm.stderr.pipe(log, { end: false });
  let spawnError: Error | undefined;
  vm.on('error', error => { spawnError = error; });
  const sshArgs = ['ssh', '-i', key, '-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${resolve(directory, 'known_hosts')}`, 'ubuntu@127.0.0.1'];
  const ssh = (command: string) => cmd([...sshArgs, command]);
  try {
    let ready = false;
    for (let n = 0; n < 120; n++) {
      if (spawnError) throw spawnError;
      if (vm.exitCode !== null) throw new Error(`QEMU exited: see ${stage}/console.log`);
      try { await cmd([...sshArgs, 'true'], { capture: true, timeout: 10000 }); ready = true; break; }
      catch { await pause(2000); }
    }
    if (!ready) throw new Error(`Guest SSH did not become ready: see ${stage}/console.log`);
    await ssh('sudo cloud-init status --wait');
    console.log(`VM ${stage}: real guest booted`);
    if (stage === 'build') {
      const scp = ['scp', '-i', key, '-P', port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no',
        '-o', `UserKnownHostsFile=${resolve(directory, 'known_hosts')}`];
      await cmd([...scp, resolve(OUT, 'source.tar'), resolve(OUT, 'containers.tar'), 'ubuntu@127.0.0.1:/tmp/']);
    }
    await action(ssh);
    try { await ssh('sudo shutdown -h now'); } catch { /* SSH can close on shutdown. */ }
    for (let n = 0; n < 120 && vm.exitCode === null; n++) await pause(1000);
    if (vm.exitCode === null) throw new Error('Guest failed to shut down cleanly');
    if (vm.exitCode !== 0) throw new Error('QEMU guest exited unsuccessfully');
  } finally {
    if (vm.exitCode === null) {
      vm.kill('SIGTERM');
      await pause(2000);
      if (vm.exitCode === null) vm.kill('SIGKILL');
    }
    log.end();
    await rm(key, { force: true });
  }
}

async function main() {
  await mkdir(dirname(OUT), { recursive: true, mode: 0o700 });
  await mkdir(OUT, { recursive: false, mode: 0o700 });
  if (spawnSync('test', ['-w', '/dev/kvm']).status !== 0) throw new Error('QEMU E2E requires accessible /dev/kvm');
  const sha = await cmd(['git', 'rev-parse', 'HEAD'], { capture: true });
  const base = resolve(OUT, 'ubuntu.img');
  const response = await fetch(BASE_URL);
  if (!response.ok || !response.body) throw new Error('Ubuntu image download failed');
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(base));
  if (await digest(base) !== BASE_SHA) throw new Error('Ubuntu image checksum mismatch');
  const disk = resolve(OUT, 'build.qcow2');
  await cmd(['qemu-img', 'convert', '-O', 'qcow2', base, disk]);
  await rm(base);
  await cmd(['qemu-img', 'resize', disk, '40G']);
  await cmd(['git', 'archive', '--format=tar', '--output=' + resolve(OUT, 'source.tar'), 'HEAD', 'self-hosting',
    '.dockerignore', '.github/agent-toolchain.lock.json', '.github/nugs-toolchain.lock.json']);
  const services = JSON.parse(await cmd(['docker', 'compose', '--env-file', '.env.example', '-f', 'compose.yml', 'config', '--format', 'json'],
    { capture: true, cwd: resolve(ROOT, 'self-hosting') })).services;
  const images = [...new Set<string>(['minio', 'gateway', 'worker-image', 'gitea', 'runner', 'caddy'].map(name => services[name].image))];
  await cmd(['docker', 'save', '--output', resolve(OUT, 'containers.tar'), ...images]);
  await boot(disk, 'build', async ssh => {
    await ssh('sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io docker-compose-v2 qemu-guest-agent');
    await ssh('sudo mkdir -p /opt/agentic && sudo tar -xf /tmp/source.tar -C /opt/agentic && sudo docker load -i /tmp/containers.tar && sudo rm /tmp/source.tar /tmp/containers.tar');
    await ssh('sudo systemctl enable docker qemu-guest-agent && sudo docker compose version');
    await ssh('sudo test ! -e /opt/agentic/self-hosting/.env && sudo test ! -e /opt/agentic/self-hosting/secrets');
    // No app boot before sealing: no test data or generated service credentials in base.
    await ssh('sudo systemctl stop docker.service docker.socket && sudo apt-get clean && sudo fstrim -av');
    // Schedule shutdown before dropping the only build login; the current SSH
    // command completes before systemd powers the VM off.
    await ssh('sudo cloud-init clean --logs --machine-id --seed && sudo rm -f /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys /etc/ssh/ssh_host_* /etc/netplan/50-cloud-init.yaml && sudo systemd-run --on-active=5s /usr/sbin/shutdown -h now');
  });
  await rm(resolve(OUT, 'containers.tar')); await rm(resolve(OUT, 'source.tar'));
  const image = resolve(OUT, 'agentic-proxmox-amd64.qcow2');
  await cmd(['qemu-img', 'convert', '-c', '-O', 'qcow2', disk, image]);
  await rm(disk);
  const sealedHash = await digest(image);
  const overlay = resolve(OUT, 'test.qcow2');
  await cmd(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b', image, overlay]);
  await boot(overlay, 'test', async ssh => {
    await ssh('sudo test ! -e /opt/agentic/self-hosting/.env && sudo test ! -e /opt/agentic/self-hosting/secrets');
    await ssh('sudo systemctl is-active docker && sudo test -e /dev/vda');
    await ssh('cd /opt/agentic/self-hosting && sudo python3 tests/smoke.py && sudo docker exec agentic-test-gateway-1 python /opt/pilot/tests/storage_pages.py && sudo python3 tests/recovery.py');
  });
  await rm(overlay);
  if (await digest(image) !== sealedHash) throw new Error('E2E modified the sealed base image');
  await cmd(['qemu-img', 'check', image]);
  await writeFile(resolve(OUT, 'manifest.json'), JSON.stringify({ schema: 1, engine_sha: sha,
    image: 'agentic-proxmox-amd64.qcow2', sha256: sealedHash, format: 'qcow2', architecture: 'amd64',
    virtual_disk_gib: 40, ubuntu_image: BASE_URL, ubuntu_sha256: BASE_SHA,
    test: 'qemu-kvm-fresh-overlay-guest-native-compose-e2e', passed: true }, null, 2) + '\n');
  await chmod(image, 0o600);
  console.log('Sealed Proxmox disk passed guest E2E; ready for private S3 publication.');
}

await main();
