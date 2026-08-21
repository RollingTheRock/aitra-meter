# Measurement agent — runs as a DaemonSet on GPU nodes.
#
# Built with CGO_ENABLED=1: the default NVML provider uses go-nvml, whose
# generated bindings import "C" (it still dlopens libnvidia-ml.so.1 at
# runtime, so no NVIDIA libraries are needed at build time). The runtime
# base is distroless/base (glibc) rather than static for that reason.
# The AMD provider is gated behind the `amd` build tag and compiles to a
# stub in this image; ROCm nodes need an image built with
# `--build-arg BUILD_TAGS=amd` against the AMD SMI headers.
FROM golang:1.26-bookworm AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
ARG BUILD_TAGS=""
RUN CGO_ENABLED=1 GOOS=linux go build \
      -buildvcs=false \
      -tags "${BUILD_TAGS}" \
      -trimpath \
      -ldflags "-s -w -X main.version=${VERSION}" \
      -o /out/measurement-agent \
      ./cmd/measurement-agent

FROM gcr.io/distroless/base-debian12:nonroot
COPY --from=builder /out/measurement-agent /usr/local/bin/measurement-agent
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/measurement-agent"]
