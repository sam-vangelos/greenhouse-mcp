# syntax=docker/dockerfile:1
# Build from the WORKSPACE ROOT:
#   docker build -f packages/recruiter-mcp/deploy/Dockerfile .
# The image ships the recruiter read plane and the action write plane together:
# the recruiter server imports the control plane's built dist, and a runtime
# without the action dist cannot start at all.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/scoped-core/package.json packages/scoped-core/package.json
COPY packages/recruiter-mcp/package.json packages/recruiter-mcp/package.json
COPY packages/action-mcp/package.json packages/action-mcp/package.json
RUN --mount=type=secret,id=npm_ca,required=false \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --include=dev --no-audit --no-fund

FROM deps AS build
COPY packages packages
RUN npm run build
# Fail the BUILD if the entries the recruiter server imports are not there, rather than
# discovering it in the self-check below with a module-resolution error that reads like a
# path bug.
RUN test -f packages/control-plane/dist/client-readonly.js || (echo "control-plane dist missing after build" && exit 1)
RUN test -f packages/action-mcp/dist/index.js || (echo "action-mcp dist/index.js missing after build" && exit 1)

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    GREENHOUSE_RECRUITER_MCP_PORT=3333
WORKDIR /app
# tsx stays in the image: the bin entrypoints import the TypeScript sources directly.
COPY --from=build /app/package.json package.json
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages packages
RUN mkdir -p /app/audit && chown node:node /app/audit
RUN node packages/recruiter-mcp/bin/greenhouse-recruiter-container-self-check.mjs
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.GREENHOUSE_RECRUITER_MCP_PORT || '3333') + (process.env.GREENHOUSE_RECRUITER_HEALTH_PATH || '/healthz')).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "packages/recruiter-mcp/bin/greenhouse-recruiter-mcp-http.mjs"]
