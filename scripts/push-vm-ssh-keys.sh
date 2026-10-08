#!/usr/bin/env bash
# Push keys/vm/{config,id_rsa,id_rsa.pub} to ~/.ssh on the Oracle VM so the VM
# can reach GitHub over SSH, then verify it can.
#
# Run from the repo root in Git Bash or WSL (NOT on the VM):
#   ./scripts/push-vm-ssh-keys.sh
#   ./scripts/push-vm-ssh-keys.sh -h 129.153.57.126 -u ubuntu -i keys/oracle/ssh-key-2026-10-06.key
#   ./scripts/push-vm-ssh-keys.sh -a     # also authorize keys/vm/id_rsa.pub for VM login
#
# Options (env var in brackets):
#   -h HOST   VM address                          [VM_HOST]  default 129.153.57.126
#   -u USER   VM user                             [VM_USER]  default ubuntu
#   -i KEY    private key used to LOG IN to the VM [VM_LOGIN_KEY] default keys/oracle/ssh-key-2026-10-06.key
#   -s DIR    local folder holding the files      [SRC_DIR]  default keys/vm
#   -a        also append id_rsa.pub to ~/.ssh/authorized_keys (idempotent)
#
# Safe to re-run: existing files on the VM are backed up to ~/.ssh/*.bak-<timestamp>
# before being replaced, and authorized_keys is never overwritten.
# keys/ is gitignored — never commit the private keys.
set -euo pipefail

VM_HOST="${VM_HOST:-129.153.57.126}"
VM_USER="${VM_USER:-ubuntu}"
VM_LOGIN_KEY="${VM_LOGIN_KEY:-keys/oracle/ssh-key-2026-10-06.key}"
SRC_DIR="${SRC_DIR:-keys/vm}"
AUTHORIZE=0

while getopts "h:u:i:s:a" opt; do
  case "$opt" in
    h) VM_HOST="$OPTARG" ;;
    u) VM_USER="$OPTARG" ;;
    i) VM_LOGIN_KEY="$OPTARG" ;;
    s) SRC_DIR="$OPTARG" ;;
    a) AUTHORIZE=1 ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."   # repo root, so the default relative paths resolve

FILES=(config id_rsa id_rsa.pub)
for f in "$VM_LOGIN_KEY" "${FILES[@]/#/$SRC_DIR/}"; do
  [ -f "$f" ] || { echo "[keys] missing: $f" >&2; exit 1; }
done

# Sanity: the private and public key must be a pair.
if [ "$(ssh-keygen -y -f "$SRC_DIR/id_rsa" | awk '{print $2}')" != "$(awk '{print $2}' "$SRC_DIR/id_rsa.pub")" ]; then
  echo "[keys] $SRC_DIR/id_rsa and id_rsa.pub are not a pair" >&2; exit 1
fi

# OpenSSH refuses a private key that others can read (no-op on NTFS, matters in WSL).
chmod 600 "$VM_LOGIN_KEY" 2>/dev/null || true

SSH_OPTS=(-i "$VM_LOGIN_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
TARGET="$VM_USER@$VM_HOST"

echo "[keys] login check $TARGET"
ssh "${SSH_OPTS[@]}" "$TARGET" true

echo "[keys] uploading ${FILES[*]} to staging dir"
STAGE=".ssh-upload-$$"
ssh "${SSH_OPTS[@]}" "$TARGET" "mkdir -p ~/$STAGE && chmod 700 ~/$STAGE"
scp "${SSH_OPTS[@]}" "${FILES[@]/#/$SRC_DIR/}" "$TARGET:~/$STAGE/"

echo "[keys] installing into ~/.ssh"
ssh "${SSH_OPTS[@]}" "$TARGET" STAGE="$STAGE" AUTHORIZE="$AUTHORIZE" 'bash -s' <<'REMOTE'
set -euo pipefail
mkdir -p ~/.ssh && chmod 700 ~/.ssh
ts=$(date +%Y%m%d%H%M%S)
cd ~/"$STAGE"
sed -i 's/\r$//' config id_rsa id_rsa.pub          # Windows line endings break ssh config
for f in config id_rsa id_rsa.pub; do
  if [ -f ~/.ssh/"$f" ] && ! cmp -s "$f" ~/.ssh/"$f"; then
    cp -p ~/.ssh/"$f" ~/.ssh/"$f.bak-$ts"; echo "  backed up ~/.ssh/$f -> $f.bak-$ts"
  fi
  mv -f "$f" ~/.ssh/"$f"
done
cd ~ && rmdir ~/"$STAGE"
chmod 600 ~/.ssh/config ~/.ssh/id_rsa
chmod 644 ~/.ssh/id_rsa.pub

if [ "$AUTHORIZE" = 1 ]; then
  touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
  if grep -qxF "$(cat ~/.ssh/id_rsa.pub)" ~/.ssh/authorized_keys; then
    echo "  authorized_keys: already present"
  else
    cat ~/.ssh/id_rsa.pub >> ~/.ssh/authorized_keys; echo "  authorized_keys: added"
  fi
fi

ls -la ~/.ssh
ssh-keygen -lf ~/.ssh/id_rsa.pub

echo "[keys] GitHub check from the VM:"
# Exit code is 1 even on success (no shell access), so judge by the message.
# </dev/null: this script arrives on stdin (`bash -s`); without it ssh eats the rest.
out=$(ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 git@github.com </dev/null 2>&1 || true)
echo "  $out"
case "$out" in
  *"successfully authenticated"*) ;;
  *) echo "  -> add ~/.ssh/id_rsa.pub to GitHub (repo Settings > Deploy keys, read-only)"; exit 1 ;;
esac
REMOTE

echo "[keys] done"
