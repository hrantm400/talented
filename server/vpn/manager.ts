import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const VPN_DIR = path.join(process.cwd(), "vpn");

export async function generateDockerCompose(
  privateKey: string,
  address: string,
  country: string
) {
  if (!fs.existsSync(VPN_DIR)) {
    fs.mkdirSync(VPN_DIR, { recursive: true });
  }

  const composeContent = `
services:
  gluetun:
    image: qmcgaw/gluetun
    cap_add:
      - NET_ADMIN
    environment:
      - VPN_SERVICE_PROVIDER=mullvad
      - VPN_TYPE=wireguard
      - WIREGUARD_PRIVATE_KEY=${privateKey}
      - WIREGUARD_ADDRESSES=${address.split(",")[0].trim()}
      - SERVER_COUNTRIES=${country}
      - HTTPPROXY=on
    ports:
      - 127.0.0.1:8888:8888/tcp # HTTP proxy
    deploy:
      resources:
        limits:
          cpus: '0.5'
          memory: 256M
    restart: unless-stopped
`;

  fs.writeFileSync(path.join(VPN_DIR, "docker-compose.yml"), composeContent.trim());
}

export async function startVpn() {
  if (!fs.existsSync(path.join(VPN_DIR, "docker-compose.yml"))) {
    throw new Error("VPN is not configured yet.");
  }
  
  // Bring it down if it exists, then up
  await execAsync("docker compose down", { cwd: VPN_DIR }).catch(() => {});
  await execAsync("docker compose up -d", { cwd: VPN_DIR });
}

export async function stopVpn() {
  if (fs.existsSync(path.join(VPN_DIR, "docker-compose.yml"))) {
    await execAsync("docker compose down", { cwd: VPN_DIR }).catch(() => {});
  }
}
