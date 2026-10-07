import { BlockVolume, system, world } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";
import {
  BREAKER_NODE_BLOCK,
  BREAKER_NODE_ENTITY,
  BREAKER_HEAD_ENTITY,
  BREAKER_START_BLOCK,
  BREAKER_END_BLOCK,
  DIMENSION_IDS,
} from "../config/constants.js";
import { ensureMarkerForBlock, findMarkerAtBlock } from "../core/marker.js";

// BR-1: red Start Marker + blue End Marker define opposite corners of one X-Z mining plane.
// Breaker Node must be face-adjacent to Start. Start and End must share the same Y.
// BR-10: UI uses a speed multiplier instead of exposing raw tick intervals.
// 1.0x preserves the proven BR-6 baseline (7 ticks per mined block).
const BASE_BREAK_INTERVAL_TICKS = 7;
const DEFAULT_BREAK_SPEED_MULTIPLIER = 1.0;
const MIN_BREAK_SPEED_MULTIPLIER = 0.1;
const MAX_BREAK_SPEED_MULTIPLIER = 5.0;
const DEFAULT_BREAK_INTERVAL_TICKS = BASE_BREAK_INTERVAL_TICKS;
const MIN_BREAK_INTERVAL_TICKS = Math.max(1, Math.round(BASE_BREAK_INTERVAL_TICKS / MAX_BREAK_SPEED_MULTIPLIER));
const MAX_BREAK_INTERVAL_TICKS = Math.round(BASE_BREAK_INTERVAL_TICKS / MIN_BREAK_SPEED_MULTIPLIER);
const BREAKER_REDSTONE_COMPONENT = "vfh:breaker_redstone_sync";
const BREAK_INTERVAL_PROP = "breaker_interval_ticks"; // Legacy property, migrated on first access.
const BREAK_SPEED_PROP = "breaker_speed_multiplier";
const REDSTONE_POWER_PROP = "breaker_redstone_power";
const VACUUM_RADIUS = 1.75;
const RANGE_FIND_RADIUS = 128;
const PARTICLE_INTERVAL_TICKS = 20;
const PARTICLE_STEP = 1;
const RANGE_PARTICLE = "minecraft:basic_flame_particle";
// BR-F2: replace the temporary particle outline with a physical frame erected one block at a time.
const BREAKER_FRAME_BLOCK = "vfh:breaker_frame";
const BREAKER_FRAME_BUILD_INTERVAL_TICKS = 4;
const BREAKER_FRAME_STRUCTURE_HEIGHT = 4;
const BREAKER_FRAME_INDEX_PROP = "breaker_frame_build_index";
const BREAKER_FRAME_RANGE_PROP = "breaker_frame_range_key";
const BREAKER_FRAME_COMPLETE_PROP = "breaker_frame_complete";
// BR-F9: once mining reaches the bottom of the world, dismantle only the initial surface scaffold.
const BREAKER_FRAME_CLEANUP_INDEX_PROP = "breaker_frame_cleanup_index";
const BREAKER_FRAME_CLEANUP_KEY_PROP = "breaker_frame_cleanup_key";
const BREAKER_FRAME_CLEANUP_COMPLETE_PROP = "breaker_frame_cleanup_complete";
// BR-F11: remember only coordinates where liquid protection actually placed a frame.
const BREAKER_LIQUID_FRAME_POSITIONS = new Map();
// BR-F7: liquid boundary protection runs independently from the mining loop.
// A runJob generator yields after every boundary cell so the job scheduler can
// spread monitoring work across ticks without gating mining progress.
const BREAKER_LIQUID_MONITORS = new Map();
// BR-F16: one drain job per Breaker marker, plus per-cursor stall tracking.
const BREAKER_LAYER_DRAIN_JOBS = new Map();
const BREAKER_AQUATIC_STALLS = new Map();
const BREAKER_AQUATIC_STALL_LIMIT = 3;
// BR-F17: remember the last mining layer whose stale internal frames were cleaned.
const BREAKER_STALE_FRAME_CLEAN_Y = new Map();
const HEAD_OWNER = "breaker_owner";
const BR5_OUTPUT_MAX_ITEMS_PER_TICK = 64;
const CURSOR_X = "breaker_cursor_x";
const CURSOR_Z = "breaker_cursor_z";
const CURSOR_Y = "breaker_cursor_y";
const DIR_X = "breaker_dir_x";
const NEXT_BREAK = "breaker_next_break"; // Legacy scheduler property, cleared by cumulative-speed mode.
const BREAK_PROGRESS = "breaker_speed_progress";
// BR-15: persistent chunk loading. Same TickingAreaManager path proven by Ender Node.
const BREAKER_TICKING_PREFIX = "vfh_brk";
const BREAKER_HEAD_CHUNK_RADIUS = 1;
const BREAKER_NODE_FIXED_RADIUS = 10;
const BREAKER_MARKER_LOAD_RADIUS = 0;
const BREAKER_HEAD_PARTICLE = "minecraft:basic_flame_particle";
const BREAKER_CHUNK_READY_PROP = "breaker_chunk_ready";
const BREAKER_CHUNK_PENDING_PROP = "breaker_chunk_pending";
const BREAKER_HEAD_CHUNK_X_PROP = "breaker_head_chunk_x";
const BREAKER_HEAD_CHUNK_Z_PROP = "breaker_head_chunk_z";
const BREAKER_BEAM = "vfh:breaker_beam";
const BREAKER_BEAM_HEIGHT = 48;
const OFFSETS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

function ensureBreakerMarker(block) {
  const marker = ensureMarkerForBlock(block, BREAKER_NODE_ENTITY, null, BREAKER_NODE_BLOCK);
  if (marker && marker.getDynamicProperty(BREAK_SPEED_PROP) === undefined) {
    const legacy = Number(marker.getDynamicProperty(BREAK_INTERVAL_PROP));
    const migrated = Number.isFinite(legacy) && legacy > 0
      ? clampSpeedMultiplier(BASE_BREAK_INTERVAL_TICKS / legacy)
      : DEFAULT_BREAK_SPEED_MULTIPLIER;
    marker.setDynamicProperty(BREAK_SPEED_PROP, migrated);
  }
  if (marker && marker.getDynamicProperty(REDSTONE_POWER_PROP) === undefined) marker.setDynamicProperty(REDSTONE_POWER_PROP, 0);
  return marker;
}
function clampSpeedMultiplier(value) {
  if (!Number.isFinite(value)) return DEFAULT_BREAK_SPEED_MULTIPLIER;
  const clamped = Math.max(MIN_BREAK_SPEED_MULTIPLIER, Math.min(MAX_BREAK_SPEED_MULTIPLIER, value));
  return Math.round(clamped * 10) / 10;
}
function getBreakSpeedMultiplier(marker) {
  const value = Number(marker?.getDynamicProperty(BREAK_SPEED_PROP));
  return clampSpeedMultiplier(value);
}
function getBreakInterval(marker) {
  const speed = getBreakSpeedMultiplier(marker);
  return BASE_BREAK_INTERVAL_TICKS / speed;
}
function resetBreakProgress(head) {
  if (!head?.isValid) return;
  head.setDynamicProperty(BREAK_PROGRESS, 0);
  try { head.setDynamicProperty(NEXT_BREAK, undefined); } catch {}
}
function consumeBreakCredit(head, marker) {
  // Accumulate fractional work every tick. One block costs BASE_BREAK_INTERVAL_TICKS units.
  // This preserves the proven 1.0x = 7 ticks/block baseline while allowing exact
  // long-term ratios for settings that cannot be represented by an integer tick interval.
  const speed = getBreakSpeedMultiplier(marker);
  let progress = Number(head.getDynamicProperty(BREAK_PROGRESS));
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  progress += speed;
  if (progress + 1e-9 < BASE_BREAK_INTERVAL_TICKS) {
    head.setDynamicProperty(BREAK_PROGRESS, progress);
    return false;
  }
  head.setDynamicProperty(BREAK_PROGRESS, progress - BASE_BREAK_INTERVAL_TICKS);
  return true;
}
function isBreakerPowered(marker) { return Number(marker?.getDynamicProperty(REDSTONE_POWER_PROP)) > 0; }
const openingBreakerForm = new Set();

