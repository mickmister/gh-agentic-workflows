# On-demand Proxmox VM

The **Self-hosted VM and Compose (on demand)** Actions workflow builds an amd64
Ubuntu 24.04 QCOW2 disk with Docker, Compose, QEMU guest agent, this engine's
pilot source and preloaded stack images. It runs only by `workflow_dispatch`.
Choose `suite=vm` (default) to build, boot-test and publish a VM, or `suite=compose`
for just the existing container integration test. Neither suite runs on commits
or pull requests. Other repository CI is independent.

```sh
gh workflow run self-hosting.yml --ref vk/46e5-vd-multi-instanc \
  -f suite=vm -f publish=true
```

The build pins the Ubuntu cloud disk by dated URL and SHA256. Ubuntu packages
are resolved during provisioning, so rebuilds are not byte-identical. The image
contains the published locked native tools, not source-built nugs.

## What CI actually tests

A hardware-accelerated QEMU/KVM guest is provisioned over temporary SSH. It is
shut down and sealed before any app configuration or test data is created.
CI then boots a new QCOW2 overlay with fresh cloud-init identity/SSH keys and
runs the existing native pilot suite **inside that guest**: real Gitea jobs,
container isolation, OpenCode source read/import, duplicate admission, native
abort, queued continuation, HTTPS S3 publication and fresh-volume recovery.
The inference provider is deterministic; this is not live-model acceptance.

The sealed base must remain unchanged and pass `qemu-img check`. Only then are
the base QCOW2 and checksum manifest published to private S3. The test overlay,
generated credentials and temporary build SSH keys are not distributed.
CI requires `/dev/kvm`; a runner without nested virtualization fails explicitly.
Current CI uses two guest vCPUs and 4 GiB RAM. Proxmox itself is not installed in
CI; actual Proxmox import/network configuration remains host acceptance.

## Download

The successful job summary reports an image ID (`RUN_ID-ATTEMPT`), source SHA
and disk SHA256. Set the same explicit `S3_CACHE_*` credentials/binding used by
the repository (see `.github/actions/workflow-files/action.yml`), with Node
22.18+ and AWS CLI available, then:

```sh
node --experimental-strip-types self-hosting/vm/publish.ts download RUN_ID-ATTEMPT
```

This retrieves `self-hosting/runtime/vm/agentic-proxmox-amd64.qcow2` and
`manifest.json`, verifying the disk SHA256. Private objects live beneath the
configured prefix at `vm-images/RUN_ID-ATTEMPT/`. No Actions artifacts or publicly
signed download links are created. `publish=false` runs the complete build/E2E
without storing a downloadable image.

## Import into Proxmox

Copy the verified disk to your **amd64 Proxmox host**. Choose an unused VM ID,
your storage pool and bridge (examples: `9001`, `local-lvm`, `vmbr0`):

```sh
qm create 9001 --name agentic --memory 4096 --cores 2 --cpu host \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci --agent enabled=1 \
  --serial0 socket --vga serial0
qm set 9001 --scsi0 local-lvm:0,import-from=/path/to/agentic-proxmox-amd64.qcow2,discard=on
qm set 9001 --ide2 local-lvm:cloudinit --boot order=scsi0
qm set 9001 --ciuser ubuntu --sshkeys /root/.ssh/your-public-key.pub --ipconfig0 ip=dhcp
qm start 9001
```

Use SeaBIOS (the default) and the cloud-init drive; there is no baked-in login
password or SSH key. The disk is 40 GiB virtual size; expand it in Proxmox before
first boot if you need more room. DHCP supplies an address; production DNS/TLS
and inference settings are yours to configure.

SSH as `ubuntu`, then:

```sh
sudo -i
cd /opt/agentic/self-hosting
cp .env.example .env
# Edit .env: actual hostnames/DNS, TLS email, repository and inference endpoint.
python3 setup.py --no-build
# Put your provider key in secrets/inference_key, then:
docker compose -f compose.yml up -d --force-recreate gateway
```

The existing Python pilot/runtime is bundled explicitly; the new VM build and
distribution orchestration is TypeScript without a Python wrapper/fallback.
No app automatically starts before configuration, and each installation generates
its own secrets/volumes. Network access is needed for provisioning, inference and
any pinned upstream service-image resolution. See `../README.md` for operation
and off-host backup/restore.
