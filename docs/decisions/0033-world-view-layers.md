# 0033: The world view as layers with one lifecycle, rendering on demand

Date: 2026-10-26. Status: accepted.

## Context

`web/src/game/WorldView.ts` drew the whole office itself: one class of about 1,350 lines whose `frame()` (about 180 lines) moved me, placed the camera and then updated, one after the other, avatars, emotes, area, desk and placeholder labels, the destination and locate markers, the banner, the plugin sprites and the hover tag, while `setMap`, `applyWorld` and a dozen setters reached into every one of those fields. Most client features land in this file, so every change meant reading all of it, and nothing in it could be tested without a browser. The pure parts had already left it (`motion.ts`, `camera.ts`, `areas.ts`, decision 0017 and #42); what was left was drawing.

Plugins already live by a lifecycle (`plugins/sdk/client.d.ts`: `onLoad`, `onUpdate`, `onObjectInit/Update/Destroy`), the shape of Godot's `_ready`, `_process` and `_exit_tree`. The world view now uses the same one for its own parts.

## Decision

- **A layer is a code module with four parts** (`web/src/game/layer.ts`): `init(ctx)` once the PixiJS application exists (it creates its Containers and adds them to the stage); events as direct method calls (`onMap(map)`, `setSpecs`, `showEmote`, ...); `update(dt, now)` on every frame, returning `true` when it changed something on screen; `destroy()`. A layer is not necessarily a Container: avatars, the desks and PCs drawn over the bake, plugin objects and plugin sprites all stay in the one depth-sorted `entLayer`, so the draw order of people and furniture is unchanged.
- **The layers**: `MapLayer` (the bake and the depth sprites), `AvatarLayer` (people, name tags, badges, hands, emotes, dances, speaking rings, remote dead reckoning), `ObjectLayer` (plugin map objects, editor placeholders, the object within reach), `PluginLayer` (sprites plugins draw, which already almost had this shape), `HudLayer` (hover rectangle, destination, locate pulse and arrow, hover tag) and `LabelLayer` (area and desk names, the signboard). Two modules draw nothing and are not layers: `LocalPlayer` (my held direction, running, server-steered walks, predicted position and area) and `InputController` (keys, wheel, drag, double-click, the mouse over the map).
- **WorldView orchestrates.** It owns the application and a `ViewContext` the layers share (stage containers, camera, map, movement grid, people, the `dirty` flag). It keeps one fixed, ordered array of layers: map, avatars, objects, plugins, hud, labels. The order is part of the contract: `init` adds Containers in it (the world keeps entLayer, then placeholders, then markers; the hud keeps the locate arrow, the hover tag, then the banner, as before), plugin sprites follow the avatars they are pinned to, and the hover tag looks for plugin sprites where they were just drawn.
- **The frame**: advance me (`LocalPlayer.update`), recentre the camera if I move, place it, then `updateLayers` calls every layer's `update` in order (each one every frame, no short cut once one changed) and ORs the results with the `dirty` flag; `shouldRender` draws at most once, only on a change or the 250 ms idle heartbeat. `app.ticker.remove(app.render, app)` stays, as do the hidden-tab ticker stop and the economy mode's 30 FPS cap (decision 0017).
- **Events are direct calls in a fixed order, not a bus.** `setMap` calls `MapLayer`, then `LabelLayer`, then `ObjectLayer`, which is also the order their labels join the hud. Only one layer hears a world delta, so there is no `onWorld` in the interface: `applyWorld` calls `AvatarLayer` directly.
- **No allocation per frame added**: the layer loop is an index loop over the fixed array; layers keep the loops they had. The public API of `WorldView` is unchanged: everything the session, the UI and the browser tests read (`window.__hq.view`: `ents`, `map`, `locate`, `deskLabels`, `rendersTotal`, `stats`, `debug*`, ...) is a method or an accessor that delegates to the layer that now holds it.

## Alternatives

- **Keep one class and only split `frame()` into private methods:** shorter functions, but the state stays shared by everything and nothing becomes testable on its own.
- **One PixiJS Container per layer:** simpler to explain, but people, furniture and plugin sprites must sort together by their feet, which only works inside one container (decision 0031); separate containers would draw a desk over everyone or under everyone.
- **A generic event bus or signals:** looser coupling, but a subscription list to walk, closures, and an order nobody can read from the code; with six layers, direct calls in a fixed order are both faster and clearer.
- **Each layer renders its own Container on demand:** PixiJS renders a whole stage, not parts of it; one render per frame decided by the OR of the layers is the same cost with one place to look.

## Impact

- **Performance**: unchanged by design (same loops, one more index loop over six layers, no new allocation per frame). Measured with the `perf` scenario before and after on the same machine (Windows 11, AMD Ryzen 5 9600X, Chrome 156 headless, software GL through SwiftShader, 1440x900): see the numbers in PR #44 and below.
- **Maintenance**: `WorldView.ts` goes from 1,349 to about 600 lines, a third of which are the accessors the browser tests read; each concern is a module of 60 to 320 lines. A new thing drawn in the world is a new layer (AGENTS.md, conventions) instead of more fields and another block in `frame()`. The parts that node can run are unit tested (`web/test/layers.test.ts`: the layer loop and render decision, the signboard's slide, `LocalPlayer`); PixiJS text needs a DOM, so the drawing itself stays covered by the browser scenarios and the `capture-*` films.
- **Install**: none. No new dependency, no configuration, no protocol or data change.
