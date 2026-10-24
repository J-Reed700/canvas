import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER = "http://127.0.0.1:8765";
// The server takes POSTs only from its own pages. Requests from this dev server's pages go on as if they
// came from the server's origin; a page on any other site keeps its own origin and is still refused.
const toServer = {
  target: SERVER,
  changeOrigin: true,
  configure: (proxy: any) => {
    proxy.on("proxyReq", (req: any, incoming: any) => {
      if (incoming.headers.origin === `http://${incoming.headers.host}`) req.setHeader("origin", SERVER);
    });
  },
};

export default defineConfig({
  plugins: [react()],
  root: "downbeat/studio",
  base: "/studio/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": toServer,
      "/out": toServer,
    },
  },
});
