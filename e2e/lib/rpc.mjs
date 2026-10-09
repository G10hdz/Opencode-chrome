// Shared JSON-RPC plumbing for the e2e suite: an MCP client over the bridge's
// stdio and a CDP client over raw DevTools websockets.
//
// The browser-level DevTools endpoint rejects the 'jsonrpc' property outright
// and its error reply carries no id (undeliverable — the request just hangs),
// so only the MCP client sends the tag.

import WebSocket from 'ws';

export class Rpc {
  constructor(jsonrpcTag = true) {
    this.jsonrpcTag = jsonrpcTag;
    this.nextId = 1;
    this.pending = new Map();
  }
  dispatch(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
      this.pending.get(msg.id)(msg);
      this.pending.delete(msg.id);
    }
  }
  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no response in ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      });
      this.send({ ...(this.jsonrpcTag ? { jsonrpc: '2.0' } : {}), id, method, params });
    });
  }
}

export class CdpSocket extends Rpc {
  constructor(ws) {
    super(false);
    this.ws = ws;
    ws.on('message', (d) => this.dispatch(d.toString()));
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  // The service worker has a single execution context (chrome.* present), so a
  // plain evaluate lands in the right place.
  async evaluate(expr) {
    const r = await this.request('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r?.exceptionDetails) throw new Error(`sw eval: ${JSON.stringify(r.exceptionDetails.text)}`);
    return r?.result?.value;
  }
  static async connect(webSocketDebuggerUrl, timeoutMs = 5000) {
    const sock = new CdpSocket(new WebSocket(webSocketDebuggerUrl));
    const end = Date.now() + timeoutMs;
    while (sock.ws.readyState !== 1) {
      if (Date.now() > end) throw new Error('ws connect timeout');
      await new Promise((r) => setTimeout(r, 100));
    }
    return sock;
  }
}

// MCP client over the bridge child process's stdio.
export class McpClient extends Rpc {
  constructor(proc) {
    super(true);
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        this.dispatch(buf.slice(0, idx).trim());
        buf = buf.slice(idx + 1);
      }
    });
  }
  send(obj) {
    this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }
  async handshake() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  // Returns parsed tool content. Throws the error envelope on isError.
  async call(name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args });
    const content = r?.content ?? [];
    if (r?.isError) {
      const e = new Error(content.map((c) => c.text).join(' '));
      e.raw = content;
      throw e;
    }
    const text = content[0]?.text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
