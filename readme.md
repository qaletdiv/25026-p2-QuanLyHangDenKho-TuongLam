# DevOps Demo - Next.js Blog with Nginx & Docker

A **DevOps demonstration project** showing how to deploy a **Next.js blog application** behind an **Nginx reverse proxy** using **Docker**, with **SSL termination** and **CI/CD deployment via GitHub Actions**.

---

# 1. Architecture Overview

The system architecture routes traffic through **Cloudflare**, which provides **DNS management, SSL, and reverse proxy protection** before reaching the server.

```
User
  │
  │ HTTPS
  ▼
Cloudflare (DNS + Proxy + SSL)
  │
  │ HTTPS
  ▼
Nginx Reverse Proxy (Docker)
  │
  │ HTTP
  ▼
Next.js Application (Docker)
```

Responsibilities:

| Component          | Role                                          |
| ------------------ | --------------------------------------------- |
| **Cloudflare**     | DNS management, SSL protection, reverse proxy |
| **Nginx**          | Reverse proxy and SSL termination             |
| **Next.js**        | Blog application                              |
| **Docker**         | Container runtime                             |
| **Docker Compose** | Service orchestration                         |
| **GitHub Actions** | CI/CD deployment                              |

---

# 2. Project Structure

```
.
├── blog-starter-app/        # Next.js application
├── nginx/                   # Production Nginx configuration
│   └── opt/nginx/ssl/       # Production SSL certificates
├── nginx.local/             # Local Nginx config (self-signed SSL)
│   └── opt/nginx/ssl/
├── docker-compose.yml       # Production-like deployment
├── docker-compose.local.yml # Local Docker testing
└── .github/workflows/       # CI/CD pipelines
```

---

# 3. Prerequisites

Make sure the following tools are installed:

- **Node.js**
- **Docker**
- **Docker Compose**

Links:

