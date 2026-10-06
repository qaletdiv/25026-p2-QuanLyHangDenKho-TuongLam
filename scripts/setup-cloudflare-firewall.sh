#!/bin/sh
set -e

CF_IPV4_URL="https://www.cloudflare.com/ips-v4"
CF_IPV6_URL="https://www.cloudflare.com/ips-v6"

IPSET_V4="cloudflare"
IPSET_V6="cloudflare6"

PORTS="80,443"

echo "[Cloudflare Firewall] === START ==="

####################################
# Install packages
####################################
if ! command -v ipset >/dev/null 2>&1; then
  echo "[Cloudflare Firewall] Installing ipset..."

  if command -v apt >/dev/null; then
      apt update
      apt install -y ipset
  elif command -v dnf >/dev/null; then
      dnf install -y ipset
  elif command -v yum >/dev/null; then
      yum install -y ipset
  fi
fi

####################################
# Create ipset
####################################

ipset list "$IPSET_V4" >/dev/null 2>&1 || \
ipset create "$IPSET_V4" hash:net

ipset list "$IPSET_V6" >/dev/null 2>&1 || \
ipset create "$IPSET_V6" hash:net family inet6

####################################
# Flush old entries
####################################

ipset flush "$IPSET_V4"
ipset flush "$IPSET_V6"

####################################
# Download latest Cloudflare ranges
####################################

echo "[Cloudflare Firewall] Updating IPv4..."

curl -s "$CF_IPV4_URL" | while read -r ip
do
    [ -n "$ip" ] && ipset add "$IPSET_V4" "$ip"
done

echo "[Cloudflare Firewall] Updating IPv6..."

curl -s "$CF_IPV6_URL" | while read -r ip
do
    [ -n "$ip" ] && ipset add "$IPSET_V6" "$ip"
done

####################################
# INPUT rules
####################################

iptables -C INPUT \
-p tcp \
-m multiport --dports $PORTS \
-m set --match-set cloudflare src \
-j ACCEPT 2>/dev/null || \

iptables -I INPUT \
-p tcp \
-m multiport --dports $PORTS \
-m set --match-set cloudflare src \
-j ACCEPT


ip6tables -C INPUT \
-p tcp \
-m multiport --dports $PORTS \
-m set --match-set cloudflare6 src \
-j ACCEPT 2>/dev/null || \

ip6tables -I INPUT \
-p tcp \
-m multiport --dports $PORTS \
-m set --match-set cloudflare6 src \
-j ACCEPT

####################################
# Drop non-cloudflare
####################################

iptables -C INPUT \
-p tcp \
-m multiport --dports $PORTS \
-j DROP 2>/dev/null || \

iptables -A INPUT \
-p tcp \
-m multiport --dports $PORTS \
-j DROP


ip6tables -C INPUT \
-p tcp \
-m multiport --dports $PORTS \
-j DROP 2>/dev/null || \

ip6tables -A INPUT \
-p tcp \
-m multiport --dports $PORTS \
-j DROP

echo "[Cloudflare Firewall] === DONE ==="