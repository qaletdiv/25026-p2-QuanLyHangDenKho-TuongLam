#!/bin/sh
set -e

OUTPUT="/etc/nginx/cloudflare_realip.conf"

echo "# Cloudflare real IP config" > $OUTPUT
echo "# generated $(date)" >> $OUTPUT
echo "" >> $OUTPUT

echo "real_ip_header CF-Connecting-IP;" >> $OUTPUT
echo "" >> $OUTPUT

# Mock Cloudflare IP ranges for local testing
echo "set_real_ip_from 0.0.0.0/0;" >> $OUTPUT
echo "" >> $OUTPUT

echo "Cloudflare real IP config generated"