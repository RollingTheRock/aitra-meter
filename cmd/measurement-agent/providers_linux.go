//go:build linux

package main

// NOTE: the nvml provider is imported in main.go and requires CGO_ENABLED=1
// (go-nvml's generated bindings import "C"; it still dlopens
// libnvidia-ml.so.1 at runtime). See build/measurement-agent/Dockerfile.