function initializeBreakerMarker(marker) {
  if (!marker) return null;
  if (marker.getDynamicProperty(BREAK_SPEED_PROP) === undefined) {
    const legacy = Number(marker.getDynamicProperty(BREAK_INTERVAL_PROP));
    const migrated = Number.isFinite(legacy) && legacy > 0
      ? clampSpeedMultiplier(BASE_BREAK_INTERVAL_TICKS / legacy)
      : DEFAULT_BREAK_SPEED_MULTIPLIER;
    marker.setDynamicProperty(BREAK_SPEED_PROP, migrated);
  }
  if (marker.getDynamicProperty(REDSTONE_POWER_PROP) === undefined) {
    marker.setDynamicProperty(REDSTONE_POWER_PROP, 0);
  }
  if (marker.getDynamicProperty(BREAKER_CHUNK_READY_PROP) === undefined) marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, 0);
  if (marker.getDynamicProperty(BREAKER_CHUNK_PENDING_PROP) === undefined) marker.setDynamicProperty(BREAKER_CHUNK_PENDING_PROP, 0);
  return marker;
}

/* =========================================================
   BR-14 OPEN BREAKER SETTINGS - VACUUM NODE STYLE
========================================================= */
world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
  const player = ev.player;
  if (!player.isSneaking || ev.block.typeId !== BREAKER_NODE_BLOCK || ev.itemStack) return;
  ev.cancel = true;

  const dimension = ev.block.dimension;
  const location = {
    x: ev.block.location.x,
    y: ev.block.location.y,
    z: ev.block.location.z,
  };
  const formKey = `${player.id}:${dimension.id}:${location.x}:${location.y}:${location.z}`;
  if (openingBreakerForm.has(formKey)) return;
  openingBreakerForm.add(formKey);

  system.run(() => {
    try {
      const block = dimension.getBlock(location);
      if (!block || block.typeId !== BREAKER_NODE_BLOCK) {
        openingBreakerForm.delete(formKey);
        return;
      }

      const marker = initializeBreakerMarker(ensureBreakerMarker(block));
      if (!marker) {
        openingBreakerForm.delete(formKey);
        return;
      }

      const speed = Number(marker.getDynamicProperty(BREAK_SPEED_PROP)) || DEFAULT_BREAK_SPEED_MULTIPLIER;
      const form = new ModalFormData()
        .title("Breaker Node")
        .slider("Mining Speed / 採掘速度", MIN_BREAK_SPEED_MULTIPLIER, MAX_BREAK_SPEED_MULTIPLIER, { defaultValue: speed });

      form.show(player)
        .then((result) => {
          if (result.canceled || !Array.isArray(result.formValues)) return;
          const value = Number(result.formValues[0]);
          if (!Number.isFinite(value)) return;
          const savedSpeed = clampSpeedMultiplier(value);
          marker.setDynamicProperty(BREAK_SPEED_PROP, savedSpeed);
          try { marker.setDynamicProperty(BREAK_INTERVAL_PROP, undefined); } catch {}
          const head = findOwnedHead(marker);
          resetBreakProgress(head);
          player.sendMessage(`Mining Speed = ${savedSpeed.toFixed(1)}x`);
        })
        .catch((error) => (() => {})("BREAKER FORM ERROR = " + error))
        .finally(() => openingBreakerForm.delete(formKey));
    } catch (error) {
      (() => {})("BREAKER SELF-HEAL ERROR = " + error);
      openingBreakerForm.delete(formKey);
    }
  });
});

