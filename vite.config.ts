import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    rollupOptions: {
      // Optional dev-only dependency — keep as runtime dynamic import so the
      // build doesn't fail when it isn't installed.
      external: ["@babylonjs/inspector"],
    },
  },
  server: {
    host: "::",
    port: 8080,
  },
});
