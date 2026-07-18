"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { EventEmitter } = require("node:events");

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function websocketAccept(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

class WebSocketPeer extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.buffer = head;
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    if (head.length > 0) {
      queueMicrotask(() => this.drain());
    }
  }

  sendText(value) {
    if (this.closed) {
      throw new Error("Remote App Host WebSocket is closed");
    }
    this.socket.write(encodeFrame(0x1, Buffer.from(value, "utf8")));
  }

  close(code = 1000) {
    if (this.closed) {
      return;
    }
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(code);
    this.socket.end(encodeFrame(0x8, payload));
    this.finish();
  }

  finish() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  }

  drain() {
    while (!this.closed) {
      if (this.buffer.length < 2) {
        return;
      }
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!final || !masked) {
        this.close(1002);
        return;
      }
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const largeLength = this.buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(MAX_FRAME_BYTES)) {
          this.close(1009);
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) {
        this.close(1009);
        return;
      }
      if (this.buffer.length < offset + 4 + length) {
        return;
      }
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode !== 0x1) {
        this.close(1003);
        return;
      }
      this.emit("text", payload.toString("utf8"));
    }
  }
}

class RpcMessagePort extends EventEmitter {
  constructor(peer) {
    super();
    this.peer = peer;
    peer.on("text", (data) => this.emit("message", { data }));
    peer.on("close", () => this.emit("close"));
  }

  start() {}

  postMessage(data) {
    if (data == null) {
      this.close();
      return;
    }
    if (typeof data !== "string") {
      throw new TypeError("Remote App Host transport only supports string frames");
    }
    this.peer.sendText(data);
  }

  close() {
    this.peer.close();
  }
}

function findWindowContext(electron, getContext) {
  for (const window of electron.BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    const context = getContext(window.webContents);
    if (context != null) return context;
  }
  return null;
}

function authorize(request, bind, token) {
  if (LOOPBACK_HOSTS.has(bind)) return true;
  if (!token) return false;
  const url = new URL(request.url, "http://localhost");
  const provided = Buffer.from(url.searchParams.get("token") ?? "");
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function reject(socket, status, message) {
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

async function attachAppHost({ electron, getContext, createRpc, peer }) {
  const context = findWindowContext(electron, getContext);
  if (context == null) {
    peer.close(1013);
    throw new Error("No initialized Codex window context is available");
  }
  const owner = new electron.BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: { backgroundThrottling: false },
  });
  const port = new RpcMessagePort(peer);
  const appHost = context.createAppHost(owner.webContents);
  const remoteAppView = createRpc(port, appHost);
  const dispose = () => {
    console.log("[remote-web-host] App Host connection closed");
    if (!owner.isDestroyed()) owner.destroy();
  };
  peer.once("close", dispose);
  try {
    await context.registerAppView(owner.webContents, remoteAppView);
    console.log("[remote-web-host] App Host connection registered");
  } catch (error) {
    peer.removeListener("close", dispose);
    dispose();
    peer.close(1011);
    throw error;
  }
}

const ipcRelays = new Map();
const transferablePorts = new Map();
let ipcRelayListenersInstalled = false;

function sendJson(peer, value) {
  peer.sendText(JSON.stringify(value));
}

function installIpcRelayListeners(electron) {
  if (ipcRelayListenersInstalled) return;
  ipcRelayListenersInstalled = true;
  electron.ipcMain.on("codex-linux:remote-ipc-result", (event, result) => {
    const peer = ipcRelays.get(result.relayId);
    if (peer != null) sendJson(peer, { type: "result", ...result });
  });
  electron.ipcMain.on("codex-linux:remote-ipc-event", (event, message) => {
    const peer = ipcRelays.get(message.relayId);
    if (peer != null) sendJson(peer, { type: "event", ...message });
  });
  electron.ipcMain.on("codex-linux:remote-port-register", (event, registration) => {
    const port = event.ports[0];
    if (
      port == null ||
      registration == null ||
      typeof registration.portId !== "string" ||
      typeof registration.token !== "string" ||
      !ipcRelays.has(registration.relayId)
    ) {
      port?.close();
      return;
    }
    const timeout = setTimeout(() => {
      const entry = transferablePorts.get(registration.portId);
      if (entry?.port === port) transferablePorts.delete(registration.portId);
      port.close();
    }, 30_000);
    timeout.unref?.();
    transferablePorts.set(registration.portId, {
      port,
      relayId: registration.relayId,
      timeout,
      token: registration.token,
    });
  });
}

