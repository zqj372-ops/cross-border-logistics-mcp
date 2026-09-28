import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";
import { selectPublicIpv4Address } from "./node-connector";

/** Loopback CONNECT bridge: Chromium keeps TLS; the destination IP stays pinned. */
export async function openBrowserTunnel(pins: ReadonlyMap<string, string>, upstreamPort?: number) {
  if (upstreamPort !== undefined && (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535)) throw new Error("schedule_browser_proxy_port_invalid");
  for (const [host, address] of pins) {
    if (!/^[a-z0-9.-]+$/u.test(host)) throw new Error("schedule_browser_host_invalid");
    selectPublicIpv4Address([{ address, family: 4 }]);
  }
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => socket.destroy()); };
  const server = createServer((_req, res) => { res.writeHead(403).end(); });
  server.on("connection", track);
  server.on("connect", (req, client, head) => {
    const host = req.url?.endsWith(":443") ? req.url.slice(0, -4) : "";
    const address = pins.get(host);
    if (!address || head.length) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const pipe = (remote: Socket) => {
      track(remote);
      client.on("close", () => remote.destroy());
      remote.on("close", () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      client.pipe(remote).pipe(client);
    };
    if (upstreamPort === undefined) {
      const remote = connect({ host: address, port: 443 });
      track(remote);
      remote.setTimeout(90_000, () => remote.destroy());
      remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy());
      remote.once("connect", () => pipe(remote));
    } else {
      const upstream = request({ host: "127.0.0.1", port: upstreamPort, method: "CONNECT", path: `${address}:443`, headers: { host: `${address}:443` } });
      upstream.setTimeout(15_000, () => upstream.destroy());
      upstream.once("socket", track);
      upstream.once("error", () => client.destroy());
      client.once("close", () => upstream.destroy());
      upstream.once("response", () => { upstream.destroy(); client.destroy(); });
      upstream.once("connect", (response, remote, extra) => {
        if (response.statusCode !== 200 || extra.length) { remote.destroy(); client.destroy(); return; }
        pipe(remote);
      });
      upstream.end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("schedule_browser_proxy_bind_failed");
  return {
    server: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