system.beforeEvents.startup.subscribe((event) => {
  event.blockComponentRegistry.registerCustomComponent(BREAKER_REDSTONE_COMPONENT, {
    onRedstoneUpdate(redstoneEvent) {
      const block = redstoneEvent.block; if (!block || block.typeId !== BREAKER_NODE_BLOCK) return;
      const marker = ensureBreakerMarker(block); if (!marker) return;
      marker.setDynamicProperty(REDSTONE_POWER_PROP, Number(redstoneEvent.powerLevel) || 0);
    },
  });
});
function getBlock(dimension, p) {
  try { return dimension.getBlock(p); } catch { return undefined; }
}
function adjacentStart(block) {
  for (const o of OFFSETS) {
    const b = getBlock(block.dimension, { x: block.location.x + o.x, y: block.location.y + o.y, z: block.location.z + o.z });
    if (b?.typeId === BREAKER_START_BLOCK) return b;
  }
  return undefined;
}
function nearestEnd(start) {
  let best;
  let bestD = Infinity;
  try {
    const volume = new BlockVolume(
      { x: start.location.x - RANGE_FIND_RADIUS, y: start.location.y, z: start.location.z - RANGE_FIND_RADIUS },
      { x: start.location.x + RANGE_FIND_RADIUS, y: start.location.y, z: start.location.z + RANGE_FIND_RADIUS }
    );
    for (const p of start.dimension.getBlocks(volume, { includeTypes: [BREAKER_END_BLOCK] }, true).getBlockLocationIterator()) {
      if (p.y !== start.location.y) continue;
      const dx = p.x - start.location.x, dz = p.z - start.location.z;
      if (dx === 0 || dz === 0) continue;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = getBlock(start.dimension, p); }
    }
  } catch {}
  return best;
}
const RANGE_CACHE = new Map();
function rangeKey(block) { return `${block.dimension.id}:${block.location.x},${block.location.y},${block.location.z}`; }
function breakerAreaDimTag(id) {
  if (id === "minecraft:overworld") return "o";
  if (id === "minecraft:nether") return "n";
  if (id === "minecraft:the_end") return "e";
  return "x";
}
function breakerAreaNum(value) {
  const n = Math.trunc(Number(value) || 0);
  return n < 0 ? `m${Math.abs(n)}` : `p${n}`;
}
function breakerAreaName(block) {
  return `${BREAKER_TICKING_PREFIX}_${breakerAreaDimTag(block.dimension.id)}_${breakerAreaNum(block.location.x)}_${breakerAreaNum(block.location.y)}_${breakerAreaNum(block.location.z)}`;
}
function breakerNodeAreaName(block) { return `${breakerAreaName(block)}_node`; }
function breakerHeadAreaName(block) { return `${breakerAreaName(block)}_head`; }
function breakerStartAreaName(block) { return `${breakerAreaName(block)}_start`; }
function breakerEndAreaName(block) { return `${breakerAreaName(block)}_end`; }
function removeBreakerTickingArea(block) {
  try {
    const manager = world.tickingAreaManager;
    for (const name of [breakerAreaName(block), breakerNodeAreaName(block), breakerStartAreaName(block), breakerEndAreaName(block), breakerHeadAreaName(block)]) {
      if (manager.hasTickingArea(name)) manager.removeTickingArea(name);
    }
  } catch {}
}
async function ensureBreakerTickingArea(block, marker, targetLocation) {
  if (!block || !marker || !targetLocation) return false;
  if (Number(marker.getDynamicProperty(BREAKER_CHUNK_PENDING_PROP)) > 0) return false;
  try {
    marker.setDynamicProperty(BREAKER_CHUNK_PENDING_PROP, 1);
    const manager = world.tickingAreaManager;
    const nodeName = breakerNodeAreaName(block);
    const headName = breakerHeadAreaName(block);
    const nodeOptions = {
      dimension: block.dimension,
      from: { x: block.location.x - BREAKER_NODE_FIXED_RADIUS, y: block.location.y, z: block.location.z - BREAKER_NODE_FIXED_RADIUS },
      to: { x: block.location.x + BREAKER_NODE_FIXED_RADIUS, y: block.location.y, z: block.location.z + BREAKER_NODE_FIXED_RADIUS },
    };
    if (!manager.hasTickingArea(nodeName)) {
      if (!manager.hasCapacity(nodeOptions)) { marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, 0); return false; }
      await manager.createTickingArea(nodeName, nodeOptions);
    }
    // Keep the range markers themselves ticking, independent of player distance.
    // Start is adjacent to Breaker; End may be far away within RANGE_FIND_RADIUS.
    const range = getRange(block);
    if (range) {
      const markerAreas = [
        [breakerStartAreaName(block), range.start.location],
        [breakerEndAreaName(block), range.end.location],
      ];
      for (const [areaName, location] of markerAreas) {
        if (manager.hasTickingArea(areaName)) continue;
        const markerOptions = {
          dimension: block.dimension,
          from: { x: location.x - BREAKER_MARKER_LOAD_RADIUS, y: location.y, z: location.z - BREAKER_MARKER_LOAD_RADIUS },
          to: { x: location.x + BREAKER_MARKER_LOAD_RADIUS, y: location.y, z: location.z + BREAKER_MARKER_LOAD_RADIUS },
        };
        if (!manager.hasCapacity(markerOptions)) { marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, 0); return false; }
        await manager.createTickingArea(areaName, markerOptions);
      }
    }
    const chunkX = Math.floor(targetLocation.x / 16);
    const chunkZ = Math.floor(targetLocation.z / 16);
    const previousX = Number(marker.getDynamicProperty(BREAKER_HEAD_CHUNK_X_PROP));
    const previousZ = Number(marker.getDynamicProperty(BREAKER_HEAD_CHUNK_Z_PROP));
    if (manager.hasTickingArea(headName) && previousX === chunkX && previousZ === chunkZ) {
      const area = manager.getTickingArea(headName);
      const ready = !!area?.isFullyLoaded;
      marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, ready ? 1 : 0);
      return ready;
    }
    const minX = (chunkX - BREAKER_HEAD_CHUNK_RADIUS) * 16;
    const maxX = (chunkX + BREAKER_HEAD_CHUNK_RADIUS + 1) * 16 - 1;
    const minZ = (chunkZ - BREAKER_HEAD_CHUNK_RADIUS) * 16;
    const maxZ = (chunkZ + BREAKER_HEAD_CHUNK_RADIUS + 1) * 16 - 1;
    const headOptions = {
      dimension: block.dimension,
      from: { x: minX, y: targetLocation.y, z: minZ },
      to: { x: maxX, y: targetLocation.y, z: maxZ },
    };
    // Load the next head area before dropping the previous one whenever capacity permits.
    // If overlap prevents that, replace the old head area and wait for the new one to finish loading.
    if (manager.hasTickingArea(headName)) manager.removeTickingArea(headName);
    if (!manager.hasCapacity(headOptions)) { marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, 0); return false; }
    await manager.createTickingArea(headName, headOptions);
    marker.setDynamicProperty(BREAKER_HEAD_CHUNK_X_PROP, chunkX);
    marker.setDynamicProperty(BREAKER_HEAD_CHUNK_Z_PROP, chunkZ);
    marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, 1);
    return true;
  } catch {
    try { marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, 0); } catch {}
    return false;
  } finally {
    try { marker.setDynamicProperty(BREAKER_CHUNK_PENDING_PROP, 0); } catch {}
  }
}
function requestBreakerTickingArea(block, marker, targetLocation) {
  if (!block || !marker || !targetLocation) return;
  if (Number(marker.getDynamicProperty(BREAKER_CHUNK_PENDING_PROP)) > 0) return;
  void ensureBreakerTickingArea(block, marker, targetLocation);
}
function resolveRange(block) {
  const start = adjacentStart(block);
  if (!start) return undefined;
  const end = nearestEnd(start);
  if (!end || end.location.y !== start.location.y) return undefined;
  return {
    start, end, y: start.location.y,
    minX: Math.min(start.location.x, end.location.x), maxX: Math.max(start.location.x, end.location.x),
    minZ: Math.min(start.location.z, end.location.z), maxZ: Math.max(start.location.z, end.location.z),
  };
}
function cacheRange(block) {
  const key = rangeKey(block);
  const range = resolveRange(block);
  if (range) RANGE_CACHE.set(key, range); else RANGE_CACHE.delete(key);
  return range;
}
function getRange(block) {
  const key = rangeKey(block);
  const cached = RANGE_CACHE.get(key);
  if (!cached) return cacheRange(block);
  const start = getBlock(block.dimension, cached.start.location);
  const end = getBlock(block.dimension, cached.end.location);
  if (start?.typeId !== BREAKER_START_BLOCK || end?.typeId !== BREAKER_END_BLOCK || start.location.y !== end.location.y) {
    RANGE_CACHE.delete(key);
    return undefined;
  }
  return cached;
}
function findOwnedHead(marker) {
  for (const head of marker.dimension.getEntities({ type: BREAKER_HEAD_ENTITY })) {
    try { if (head.getDynamicProperty(HEAD_OWNER) === marker.id) return head; } catch {}
  }
  return undefined;
}
function findFirstMiningY(range) {
  const zStep = range.end.location.z >= range.start.location.z ? 1 : -1;
  for (let y = range.y; y >= range.start.dimension.heightRange.min; y--) {
    for (let z = range.start.location.z; ; z += zStep) {
      for (let x = range.minX; x <= range.maxX; x++) {
        const target = getBlock(range.start.dimension, { x, y, z });
        if (!target) return range.y;
        try {
          if (target.typeId !== "minecraft:air" && !isProtected(target.typeId) && !isUnbreakable(target.typeId) && !isBreakerWaterOrLava(target)) return y;
        } catch { return range.y; }
      }
      if (z === range.end.location.z) break;
    }
  }
  return range.y;
}
function ensureHead(marker, range) {
  let head = findOwnedHead(marker);
  if (!head) {
    try {
      // BR-15: remove the initial descent animation. Spawn the head directly on
      // the first Y layer that actually contains a mineable block.
      const firstMiningY = findFirstMiningY(range);
      head = marker.dimension.spawnEntity(BREAKER_HEAD_ENTITY, {
        x: range.start.location.x + 0.5, y: firstMiningY + 0.5, z: range.start.location.z + 0.5,
      });
      head.setDynamicProperty(HEAD_OWNER, marker.id);
      head.setDynamicProperty(CURSOR_X, range.start.location.x);
      head.setDynamicProperty(CURSOR_Z, range.start.location.z);
      head.setDynamicProperty(CURSOR_Y, firstMiningY);
      head.setDynamicProperty(DIR_X, range.end.location.x >= range.start.location.x ? 1 : -1);
      head.setDynamicProperty(NEXT_BREAK, 0);
    } catch { return undefined; }
  }
  return head;
}
function cleanupXpOrbsAroundHead(head) {
  if (!head?.isValid) return 0;
  let removed = 0;
  let orbs;
  try {
    orbs = head.dimension.getEntities({
      type: "minecraft:xp_orb",
      location: head.location,
      maxDistance: VACUUM_RADIUS,
    });
  } catch { return 0; }
  for (const orb of orbs) {
    try {
      if (!orb?.isValid) continue;
      orb.remove();
      removed++;
    } catch {}
  }
  return removed;
}
function vacuumIntoHead(head) {
  const inv = head.getComponent("minecraft:inventory")?.container;
  if (!inv?.isValid) return 0;
  let collected = 0;
  for (const e of head.dimension.getEntities({ type: "minecraft:item", location: head.location, maxDistance: VACUUM_RADIUS }).slice(0, 16)) {
    try {
      const stack = e.getComponent("minecraft:item")?.itemStack;
      if (!stack) continue;
      const left = inv.addItem(stack);
      if (!left) { collected += stack.amount ?? 1; e.remove(); }
    } catch {}
  }
  return collected;
}
function transferHeadToBreaker(head, marker) {
  const src = head.getComponent("minecraft:inventory")?.container;
  const dst = marker.getComponent("minecraft:inventory")?.container;
  if (!src?.isValid || !dst?.isValid) return 0;
  let moved = 0;
  for (let i = 0; i < src.size; i++) {
    const item = src.getItem(i); if (!item) continue;
    try { const before = item.amount ?? 1; const left = dst.addItem(item); const after = left?.amount ?? 0; moved += Math.max(0, before - after); src.setItem(i, left); } catch {}
  }
  return moved;
}
function adjacentOutputContainers(block) {
  const out = [];
  for (const o of OFFSETS) {
    const b = getBlock(block.dimension, { x: block.location.x + o.x, y: block.location.y + o.y, z: block.location.z + o.z });
    if (!b || b.typeId.startsWith("vfh:")) continue;
    try {
      const c = b.getComponent("minecraft:inventory")?.container;
      if (c?.isValid) out.push(c);
    } catch {}
  }
  return out;
}
function transferBreakerToAdjacent(block, marker) {
  const src = marker.getComponent("minecraft:inventory")?.container;
  if (!src?.isValid) return 0;
  const targets = adjacentOutputContainers(block);
  if (!targets.length) return 0;
  let moved = 0;
  for (let i = 0; i < src.size && moved < BR5_OUTPUT_MAX_ITEMS_PER_TICK; i++) {
    let item = src.getItem(i);
    if (!item) continue;
    for (const dst of targets) {
      if (!item || moved >= BR5_OUTPUT_MAX_ITEMS_PER_TICK) break;
      try {
        const remainingBudget = BR5_OUTPUT_MAX_ITEMS_PER_TICK - moved;
        const originalAmount = item.amount ?? 1;
        const sendAmount = Math.min(originalAmount, remainingBudget);
        const send = item.clone();
        send.amount = sendAmount;
        const left = dst.addItem(send);
        const leftAmount = left?.amount ?? 0;
        const accepted = Math.max(0, sendAmount - leftAmount);
        if (accepted <= 0) continue;
        moved += accepted;
        const remain = originalAmount - accepted;
        if (remain <= 0) { src.setItem(i, undefined); item = undefined; }
        else { const kept = item.clone(); kept.amount = remain; src.setItem(i, kept); item = kept; }
      } catch {}
    }
  }
  return moved;
}
function breakerFrameRangeKey(range) {
  return `${range.start.dimension.id}:${range.minX},${range.y},${range.minZ}:${range.maxX},${range.maxZ}`;
}
function breakerFramePerimeterAtY(range, y) {
  const out = [];
  const seen = new Set();
  const add = (x, z) => {
    const key = `${x},${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y, z });
  };
  for (let x = range.minX; x <= range.maxX; x += PARTICLE_STEP) {
    add(x, range.minZ);
    if (range.maxZ !== range.minZ) add(x, range.maxZ);
  }
  for (let z = range.minZ + PARTICLE_STEP; z < range.maxZ; z += PARTICLE_STEP) {
    add(range.minX, z);
    if (range.maxX !== range.minX) add(range.maxX, z);
  }
  return out;
}
function breakerFrameStructure(range) {
  const baseY = range.y + 1;
  const topY = baseY + BREAKER_FRAME_STRUCTURE_HEIGHT - 1;
  const out = breakerFramePerimeterAtY(range, baseY);
  const seen = new Set(out.map((p) => `${p.x},${p.y},${p.z}`));
  const add = (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y, z });
  };
  const corners = [
    [range.minX, range.minZ], [range.maxX, range.minZ],
    [range.maxX, range.maxZ], [range.minX, range.maxZ],
  ];
  // After the lower perimeter, erect only the four corner columns.
  for (let y = baseY + 1; y < topY; y++) {
    for (const [x, z] of corners) add(x, y, z);
  }
  // Finish construction with a complete upper perimeter on the fourth block level.
  for (const pos of breakerFramePerimeterAtY(range, topY)) add(pos.x, pos.y, pos.z);
  return out;
}
function tickBreakerFrameConstruction(block, marker, range) {
  if (!block || !marker || !range) return false;
  if (!isBreakerPowered(marker)) return false;
  const areaKey = breakerFrameRangeKey(range);
  let storedKey;
  try { storedKey = marker.getDynamicProperty(BREAKER_FRAME_RANGE_PROP); } catch {}
  if (storedKey !== areaKey) {
    try {
      marker.setDynamicProperty(BREAKER_FRAME_RANGE_PROP, areaKey);
      marker.setDynamicProperty(BREAKER_FRAME_INDEX_PROP, 0);
      marker.setDynamicProperty(BREAKER_FRAME_COMPLETE_PROP, 0);
    } catch {}
  }
  const structure = breakerFrameStructure(range);
  if (structure.length === 0) return false;
  let index = Number(marker.getDynamicProperty(BREAKER_FRAME_INDEX_PROP));
  if (!Number.isInteger(index) || index < 0) index = 0;
  if (index >= structure.length) {
    try { marker.setDynamicProperty(BREAKER_FRAME_COMPLETE_PROP, 1); } catch {}
    return true;
  }
  const pos = structure[index];
  const target = getBlock(block.dimension, pos);
  // If the block cannot be resolved (for example during a transient chunk reload), keep the cursor here and retry.
  if (!target) return false;
  let beforeType;
  try { beforeType = target.typeId; } catch { return false; }
  if (beforeType === BREAKER_FRAME_BLOCK) {
    try {
      marker.setDynamicProperty(BREAKER_FRAME_INDEX_PROP, index + 1);
      marker.setDynamicProperty(BREAKER_FRAME_COMPLETE_PROP, index + 1 >= structure.length ? 1 : 0);
    } catch {}
    return index + 1 >= structure.length;
  }
  // Non-destructive construction: solid terrain already secures this perimeter position.
  if (beforeType !== "minecraft:air") {
    try {
      marker.setDynamicProperty(BREAKER_FRAME_INDEX_PROP, index + 1);
      marker.setDynamicProperty(BREAKER_FRAME_COMPLETE_PROP, index + 1 >= structure.length ? 1 : 0);
    } catch {}
    return index + 1 >= structure.length;
  }
  // Place directly through Block.setType. Never advance until a fresh read confirms the Frame exists.
  try { target.setType(BREAKER_FRAME_BLOCK); } catch { return false; }
  const verify = getBlock(block.dimension, pos);
  let verified = false;
  try { verified = verify?.typeId === BREAKER_FRAME_BLOCK; } catch {}
  if (!verified) return false;
  const nextIndex = index + 1;
  try {
    marker.setDynamicProperty(BREAKER_FRAME_INDEX_PROP, nextIndex);
    marker.setDynamicProperty(BREAKER_FRAME_COMPLETE_PROP, nextIndex >= structure.length ? 1 : 0);
  } catch {}
  return nextIndex >= structure.length;
}
function breakerInitialFrameCleanupKey(range) {
  return breakerFrameRangeKey(range);
}
function isBreakerMiningFinishedY(y) {
  // Bedrock Overworld/Nether/The End minimum build Y is -64 in this pack's supported runtime.
  return Number.isInteger(y) && y < -64;
}
function tickBreakerInitialFrameCleanup(block, marker, range) {
  if (!block || !marker || !range) return false;
  const key = breakerInitialFrameCleanupKey(range);
  let storedKey;
  try { storedKey = marker.getDynamicProperty(BREAKER_FRAME_CLEANUP_KEY_PROP); } catch {}
  if (storedKey !== key) {
    try {
      marker.setDynamicProperty(BREAKER_FRAME_CLEANUP_KEY_PROP, key);
      marker.setDynamicProperty(BREAKER_FRAME_CLEANUP_INDEX_PROP, 0);
      marker.setDynamicProperty(BREAKER_FRAME_CLEANUP_COMPLETE_PROP, 0);
    } catch {}
  }
  const structure = breakerFrameStructure(range);
  if (structure.length === 0) return false;
  let cleanupIndex = Number(marker.getDynamicProperty(BREAKER_FRAME_CLEANUP_INDEX_PROP));
  if (!Number.isInteger(cleanupIndex) || cleanupIndex < 0) cleanupIndex = 0;
  if (cleanupIndex >= structure.length) {
    try { marker.setDynamicProperty(BREAKER_FRAME_CLEANUP_COMPLETE_PROP, 1); } catch {}
    return true;
  }
  // Reverse construction order: upper perimeter -> corner columns -> lower perimeter.
  const pos = structure[structure.length - 1 - cleanupIndex];
  const target = getBlock(block.dimension, pos);
  if (!target) return false; // transient unload: retry exactly this position.
  let typeId;
  try { typeId = target.typeId; } catch { return false; }
  if (typeId === BREAKER_FRAME_BLOCK) {
    try { target.setType("minecraft:air"); } catch { return false; }
    const verify = getBlock(block.dimension, pos);
    try { if (verify?.typeId === BREAKER_FRAME_BLOCK) return false; } catch { return false; }
  }
  const nextIndex = cleanupIndex + 1;
  try {
    marker.setDynamicProperty(BREAKER_FRAME_CLEANUP_INDEX_PROP, nextIndex);
    marker.setDynamicProperty(BREAKER_FRAME_CLEANUP_COMPLETE_PROP, nextIndex >= structure.length ? 1 : 0);
  } catch {}
  return nextIndex >= structure.length;
}
function emitRangeParticles(range) {
  const y = range.y + 1.05;
  try {
    for (let x = range.minX; x <= range.maxX; x += PARTICLE_STEP) {
      range.start.dimension.spawnParticle(RANGE_PARTICLE, { x: x + 0.5, y, z: range.minZ + 0.5 });
      if (range.maxZ !== range.minZ) range.start.dimension.spawnParticle(RANGE_PARTICLE, { x: x + 0.5, y, z: range.maxZ + 0.5 });
    }
    for (let z = range.minZ + PARTICLE_STEP; z < range.maxZ; z += PARTICLE_STEP) {
      range.start.dimension.spawnParticle(RANGE_PARTICLE, { x: range.minX + 0.5, y, z: z + 0.5 });
      if (range.maxX !== range.minX) range.start.dimension.spawnParticle(RANGE_PARTICLE, { x: range.maxX + 0.5, y, z: z + 0.5 });
    }
  } catch {}
}
function isBreakerWaterOrLava(block) {
  if (!block) return false;
  try {
    if (!block.isLiquid) return false;
    return block.typeId === "minecraft:water" || block.typeId === "minecraft:flowing_water" ||
      block.typeId === "minecraft:lava" || block.typeId === "minecraft:flowing_lava";
  } catch { return false; }
}
// BR-F14: aquatic plant blocks can occupy water cells without satisfying the plain
// water/lava predicate. Remove them without drops before the layer drain is evaluated.
const BREAKER_AQUATIC_PLANT_IDS = new Set([
  "minecraft:seagrass",
  "minecraft:tall_seagrass",
  "minecraft:kelp",
  "minecraft:kelp_plant"
]);
function isBreakerAquaticPlant(block) {
  if (!block) return false;
  try {
    const id = String(block.typeId || "");
    if (BREAKER_AQUATIC_PLANT_IDS.has(id)) return true;
    // BR-F16: guard name variants without classifying unrelated terrain.
    return id.startsWith("minecraft:") && (id.includes("kelp") || id.includes("seagrass"));
  } catch { return false; }
}
function isBreakerBubbleColumn(block) {
  if (!block) return false;
  try { return block.typeId === "minecraft:bubble_column"; } catch { return false; }
}
function isBreakerDrainTarget(block) {
  // BR-F18: bubble columns are water-current blocks generated above magma blocks
  // or soul sand. Treat the column itself as drainable while leaving its base terrain alone.
  return isBreakerWaterOrLava(block) || isBreakerAquaticPlant(block) || isBreakerBubbleColumn(block);
}
function breakerLiquidBarrierTargets(range, y) {
  const out = [];
  const seen = new Set();
  const add = (insideX, insideZ, outsideX, outsideZ) => {
    const key = `${outsideX},${outsideZ}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ inside: { x: insideX, y, z: insideZ }, outside: { x: outsideX, y, z: outsideZ } });
  };

  // Cardinal one-block outer perimeter.
  for (let x = range.minX; x <= range.maxX; x++) {
    add(x, range.minZ, x, range.minZ - 1);
    if (range.maxZ !== range.minZ) add(x, range.maxZ, x, range.maxZ + 1);
  }
  for (let z = range.minZ; z <= range.maxZ; z++) {
    add(range.minX, z, range.minX - 1, z);
    if (range.maxX !== range.minX) add(range.maxX, z, range.maxX + 1, z);
  }

  // BR-F15: reinforce every corner as a 3-cell guard: the X-side cell, the
  // Z-side cell, and the diagonal cell. The side cells intentionally duplicate
  // the cardinal perimeter and are deduplicated by add(), making the corner
  // definition explicit and preventing future edge-loop changes from reopening it.
  const corners = [
    { x: range.minX, z: range.minZ, sx: -1, sz: -1 },
    { x: range.maxX, z: range.minZ, sx:  1, sz: -1 },
    { x: range.minX, z: range.maxZ, sx: -1, sz:  1 },
    { x: range.maxX, z: range.maxZ, sx:  1, sz:  1 }
  ];
  for (const corner of corners) {
    add(corner.x, corner.z, corner.x + corner.sx, corner.z);
    add(corner.x, corner.z, corner.x, corner.z + corner.sz);
    add(corner.x, corner.z, corner.x + corner.sx, corner.z + corner.sz);
  }
  return out;
}
function breakerLiquidMonitorKey(marker) { return marker.id; }
function breakerLiquidFrameSet(marker) {
  const key = breakerLiquidMonitorKey(marker);
  let set = BREAKER_LIQUID_FRAME_POSITIONS.get(key);
  if (!set) { set = new Set(); BREAKER_LIQUID_FRAME_POSITIONS.set(key, set); }
  return set;
}
function breakerLiquidPositionKey(location) { return `${location.x},${location.y},${location.z}`; }
function stopBreakerLiquidMonitor(marker) {
  if (!marker) return;
  const key = breakerLiquidMonitorKey(marker);
  const jobId = BREAKER_LIQUID_MONITORS.get(key);
  if (jobId === undefined) return;
  try { system.clearJob(jobId); } catch {}
  BREAKER_LIQUID_MONITORS.delete(key);
  BREAKER_LIQUID_FRAME_POSITIONS.delete(key);
  const drainJob = BREAKER_LAYER_DRAIN_JOBS.get(key);
  if (drainJob !== undefined) { try { system.clearJob(drainJob); } catch {} }
  BREAKER_LAYER_DRAIN_JOBS.delete(key);
  BREAKER_AQUATIC_STALLS.delete(key);
  BREAKER_STALE_FRAME_CLEAN_Y.delete(key);
}
// BR-F17: remove stale Breaker Frames left inside the mining range by an earlier
// drain/pass. Outer perimeter and BR-F15 corner guards are outside min/max and are
// therefore never touched. Direct setType(air) keeps cleanup out of item collection.
function* cleanupBreakerStaleFramesInLayer(range, y) {
  let removed = 0;
  for (let z = range.minZ; z <= range.maxZ; z++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      const block = getBlock(range.start.dimension, { x, y, z });
      if (block?.typeId === BREAKER_FRAME_BLOCK) {
        try { block.setType("minecraft:air"); removed++; } catch {}
      }
      yield;
    }
  }
  return removed;
}
// BR-F12: drain one mining layer atomically from the water simulation's point of view.
// Phase 1 replaces only liquid cells with temporary Breaker Frames. Phase 2 removes
// only frames recorded by this pass via setType(air), so they never enter drop/vacuum/network paths.
function* drainBreakerLiquidLayerWithFrames(range, y) {
  const temporaryFrames = [];
  for (let z = range.minZ; z <= range.maxZ; z++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      const inside = getBlock(range.start.dimension, { x, y, z });
      if (inside && (isBreakerDrainTarget(inside))) {
        try {
          // BR-F14: direct replacement means seagrass/kelp never enter the normal
          // destroy -> item drop -> vacuum -> network collection path.
          inside.setType(BREAKER_FRAME_BLOCK);
          const verify = getBlock(range.start.dimension, { x, y, z });
          if (verify?.typeId === BREAKER_FRAME_BLOCK) temporaryFrames.push({ x, y, z });
        } catch {}
      }
      yield;
    }
  }
  // Do not use destroy/breakBlock here. Temporary drain frames must never be collected.
  for (const location of temporaryFrames) {
    const frame = getBlock(range.start.dimension, location);
    if (frame?.typeId === BREAKER_FRAME_BLOCK) {
      try { frame.setType("minecraft:air"); } catch {}
    }
    yield;
  }
  return temporaryFrames.length;
}
function breakerLayerHasDrainTarget(range, y) {
  for (let z = range.minZ; z <= range.maxZ; z++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      if (isBreakerDrainTarget(getBlock(range.start.dimension, { x, y, z }))) return true;
    }
  }
  return false;
}
function ensureBreakerLayerDrain(marker, range, y) {
  if (!marker?.isValid || !range || !Number.isInteger(y)) return false;
  const ownerKey = breakerLiquidMonitorKey(marker);
  if (BREAKER_LAYER_DRAIN_JOBS.has(ownerKey)) return true;
  let jobId;
  const job = (function* () {
    try {
      // BR-F17: clear leftovers first, then perform the current layer drain.
      // This cleanup cannot touch perimeter/corner protection because iteration is
      // strictly constrained to the mining range.
      yield* cleanupBreakerStaleFramesInLayer(range, y);
      BREAKER_STALE_FRAME_CLEAN_Y.set(ownerKey, y);
      // BR-F16: repeat full-layer sealing until no liquid/aquatic target remains.
      // Each pass still uses frame -> direct air, so no drops enter collection.
      for (let retry = 0; retry < BREAKER_AQUATIC_STALL_LIMIT; retry++) {
        yield* drainBreakerLiquidLayerWithFrames(range, y);
        if (!breakerLayerHasDrainTarget(range, y)) return;
        yield;
      }
      // Stall guard: a stubborn cursor cell gets one final direct frame seal on
      // a later tick. Natural terrain is never selected by isBreakerDrainTarget().
      const head = findOwnedHead(marker);
      const x = Number(head?.getDynamicProperty(CURSOR_X));
      const z = Number(head?.getDynamicProperty(CURSOR_Z));
      if (Number.isInteger(x) && Number.isInteger(z)) {
        const location = { x, y, z };
        const target = getBlock(range.start.dimension, location);
        if (isBreakerDrainTarget(target)) {
          try { target.setType(BREAKER_FRAME_BLOCK); } catch {}
          yield;
          const frame = getBlock(range.start.dimension, location);
          if (frame?.typeId === BREAKER_FRAME_BLOCK) { try { frame.setType("minecraft:air"); } catch {} }
        }
      }
    } finally {
      BREAKER_LAYER_DRAIN_JOBS.delete(ownerKey);
    }
  })();
  try { jobId = system.runJob(job); } catch { return false; }
  BREAKER_LAYER_DRAIN_JOBS.set(ownerKey, jobId);
  return true;
}
function* breakerLiquidMonitor(marker) {
  while (marker?.isValid) {
    let block;
    try {
      const p = marker.location;
      block = getBlock(marker.dimension, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
    } catch {}
    if (!block || block.typeId !== BREAKER_NODE_BLOCK) { yield; continue; }
    if (!isBreakerPowered(marker)) { yield; continue; }
    const range = getRange(block);
    const head = findOwnedHead(marker);
    let y;
    try { y = Number(head?.getDynamicProperty(CURSOR_Y)); } catch {}
    if (!range || !Number.isInteger(y)) { yield; continue; }
    let boundaryLiquidFound = false;
    const protectedPositions = breakerLiquidFrameSet(marker);
    for (const pair of breakerLiquidBarrierTargets(range, y)) {
      if (!marker.isValid) return;
      const outside = getBlock(block.dimension, pair.outside);
      if (!outside) { yield; continue; }
      const positionKey = breakerLiquidPositionKey(pair.outside);
      if (isBreakerDrainTarget(outside)) {
        boundaryLiquidFound = true;
        // BR-F11: only the liquid cell itself is converted. Never overwrite terrain.
        try {
          outside.setType(BREAKER_FRAME_BLOCK);
          const verify = getBlock(block.dimension, pair.outside);
          if (verify?.typeId === BREAKER_FRAME_BLOCK) protectedPositions.add(positionKey);
        } catch {}
      } else if (protectedPositions.has(positionKey) && outside.typeId === "minecraft:air") {
        // Self-heal only a location that this Breaker previously converted to a frame,
        // and only while the location is empty. Natural blocks are never overwritten.
        try { outside.setType(BREAKER_FRAME_BLOCK); } catch {}
      }
      // Fine-grained yield: monitoring never becomes a prerequisite for mining.
      yield;
    }
    // BR-F12: seal already-internal liquid as a complete layer pass before removing it.
    if (boundaryLiquidFound) {
      ensureBreakerLayerDrain(marker, range, y);
    }
    // Start another pass continuously; new flowing liquid is detected later.
    yield;
  }
}
function ensureBreakerLiquidMonitor(marker) {
  if (!marker?.isValid) return;
  const key = breakerLiquidMonitorKey(marker);
  if (BREAKER_LIQUID_MONITORS.has(key)) return;
  let jobId;
  try { jobId = system.runJob(breakerLiquidMonitor(marker)); } catch { return; }
  BREAKER_LIQUID_MONITORS.set(key, jobId);
}
function advanceSerpentine(head, range, x, z, dir) {
  const rowEnd = dir > 0 ? range.maxX : range.minX;
  if (x !== rowEnd) {
    head.setDynamicProperty(CURSOR_X, x + dir);
    return true;
  }
  const zStep = range.end.location.z >= range.start.location.z ? 1 : -1;
  if (z === range.end.location.z) return false;
  head.setDynamicProperty(CURSOR_Z, z + zStep);
  head.setDynamicProperty(DIR_X, -dir);
  return true;
}
function isProtected(typeId) { return typeId.startsWith("vfh:"); }
function isUnbreakable(typeId) { return typeId === "minecraft:bedrock"; }
function tickBreaker(block) {
  const marker = ensureBreakerMarker(block); if (!marker) return;
  if (!isBreakerPowered(marker)) return; // BR-11: mine only while redstone power is present. Output buffer still drains.
  const range = getRange(block);
  const oldHead = findOwnedHead(marker);
  if (!range) { if (oldHead) { vacuumIntoHead(oldHead); cleanupXpOrbsAroundHead(oldHead); transferHeadToBreaker(oldHead, marker); } return; }
  const head = ensureHead(marker, range); if (!head) return;
  const collected = vacuumIntoHead(head);
  const removedXpOrbs = cleanupXpOrbsAroundHead(head);
  const moved = transferHeadToBreaker(head, marker);
  let x = Number(head.getDynamicProperty(CURSOR_X));
  let z = Number(head.getDynamicProperty(CURSOR_Z));
  let y = Number(head.getDynamicProperty(CURSOR_Y));
  let dir = Number(head.getDynamicProperty(DIR_X));
  const resetCursor = (ny) => {
    x = range.start.location.x; z = range.start.location.z; y = ny;
    dir = range.end.location.x >= x ? 1 : -1;
    head.setDynamicProperty(CURSOR_X, x); head.setDynamicProperty(CURSOR_Z, z);
    head.setDynamicProperty(CURSOR_Y, y); head.setDynamicProperty(DIR_X, dir);
  };
  if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(y) || (dir !== 1 && dir !== -1)) resetCursor(range.y);

  // BR-F7: mining is speed-first. Liquid protection runs concurrently and does
  // not block this tick while waiting for a boundary scan to complete.
  ensureBreakerLiquidMonitor(marker);
  // BR-F9: y below the build floor is the persistent mining-complete state.
  // Surface scaffold cleanup is handled separately at the visual/construction interval.
  if (isBreakerMiningFinishedY(y)) return;

  // BR-F17: on first processing of each Y layer, remove stale internal frames.
  // Use the existing single-flight drain job so cleanup cannot race BR-F16 drainage.
  const ownerKey = breakerLiquidMonitorKey(marker);
  if (BREAKER_STALE_FRAME_CLEAN_Y.get(ownerKey) !== y) {
    ensureBreakerLayerDrain(marker, range, y);
    return;
  }

  // Skip empty/protected/unbreakable cells quickly. This makes high-altitude descent independent of the mining delay.
  const FAST_SCAN_CELLS = 64;
  for (let scan = 0; scan < FAST_SCAN_CELLS; scan++) {
    if (x < range.minX || x > range.maxX || z < range.minZ || z > range.maxZ) return;
    const targetChunkX = Math.floor(x / 16), targetChunkZ = Math.floor(z / 16);
    const loadedChunkX = Number(marker.getDynamicProperty(BREAKER_HEAD_CHUNK_X_PROP));
    const loadedChunkZ = Number(marker.getDynamicProperty(BREAKER_HEAD_CHUNK_Z_PROP));
    const chunkReady = Number(marker.getDynamicProperty(BREAKER_CHUNK_READY_PROP)) > 0;
    if (!chunkReady || loadedChunkX !== targetChunkX || loadedChunkZ !== targetChunkZ) {
      requestBreakerTickingArea(block, marker, { x, y, z });
      return;
    }
    const target = getBlock(block.dimension, { x, y, z }); if (!target) return;
    try { head.teleport({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }); } catch { return; }
    // BR-F12: if mining enters a pre-existing liquid layer, temporarily replace every
    // liquid cell on this Y layer with Breaker Frames before any are removed. This
    // prevents water-source regeneration between individual cell removals.
    if (isBreakerDrainTarget(target)) {
      // BR-F16: do not spawn a new drain job every mining tick. Track repeated
      // visits for diagnostics/guarding and keep one retrying drain job in flight.
      const ownerKey = breakerLiquidMonitorKey(marker);
      const stallKey = `${x},${y},${z}`;
      const prior = BREAKER_AQUATIC_STALLS.get(ownerKey);
      BREAKER_AQUATIC_STALLS.set(ownerKey, { key: stallKey, count: prior?.key === stallKey ? prior.count + 1 : 1 });
      ensureBreakerLayerDrain(marker, range, y);
      return;
    }
    BREAKER_AQUATIC_STALLS.delete(breakerLiquidMonitorKey(marker));
    const skip = target.typeId === "minecraft:air" || isProtected(target.typeId) || isUnbreakable(target.typeId);
    if (!skip) {
      // BR-12: cumulative speed credit avoids integer-tick quantization.
      // Example: 5.0x earns 5 credits/tick, so 7 blocks cost 49 credits and complete
      // over 10 ticks (4.9x effective over that window, converging to exact 5.0x).
      if (!consumeBreakCredit(head, marker)) return;
      try {
        block.dimension.runCommand(`fill ${x} ${y} ${z} ${x} ${y} ${z} air destroy`);
        if (!advanceSerpentine(head, range, x, z, dir)) resetCursor(y - 1);
        system.run(() => {
          const c = vacuumIntoHead(head); const xp = cleanupXpOrbsAroundHead(head); const m = transferHeadToBreaker(head, marker);
        });
      } catch {}
      return;
    }
    if (!advanceSerpentine(head, range, x, z, dir)) {
      resetCursor(y - 1);
    } else {
      x = Number(head.getDynamicProperty(CURSOR_X));
      z = Number(head.getDynamicProperty(CURSOR_Z));
      dir = Number(head.getDynamicProperty(DIR_X));
    }
  }
}

