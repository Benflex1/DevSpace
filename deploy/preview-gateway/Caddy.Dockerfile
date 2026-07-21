FROM caddy:2.11.3

COPY deploy/preview-gateway/caddy.json /etc/caddy/caddy.json
