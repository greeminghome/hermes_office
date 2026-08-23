FROM nousresearch/hermes-agent@sha256:8fdd63308277ff25c4c5bef41aec108d700efa4961335b9cea003d7395f9ebc2

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/hermes/.playwright
ENV NODE_PATH=/usr/local/lib/node_modules

USER root

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl gosu procps xauth zsh \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g playwright@1.60.0 \
    && playwright install --with-deps chromium \
    && chmod -R 0755 /opt/hermes/.playwright

COPY entrypoint.sh /usr/local/bin/hermes-office-agent-entrypoint.sh
COPY start-persistent-browser.sh /usr/local/bin/start-persistent-browser.sh
COPY overrides/cdp-http-proxy.js /usr/local/bin/cdp-http-proxy.js
COPY overrides/browser_tool.py /opt/hermes/tools/browser_tool.py
COPY overrides/tui_gateway_server.py /opt/hermes/tui_gateway/server.py

RUN chmod 0755 \
      /usr/local/bin/hermes-office-agent-entrypoint.sh \
      /usr/local/bin/start-persistent-browser.sh \
      /usr/local/bin/cdp-http-proxy.js

ENTRYPOINT ["/init"]
CMD ["/usr/local/bin/hermes-office-agent-entrypoint.sh"]