system.runInterval(() => {
  for (const id of DIMENSION_IDS) {
    let d; try { d = world.getDimension(id); } catch { continue; }
    for (const head of d.getEntities({ type: BREAKER_HEAD_ENTITY })) {
      try {
        const p = head.location;
        d.spawnParticle(BREAKER_HEAD_PARTICLE, { x: p.x, y: p.y + 0.35, z: p.z });
      } catch {}
    }
  }
}, 4);

system.runInterval(() => {
  for (const id of DIMENSION_IDS) {
    let d; try { d = world.getDimension(id); } catch { continue; }
    for (const marker of d.getEntities({ type: BREAKER_NODE_ENTITY })) {
      try {
        const p = marker.location;
        const block = getBlock(d, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
        if (block?.typeId === BREAKER_NODE_BLOCK) {
          tickBreaker(block);
          const outputMoved = transferBreakerToAdjacent(block, marker);
        }
        else {
          // Do not delete a persistent marker merely because the owner block is
          // transiently unavailable during chunk reload. playerBreakBlock owns
          // intentional break cleanup.
          continue;
        }
      } catch {}
    }
  }
}, 1);

system.runInterval(() => {
  for (const id of DIMENSION_IDS) {
    let d; try { d = world.getDimension(id); } catch { continue; }
    for (const marker of d.getEntities({ type: BREAKER_NODE_ENTITY })) {
      try {
        const p = marker.location;
        const block = getBlock(d, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
        if (block?.typeId !== BREAKER_NODE_BLOCK) continue;
        const range = getRange(block);
        if (range) {
          const head = findOwnedHead(marker);
          let cursorY;
          try { cursorY = Number(head?.getDynamicProperty(CURSOR_Y)); } catch {}
          if (isBreakerMiningFinishedY(cursorY)) tickBreakerInitialFrameCleanup(block, marker, range);
          else tickBreakerFrameConstruction(block, marker, range);
        }
        for (let up = 1; up <= BREAKER_BEAM_HEIGHT; up++) {
          try {
            block.dimension.spawnParticle(BREAKER_BEAM, {
              x: block.location.x + 0.5,
              y: block.location.y + up + 0.5,
              z: block.location.z + 0.5,
            });
          } catch { break; }
        }
      } catch {}
    }
  }
}, BREAKER_FRAME_BUILD_INTERVAL_TICKS);

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  if (ev.block.typeId !== BREAKER_NODE_BLOCK) return;
  system.run(() => {
    const marker = initializeBreakerMarker(ensureBreakerMarker(ev.block));
    const range = getRange(ev.block);
    if (marker && range) { ensureHead(marker, range); ensureBreakerLiquidMonitor(marker); requestBreakerTickingArea(ev.block, marker, range.start.location); }
  });
});
world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const marker = findMarkerAtBlock(ev.block, BREAKER_NODE_ENTITY); if (!marker) return;
  removeBreakerTickingArea(ev.block);
  stopBreakerLiquidMonitor(marker);
  const head = findOwnedHead(marker); if (head) head.remove(); marker.remove();
});

