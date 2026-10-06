#!/bin/sh
set -e

OUTPUT="/etc/nginx/cloudflare_realip.conf"

echo "# Cloudflare real IP config" > $OUTPUT
echo "# generated $(date)" >> $OUTPUT
echo "" >> $OUTPUT

echo "real_ip_header CF-Connecting-IP;" >> $OUTPUT
echo "" >> $OUTPUT

# IPv4
curl -s https://www.cloudflare.com/ips-v4 | while read ip; do
  echo "set_real_ip_from $ip;" >> $OUTPUT
done

# IPv6
curl -s https://www.cloudflare.com/ips-v6 | while read ip; do
  echo "set_real_ip_from $ip;" >> $OUTPUT
done

echo "Cloudflare real IP config generated"