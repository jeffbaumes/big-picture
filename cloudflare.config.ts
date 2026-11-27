import { defineConfig, bindings } from "cf/config";

export default defineConfig({
  worker: {
    name: "bigpicture",
    compatibilityDate: "2026-11-01",
    entrypoint: "./src/worker.js",
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*", "/mcp", "/oauth/*", "/.well-known/*"],
    },
    domains: ["bigpicture.io27.com"],
    observability: { enabled: true },
    env: {
      DB: bindings.d1({ id: "a5a0ad0c-53e8-4ecf-b732-f15e3c737f42", name: "bigpicture" }),
      ASSETS: bindings.assets(),
    },
  },
});
