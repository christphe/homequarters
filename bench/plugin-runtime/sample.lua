-- Sample plugin: every member online has a seedling. From the plugin's modal (side panel > Plugins >
-- Sample pet) a member shows or hides theirs and picks its colour; a button in the top bar lets it
-- wander around where it was left, or calls it back. Colour and visibility are remembered (tw.kv).
-- The browser code is public/client.js.
--
-- Habits worth copying:
--   * changes are collected and broadcast once per update (10 times a second), so a whole office
--     arriving at once (a restart) is one message, well inside the send budget;
--   * messages from browsers are checked before use, and what a member can repeat is throttled:
--     every Lua error counts toward the 10 a minute that stop the plugin.

local VARIANTS = 4

local pets = {}     -- by member id: { v = variant, shown = bool, mode = "follow" | "wander" }
local changed = {}  -- ids whose seedling changed since the last broadcast
local gone = {}     -- ids that left since the last broadcast
local goals = {}    -- wander goals to relay, by id: { x, y }
local last = {}     -- last accepted change, by id (throttle)

local function stored(id)
  local v = tonumber(tw.kv.get("v:" .. id) or "")
  if v == nil then
    v = math.random(0, VARIANTS - 1)
    tw.kv.set("v:" .. id, tostring(v))
  end
  return v
end

local function entry(id)
  local p = pets[id]
  return { id = id, v = p.v, shown = p.shown, mode = p.mode }
end

local function list(ids)
  local out = {}
  for id in pairs(ids) do
    if pets[id] ~= nil then out[#out + 1] = entry(id) end
  end
  return out
end

-- at most 5 changes a second per member, with a burst of 5 (a token bucket): quick clicks go
-- through, a script hammering the plugin does not
local function allowed(id)
  local now = tw.now()
  local b = last[id] or { tokens = 5, at = now }
  b.tokens = math.min(5, b.tokens + (now - b.at) * 5)
  b.at = now
  last[id] = b
  if b.tokens < 1 then return false end
  b.tokens = b.tokens - 1
  return true
end

function on_join(p)
  pets[p.id] = { v = stored(p.id), shown = tw.kv.get("h:" .. p.id) ~= "1", mode = "follow" }
  changed[p.id] = true
  gone[p.id] = nil
end

function on_leave(p)
  pets[p.id], changed[p.id], goals[p.id], last[p.id] = nil, nil, nil, nil
  gone[p.id] = true
end

function update(dt)
  local set, del, go = list(changed), {}, {}
  for id in pairs(gone) do del[#del + 1] = id end
  for id, g in pairs(goals) do go[#go + 1] = { id = id, x = g.x, y = g.y } end
  if #set == 0 and #del == 0 and #go == 0 then return end
  -- a refused broadcast (send budget) is kept and retried on the next update
  if tw.broadcast({ t = "pets", set = set, del = del, go = go }) then
    changed, gone, goals = {}, {}, {}
  end
end

local function coord(v)
  return type(v) == "number" and v == v and v > -100000 and v < 100000
end

function on_message(p, m)
  local me = pets[p.id]
  if type(m) ~= "table" or me == nil then return end
  if m.t == "sync" then
    -- a page (re)started: tell it every seedling at once
    tw.send(p.id, { t = "pets", set = list(pets), del = {}, go = {} })
  elseif m.t == "variant" and type(m.v) == "number" and m.v >= 0 and m.v < VARIANTS and m.v % 1 == 0 then
    if not allowed(p.id) then return end
    me.v = m.v
    tw.kv.set("v:" .. p.id, tostring(m.v))
    changed[p.id] = true
  elseif m.t == "shown" and type(m.on) == "boolean" then
    if not allowed(p.id) then return end
    me.shown = m.on
    tw.kv.set("h:" .. p.id, m.on and "0" or "1")
    changed[p.id] = true
  elseif m.t == "mode" and (m.m == "follow" or m.m == "wander") then
    if not allowed(p.id) then return end
    me.mode = m.m
    goals[p.id] = nil
    changed[p.id] = true
  elseif m.t == "wander" and me.mode == "wander" and coord(m.x) and coord(m.y) then
    -- the owner's page picks where its seedling strolls; everybody's page walks it there
    if not allowed(p.id) then return end
    goals[p.id] = { x = m.x, y = m.y }
  end
end
