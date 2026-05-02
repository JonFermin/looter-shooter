import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const allowedHosts = env.ALLOWED_HOSTS
    ? env.ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
    : [];

  return {
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
      allowedHosts,
    },
  };
});
