// The contract every part of the world view follows (docs/decisions/0033-world-view-layers.md), the
// lifecycle plugins already have (plugins/sdk/client.d.ts: onLoad, onUpdate, onObjectInit/Destroy):
//   init(ctx)          once, when the PixiJS application exists: create Containers, add them to the stage
//                      (events and update come only after it: the session starts after `await view.init`)
//   onMap(map) ...     events, as direct calls from WorldView in a fixed order (no event bus)
//   update(dt, now)    every frame; returns true when something on screen changed
//   destroy()          once; the stage's children go with the application
// A layer is a code module, not necessarily a Container: avatars, desks and pcs, plugin objects and plugin
// sprites all live in the one depth-sorted `entLayer`. No PixiJS value import here, so tests load it in node.
import type { Application, Container } from "pixi.js";
import type { MapData, Person } from "../net/protocol";
import type { Camera } from "./camera";
import type { Grid } from "./motion";
import type { NameOf } from "./places";

// Render on demand: a frame is drawn only when something on screen changed, plus this slow
// heartbeat as a safety net. An office is mostly people standing still; redrawing an unchanged
// scene 60 times a second kept the GPU awake for nothing.
export const IDLE_RENDER_MS = 250;

/** What the layers share: the stage, the camera and the world as the view knows it. Owned by WorldView. */
export interface ViewContext {
  /** Set in WorldView.init, before any layer's init. */
  app: Application;
  /** The world, scaled and moved by the camera: the baked map, then entLayer, then markers drawn in world px. */
  world: Container;
  /** Everything sorted by its feet (zIndex): avatars, desks and pcs over the bake, plugin objects and sprites. */
  entLayer: Container;
  /** Screen-pixel overlay: name tags, labels, emotes, the hover tag, the banner. */
  hud: Container;
  cam: Camera;
  /** Something changed outside frame(): draw the next frame. */
  dirty: boolean;
  /** Economy mode (slower walk animation, 30 FPS cap). */
  eco: boolean;
  map: MapData | null;
  /** The map as movement sees it: walls, the area of each tile, and the rooms I may not enter. */
  grid: Grid;
  /** The area named to the player for each area: itself, or for a desk room the area it sits in. */
  shownOf: Int16Array;
  people: Map<number, Person>;
  /** Names of the members places belong to (the server's owner names); online people fill the gaps. */
  nameOf: NameOf;
  meId: number;
}

export interface Layer {
  init(ctx: ViewContext): void;
  /** A new map (or an editor draft); called by WorldView.setMap in a fixed order. */
  onMap?(map: MapData): void;
  /** One frame: dt in seconds (at most 0.1), now from performance.now(). True when something on screen changed. */
  update(dt: number, now: number): boolean;
  destroy(): void;
}

/** Updates every layer, in order, each one every frame (no short cut once one changed); true if any changed. */
export function updateLayers(layers: readonly Layer[], dt: number, now: number): boolean {
  let changed = false;
  for (let i = 0; i < layers.length; i++) if (layers[i].update(dt, now)) changed = true;
  return changed;
}

/** Whether this frame is drawn: something changed, or the idle heartbeat is due. */
export function shouldRender(changed: boolean, now: number, lastRender: number): boolean {
  return changed || now - lastRender >= IDLE_RENDER_MS;
}
