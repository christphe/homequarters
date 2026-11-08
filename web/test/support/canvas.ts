// A 2D canvas for jsdom, which has none (getContext returns null and logs "not implemented"): enough for the UI's
// painters (AvatarCanvas, Minimap) to run. It draws nothing; it records the name of every call, so a test can
// tell that something was painted. No dependency (the `canvas` package would need a native build).
type Calls = string[];
const calls = new WeakMap<HTMLCanvasElement, Calls>();

const DRAW = ["arc", "arcTo", "beginPath", "bezierCurveTo", "clearRect", "clip", "closePath", "drawImage", "ellipse", "fill", "fillRect",
  "fillText", "lineTo", "moveTo", "putImageData", "quadraticCurveTo", "rect", "reset", "resetTransform", "restore", "rotate", "roundRect",
  "save", "scale", "setLineDash", "setTransform", "stroke", "strokeRect", "strokeText", "transform", "translate"] as const;

const imageData = (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(0, w * h * 4)), colorSpace: "srgb" as const });
const gradient = () => ({ addColorStop() {} });

function context(canvas: HTMLCanvasElement) {
  const log: Calls = calls.get(canvas) ?? [];
  calls.set(canvas, log);
  const ctx: Record<string, unknown> = {
    canvas, fillStyle: "#000000", strokeStyle: "#000000", lineWidth: 1, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic",
    globalAlpha: 1, globalCompositeOperation: "source-over", imageSmoothingEnabled: true, lineCap: "butt", lineJoin: "miter", filter: "none",
  };
  for (const name of DRAW) ctx[name] = () => { log.push(name); };
  const value = (name: string, f: (...a: never[]) => unknown) => { ctx[name] = (...a: never[]) => { log.push(name); return f(...a); }; };
  value("getImageData", (_x: number, _y: number, w: number, h: number) => imageData(w, h));
  value("createImageData", (w: number | { width: number; height: number }, h?: number) => typeof w === "number" ? imageData(w, h ?? 0) : imageData(w.width, w.height));
  value("measureText", (text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }));
  value("getLineDash", () => []);
  value("getTransform", () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }));
  value("createLinearGradient", gradient);
  value("createRadialGradient", gradient);
  value("createConicGradient", gradient);
  value("createPattern", () => ({ setTransform() {} }));
  value("isPointInPath", () => false);
  return ctx;
}

let installed = false;

/**
 * Gives every canvas of the page a 2D context that records calls (WebGL and the others stay null), plus
 * `toDataURL`/`toBlob`, and `ImageData` when the environment lacks it. Importing any helper installs it (below);
 * renderUI makes sure. Idempotent.
 */
export function installCanvas(): void {
  if (installed) return;
  installed = true;
  const proto = HTMLCanvasElement.prototype;
  const ctxs = new WeakMap<HTMLCanvasElement, Record<string, unknown>>();
  proto.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null;
    let c = ctxs.get(this);
    if (!c) ctxs.set(this, (c = context(this)));
    return c;
  } as typeof proto.getContext;
  proto.toDataURL = () => "data:image/png;base64,";
  proto.toBlob = function (cb: BlobCallback) { cb(new Blob([], { type: "image/png" })); };
  const g = globalThis as { ImageData?: unknown };
  if (!("ImageData" in g)) {
    g.ImageData = class {
      readonly width: number; readonly height: number; readonly data: Uint8ClampedArray; readonly colorSpace = "srgb";
      constructor(a: number | Uint8ClampedArray, b: number, c?: number) {
        if (typeof a === "number") { this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4); }
        else { this.data = a; this.width = b; this.height = c ?? a.length / 4 / b; }
      }
    };
  }
}

// Installed as soon as a helper is imported: PixiJS probes a canvas when it loads (canUseNewCanvasBlendModes), so a
// test file that imports ./support before its components keeps jsdom's "not implemented" warning out of the output.
// It stays for the whole file (each test file has its own jsdom).
if (typeof HTMLCanvasElement !== "undefined") installCanvas();

/** The names of the 2D calls made on `canvas` so far (empty when it was never painted). */
export const canvasCalls = (canvas: HTMLCanvasElement): readonly string[] => calls.get(canvas) ?? [];
