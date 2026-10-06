FROM nginx:alpine

RUN apk add --no-cache curl

COPY generate-cloudflare-realip.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/generate-cloudflare-realip.sh

# Generate config when build image
RUN /usr/local/bin/generate-cloudflare-realip.sh
