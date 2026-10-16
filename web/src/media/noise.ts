// Noise suppression for the microphone: RNNoise, Speex or GTCRN (WebAssembly, run in an AudioWorklet at
// 48 kHz). Loaded only when the setting is on: this module and the chosen engine's wasm are fetched on
// first use. Used for the published microphone (a LiveKit processor) and for the "listen to myself" test.
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import { GtcrnWorkletNode, loadGtcrn, loadRnnoise, loadSpeex, RnnoiseWorkletNode, SpeexWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorklet from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasm from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimd from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import speexWorklet from "@sapphi-red/web-noise-suppressor/speexWorklet.js?url";
import speexWasm from "@sapphi-red/web-noise-suppressor/speex.wasm?url";
import gtcrnWorklet from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import gtcrnWasm from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";
import type { NoiseEngine } from "../store";

type NoiseNode = AudioWorkletNode & { destroy(): void };

const ENGINES: Record<NoiseEngine, { worklet: string; load: () => Promise<ArrayBuffer>; make: (ctx: AudioContext, wasmBinary: ArrayBuffer) => NoiseNode }> = {
  rnnoise: { worklet: rnnoiseWorklet, load: () => loadRnnoise({ url: rnnoiseWasm, simdUrl: rnnoiseSimd }), make: (ctx, wasmBinary) => new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary }) },
  speex: { worklet: speexWorklet, load: () => loadSpeex({ url: speexWasm }), make: (ctx, wasmBinary) => new SpeexWorkletNode(ctx, { maxChannels: 1, wasmBinary }) },
  gtcrn: { worklet: gtcrnWorklet, load: () => loadGtcrn({ url: gtcrnWasm }), make: (ctx, wasmBinary) => new GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary }) },
};

const binaries = new Map<NoiseEngine, Promise<ArrayBuffer>>();
const modules = new WeakMap<AudioContext, Map<NoiseEngine, Promise<void>>>();

/** A ready filter node for `engine` in `ctx` (48 kHz). */
export async function noiseNode(ctx: AudioContext, engine: NoiseEngine): Promise<NoiseNode> {
  const e = ENGINES[engine];
  if (!binaries.has(engine)) binaries.set(engine, e.load());
  const loaded = modules.get(ctx) ?? new Map<NoiseEngine, Promise<void>>();
  modules.set(ctx, loaded);
  if (!loaded.has(engine)) loaded.set(engine, ctx.audioWorklet.addModule(e.worklet));
  const [binary] = await Promise.all([binaries.get(engine)!, loaded.get(engine)]);
  if (ctx.state === "suspended") await ctx.resume();
  const node = e.make(ctx, binary);
  // the engines run on one channel: mix a stereo microphone down first, or only its left half is kept
  // (the voice in one ear, 6 dB quieter)
  node.channelCount = 1;
  node.channelCountMode = "explicit";
  node.channelInterpretation = "speakers";
  return node;
}

export const processorName = (engine: NoiseEngine) => "noise-" + engine;

/** A LiveKit audio processor: microphone -> engine -> the track that is published. */
export function noiseProcessor(engine: NoiseEngine): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let src: MediaStreamAudioSourceNode | null = null;
  let node: NoiseNode | null = null;
  const p: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: processorName(engine),
    async init({ track, audioContext: ctx }) {
      node = await noiseNode(ctx, engine);
      src = ctx.createMediaStreamSource(new MediaStream([track]));
      const dest = ctx.createMediaStreamDestination();
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
      src = node = null;
      p.processedTrack = undefined;
    },
  };
  return p;
}
