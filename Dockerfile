# syntax=docker/dockerfile:1
# Socrates: one Node process serving the UI + API (:8080, tailnet) and OAuth MCP (:8081, public via the tunnel).
# Everything it needs at runtime is in the image (built UI, embedding model), so the pod needs no network egress.
# Build from the repository root on an x64 machine:
#   docker build --platform linux/amd64 -t ghcr.io/kar6677thik/socrates:candidate .
ARG NODE_IMAGE=node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

# ---- Production dependencies only (onnxruntime-node ships prebuilt glibc binaries, hence Debian, not Alpine)
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force
# CPU inference on linux/x64 only: drop other platforms and the GPU providers (~600 MB). The model stage below
# warms the model up with exactly these modules, so the build fails if something needed was removed.
RUN cd node_modules/onnxruntime-node/bin/napi-v6 \
 && rm -rf darwin win32 linux/arm64 linux/x64/libonnxruntime_providers_cuda.so linux/x64/libonnxruntime_providers_tensorrt.so \
 && rm -rf /app/node_modules/onnxruntime-web

# ---- Typecheck, test, build the UI
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src/ src/
COPY web/ web/
COPY tests/ tests/
COPY scripts/ scripts/
RUN npm run typecheck && npx tsc -p web/tsconfig.json --noEmit && SOCRATES_EMBEDDINGS=off npm test && npm run build

# ---- all-MiniLM-L6-v2 (8-bit, ~23 MB) into /models, loaded with the pruned runtime modules; the runtime never downloads.
FROM deps AS model
COPY src/ src/
RUN SOCRATES_MODELS=/models node --no-warnings --input-type=module -e "const { embed } = await import('./src/core/embed.ts'); const v = await embed(['warm up']); if (!v || v[0].length !== 384) process.exit(1);"

# ---- Runtime
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# Root-owned and read-only to the app user; state lives only on the /data volume.
COPY --from=deps --chown=root:root /app/node_modules/ node_modules/
COPY --from=build --chown=root:root /app/web/dist/ web/dist/
COPY --from=model --chown=root:root /models/ /models/
COPY --chown=root:root package.json ./
COPY --chown=root:root src/ src/
# The volume mount point. Kubernetes sets ownership with fsGroup; this covers plain `docker run -v`.
RUN mkdir /data && chown 1654:1654 /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SOCRATES_DATA=/data \
    SOCRATES_MODELS=/models \
    SOCRATES_MODELS_OFFLINE=1 \
    HOME=/tmp
# Numeric, so kubelet can verify runAsNonRoot.
USER 1654:1654
EXPOSE 8080 8081
CMD ["node", "--no-warnings", "src/server/index.ts"]
