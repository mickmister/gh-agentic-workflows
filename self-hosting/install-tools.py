"""Install released, digest-verified tools at image-build time, never per turn."""
import base64
import hashlib
import io
import json
from pathlib import Path
import platform
import tarfile
import urllib.request

assert platform.machine() == "x86_64", "Pilot toolchain is linux/amd64; do not silently emulate arm64"
out = Path('/opt/tools')
out.mkdir(exist_ok=True)
lock = json.loads(Path('/opt/locks/agent-toolchain.lock.json').read_text())
for name in ('opencode', 'gas_city', 'gas_city_beads', 'gas_city_dolt'):
    item = lock[name]
    data = urllib.request.urlopen(item['url'], timeout=120).read()
    assert len(data) == item['archive_bytes'] and hashlib.sha256(data).hexdigest() == item['sha256']
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        member = archive.getmember(item['member'])
        assert member.isfile()
        binary = out / {'gas_city': 'gc', 'gas_city_beads': 'bd', 'gas_city_dolt': 'dolt'}.get(name, name)
        binary.write_bytes(archive.extractfile(member).read())
        binary.chmod(0o755)
item = json.loads(Path('/opt/locks/nugs-toolchain.lock.json').read_text())['tools']['nugs']
data = urllib.request.urlopen(item['tarball'], timeout=120).read()
assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == item['integrity']
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    members = [m for m in archive.getmembers() if m.isfile() and m.name.endswith('/nugs') and '/linux-amd64/' in m.name]
    # The published package layout is validated against the executable digest too.
    if not members:
        members = [m for m in archive.getmembers() if m.isfile() and m.size == item['binary_bytes']]
    binaries = [archive.extractfile(m).read() for m in members]
    binaries = [b for b in binaries if hashlib.sha256(b).hexdigest() == item['binary_sha256']]
    assert len(binaries) == 1
    (out / 'nugs').write_bytes(binaries[0])
    (out / 'nugs').chmod(0o755)
# GHU's current hosted build uses this exact pnpm release. Install the published
# package without a mutable global npm install or a first-use Corepack download.
data = urllib.request.urlopen('https://registry.npmjs.org/pnpm/-/pnpm-12.18.0.tgz', timeout=120).read()
assert 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() == 'sha512-nXiC1dyCFH7PxOBiqjSDTgrQKWcQoYN6ERWuASEn02txCeMhrBWYod0KZVl2gbHpmRfhLtDXSerpEYeUM2O+sw=='
destination = Path('/opt/pnpm')
destination.mkdir()
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    archive.extractall(destination, filter='data')
entry = destination / 'package/bin/pnpm.mjs'
entry.chmod(0o755)
(out / 'pnpm').symlink_to(entry)
