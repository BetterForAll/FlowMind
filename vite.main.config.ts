import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  build: {
    rollupOptions: {
      external: ["bufferutil", "utf-8-validate", "uiohook-napi", "dotenv"],
    },
  },
});
