// Exposes the Vite development and build configuration for the web client.
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { config } from "./server/config.mjs";

// Vite's client also supplies the helpers used by dev-mode CSS, so it must remain available.
// Disconnect only its HMR transport: otherwise any brief socket loss makes the client reload the
// entire board. The marker guard makes a future Vite client change fail loudly during startup.
const hmrConnectMarker = "transport.connect(createHMRHandler(handleMessage));";
const disableHmrTransport = {
  name: "whiteboard:disable-hmr-transport",
  apply: "serve",
  enforce: "post",
  transform(code, id) {
    if (!id.replaceAll("\\", "/").endsWith("/vite/dist/client/client.mjs")) return;
    if (!code.includes(hmrConnectMarker))
      throw new Error("Vite client HMR connection marker not found");
    return code.replace(
      hmrConnectMarker,
      "/* HMR transport disabled for the persistent whiteboard. */",
    );
  },
} satisfies Plugin;

// Before the upgrade, Vite's proxy does not read the client socket and does not cancel its request
// to the chat server when the client leaves. The chat server then keeps a preview viewer that is
// gone, and that viewer may still hold control. This reads until the upgrade, keeps the bytes for
// the upgraded pipe, and cancels the request when the client leaves.
const endUpgradeWithClient: ProxyOptions["configure"] = (proxy) => {
  proxy.on("proxyReqWs", (proxyReq, _req, socket) => {
    const early: Buffer[] = [];
    const keep = (chunk: Buffer) => early.push(chunk);
    const cancel = () => proxyReq.destroy();
    socket.on("data", keep);
    socket.once("end", cancel);
    socket.once("close", cancel);
    proxyReq.once("upgrade", () => {
      socket.off("data", keep);
      socket.off("end", cancel);
      socket.off("close", cancel);
      socket.pause();
      for (const chunk of early.reverse()) socket.unshift(chunk);
    });
  });
};

export default defineConfig({
  plugins: [react(), disableHmrTransport],
  resolve: { dedupe: ["prosemirror-state"] },
  define: { __OPEN_VIEWS__: JSON.stringify(config.openViews) },
  server: {
    hmr: false,
    port: config.webPort,
    strictPort: true,
    // Vite refuses other Host headers, so a reverse proxy in front needs its hostname listed here.
    allowedHosts: config.allowedHosts,
    proxy: {
      "/sync": {
        target: `http://127.0.0.1:${config.port}`,
        ws: true,
        rewrite: (path) => path.replace(/^\/sync/, ""),
      },
      "/chat": {
        target: `http://127.0.0.1:${config.chatPort}`,
        ws: true,
        rewrite: (path) => path.replace(/^\/chat/, ""),
      },
      // The chat's browser code builds these from the page origin, so they reach it unprefixed.
      "/api": {
        target: `http://127.0.0.1:${config.chatPort}`,
        ws: true,
        configure: endUpgradeWithClient,
      },
      "/ws": { target: `http://127.0.0.1:${config.chatPort}`, ws: true },
      "/.well-known": { target: `http://127.0.0.1:${config.chatPort}`, ws: true },
    },
  },
});
