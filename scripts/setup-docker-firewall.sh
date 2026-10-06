#!/bin/sh
set -e

PORT=443
INTERFACE=$(ip route | awk '/default/ {print $5}' | head -n1)
echo "[Docker Firewall] Detected interface: $INTERFACE"

echo "[Docker Firewall] === START ==="

####################################
# create DOCKER-USER if missing
####################################

iptables -nL DOCKER-USER >/dev/null 2>&1 || \
iptables -N DOCKER-USER

ip6tables -nL DOCKER-USER >/dev/null 2>&1 || \
ip6tables -N DOCKER-USER

####################################
# Allow established
####################################

iptables -C DOCKER-USER \
-m conntrack \
--ctstate ESTABLISHED,RELATED \
-j ACCEPT 2>/dev/null || \

iptables -I DOCKER-USER \
-m conntrack \
--ctstate ESTABLISHED,RELATED \
-j ACCEPT


ip6tables -C DOCKER-USER \
-m conntrack \
--ctstate ESTABLISHED,RELATED \
-j ACCEPT 2>/dev/null || \

ip6tables -I DOCKER-USER \
-m conntrack \
--ctstate ESTABLISHED,RELATED \
-j ACCEPT

####################################
# Allow Cloudflare only
####################################

iptables -C DOCKER-USER \
-i $INTERFACE \
-m set --match-set cloudflare src \
-p tcp --dport $PORT \
-j ACCEPT 2>/dev/null || \

iptables -I DOCKER-USER \
-i $INTERFACE \
-m set --match-set cloudflare src \
-p tcp --dport $PORT \
-j ACCEPT


ip6tables -C DOCKER-USER \
-i $INTERFACE \
-m set --match-set cloudflare6 src \
-p tcp --dport $PORT \
-j ACCEPT 2>/dev/null || \

ip6tables -I DOCKER-USER \
-i $INTERFACE \
-m set --match-set cloudflare6 src \
-p tcp --dport $PORT \
-j ACCEPT

####################################
# Drop others
####################################

iptables -C DOCKER-USER \
-i $INTERFACE \
-p tcp \
--dport $PORT \
-j DROP 2>/dev/null || \

iptables -A DOCKER-USER \
-i $INTERFACE \
-p tcp \
--dport $PORT \
-j DROP


ip6tables -C DOCKER-USER \
-i $INTERFACE \
-p tcp \
--dport $PORT \
-j DROP 2>/dev/null || \

ip6tables -A DOCKER-USER \
-i $INTERFACE \
-p tcp \
--dport $PORT \
-j DROP

echo "[Docker Firewall] === DONE ==="