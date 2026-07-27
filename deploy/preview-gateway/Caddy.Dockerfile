FROM caddy:2.11.3

COPY --chmod=0444 deploy/preview-gateway/caddy.json /etc/caddy/caddy.json