- [https://nodejs.org](https://nodejs.org)
- [https://www.docker.com](https://www.docker.com)
- [https://docs.docker.com/compose/](https://docs.docker.com/compose/)

---

# 4. Development

## 4.1 Run Next.js Locally (without Docker)

```bash
cd blog-starter-app
npm install
npm run dev
```

Application will run at:

```
http://localhost:3000
```

This mode is useful for **development and debugging**.

---

# 5. Local Testing with Docker

This setup runs the **full production-like stack**:

- Nginx
- Next.js
- HTTPS via self-signed certificate

## 5.1 Generate Local SSL Certificate

```bash
mkdir -p nginx.local/opt/nginx/ssl

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
-keyout nginx.local/opt/nginx/ssl/local.key \
-out nginx.local/opt/nginx/ssl/local.crt \
-subj "/CN=localhost"
```

---

## 5.2 Start Containers

```bash
docker compose -f docker-compose.local.yml up -d --build
```

---

## 5.3 Access Application

Open in browser:

```
https://localhost:8443
```

Because this uses a **self-signed certificate**, the browser may show a security warning.

---

# 6. Production Deployment

## 6.1. Cloudflare DNS Configuration

To connect your domain to the server, configure a **DNS A record** in Cloudflare.

Navigate to:

```
Cloudflare Dashboard
 → Your Domain
 → DNS
 → Records
 → Add Record
```

Add the following record:

| Type | Name            | Content    | Proxy Status | TTL  |
| ---- | --------------- | ---------- | ------------ | ---- |
| A    | your-domain.com | YOUR_VM_IP | Proxied      | Auto |

Example:

| Type | Name             | Content      | Proxy Status | TTL  |
| ---- | ---------------- | ------------ | ------------ | ---- |
| A    | blog.example.com | 203.0.113.10 | Proxied      | Auto |

Explanation:

| Setting      | Meaning                                  |
| ------------ | ---------------------------------------- |
| **Type A**   | Maps domain → server IP                  |
| **Content**  | Public IP of your VM                     |
| **Proxied**  | Traffic goes through Cloudflare          |
| **TTL Auto** | Cloudflare manages caching automatically |

When **Proxy Status = Proxied**, traffic flow becomes:

```
User
 → Cloudflare Edge
 → Your VM
 → Nginx
 → Next.js
```

Benefits:

- DDoS protection
- Cloudflare SSL
- IP masking (server IP hidden)
- Global CDN caching

---

## 6.2 Add Production SSL Certificates

For production deployment, this project uses a Cloudflare Origin Certificate.
This certificate allows secure HTTPS communication between Cloudflare and your server.

Navigate to the Cloudflare dashboard:

Cloudflare Dashboard
→ Your Domain
→ SSL/TLS
→ Origin Server
→ Create Certificate

Follow the steps to generate the certificate:

1. **Hostnames**: Enter your domain name (e.g., blog.example.com)
2. **Validity**: Choose a duration (e.g., 15 years)
3. **Type**: Select **RSA** and **2048-bit**
4. **Generate**

After generation, Cloudflare will provide:

- **Origin Certificate** (paste this into `origin.pem`)
- **Private Key** (paste this into `origin.key`)

Place Cloudflare certificates from Cloudflare dashboard SSL section in:

```
nginx/opt/nginx/ssl/
```

Required files:

```
origin.pem
origin.key
```

---

## 6.3 Start Production Containers

```bash
docker compose up -d --build
```

---

# 7. CI/CD Deployment (GitHub Actions)

Deployment is automated when pushing to the:

```
production
```

branch.

The workflow connects to the server using **SSH** and updates the running containers.

---

## 7.1 Generate SSH Key Pair

On your local machine:

```bash
ssh-keygen -t ed25519 -C "github-actions@devops-demo"
```

Leave the **passphrase empty** to allow automated deployment.

---

## 7.2 Configure Server Access

Add the public key to the server:

```
~/.ssh/authorized_keys
```

Then fix permissions:

```bash
chmod 700 ~/.ssh
chmod 600 ~/.ssh/authorized_keys
```

---

## 7.3 Configure GitHub Secrets

Go to:

```
Repository
 → Settings
 → Secrets and variables
 → Actions
```

Add the following secrets:

| Secret              | Description         |
| ------------------- | ------------------- |
| `SSH_PRIVATE_KEY`   | Private key content |
| `DOCKERHUB_TOKEN`   | DockerHub token     |
| `AZURE_CREDENTIALS` | Azure credentials   |

and vars:

| Var                        | Description                 |
| -------------------------- | --------------------------- |
| `SSH_PROJECT_URL`          | Project URL                 |
| `SSH_PROJECT_PATH`         | Project directory on server |
| `SSH_HOST`                 | Production server IP        |
| `SSH_USER`                 | SSH login user              |
| `SSH_PORT`                 | SSH port (usually 22)       |
| `DOCKERHUB_USERNAME`       | DockerHub username          |
| `DOCKERHUB_IMAGE_NAME`     | DockerHub image name        |
| `AZURE_RESOURCE_GROUP`     | Azure resource group        |
| `AZURE_LOCATION`           | Azure location              |
| `AZURE_CONTAINER_APP`      | Azure container app         |
| `AZURE_CONTAINER_APP_PORT` | Azure container app port    |
| `AZURE_CONTAINER_APP_ENV`  | Azure container app env     |

---

# 8. Cloud Infrastructure Configuration

External traffic must be allowed in **two places**:

1. VM firewall
2. Cloud provider network rules

---

# 9. Oracle Cloud VM Firewall Setup

## 9.1 Configure Firewall Inside the VM

Edit iptables rules:

```bash
sudo nano /etc/iptables/rules.v4
```

Add HTTPS rule:

```bash
-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
```

Apply rules:

```bash
sudo iptables-restore < /etc/iptables/rules.v4
```

Restart Docker:

```bash
sudo systemctl restart docker
```

---

## 9.2 Configure Oracle Cloud Security List

Navigate in the **Oracle Cloud Console**:

```
Networking
 → Virtual Cloud Networks
 → Your VCN
 → Security
 → Security Lists
 → Default Security List
 → Add Ingress Rule
```

Rule configuration:

| Field            | Value     |
| ---------------- | --------- |
| Source           | 0.0.0.0/0 |
| Protocol         | TCP       |
| Source Port      | All       |
| Destination Port | 443       |

---

## 9.3 Enable HTTP Instead of HTTPS (Optional)

VM Firewall:

```bash
-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT
```

Oracle Security Rule:

| Field            | Value     |
| ---------------- | --------- |
| Source           | 0.0.0.0/0 |
| Protocol         | TCP       |
| Source Port      | All       |
| Destination Port | 80        |

---

# 10. Google Cloud VM Firewall Setup

Google Cloud provides built-in firewall rules.

### Steps

1. Go to **Compute Engine**
2. Select **VM Instances**
3. Click your instance
4. Click **Edit**
5. Scroll to **Firewall**
6. Enable:

```
Allow HTTP traffic
Allow HTTPS traffic
```

These options automatically apply firewall tags:

```
http-server
https-server
```

Allowing traffic from:

```
0.0.0.0/0
```

to ports:

```
80 / 443
```

---

# 11. Command Reference

## Generate Self-Signed SSL

```bash
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
-keyout local.key \
-out local.crt \
-subj "/CN=localhost"
```

---

## Generate SSH Key

```bash
ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
```
