FROM nginx:alpine

RUN apk add --no-cache curl

COPY generate-cloudflare-realip.sh /usr/local/bin/
# Strip CRLF in case of a Windows checkout (sh reports "not found" on a CRLF shebang).
RUN sed -i 's/\r$//' /usr/local/bin/generate-cloudflare-realip.sh \
 && chmod +x /usr/local/bin/generate-cloudflare-realip.sh

# Generate config when build image
RUN /usr/local/bin/generate-cloudflare-realip.sh
