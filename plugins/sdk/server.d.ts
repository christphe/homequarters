// Types of the Home Quarters plugin API on the server: the global `hq` and the functions a plugin's server
// module may export. Reference: docs/plugin-api.md. Use it from a plugin's tsconfig.json:
//   { "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2020", "lib": ["ES2020"], "types": [] },
//     "include": ["*.ts", "../sdk/server.d.ts"] }
// The server compiles TypeScript without checking types: run tsc (or your editor) to check them.

declare global {
  namespace HQ {
    /** A member as plugins see them: online and not invisible. */
    interface Player {
      readonly id: number;
      readonly name: string;
      readonly role: "admin" | "member";
    }

    /** Anything JSON can carry. */
    type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

    interface RouteRequest {
      /** The signed-in member, or the member an app token belongs to. */
      player: Player;
      /** The POST body (at most 16 KB), "" for GET. */
      body: string;
      /** Query parameters (first value of each). */
      query: Record<string, string>;
    }

    interface RouteReply {
      /** 100-599, 200 when missing. */
      status?: number;
      /** A string is sent as text/plain, anything else as JSON, nothing as an empty body (at most 1 MB). */
      body?: unknown;
    }

    interface RouteOptions {
      /** Also open the route to an app holding a member's app token (needs "appTokens": true in plugin.json). */
      token?: boolean;
    }

    interface Server {
      /** Sends msg (anything JSON.stringify accepts) to that member's browser code. false: not online, or the send budget is spent. Throws over 4 KB. */
      send(id: number, msg: unknown): boolean;
      /** Sends msg to every online member. false: the send budget of one of them is spent. Throws over 4 KB. */
      broadcast(msg: unknown): boolean;
      /** The online (visible) members. */
      players(): Player[];
      /** Persistent strings, per plugin and office: keys 1-128 bytes, values up to 4 KB, at most 1000 keys. */
      kv: {
        get(key: string): string | null;
        /** Throws when a limit is broken or the value is not a string. */
        set(key: string, value: string): void;
        delete(key: string): void;
      };
      /** While the plugin loads (its top level or load()): serves GET or POST at /plugins/<name>/api<path>. An async handler may await. */
      route(method: "GET" | "POST", path: `/${string}`, handler: (req: RouteRequest) => RouteReply | void | Promise<RouteReply | void>, opts?: RouteOptions): void;
      /** One server log line tagged with the plugin's name. Never log message contents or personal data. */
      log(...parts: unknown[]): void;
      /** Seconds since the plugin started. */
      now(): number;
    }

    /** What a server module may export (all optional, may be async). Any other export stops the plugin from starting. */
    interface Exports {
      /** Once, when the plugin starts: declare routes here. */
      load?(): void;
      /** About every 100 ms; dt in seconds. */
      update?(dt: number): void;
      /** A member became visible-online; also called for everybody online right after load(). */
      onJoin?(player: Player): void;
      /** The member left, was removed, or went invisible. */
      onLeave?(player: Player): void;
      /** That member's browser code called hq.send(msg). msg comes from a browser: check it before use. */
      onMessage?(player: Player, msg: unknown): void;
      /** Before the plugin stops. */
      unload?(): void;
    }
  }

  const hq: HQ.Server;
  const console: { log(...parts: unknown[]): void; info(...parts: unknown[]): void; warn(...parts: unknown[]): void; error(...parts: unknown[]): void };
}

export {};
