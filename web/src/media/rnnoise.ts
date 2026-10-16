// RNNoise noise suppression for the microphone (xiph/rnnoise in WebAssembly, run in an AudioWorklet).
// Loaded only when the setting is on: this module and its wasm are fetched on first use.
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import workletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import simdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

let wasm: Promise<ArrayBuffer> | null = null;
const ready = new WeakMap<AudioContext, Promise<void>>();

/** A LiveKit audio processor: microphone -> RNNoise -> the track that is published. */
export function rnnoiseProcessor(): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let src: MediaStreamAudioSourceNode | null = null;
  let node: RnnoiseWorkletNode | null = null;
  let dest: MediaStreamAudioDestinationNode | null = null;
  const p: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: "rnnoise",
    async init({ track, audioContext: ctx }) {
      wasm ??= loadRnnoise({ url: wasmUrl, simdUrl });
      if (!ready.has(ctx)) ready.set(ctx, ctx.audioWorklet.addModule(workletUrl));
      const [binary] = await Promise.all([wasm, ready.get(ctx)]);
      if (ctx.state === "suspended") await ctx.resume();
      node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: binary });
      src = ctx.createMediaStreamSource(new MediaStream([track]));
      dest = ctx.createMediaStreamDestination();
      src.connect(node).connect(dest);
      p.processedTrack = dest.stream.getAudioTracks()[0];
    },
    async restart(opts) {
      await p.destroy();
      await p.init(opts);
    },
    async destroy() {
      src?.disconnect();
      node?.disconnect();
      node?.destroy();
      p.processedTrack?.stop();
      src = node = dest = null;
      p.processedTrack = undefined;
    },
  };
  return p;
}
