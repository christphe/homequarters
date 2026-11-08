// <audio> and <video> for jsdom, whose play() logs "not implemented" and returns undefined (web/src/audioOut.ts chains
// .then on it at the first key or pointer press). Here play() resolves and the element reads as playing until paused;
// nothing is heard or shown. Like the canvas, installed when a helper is imported, for the whole test file.
const playing = new WeakSet<HTMLMediaElement>();
let installed = false;

/** Gives media elements a play() that resolves, a pause(), a load() and a `paused` that follows them. Idempotent. */
export function installMediaElements(): void {
  if (installed || typeof HTMLMediaElement === "undefined") return;
  installed = true;
  const proto = HTMLMediaElement.prototype;
  proto.play = function (this: HTMLMediaElement) { playing.add(this); this.dispatchEvent(new Event("play")); return Promise.resolve(); };
  proto.pause = function (this: HTMLMediaElement) { if (playing.delete(this)) this.dispatchEvent(new Event("pause")); };
  proto.load = function () {};
  Object.defineProperty(proto, "paused", { configurable: true, get(this: HTMLMediaElement) { return !playing.has(this); } });
}

installMediaElements();
