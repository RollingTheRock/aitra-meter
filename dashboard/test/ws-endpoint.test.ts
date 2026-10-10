import { describe, it, expect, afterEach } from "vitest";
import { resolveWsUrl } from "../src/services/wsClient";

describe("resolveWsUrl Strategy", () => {
  afterEach(() => {
    delete (globalThis as any).window;
  });

  it("respects explicit override option", () => {
    expect(resolveWsUrl({ url: "ws://custom.host:9999/ws" })).toBe("ws://custom.host:9999/ws");
  });

  it("falls back to localhost:8000 when running in Vite local dev (port 5173)", () => {
    (globalThis as any).window = {
      location: { protocol: "http:", hostname: "localhost", host: "localhost:5173", port: "5173" },
    };
    expect(resolveWsUrl({})).toBe("ws://127.0.0.1:8000/ws");
  });

  it("resolves same-origin ws:// URL when deployed behind BidCore Caddy proxy (port 80 / public domain)", () => {
    (globalThis as any).window = {
      location: { protocol: "http:", hostname: "47.122.111.234", host: "47.122.111.234", port: "" },
    };
    expect(resolveWsUrl({})).toBe("ws://47.122.111.234/ws");
  });

  it("resolves wss:// URL when accessed via HTTPS", () => {
    (globalThis as any).window = {
      location: { protocol: "https:", hostname: "dashboard.aitra.ai", host: "dashboard.aitra.ai", port: "" },
    };
    expect(resolveWsUrl({})).toBe("wss://dashboard.aitra.ai/ws");
  });
});