// BR-1 range cache invalidation: marker changes are rare, so expensive range discovery never runs every tick.
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  if (ev.block.typeId !== BREAKER_START_BLOCK && ev.block.typeId !== BREAKER_END_BLOCK) return;
  RANGE_CACHE.clear();
  system.run(() => {
    for (const marker of ev.block.dimension.getEntities({ type: BREAKER_NODE_ENTITY })) {
      try {
        const p = marker.location;
        const node = getBlock(ev.block.dimension, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
        if (node?.typeId === BREAKER_NODE_BLOCK) {
          const range = getRange(node);
          if (range) {
            const head = ensureHead(marker, range);
            const x = Number(head?.getDynamicProperty(CURSOR_X));
            const y = Number(head?.getDynamicProperty(CURSOR_Y));
            const z = Number(head?.getDynamicProperty(CURSOR_Z));
            requestBreakerTickingArea(node, marker, {
              x: Number.isFinite(x) ? x : range.start.location.x,
              y: Number.isFinite(y) ? y : range.y,
              z: Number.isFinite(z) ? z : range.start.location.z,
            });
          }
        }
      } catch {}
    }
  });
});
world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const broken = ev.brokenBlockPermutation?.type?.id;
  if (broken === BREAKER_START_BLOCK || broken === BREAKER_END_BLOCK || broken === BREAKER_NODE_BLOCK) RANGE_CACHE.clear();
});