function transferablePortEntry(url) {
  if (!url.pathname.startsWith("/message-port/")) return null;
  const portId = url.pathname.slice("/message-port/".length);
  const entry = transferablePorts.get(portId);
  if (entry == null) return null;
  const provided = Buffer.from(url.searchParams.get("token") ?? "");
  const expected = Buffer.from(entry.token);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
  return { entry, portId };
}

function attachTransferredPort({ entry, portId, peer }) {
  transferablePorts.delete(portId);
  clearTimeout(entry.timeout);
  const dispose = () => entry.port.close();
  peer.once("close", dispose);
  peer.on("text", (text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      peer.close(1003);
      return;
    }
    if (message?.type !== "message") {
      peer.close(1003);
      return;
    }
    entry.port.postMessage(message.data);
  });
  entry.port.on("message", (event) => {
    if (event.ports?.length > 0) {
      peer.close(1003);
      return;
    }
    sendJson(peer, { type: "message", data: event.data });
  });
  entry.port.on("close", () => peer.close());
  entry.port.start();
}

function attachIpcRelay({ electron, getContext, peer }) {
  installIpcRelayListeners(electron);
  const context = findWindowContext(electron, getContext);
  const owner = electron.BrowserWindow.getAllWindows().find(
    (window) => !window.isDestroyed() && getContext(window.webContents) === context,
  );
  if (owner == null) {
    peer.close(1013);
    return;
  }
  const relayId = crypto.randomUUID();
  ipcRelays.set(relayId, peer);
  const dispose = () => {
    ipcRelays.delete(relayId);
  };
  peer.once("close", dispose);
  peer.on("text", (data) => {
    let command;
    try {
      command = JSON.parse(data);
    } catch {
      peer.close(1003);
      return;
    }
    if (
      command == null ||
      typeof command !== "object" ||
      typeof command.requestId !== "string" ||
      !["send-sync", "invoke", "send", "subscribe", "unsubscribe"].includes(command.type)
    ) {
      peer.close(1003);
      return;
    }
    owner.webContents.send("codex-linux:remote-ipc-command", { relayId, ...command });
  });
  sendJson(peer, { type: "ready" });
}

async function start({ electron, getContext, createRpc }) {
  const bind = process.env.CODEX_REMOTE_WEB_HOST_BIND || "127.0.0.1";
  const port = Number.parseInt(process.env.CODEX_REMOTE_WEB_HOST_PORT || "5177", 10);
  const token = process.env.CODEX_REMOTE_WEB_HOST_TOKEN || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CODEX_REMOTE_WEB_HOST_PORT must be a valid TCP port");
  }
  if (!LOOPBACK_HOSTS.has(bind) && !token) {
    throw new Error("CODEX_REMOTE_WEB_HOST_TOKEN is required for a non-loopback bind address");
  }

  const server = http.createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, appVersion: electron.app.getVersion() }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://localhost");
    const key = request.headers["sec-websocket-key"];
    const transferredPort = transferablePortEntry(url);
    if (url.pathname !== "/app-host" && url.pathname !== "/electron-ipc" && transferredPort == null) {
      reject(socket, "404 Not Found", "Not found");
      return;
    }
    if (!authorize(request, bind, token)) {
      reject(socket, "401 Unauthorized", "Unauthorized");
      return;
    }
    if (request.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
      reject(socket, "400 Bad Request", "Invalid WebSocket upgrade");
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
    );
    const peer = new WebSocketPeer(socket, head);
    if (transferredPort != null) {
      attachTransferredPort({ ...transferredPort, peer });
      return;
    }
    if (url.pathname === "/electron-ipc") {
      attachIpcRelay({ electron, getContext, peer });
      return;
    }
    attachAppHost({ electron, getContext, createRpc, peer }).catch((error) => {
      console.error("[remote-web-host] App Host connection failed", error);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bind, resolve);
  });
  console.log(`[remote-web-host] App Host WebSocket listening on ws://${bind}:${port}/app-host`);
  return server;
}

module.exports = {
  MAX_FRAME_BYTES,
  RpcMessagePort,
  WebSocketPeer,
  attachTransferredPort,
  encodeFrame,
  start,
  websocketAccept,
};
