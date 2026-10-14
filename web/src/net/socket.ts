import type { ServerMsg } from "./protocol";

export type ConnState = "connecting" | "open" | "reconnecting" | "replaced";

/** Reconnecting WebSocket. The server re-sends hello (map, roster, conversation) on every connect. */
export class Socket {
  private ws?: WebSocket;
  private backoff = 400;
  private stopped = false;
  private pingTimer = 0;
  private retryTimer = 0;
  // the last abnormal close, reported to the server once connected again (the server logs it)
  private drop: { code: number; at: number } | null = null;
  rtt = 0;

  constructor(
    private onMsg: (m: ServerMsg) => void,
    private onState: (s: ConnState) => void,
    private onEvicted: () => void = () => {},
  ) {}

  connect() {
    this.stopped = false;
    this.onState(this.backoff > 400 ? "reconnecting" : "connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 400;
      this.onState("open");
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: "ping", c: Math.round(performance.now()) }), 5000);
      if (this.drop) {
        this.send({ t: "diag", v: "ws-drop", n: this.drop.code, c: Math.round(performance.now() - this.drop.at) });
        this.drop = null;
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data) as ServerMsg;
      if (m.t === "pong") {
        this.rtt = Math.round(performance.now()) - m.c;
        return;
      }
      this.onMsg(m);
    };
    ws.onclose = (e) => {
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      if (e.code === 4001) {
        this.onState("replaced");
        return;
      }
      if (e.code === 4003) {
        // removed or role changed: the session layer decides whether to reconnect
        this.backoff = 400;
        this.onEvicted();
        return;
      }
      // 1000/1001 are a page leaving; 4001 and 4003 are handled above: anything else is worth reporting
      if (e.code !== 1000 && e.code !== 1001) this.drop ??= { code: e.code >= 1000 && e.code <= 4999 ? e.code : 1006, at: performance.now() };
      this.onState("reconnecting");
      const wait = this.backoff * (0.6 + Math.random() * 0.8);
      this.backoff = Math.min(this.backoff * 2, 8000);
      this.retryTimer = window.setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
  }

  send(o: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  close() {
    this.stopped = true;
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.ws?.close(1000); // a deliberate close: the server does not log it as a drop
  }
}
