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
const MAX_BREAK_SPEED_MULTIPLIER = 8.0; // BR-13: High-Speed Mining Extension
const DEFAULT_BREAK_INTERVAL_TICKS = BASE_BREAK_INTERVAL_TICKS;
const MIN_BREAK_INTERVAL_TICKS = Math.max(1, Math.round(BASE_BREAK_INTERVAL_TICKS / MAX_BREAK_SPEED_MULTIPLIER));
const MAX_BREAK_INTERVAL_TICKS = Math.round(BASE_BREAK_INTERVAL_TICKS / MIN_BREAK_SPEED_MULTIPLIER);
const BREAKER_REDSTONE_COMPONENT = "vfh:breaker_redstone_sync";
const BREAK_INTERVAL_PROP = "breaker_interval_ticks"; // Legacy property, migrated on first access.
const BREAK_SPEED_PROP = "breaker_speed_multiplier";
const REDSTONE_POWER_PROP = "breaker_redstone_power";
const VACUUM_RADIUS = 1.75;
const RANGE_FIND_RADIUS = 256;
const PARTICLE_INTERVAL_TICKS = 20;
const PARTICLE_STEP = 1;
const RANGE_PARTICLE = "minecraft:basic_flame_particle";
// BR-F2: replace the temporary particle outline with a physical frame erected one block at a time.
const BREAKER_FRAME_BLOCK = "vfh:breaker_frame";
const BREAKER_RANGE_AREA_SUFFIX = "_range";
const BREAKER_FRAME_BUILD_INTERVAL_TICKS = 1;
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
const BREAKER_LIQUID_GUARD_PROP = "breaker_liquid_guard";
// BR-F7: liquid boundary protection runs independently from the mining loop.
// A runJob generator yields after every boundary cell so the job scheduler can
// spread monitoring work across ticks without gating mining progress.
const BREAKER_LIQUID_MONITORS = new Map();
// BR-F16: one drain job per Breaker marker, plus per-cursor stall tracking.
const BREAKER_LAYER_DRAIN_JOBS = new Map();
// BR-F28: completed drain barriers stay alive for the whole mining-layer lifecycle.
const BREAKER_LAYER_BARRIERS = new Map();
/* Guard Loader v3 */
const BREAKER_GUARD_FRAME_POSITIONS = new Map();
// BR-F30: in-memory one-shot startup surface seek per Breaker marker.
const BREAKER_FAST_START_DONE = new Set();
// BR-F41: startup surface seek is a yielded runJob. Never scan the full X/Z/Y
// mining volume synchronously from tickBreaker or ensureHead.
const BREAKER_FAST_START_JOBS = new Map();
const BREAKER_FAST_START_RESULTS = new Map();
const BREAKER_AQUATIC_STALLS = new Map();
const BREAKER_AQUATIC_STALL_LIMIT = 3;
// BR-F49: final 3x3 mining failsafe. Only activates after repeated stalls at
// the same Head cursor; protected VFH blocks and bedrock are never cleared.
const BREAKER_FAILSAFE_STALL_LIMIT = 12;
// BR-F50: completed Breakers enter an in-memory sleep state after one-time teardown.
const BREAKER_FINISHED_SLEEP = new Set();
// BR-F51: startup feedback state. Notifications are emitted only on state changes.
const BREAKER_STARTUP_RANGE_STATE = new Map();
const BREAKER_STARTUP_READY_NOTIFIED = new Set();
const BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED = new Set();
// BR-F55: Beam-positive gate. A Breaker may execute only after its maintenance
// pass has successfully spawned the breaker beam while a valid range exists.
// Absence of a positive beam result is fail-closed.
const BREAKER_BEAM_READY = new Set();
// BR-F17: remember the last mining layer whose stale internal frames were cleaned.
const BREAKER_STALE_FRAME_CLEAN_Y = new Map();
// BR-F19: background internal-frame sweeper. The cursor is intentionally in-memory:
// it can restart safely after reload because every pass is idempotent.
const BREAKER_BACKGROUND_FRAME_SWEEP = new Map();
const BREAKER_BACKGROUND_FRAME_SWEEP_CELLS_PER_TICK = 48;
const HEAD_OWNER = "breaker_owner";
const PAIR_START_X = "breaker_pair_start_x";
const PAIR_START_Y = "breaker_pair_start_y";
const PAIR_START_Z = "breaker_pair_start_z";
const BREAKER_RANGE_PENDING_PROP = "breaker_range_pending";
const PAIR_END_X = "breaker_pair_end_x";
const PAIR_END_Y = "breaker_pair_end_y";
const PAIR_END_Z = "breaker_pair_end_z";
const RANGE_FIRST_MINING_Y = "breaker_first_mining_y";
const RANGE_MIN_X = "breaker_range_min_x";
const RANGE_MAX_X = "breaker_range_max_x";
const RANGE_MIN_Z = "breaker_range_min_z";
const RANGE_MAX_Z = "breaker_range_max_z";
const RANGE_Y     = "breaker_range_y";

// BR-F43: hot-path Head lookup cache. Dimension-wide entity scan is fallback only.
const BREAKER_HEAD_CACHE = new Map();
// BR-F21: one asynchronous startup orphan-head cleanup per Breaker marker.
const BREAKER_STARTUP_HEAD_CLEANUP_JOBS = new Map();
const BR5_OUTPUT_MAX_ITEMS_PER_TICK = 64;
const CURSOR_X = "breaker_cursor_x";
const CURSOR_Z = "breaker_cursor_z";
const CURSOR_Y = "breaker_cursor_y";
const DIR_X = "breaker_dir_x";
const DIR_Z = "breaker_dir_z"; // BR-F20: persistent layer traversal direction.
const NEXT_BREAK = "breaker_next_break"; // Legacy scheduler property, cleared by cumulative-speed mode.
const BREAK_PROGRESS = "breaker_speed_progress";
const RANGE_INIT_PENDING = new Set();
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
const START_MARKER_GUIDE_BEAM = "vfh:start_marker_beam";
const END_MARKER_GUIDE_BEAM = "vfh:end_marker_beam";
const MARKER_GUIDE_LENGTH = 16;
const OFFSETS = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
];

function breakerRangeAreaName(block) {
    return `${breakerAreaName(block)}_range`;
}
function* cleanupAllBreakerFrames(range) {

    if (!range) {
        return;
    }

    for (
        let y = Math.floor(range.y);
        y >= -64;
        y--
    ) {
        for (
            let z = range.minZ;
            z <= range.maxZ;
            z++
        ) {
            for (
                let x = range.minX;
                x <= range.maxX;
                x++
            ) {
                const block =
                    getBlock(
                        range.start.dimension,
                        { x, y, z }
                    );

                if (
                    block?.typeId ===
                    BREAKER_FRAME_BLOCK
                ) {
                    try {
                        block.setType(
                            "minecraft:air"
                        );
                    } catch {}
                }

                yield;
            }
        }
    }
}
async function ensureBreakerRangeArea(
    block,
    marker,
    range
) {
    if (!range) return false;

    try {
        const manager =
            world.tickingAreaManager;

        const areaName =
            breakerRangeAreaName(block);
        if (
            manager.hasTickingArea(areaName)
        ) {
            return true;
        }
        const options = {
            dimension: block.dimension,
            from: {
                x: range.minX,
                y: range.y,
                z: range.minZ
            },

            to: {
                x: range.maxX,
                y: range.y,
                z: range.maxZ
            }
        };
        if (!manager.hasCapacity(options))
            return false;

        await manager.createTickingArea(
            areaName,
            options
        );
        return true;
    } catch {
        return false;
    }
}

function ensureBreakerMarker(block) {
  const markers =
        block.dimension.getEntities({
            type: BREAKER_NODE_ENTITY
        });
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
function isBreakerBeamReady(marker) {
  if (!marker?.isValid) return false;
  return BREAKER_BEAM_READY.has(breakerLiquidMonitorKey(marker));
}
function isBreakerPowered(marker) {
  return Number(marker?.getDynamicProperty(REDSTONE_POWER_PROP)) > 0 && isBreakerBeamReady(marker);
}
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
      const manager = world.tickingAreaManager;
      const range = getRange(block);
      const areaNames = {
        node: breakerNodeAreaName(block),
        start: breakerStartAreaName(block),
        end: breakerEndAreaName(block),
        head: breakerHeadAreaName(block),
      };
      const areaState = (name) => {
        try { return manager.hasTickingArea(name) ? "OK" : "MISSING"; } catch { return "ERROR"; }
      };
      let areaCount = 0;
      try { areaCount = manager.getAllTickingAreas().length; } catch {}
      const chunkCount = Number(manager.chunkCount);
      const maxChunkCount = Number(manager.maxChunkCount);
      const ready = Number(marker.getDynamicProperty(BREAKER_CHUNK_READY_PROP)) > 0;
      const pending = Number(marker.getDynamicProperty(BREAKER_CHUNK_PENDING_PROP)) > 0;
      const rangeText = range
        ? `${range.maxX - range.minX + 1} x ${range.maxZ - range.minZ + 1}`
        : "NOT FOUND / 未検出";
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
      {
        x: start.location.x - RANGE_FIND_RADIUS,
        y: start.location.y,
        z: start.location.z - RANGE_FIND_RADIUS
      },
      {
        x: start.location.x + RANGE_FIND_RADIUS,
        y: start.location.y,
        z: start.location.z + RANGE_FIND_RADIUS
      }
    );

    let foundCount = 0;

    for (
      const p of start.dimension
        .getBlocks(
          volume,
          { includeTypes: [BREAKER_END_BLOCK] },
          true
        )
        .getBlockLocationIterator()
    ) {
      foundCount++;
      if (p.y !== start.location.y) continue;

      const dx = p.x - start.location.x;
      const dz = p.z - start.location.z;

      if (dx === 0 || dz === 0) continue;

      const d = dx * dx + dz * dz;

      if (d < bestD) {
        bestD = d;
        best = getBlock(start.dimension, p);
      }
    }
  } catch (e) {}

  return best;
}
function saveBreakerPair(marker, start, end) {
  if (!marker || !start || !end) return;

  try {
    marker.setDynamicProperty(PAIR_START_X, start.location.x);
    marker.setDynamicProperty(PAIR_START_Y, start.location.y);
    marker.setDynamicProperty(PAIR_START_Z, start.location.z);

    marker.setDynamicProperty(PAIR_END_X, end.location.x);
    marker.setDynamicProperty(PAIR_END_Y, end.location.y);
    marker.setDynamicProperty(PAIR_END_Z, end.location.z);
    marker.setDynamicProperty(RANGE_MIN_X, Math.min(start.location.x, end.location.x));
    marker.setDynamicProperty(RANGE_MAX_X, Math.max(start.location.x,end.location.x));
    marker.setDynamicProperty(RANGE_MIN_Z, Math.min(start.location.z, end.location.z));
    marker.setDynamicProperty(RANGE_MAX_Z, Math.max(start.location.z, end.location.z));
    marker.setDynamicProperty(RANGE_Y, start.location.y);
  } catch {}
}

function getPairedStart(marker, dimension) {
  try {
    const x = Number(marker.getDynamicProperty(PAIR_START_X));
    const y = Number(marker.getDynamicProperty(PAIR_START_Y));
    const z = Number(marker.getDynamicProperty(PAIR_START_Z));

    if (!Number.isInteger(x) ||
        !Number.isInteger(y) ||
        !Number.isInteger(z)) {
      return undefined;
    }

    const block = getBlock(dimension, { x, y, z });

    if (block?.typeId !== BREAKER_START_BLOCK) {
      return undefined;
    }
    return block;
  } catch {
    return undefined;
  }
}

function getPairedEnd(marker, dimension) {
    try {

        const x = Number(marker.getDynamicProperty(PAIR_END_X));
        const y = Number(marker.getDynamicProperty(PAIR_END_Y));
        const z = Number(marker.getDynamicProperty(PAIR_END_Z));

        if (
            !Number.isInteger(x) ||
            !Number.isInteger(y) ||
            !Number.isInteger(z)
        ) {
            return undefined;
        }

        const block =
            getBlock(dimension, { x, y, z });

        //
        // Endチャンク未ロード
        //
        if (!block) {
            return {
                   pending: true,
                   location: {
                        x,
                        y,
                        z
                    }
            };
        }

        if (
            block.typeId !== BREAKER_END_BLOCK
        ) {
            return undefined;
        }

        return block;

    } catch {
        return undefined;
    }
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
    for (const name of [breakerAreaName(block),
                        breakerNodeAreaName(block),
                        breakerStartAreaName(block),
                        breakerEndAreaName(block),
                        breakerHeadAreaName(block),
                        breakerRangeAreaName(block)]) {
      if (manager.hasTickingArea(name)) manager.removeTickingArea(name);
    }
  } catch {}
}
function parseBreakerAreaOwner(identifier) {
  const text = String(identifier ?? "");
  if (!text.startsWith(`${BREAKER_TICKING_PREFIX}_`)) return undefined;
  const suffixes = ["_node", "_start", "_end", "_head"];
  let base = text;
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) { base = base.slice(0, -suffix.length); break; }
  }
  const body = base.slice(BREAKER_TICKING_PREFIX.length + 1);
  const match = /^(minecraft_[a-z0-9_]+)_(m|p)(\d+)_(m|p)(\d+)_(m|p)(\d+)$/.exec(body);
  if (!match) return undefined;
  const dimensionId = match[1].replace(/^minecraft_/, "minecraft:");
  const signed = (sign, value) => (sign === "m" ? -1 : 1) * Number(value);
  return { dimensionId, x: signed(match[2], match[3]), y: signed(match[4], match[5]), z: signed(match[6], match[7]) };
}
function cleanupOrphanBreakerTickingAreas() {
  try {
    const manager = world.tickingAreaManager;
    for (const area of manager.getAllTickingAreas()) {
      const owner = parseBreakerAreaOwner(area.identifier);
      if (!owner) continue;
      let dimension;
      try { dimension = world.getDimension(owner.dimensionId); } catch { continue; }
      const block = getBlock(dimension, { x: owner.x, y: owner.y, z: owner.z });
      if (block?.typeId === BREAKER_NODE_BLOCK) continue;
      try { manager.removeTickingArea(area); } catch {}
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
        const existingArea = manager.hasTickingArea(areaName)
          ? manager.getTickingArea(areaName)
          : undefined;

        if (existingArea?.isFullyLoaded) continue;

        if (existingArea) {
          try { manager.removeTickingArea(areaName); } catch {}
        }

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
      if (!area.isFullyLoaded) {
        system.runTimeout(() => {
            const retryArea = manager.getTickingArea(headName);
            const retryReady = !!retryArea?.isFullyLoaded;
            marker.setDynamicProperty(BREAKER_CHUNK_READY_PROP, retryReady ? 1 : 0);
        }, 150);
      }
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
  try {
  } catch {}
  if (Number(marker.getDynamicProperty(BREAKER_CHUNK_PENDING_PROP)) > 0) return;
  void ensureBreakerTickingArea(block, marker, targetLocation);
}
function breakerPlayersForMessage(block, maxDistance = 96) {
  if (!block) return [];
  const out = [];
  try {
    for (const player of block.dimension.getPlayers()) {
      const p = player.location;
      const dx = p.x - (block.location.x + 0.5), dy = p.y - (block.location.y + 0.5), dz = p.z - (block.location.z + 0.5);
      if ((dx * dx + dy * dy + dz * dz) <= maxDistance * maxDistance) out.push(player);
    }
  } catch {}
  return out;
}
function breakerIsJapanese(player) {
  try { return String(player?.clientSystemInfo?.locale ?? "en_US").toLowerCase().startsWith("ja"); }
  catch { return false; }
}
function sendBreakerLocalized(block, en, ja) {
  for (const player of breakerPlayersForMessage(block)) {
    try { player.sendMessage(breakerIsJapanese(player) ? ja : en); } catch {}
  }
}
function breakerLoadedChunkCount(range) {
  if (!range) return 0;
  const minCX = Math.floor(range.minX / 16), maxCX = Math.floor(range.maxX / 16);
  const minCZ = Math.floor(range.minZ / 16), maxCZ = Math.floor(range.maxZ / 16);
  return (maxCX - minCX + 1) * (maxCZ - minCZ + 1);
}
function breakerRangeSignature(range) {
  return range ? `${range.start.dimension.id}:${range.minX},${range.y},${range.minZ}:${range.maxX},${range.maxZ}` : "invalid";
}
function notifyBreakerRangeState(block, marker, range) {
  if (!block || !marker) return;
  const key = breakerLiquidMonitorKey(marker);
  const signature = breakerRangeSignature(range);
  const previousSignature = BREAKER_STARTUP_RANGE_STATE.get(key);
  if (previousSignature === signature) return;
  BREAKER_STARTUP_READY_NOTIFIED.delete(key);
  if (!range) {
    BREAKER_STARTUP_RANGE_STATE.set(key, signature);
    if (BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED.has(key)) return;
    // Keep 2.7.0-19 behavior: after a previously valid range, ignore transient invalid re-checks.
    if (previousSignature !== undefined && previousSignature !== "invalid") return;
    // sendBreakerLocalized(block,
    //  "§c[Logistics Node] Breaker Node range setup failed. Place a Start Marker directly next to the Breaker Node and a matching End Marker on the same Y level within range.§r",
    //  "§c[Logistics Node] Breaker Nodeの採掘範囲を設定できませんでした。Breaker Nodeの隣にStart Markerを置き、同じY座標かつ範囲内にEnd Markerを配置してください。§r");
    return;
  }
  BREAKER_STARTUP_RANGE_STATE.set(key, signature);
}
function notifyBreakerBeamStartupSuccess(block, marker, range) {
  if (!block || !marker || !range) return;
  const key = breakerLiquidMonitorKey(marker);
  if (BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED.has(key)) return;
  BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED.add(key);
  const width = range.maxX - range.minX + 1, depth = range.maxZ - range.minZ + 1;
  const chunks = breakerLoadedChunkCount(range);
  sendBreakerLocalized(block,
    `§a[Logistics Node] Breaker Node range detected: ${width} x ${depth}. Mining area chunks: ${chunks}. Building safety frame...§r`,
    `§a[Logistics Node] Breaker Nodeの採掘範囲を検出しました: ${width} x ${depth}。採掘範囲のチャンク数: ${chunks}。保護フレームを建設しています...§r`);
}
function notifyBreakerFrameReady(block, marker) {
  if (!block || !marker) return;
  const key = breakerLiquidMonitorKey(marker);
  if (BREAKER_STARTUP_READY_NOTIFIED.has(key)) return;
  BREAKER_STARTUP_READY_NOTIFIED.add(key);
  sendBreakerLocalized(block,
    "§a[Logistics Node] Breaker Node safety frame completed. Mining is ready.§r",
    "§a[Logistics Node] Breaker Nodeの保護フレームが完成しました。採掘準備完了です。§r");
}

function delayTicks(ticks) {
    return new Promise((resolve) => {
        system.runTimeout(resolve, ticks);
    });
}

async function initializeRangeAsync(
    marker,
    start,
    block,
    endX,
    endY,
    endZ
) {
    const areaId = `breaker_restore_${marker.id}`;
    try {
        const chunkRadius = 2;
        const HEADOP = {
            dimension: start.dimension,
            from: {
                x: endX - (chunkRadius * 16),
                y: start.location.y - 16,
                z: endZ - (chunkRadius * 16)
            },
            to: {
                x: endX + (chunkRadius * 16),
                y: start.location.y + 16,
                z: endZ + (chunkRadius * 16)
            },
        };
        await world.tickingAreaManager
            .createTickingArea(
                areaId,
                HEADOP
            );
        await delayTicks(60);
        const endBlock =
            getBlock(
                block.dimension,
                {
                    x: endX,
                    y: endY,
                    z: endZ
                }
            );
        if (
            endBlock?.typeId ===
            BREAKER_END_BLOCK
        ) {
            console.warn(`[BR RECOVERED] ${endX}, ${endY}, ${endZ}`);
        }
    } catch (e) {
        console.warn(`[BR INIT ERROR] ${e}`);
    } finally {
        try {
            world.tickingAreaManager
                .removeTickingArea(
                    areaId
                );
        } catch {}
        RANGE_INIT_PENDING.delete(
            marker.id
        );
    }
}

function requestRangeInitialization(
    marker,
    start,
    block,
    endX,
    endY,
    endZ
) {

    if (
        RANGE_INIT_PENDING.has(
            marker.id
        )
    ) {
        return;
    }

    RANGE_INIT_PENDING.add(
        marker.id
    );

    void initializeRangeAsync(
        marker,
        start,
        block,
        endX,
        endY,
        endZ
    );
}

function restoreRangeFromMarker(
    marker,
    dimension
) {
    try {

        const minX =
            Number(
                marker.getDynamicProperty(
                    RANGE_MIN_X
                )
            );

        const maxX =
            Number(
                marker.getDynamicProperty(
                    RANGE_MAX_X
                )
            );

        const minZ =
            Number(
                marker.getDynamicProperty(
                    RANGE_MIN_Z
                )
            );

        const maxZ =
            Number(
                marker.getDynamicProperty(
                    RANGE_MAX_Z
                )
            );

        const y =
            Number(
                marker.getDynamicProperty(
                    RANGE_Y
                )
            );

        if (
            !Number.isInteger(minX) ||
            !Number.isInteger(maxX) ||
            !Number.isInteger(minZ) ||
            !Number.isInteger(maxZ) ||
            !Number.isInteger(y)
        ) {
            return undefined;
        }

        return {
            y,
            minX,
            maxX,
            minZ,
            maxZ
        };

    } catch {
        return undefined;
    }
}

function resolveRange(block) {
    const marker =
        ensureBreakerMarker(block);

    if (!marker)
        return undefined;

    let start =
        getPairedStart(
            marker,
            block.dimension
        );

    let end =
        getPairedEnd(
            marker,
            block.dimension
        );

    //
    // Endチャンク未ロード
    //
    if (end?.pending) {
        const storedRange = restoreRangeFromMarker(marker, block.dimension);
        if (storedRange) {
            return {
                start: {
                    location: {
                        x: storedRange.minX,
                        y: storedRange.y,
                        z: storedRange.minZ
                    },
                    dimension: block.dimension
                },

                end: {
                    location: {
                        x: storedRange.maxX,
                        y: storedRange.y,
                        z: storedRange.maxZ
                    },
                    dimension: block.dimension
                },

                y: storedRange.y,

                minX: storedRange.minX,
                maxX: storedRange.maxX,

                minZ: storedRange.minZ,
                maxZ: storedRange.maxZ
                };
        }
        requestRangeInitialization(
            marker,
            start,
            block,
            end.x,
            end.y,
            end.z
        );

        const cachedRange = RANGE_CACHE.get(rangeKey(block));

        if (cachedRange?.start && cachedRange?.end) {

            try {
                const cachedStart = getBlock(block.dimension, cachedRange.start.location);
                const cachedEnd = getBlock(block.dimension, cachedRange.end.location);

                if (
                    cachedStart?.typeId === BREAKER_START_BLOCK &&
                    cachedEnd?.typeId === BREAKER_END_BLOCK &&
                    cachedStart.location.y === cachedEnd.location.y
                ) {
                    return cachedRange;
                }
            } catch {}

            RANGE_CACHE.delete(rangeKey(block));
        }

        return undefined;
    }

    //
    // Pair不足
    //
    if (!start || !end) {

        const storedRange = restoreRangeFromMarker(marker, block.dimension);
        if (storedRange) {
            return {
                start: {
                    location: {
                        x: storedRange.minX,
                        y: storedRange.y,
                        z: storedRange.minZ
                    },
                    dimension: block.dimension
                },

                end: {
                    location: {
                        x: storedRange.maxX,
                        y: storedRange.y,
                        z: storedRange.maxZ
                    },
                    dimension: block.dimension
                },

                y: storedRange.y,

                minX: storedRange.minX,
                maxX: storedRange.maxX,

                minZ: storedRange.minZ,
                maxZ: storedRange.maxZ
                };
        }
        start = adjacentStart(block);

        if (!start) {
            return undefined;
        }

        //
        // ここは旧方式
        //
        const nearest =
            nearestEnd(start);

        if (!nearest) {
            return undefined;
        }

        saveBreakerPair(
            marker,
            start,
            nearest
        );

        end = nearest;
    }

    return {
        start,
        end,
        y: start.location.y,
        minX: Math.min(
            start.location.x,
            end.location.x
        ),
        maxX: Math.max(
            start.location.x,
            end.location.x
        ),
        minZ: Math.min(
            start.location.z,
            end.location.z
        ),
        maxZ: Math.max(
            start.location.z,
            end.location.z
        ),
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

  // Unloaded chunk is not an invalid range. Keep cached data and let
  // background recovery continue.
  if (!start || !end) {
    return cached;
  }

  if (
    start.typeId !== BREAKER_START_BLOCK ||
    end.typeId !== BREAKER_END_BLOCK ||
    start.location.y !== end.location.y
  ) {
    RANGE_CACHE.delete(key);
    return undefined;
  }

  return cached;
}
function findOwnedHead(marker) {
  if (!marker?.isValid) return undefined;
  const cached = BREAKER_HEAD_CACHE.get(marker.id);
  try {
    if (cached?.isValid && cached.getDynamicProperty(HEAD_OWNER) === marker.id) return cached;
  } catch {}
  BREAKER_HEAD_CACHE.delete(marker.id);
  // Fallback is needed after world/script reload because the in-memory cache is empty.
  for (const head of marker.dimension.getEntities({ type: BREAKER_HEAD_ENTITY })) {
    try {
      if (head.getDynamicProperty(HEAD_OWNER) === marker.id) {
        BREAKER_HEAD_CACHE.set(marker.id, head);
        return head;
      }
    } catch {}
  }
  return undefined;
}
function removeGuardMarker(marker) {
    if (!marker?.isValid) {
        return;
    }
    for (const g of marker.dimension.getEntities({
        type: "vfh:breaker_guard_loader"
    })) {
        try {
            if (
                g.getDynamicProperty("guard_owner")
                === marker.id
            ) {
                g.remove();
            }
        } catch {}
    }
}
function* findFirstMiningY(range) {
  // BR-F45: high-altitude fast descent. Advance downward in 20-block Y bands
  // instead of walking the complete world height one Y at a time for each column.
  // Every cell still yields, and a band is skipped only after that entire band is
  // confirmed empty, so floating blocks/liquids inside the 20-block gap are not missed.
  const minY = range.start.dimension.heightRange.min;
  const step = 20;
  let bandTop = Math.floor(range.y);
  while (bandTop >= minY) {
    const bandBottom = Math.max(minY, bandTop - step + 1);
    let highest = minY - 1;
    for (let z = range.minZ; z <= range.maxZ; z++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        for (let y = bandTop; y >= bandBottom; y--) {
          const target = getBlock(range.start.dimension, { x, y, z });
          if (!target) return bandTop;
          try {
            if (target.typeId !== "minecraft:air" && !isProtected(target.typeId) && !isUnbreakable(target.typeId)) {
              if (y > highest) highest = y;
              // This column cannot improve below its first hit inside this band.
              break;
            }
          } catch { return bandTop; }
          yield;
        }
        yield;
      }
    }
    if (highest >= bandBottom) return highest;
    bandTop = bandBottom - 1; // requested y-20 descent
    yield;
  }
  return Math.floor(range.y);
}
function ensureFirstMiningYSearch(marker, range) {
  if (!marker?.isValid || !range) return false;
  const key = breakerLiquidMonitorKey(marker);
  if (BREAKER_FAST_START_DONE.has(key) || BREAKER_FAST_START_RESULTS.has(key) || BREAKER_FAST_START_JOBS.has(key)) return true;
  let jobId;
  const job = (function* () {
    try {
      const firstMiningY = yield* findFirstMiningY(range);
      if (marker?.isValid && Number.isInteger(firstMiningY)) {
        BREAKER_FAST_START_RESULTS.set(key, firstMiningY);
        try {
        marker.setDynamicProperty(RANGE_FIRST_MINING_Y, firstMiningY);
        } catch {}
      }
    } finally {
      BREAKER_FAST_START_JOBS.delete(key);
    }
  })();
  try { jobId = system.runJob(job); } catch { return false; }
  BREAKER_FAST_START_JOBS.set(key, jobId);
  return true;
}

function isHeadInsideBreakerRange(head, range) {
  if (!head?.isValid || !range) return false;
  try {
    const p = head.location;
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    return x >= range.minX && x <= range.maxX && z >= range.minZ && z <= range.maxZ &&
      y >= range.start.dimension.heightRange.min && y <= range.y;
  } catch { return false; }
}
function ensureStartupOrphanHeadCleanup(marker, range, keepHead) {
  if (!marker?.isValid || !range) return false;
  const ownerKey = breakerLiquidMonitorKey(marker);
  if (BREAKER_STARTUP_HEAD_CLEANUP_JOBS.has(ownerKey)) return true;
  let jobId;
  const job = (function* () {
    try {
      let heads = [];
      try { heads = marker.dimension.getEntities({ type: BREAKER_HEAD_ENTITY }); } catch {}
      for (const candidate of heads) {
        if (!marker?.isValid) return;
        try {
          // Preserve the one current Head selected/spawned for this Breaker.
          if (keepHead?.isValid && candidate.id === keepHead.id) { yield; continue; }
          if (!isHeadInsideBreakerRange(candidate, range)) { yield; continue; }
          // BR-F21 deliberately removes legacy Heads with no owner as well as Heads
          // owned by an earlier Breaker marker, but only inside this mining volume.
          candidate.remove();
        } catch {}
        // Entity-by-entity yielding keeps startup cleanup off the hot mining tick.
        yield;
      }
    } finally {
      BREAKER_STARTUP_HEAD_CLEANUP_JOBS.delete(ownerKey);
    }
  })();
  try { jobId = system.runJob(job); } catch { return false; }
  BREAKER_STARTUP_HEAD_CLEANUP_JOBS.set(ownerKey, jobId);
  return true;
}

function ensureHead(marker, range) {
  let head = findOwnedHead(marker);
  if (!head) {
    try {
      // BR-15: remove the initial descent animation. Spawn the head directly on
      // the first Y layer that actually contains a mineable block.
      // BR-F41: spawn without any synchronous volume scan. The yielded startup
      // search below will move the cursor/head once its result is ready.
      let firstMiningY = Number(marker.getDynamicProperty(RANGE_FIRST_MINING_Y));
      if (!Number.isInteger(firstMiningY)) {
         firstMiningY = range.y;
      }
      head = marker.dimension.spawnEntity(BREAKER_HEAD_ENTITY, {
        x: range.start.location.x + 0.5, y: firstMiningY + 0.5, z: range.start.location.z + 0.5,
      });
      head.setDynamicProperty(HEAD_OWNER, marker.id);
      BREAKER_HEAD_CACHE.set(marker.id, head);
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
  // BR-F51: one-layer particle outline remains visible only while the safety frame is being built.
  let frameComplete = false;
  try { frameComplete = Number(marker.getDynamicProperty(BREAKER_FRAME_COMPLETE_PROP)) > 0 && marker.getDynamicProperty(BREAKER_FRAME_RANGE_PROP) === areaKey; } catch {}
  if (!frameComplete) emitRangeParticles(range);
  else notifyBreakerFrameReady(block, marker);
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
  try { verified = verify?.typeId === BREAKER_FRAME_BLOCK;} catch {}
  if (!verified) return false;
  registerGuardFrame(marker, pos);
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
function finishBreakerAndSleep(block, marker, head, range) {
  if (!block || !marker) return false;
  const key = breakerLiquidMonitorKey(marker);
  if (BREAKER_FINISHED_SLEEP.has(key)) return true;

  // Final inventory pass before removing the Head.
  if (head?.isValid) {
    try { vacuumIntoHead(head); } catch {}
    try { cleanupXpOrbsAroundHead(head); } catch {}
    try { transferHeadToBreaker(head, marker); } catch {}
  }

  // Stop every per-Breaker background job/cache before the Head disappears.
  stopBreakerLiquidMonitor(marker);
  const startupCleanupJob = BREAKER_STARTUP_HEAD_CLEANUP_JOBS.get(key);
  if (startupCleanupJob !== undefined) { try { system.clearJob(startupCleanupJob); } catch {} }
  BREAKER_STARTUP_HEAD_CLEANUP_JOBS.delete(key);
  BREAKER_BACKGROUND_FRAME_SWEEP.delete(key);
  BREAKER_AQUATIC_STALLS.delete(key);
  BREAKER_STALE_FRAME_CLEAN_Y.delete(key);
  BREAKER_HEAD_CACHE.delete(marker.id);

  // Initial construction frame has its own incremental completion cleanup.
  // At this point mining is finished, so finish that cleanup synchronously over
  // the small scaffold set before unloading Breaker's ticking areas.
  if (range) {
    for (const pos of breakerFrameStructure(range)) {
      const frame = getBlock(block.dimension, pos);
      try { if (frame?.typeId === BREAKER_FRAME_BLOCK) frame.setType("minecraft:air"); } catch {}
    }
  }
  try {
    system.runJob(cleanupAllBreakerFrames(range));
  } catch {}
  try { if (head?.isValid) head.remove(); } catch {}
  removeBreakerTickingArea(block);
  BREAKER_FINISHED_SLEEP.add(key);
  return true;
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
function scheduleBreakerInitialFrameDecay(block, range) {
  if (!block || !range) { try { removeBreakerTickingArea(block); } catch {} return false; }
  const structure = breakerFrameStructure(range);
  const job = (function* () {
    try {
      // BR-F46: aborted Breaker cleanup. Remove only the initial construction
      // structure, in reverse build order, one frame per scheduler slice.
      // Liquid-protection/barrier frames are intentionally not classified as
      // startup structure here.
      for (let i = structure.length - 1; i >= 0; i--) {
        const pos = structure[i];
        const target = getBlock(block.dimension, pos);
        try {
          if (target?.typeId === BREAKER_FRAME_BLOCK) target.setType("minecraft:air");
        } catch {}
        yield;
      }
    } finally {
      // Keep Breaker's ticking areas until decay has had a chance to reach the
      // complete startup structure, then release them automatically.
      try { removeBreakerTickingArea(block); } catch {}
    }
  })();
  try { system.runJob(job); return true; }
  catch { try { removeBreakerTickingArea(block); } catch {} return false; }
}
function hasAdjacentBreakerNode(markerBlock) {
  if (!markerBlock) return false;
  for (const o of OFFSETS) {
    const b = getBlock(markerBlock.dimension, { x: markerBlock.location.x + o.x, y: markerBlock.location.y + o.y, z: markerBlock.location.z + o.z });
    if (b?.typeId === BREAKER_NODE_BLOCK) return true;
  }
  return false;
}
function emitStartMarkerPlacementGuide(start) {
  if (!start || hasAdjacentBreakerNode(start)) return;
  const y = start.location.y + 0.60;
  try {
    start.dimension.spawnParticle(START_MARKER_GUIDE_BEAM, { x: start.location.x + 0.5, y, z: start.location.z + 0.5 });
  } catch {}
}
function emitEndMarkerPlacementGuide(end) {
  if (!end) return;
  const y = end.location.y + 0.60;
  try {
    end.dimension.spawnParticle(END_MARKER_GUIDE_BEAM, { x: end.location.x + 0.5, y, z: end.location.z + 0.5 });
  } catch {}
}
function emitStandaloneMarkerPlacementGuides(dimension) {
  if (!dimension) return;
  // Marker guides intentionally exist before a Breaker Node is placed. Limit scanning
  // to players' nearby setup areas so this remains a lightweight placement aid.
  const starts = new Map(), ends = new Map();
  try {
    for (const player of dimension.getPlayers()) {
      const p = player.location;
      const r = 48;
      const volume = new BlockVolume(
        { x: Math.floor(p.x) - r, y: Math.max(dimension.heightRange.min, Math.floor(p.y) - 24), z: Math.floor(p.z) - r },
        { x: Math.floor(p.x) + r, y: Math.min(dimension.heightRange.max - 1, Math.floor(p.y) + 24), z: Math.floor(p.z) + r }
      );
      for (const loc of dimension.getBlocks(volume, { includeTypes: [BREAKER_START_BLOCK, BREAKER_END_BLOCK] }, true).getBlockLocationIterator()) {
        const block = getBlock(dimension, loc);
        if (!block) continue;
        const key = `${loc.x},${loc.y},${loc.z}`;
        if (block.typeId === BREAKER_START_BLOCK) starts.set(key, block);
        else if (block.typeId === BREAKER_END_BLOCK) ends.set(key, block);
      }
    }
  } catch {}
  for (const start of starts.values()) emitStartMarkerPlacementGuide(start);
  // End Marker guide is only a pre-setup placement aid. Once an End Marker belongs
  // to a valid Breaker range, stop its beam while the safety frame is being built/mined.
  const activeEnds = new Set();
  try {
    for (const marker of dimension.getEntities({ type: BREAKER_NODE_ENTITY })) {
      const p = marker.location;
      const node = getBlock(dimension, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
      if (node?.typeId !== BREAKER_NODE_BLOCK) continue;
      const range = getRange(node);
      if (!range?.end) continue;
      activeEnds.add(`${range.end.location.x},${range.end.location.y},${range.end.location.z}`);
    }
  } catch {}
  for (const [key, end] of ends) {
    if (!activeEnds.has(key)) emitEndMarkerPlacementGuide(end);
  }
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
  "minecraft:kelp_plant",
  // BR-F48: pointed dripstone is removed by the same pre-drain path as kelp.
  // This prevents side water-sealing from waiting on a waterlogged dripstone host.
  "minecraft:pointed_dripstone",
  "minecraft:sulfur_spike",
  "minecraft:glow_lichen"
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
function isBreakerWaterTarget(block) {
  if (!block) return false;
  try {
    const id = String(block.typeId || "");
    // BR-F47: Block.isLiquid intentionally excludes waterlogged blocks.
    // Treat an actually waterlogged block as Water111 drain work without
    // special-casing pointed_dripstone or any other individual block type.
    return block.isWaterlogged === true ||
      id === "minecraft:water" || id === "minecraft:flowing_water" ||
      isBreakerAquaticPlant(block) || isBreakerBubbleColumn(block);
  } catch { return false; }
}
function isBreakerLavaTarget(block) {
  if (!block) return false;
  try {
    const id = String(block.typeId || "");
    return id === "minecraft:lava" || id === "minecraft:flowing_lava";
  } catch { return false; }
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
function breakerWorkPhase(marker, modulo) {
  const text = String(marker?.id ?? "");
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  return modulo > 0 ? hash % modulo : 0;
}
function breakerLiquidMonitorKey(marker) { return marker.id; }
function breakerLiquidFrameSet(marker) {
  const key = breakerLiquidMonitorKey(marker);
  let set = BREAKER_LIQUID_FRAME_POSITIONS.get(key);
  if (!set) { set = new Set(); BREAKER_LIQUID_FRAME_POSITIONS.set(key, set); }
  return set;
}

function saveLiquidGuardPositions(marker) {
    const set = breakerLiquidFrameSet(marker);
    if (!set) {
        return;
    }
    try {
        const value =
            Array.from(set).join("|");
        marker.setDynamicProperty(
            BREAKER_LIQUID_GUARD_PROP,
            value
        );
    } catch {}
}
function loadLiquidGuardPositions(marker) {
    const result = new Set();
    try {
        const raw =
            marker.getDynamicProperty(
                BREAKER_LIQUID_GUARD_PROP
            );
        if (!raw) {
            return result;
        }
        const parts = raw.split("|");
        for (const key of parts) {
            if (!key) {
                continue;
            }
            result.add(key);
        }
    } catch {}
    return result;
}
function breakerLiquidPositionKey(location) {
    return `${location.x},${location.y},${location.z}`;
}
function registerGuardFrame(marker, location) {
    const ownerKey = breakerLiquidMonitorKey(marker);
    let set = BREAKER_GUARD_FRAME_POSITIONS.get(ownerKey);
    if (!set) {
        set = new Set();
        BREAKER_GUARD_FRAME_POSITIONS.set(ownerKey, set);
    }
    set.add(breakerLiquidPositionKey(location));
}
function stopBreakerLiquidMonitor(marker) {
  if (!marker) return;
  const key = breakerLiquidMonitorKey(marker);
  const jobId = BREAKER_LIQUID_MONITORS.get(key);
  if (jobId !== undefined) { try { system.clearJob(jobId); } catch {} }
  BREAKER_LIQUID_MONITORS.delete(key);
  BREAKER_LIQUID_FRAME_POSITIONS.delete(key);
  const drainJob = BREAKER_LAYER_DRAIN_JOBS.get(key);
  if (drainJob !== undefined) { try { system.clearJob(drainJob); } catch {} }
  BREAKER_LAYER_DRAIN_JOBS.delete(key);
  BREAKER_LAYER_BARRIERS.delete(key);
  BREAKER_FAST_START_DONE.delete(key);
  const fastStartJob = BREAKER_FAST_START_JOBS.get(key);
  if (fastStartJob !== undefined) { try { system.clearJob(fastStartJob); } catch {} }
  BREAKER_FAST_START_JOBS.delete(key);
  BREAKER_FAST_START_RESULTS.delete(key);
  BREAKER_AQUATIC_STALLS.delete(key);
  BREAKER_STALE_FRAME_CLEAN_Y.delete(key);
  BREAKER_BACKGROUND_FRAME_SWEEP.delete(key);
  BREAKER_HEAD_CACHE.delete(key);
}
// BR-F19: continuously sweep the already-processed portion of the mining range for
// stale internal Breaker Frames. Work is bounded per tick and never touches the
// one-block outer perimeter or BR-F15 corner guards. The active drain Y layer is
// skipped while BR-F16/F18 is using temporary frames there.
function tickBreakerBackgroundFrameSweep(marker, range) {
  if (!marker?.isValid || !range || !isBreakerPowered(marker)) return;
  const ownerKey = breakerLiquidMonitorKey(marker);
  const head = findOwnedHead(marker);
  let activeY;
  try { activeY = Number(head?.getDynamicProperty(CURSOR_Y)); } catch {}
  if (!Number.isInteger(activeY)) return;

  const minY = -64;
  const maxY = Math.floor(range.y);
  if (maxY < minY) return;
  const width = range.maxX - range.minX + 1;
  const depth = range.maxZ - range.minZ + 1;
  const height = maxY - minY + 1;
  const total = width * depth * height;
  if (total <= 0) return;

  let state = BREAKER_BACKGROUND_FRAME_SWEEP.get(ownerKey);
  const sweepKey = `${range.minX},${range.maxX},${range.minZ},${range.maxZ},${minY},${maxY}`;
  if (!state || state.key !== sweepKey || !Number.isInteger(state.index) || state.index < 0 || state.index >= total) {
    state = { key: sweepKey, index: 0 };
  }
  const drainActive = BREAKER_LAYER_DRAIN_JOBS.has(ownerKey);
  for (let checked = 0; checked < BREAKER_BACKGROUND_FRAME_SWEEP_CELLS_PER_TICK; checked++) {
    const index = state.index;
    state.index = (state.index + 1) % total;
    const layerSize = width * depth;
    const yOffset = Math.floor(index / layerSize);
    const inLayer = index % layerSize;
    const zOffset = Math.floor(inLayer / width);
    const xOffset = inLayer % width;
    const y = maxY - yOffset;
    // Never race the temporary frames used by the currently active drain layer.
    if (drainActive && y === activeY) continue;
    const block = getBlock(range.start.dimension, { x: range.minX + xOffset, y, z: range.minZ + zOffset });
    if (block?.typeId === BREAKER_FRAME_BLOCK) {
      try { block.setType("minecraft:air"); } catch {}
    }
  }
  BREAKER_BACKGROUND_FRAME_SWEEP.set(ownerKey, state);
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
  const startTick = system.currentTick;
  const retainedLavaFrames = [];
  const temporaryWaterFrames = [];
  let hit = 0;
  for (let z = range.minZ; z <= range.maxZ; z++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      const inside = getBlock(range.start.dimension, { x, y, z });
      if (inside?.typeId?.includes("water")) {
      }
      if (inside && (isBreakerWaterTarget(inside) || isBreakerLavaTarget(inside))) {
        hit++;
        let waterlogged = false;
        try { waterlogged = inside.isWaterlogged === true; } catch {}
        if (waterlogged) {
          // BR-F47: remove only the contained water. Keep the host block intact;
          // normal Breaker mining can process that block afterwards.
          try { inside.setWaterlogged(false); } catch {}
        } else {
          const lava = isBreakerLavaTarget(inside);
          try {
            inside.setType(BREAKER_FRAME_BLOCK);
            const verify = getBlock(range.start.dimension, { x, y, z });
            if (verify?.typeId === BREAKER_FRAME_BLOCK) {
              (lava ? retainedLavaFrames : temporaryWaterFrames).push({ x, y, z });
            }
          } catch {}
        }
      }
      yield;
    }
  }
  // Water path = 2.3.0-111 lifecycle: temporary frame is removed immediately.
  for (const location of temporaryWaterFrames) {
    const frame = getBlock(range.start.dimension, location);
    if (frame?.typeId === BREAKER_FRAME_BLOCK) {
      try { frame.setType("minecraft:air"); } catch {}
    }
    yield;
  }
  // Lava path = 2.6.7-16 lifecycle: return frames to BREAKER_LAYER_BARRIERS for retention.
  return retainedLavaFrames;
}

function* releaseBreakerLayerBarrier(range, layerY, locations) {
  // BR-F29: first release every coordinate explicitly retained by BR-F28.
  // Then sweep the entire completed mining layer so a frame can never survive
  // merely because its coordinate was missed by the retained-location list.
  let removed = 0;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const frame = getBlock(range.start.dimension, location);
      if (frame?.typeId === BREAKER_FRAME_BLOCK) {
        try { frame.setType("minecraft:air"); removed++; } catch {}
      }
      yield;
    }
  }
  for (let z = range.minZ; z <= range.maxZ; z++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      const block = getBlock(range.start.dimension, { x, y: layerY, z });
      if (block?.typeId === BREAKER_FRAME_BLOCK) {
        try { block.setType("minecraft:air"); removed++; } catch {}
      }
      yield;
    }
  }
  return removed;
}
function releaseCompletedBreakerLayerBarrier(marker, range, activeY) {
  if (!marker?.isValid || !range) return false;
  const ownerKey = breakerLiquidMonitorKey(marker);
  const barrier = BREAKER_LAYER_BARRIERS.get(ownerKey);
  if (!barrier || barrier.y === activeY || barrier.releasing) return false;
  barrier.releasing = true;
  let jobId;
  const job = (function* () {
    try {
      // BR-F29 final sweep is constrained to minX..maxX/minZ..maxZ at the
      // completed layer Y, so perimeter/corner protection outside that range
      // is not touched.
      yield* releaseBreakerLayerBarrier(range, barrier.y, barrier.locations);
    } finally {
      const current = BREAKER_LAYER_BARRIERS.get(ownerKey);
      if (current === barrier) BREAKER_LAYER_BARRIERS.delete(ownerKey);
    }
  })();
  try { jobId = system.runJob(job); } catch { barrier.releasing = false; return false; }
  barrier.releaseJobId = jobId;
  return true;
}

function* breakerLayerHasDrainTarget(range, y) {
  for (let z = range.minZ; z <= range.maxZ; z++) {
    for (let x = range.minX; x <= range.maxX; x++) {
      if (isBreakerDrainTarget(getBlock(range.start.dimension, { x, y, z }))) {
         return true;
      }
      // BR-F42: never scan an entire mining layer synchronously.
      yield;
    }
  }
  return false;
}
function ensureBreakerLayerDrain(marker, range, y) {
  if (!marker?.isValid || !range || !Number.isInteger(y)) return false;
  const ownerKey = breakerLiquidMonitorKey(marker);
  const existingBarrier = BREAKER_LAYER_BARRIERS.get(ownerKey);
  if (existingBarrier?.y === y && !existingBarrier.releasing) return true;
  if (BREAKER_LAYER_DRAIN_JOBS.has(ownerKey)) {
	  return true;
  }
  let jobId;
  const job = (function* () {
    const retained = [];
    const retainedKeys = new Set();
    try {
      yield* cleanupBreakerStaleFramesInLayer(range, y);
      BREAKER_STALE_FRAME_CLEAN_Y.set(ownerKey, y);
      for (let retry = 0; retry < BREAKER_AQUATIC_STALL_LIMIT; retry++) {
        const sealed = yield* drainBreakerLiquidLayerWithFrames(range, y);
        for (const location of sealed) {
          const key = breakerLiquidPositionKey(location);
          if (!retainedKeys.has(key)) { retainedKeys.add(key); retained.push(location); }
        }
        const hasRemainingDrainTarget = yield* breakerLayerHasDrainTarget(range, y);
        if (!hasRemainingDrainTarget) {
          BREAKER_LAYER_BARRIERS.set(ownerKey, { y, locations: retained, releasing: false });
          return;
        }
        yield;
      }
      const head = findOwnedHead(marker);
      const x = Number(head?.getDynamicProperty(CURSOR_X));
      const z = Number(head?.getDynamicProperty(CURSOR_Z));
      if (Number.isInteger(x) && Number.isInteger(z)) {
        const location = { x, y, z };
        const target = getBlock(range.start.dimension, location);
        if (isBreakerDrainTarget(target)) {
          const lava = isBreakerLavaTarget(target);
          try { target.setType(BREAKER_FRAME_BLOCK); } catch {}
          yield;
          const frame = getBlock(range.start.dimension, location);
          if (frame?.typeId === BREAKER_FRAME_BLOCK) {
            if (lava) {
              const key = breakerLiquidPositionKey(location);
              if (!retainedKeys.has(key)) { retainedKeys.add(key); retained.push(location); }
            } else {
              try { frame.setType("minecraft:air"); } catch {}
            }
          }
        }
      }
      BREAKER_LAYER_BARRIERS.set(ownerKey, { y, locations: retained, releasing: false });
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
        const outside = getBlock(block.dimension, pair.outside);
        if (isBreakerDrainTarget(outside)) {
            protectedPositions.add(breakerLiquidPositionKey(pair.outside));
        }
    }
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
          if (verify?.typeId === BREAKER_FRAME_BLOCK) {
             protectedPositions.add(positionKey);
             saveLiquidGuardPositions(marker);
          }
        } catch {}
      } else if (protectedPositions.has(positionKey) && (outside.typeId === "minecraft:air" || isBreakerDrainTarget(outside))) {
            try {
                outside.setType(BREAKER_FRAME_BLOCK);
                const verify = getBlock( block.dimension, pair.outside);
            } catch {}
        }
        // Self-heal only a location that this Breaker previously converted to a frame,
        // and only while the location is empty. Natural blocks are never overwritten.
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
  let zStep = Number(head.getDynamicProperty(DIR_Z));
  if (zStep !== 1 && zStep !== -1) zStep = range.end.location.z >= range.start.location.z ? 1 : -1;
  const zEnd = zStep > 0 ? range.maxZ : range.minZ;
  if (z === zEnd) return false;
  head.setDynamicProperty(CURSOR_Z, z + zStep);
  head.setDynamicProperty(DIR_X, -dir);
  return true;
}
function isProtected(typeId) { return typeId.startsWith("vfh:"); }
function isUnbreakable(typeId) { return typeId === "minecraft:bedrock"; }
function clearBreakerFailsafe3x3(block, range, centerX, y, centerZ) {
  if (!block || !range || !Number.isInteger(centerX) || !Number.isInteger(y) || !Number.isInteger(centerZ)) return false;
  let changed = false;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = centerX + dx, z = centerZ + dz;
      // Never modify outside the configured Breaker mining footprint.
      if (x < range.minX || x > range.maxX || z < range.minZ || z > range.maxZ) continue;
      const target = getBlock(block.dimension, { x, y, z });
      if (!target) continue;
      let typeId;
      try { typeId = target.typeId; } catch { continue; }
      if (typeId === "minecraft:air" || isProtected(typeId) || isUnbreakable(typeId)) continue;
      try { target.setType("minecraft:air"); changed = true; } catch {}
    }
  }
  return changed;
}

function auditBreakerHeads(
    block,
    dimension,
    centerChunkX,
    centerChunkZ
) {
    const miningGroups = new Map();
    auditHeadType(
        block,
        dimension,
        centerChunkX,
        centerChunkZ,
        BREAKER_HEAD_ENTITY,
        HEAD_OWNER,
        miningGroups
    );
}

function auditHeadType(
    block,
    dimension,
    centerChunkX,
    centerChunkZ,
    entityType,
    ownerProp,
    groups
) {
    for (const entity of dimension.getEntities({
        type: entityType
    })) {
        const chunkX =
            Math.floor(entity.location.x / 16);
        const chunkZ =
            Math.floor(entity.location.z / 16);
        // loaded chunk ±1 だけ監査
        if (
            Math.abs(chunkX - centerChunkX) > 1 ||
            Math.abs(chunkZ - centerChunkZ) > 1
        ) {
            continue;
        }
        let owner;
        try {
            owner = entity.getDynamicProperty(ownerProp);
        }
        catch {
            owner = undefined;
        }
        // owner無し
        if (!owner) {
            sendBreakerLocalized(block, `§a[HEAD CLEANUP] no owner type: ${entityType}§r`, `§a[HEAD CLEANUP] オーナーじゃないエンティティタイプ: ${entityType}§r`)
            // console.warn(`[HEAD CLEANUP] no owner type=${entityType}`);
            try {
                entity.remove();
            }
            catch {}
            continue;
        }
        let markerFound = false;
        try {
            for (const marker of dimension.getEntities({
                type: BREAKER_NODE_ENTITY
            })) {
                if (marker.id === owner) {
                    markerFound = true;
                    break;
                }
            }
        }
        catch {}
        // marker無し
        if (!markerFound) {
            sendBreakerLocalized(block, `§a[HEAD CLEANUP] orphan owner: ${owner}§r`, `§a[HEAD CLEANUP] 孤立した所有者: ${owner}§r`)
            // console.warn(`[HEAD CLEANUP] orphan owner=${owner}`);
            try {
                entity.remove();
            }
            catch {}
            continue;
        }
        let list = groups.get(owner);
        if (!list) {
            list = [];
            groups.set(owner, list);
        }
        list.push(entity);
    }
    // 重複除去
    for (const [owner, list] of groups) {
        if (list.length <= 1)
            continue;
        list.sort((a, b) => b.ageTicks - a.ageTicks);
        const keep = list[0];
        for (let i = 1; i < list.length; i++) {
            sendBreakerLocalized(block, `§a[HEAD CLEANUP] duplicate owner: ${owner}§r`, `§a[HEAD CLEANUP] 重複する所有者: ${owner}§r`)
            // console.warn(`[HEAD CLEANUP] duplicate owner=${owner}`);
            try {
                list[i].remove();
            }
            catch {}
        }
        sendBreakerLocalized(block, `§a[HEAD CLEANUP] owner: ${owner} keep: ${keep.id} removed: ${list.length - 1}§r`, `§a[HEAD CLEANUP] オーナー: ${owner} キープ: ${keep.id} 削除済み: ${list.length - 1}§r`)
        // console.warn(`[HEAD CLEANUP] owner=${owner} keep=${keep.id} removed=${list.length - 1}`);
    }
}

function buildRequiredChunks(range) {
    const minChunkX =
        Math.floor(range.minX / 16);

    const maxChunkX =
        Math.floor(range.maxX / 16);

    const minChunkZ =
        Math.floor(range.minZ / 16);

    const maxChunkZ =
        Math.floor(range.maxZ / 16);

    const result = [];

    for (
        let cx = minChunkX;
        cx <= maxChunkX;
        cx++
    ) {
        for (
            let cz = minChunkZ;
            cz <= maxChunkZ;
            cz++
        ) {
            result.push({
                x: cx,
                z: cz
            });
        }
    }

    return result;
}
function ensureGuardLoader(marker) {
    if (!marker?.isValid) return undefined;

    for (const entity of marker.dimension.getEntities({
        type: "vfh:breaker_guard_loader"
    })) {
        try {
            if (
                entity.getDynamicProperty("guard_owner")
                === marker.id
            ) {
                return entity;
            }
        } catch {}
    }
    const loader =
        marker.dimension.spawnEntity(
            "vfh:breaker_guard_loader",
            marker.location
        );
    try {
        loader.setDynamicProperty(
            "guard_owner",
            marker.id
        );

    } catch {}
}

function getGuardOwnerMarker(loader) {
    if (!loader?.isValid) {
        return undefined;
    }
    let ownerId;
    try {
        ownerId = loader.getDynamicProperty(
            "guard_owner"
        );
    } catch {
        return undefined;
    }
    if (!ownerId) {
        return undefined;
    }
    try {
        for (const marker of loader.dimension.getEntities({
            type: BREAKER_NODE_ENTITY
        })) {
            if (marker.id === ownerId) {
                return marker;
            }
        }
    } catch {}
    return undefined;
}

function tickGuardLoaderParticle(loader) {
    if (!loader?.isValid) {
        return;
    }
    const marker = getGuardOwnerMarker(loader);
    if (!marker) {
        return;
    }
    try {
        const protectedPositions = loadLiquidGuardPositions(marker);
        for (const key of protectedPositions) {
            const [x, y, z] = key.split(",").map(Number);
            const block = getBlock(loader.dimension, { x: x, y: y, z: z });
            if (!block) {
                continue;
            }
            if (
                block.typeId === "minecraft:air" ||
                block.typeId === "minecraft:water" ||
                block.typeId === "minecraft:lava" ||
                block.typeId === "minecraft:flowing_water" ||
                block.typeId === "minecraft:flowing_lava"
			) {
                block.setType(BREAKER_FRAME_BLOCK);
            }
        }
    } catch {}
}

function tickGuardLoader(loader) {
    if (!loader?.isValid) return;

    tickGuardLoaderParticle(loader);
}

function tickBreaker(block) {
  const marker = ensureBreakerMarker(block); if (!marker) return;
  ensureGuardLoader(marker);
  if (BREAKER_FINISHED_SLEEP.has(breakerLiquidMonitorKey(marker))) return;
  if (!isBreakerPowered(marker)) return; // BR-11: mine only while redstone power is present. Output buffer still drains.
  const range = getRange(block);
  ensureBreakerRangeArea(block, marker, range);
  const oldHead = findOwnedHead(marker);
  if (!range) { if (oldHead) { vacuumIntoHead(oldHead); cleanupXpOrbsAroundHead(oldHead); transferHeadToBreaker(oldHead, marker); } return; }
  const HEAD_AUDIT_INTERVAL = 20 * 30; // 30秒
  const LAST_HEAD_AUDIT_PROP = "last_head_audit";
  const now = system.currentTick;
  const lastAudit = Number(marker.getDynamicProperty(LAST_HEAD_AUDIT_PROP)) || 0;
  const head = ensureHead(marker, range); if (!head) return;
  const loadedChunkX = Number(marker.getDynamicProperty(BREAKER_HEAD_CHUNK_X_PROP));
  const loadedChunkZ = Number(marker.getDynamicProperty(BREAKER_HEAD_CHUNK_Z_PROP));
  try {
        if (now - lastAudit > HEAD_AUDIT_INTERVAL) {
          marker.setDynamicProperty(LAST_HEAD_AUDIT_PROP, now);
          auditBreakerHeads(block, block.dimension, loadedChunkX, loadedChunkZ);
        }
  } catch {}
  vacuumIntoHead(head);
  cleanupXpOrbsAroundHead(head);
  transferHeadToBreaker(head, marker);
  let x = Number(head.getDynamicProperty(CURSOR_X));
  let z = Number(head.getDynamicProperty(CURSOR_Z));
  let y = Number(head.getDynamicProperty(CURSOR_Y));
  let dir = Number(head.getDynamicProperty(DIR_X));
  const resetCursor = (ny) => {
    x = range.start.location.x; z = range.start.location.z; y = ny;
    dir = range.end.location.x >= x ? 1 : -1;
    head.setDynamicProperty(CURSOR_X, x); head.setDynamicProperty(CURSOR_Z, z);
    head.setDynamicProperty(CURSOR_Y, y); head.setDynamicProperty(DIR_X, dir);
    head.setDynamicProperty(DIR_Z, range.end.location.z >= range.start.location.z ? 1 : -1);
  };
  // BR-F20: descend from the endpoint of the completed layer instead of
  // teleporting the cursor back to the original start. The next layer then
  // traverses the same 2D serpentine path in reverse, producing a continuous
  // 3D U-turn/serpentine transition between Y levels.
  const transitionToNextLayer = (ny, endX, endZ, endDir) => {
    x = endX; z = endZ; y = ny; dir = -endDir;
    head.setDynamicProperty(CURSOR_X, x); head.setDynamicProperty(CURSOR_Z, z);
    head.setDynamicProperty(CURSOR_Y, y); head.setDynamicProperty(DIR_X, dir);
    const currentZDir = Number(head.getDynamicProperty(DIR_Z));
    const zDir = currentZDir === 1 || currentZDir === -1 ? -currentZDir : (range.end.location.z >= range.start.location.z ? -1 : 1);
    head.setDynamicProperty(DIR_Z, zDir);
  };
  if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(y) || (dir !== 1 && dir !== -1)) resetCursor(range.y);
  else {
    const zDir = Number(head.getDynamicProperty(DIR_Z));
    if (zDir !== 1 && zDir !== -1) head.setDynamicProperty(DIR_Z, range.end.location.z >= range.start.location.z ? 1 : -1);
  }

  // BR-F28: only after the cursor has transitioned to another Y may the previous
  // layer barrier be released. Current-layer barriers are never touched here.
  releaseCompletedBreakerLayerBarrier(marker, range, y);

  // BR-F30: on the first active mining tick, jump the persisted cursor directly
  // to the first occupied mining Y. This also fixes Heads that already existed
  // before BR-F30 and would otherwise continue the old empty-layer serpentine.
  const fastStartKey = breakerLiquidMonitorKey(marker);
  if (!BREAKER_FAST_START_DONE.has(fastStartKey)) {
    const firstMiningY = BREAKER_FAST_START_RESULTS.get(fastStartKey);
    if (!Number.isInteger(firstMiningY)) {
      ensureFirstMiningYSearch(marker, range);
      // Mining waits only for the yielded seek itself; the main tick remains free.
      return;
    }
    BREAKER_FAST_START_RESULTS.delete(fastStartKey);
    if (firstMiningY < y) {
      resetCursor(firstMiningY);
      try { head.teleport({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }); } catch {}
    }
    BREAKER_FAST_START_DONE.add(fastStartKey);
  }

  // BR-F50: completion is a one-time teardown, not a forever-active return path.
  // Check before re-starting liquid/background work.
  if (isBreakerMiningFinishedY(y)) {
    finishBreakerAndSleep(block, marker, head, range);
    return;
  }

  // BR-F7: mining is speed-first. Liquid protection runs concurrently and does
  // not block this tick while waiting for a boundary scan to complete.
  ensureBreakerLiquidMonitor(marker);

  // BR-F17: on first processing of each Y layer, remove stale internal frames.
  // Use the existing single-flight drain job so cleanup cannot race BR-F16 drainage.
  const ownerKey = breakerLiquidMonitorKey(marker);
  if (BREAKER_STALE_FRAME_CLEAN_Y.get(ownerKey) !== y) {
    ensureBreakerLayerDrain(marker, range, y);
    return;
  }

  // BR-F52: faster exploration/descent. Empty/protected/unbreakable cells are cheap to
  // inspect, so raise the bounded per-tick cursor scan budget without changing mining,
  // liquid handling, chunk readiness checks, or Y-layer transition semantics.
  const FAST_SCAN_CELLS = 256;
  for (let scan = 0; scan < FAST_SCAN_CELLS; scan++) {
    if (x < range.minX || x > range.maxX || z < range.minZ || z > range.maxZ) return;
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
      const stallCount = prior?.key === stallKey ? prior.count + 1 : 1;
      BREAKER_AQUATIC_STALLS.set(ownerKey, { key: stallKey, count: stallCount });
      if (stallCount >= BREAKER_FAILSAFE_STALL_LIMIT) {
        // BR-F49: emergency recovery for unknown drain/mining blockers. Clear only
        // the Head's current Y-plane 3x3 area and preserve protected/unbreakable blocks.
        clearBreakerFailsafe3x3(block, range, x, y, z);
        BREAKER_AQUATIC_STALLS.delete(ownerKey);
      }
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
        if (!advanceSerpentine(head, range, x, z, dir)) transitionToNextLayer(y - 1, x, z, dir);
        system.run(() => {
          const c = vacuumIntoHead(head); const xp = cleanupXpOrbsAroundHead(head); const m = transferHeadToBreaker(head, marker);
        });
      } catch {}
      return;
    }
    if (!advanceSerpentine(head, range, x, z, dir)) {
      transitionToNextLayer(y - 1, x, z, dir);
    } else {
      x = Number(head.getDynamicProperty(CURSOR_X));
      z = Number(head.getDynamicProperty(CURSOR_Z));
      dir = Number(head.getDynamicProperty(DIR_X));
    }
  }
}
system.run(() => cleanupOrphanBreakerTickingAreas());
system.runInterval(() => cleanupOrphanBreakerTickingAreas(), 200);

system.runInterval(() => {
  for (const id of DIMENSION_IDS) {
    let d; try { d = world.getDimension(id); } catch { continue; }
    emitStandaloneMarkerPlacementGuides(d);
  }
}, 20);
system.runInterval(() => {
    for (const id of DIMENSION_IDS) {
        let d;
        try {
            d = world.getDimension(id);
        } catch {
            continue;
        }
        for (const loader of d.getEntities({
            type: "vfh:breaker_guard_loader"
        })) {
            tickGuardLoaderParticle(loader);

        }
    }

}, 1);

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
          const ownerKey = breakerLiquidMonitorKey(marker);
          if (BREAKER_FINISHED_SLEEP.has(ownerKey)) continue;
          const startupRange = getRange(block);
          notifyBreakerRangeState(block, marker, startupRange);
          tickBreaker(block);
          if (BREAKER_FINISHED_SLEEP.has(ownerKey)) continue;
          const range = getRange(block);
          // BR-F44: distribute bounded background sweep work across 4 phases.
          // Mining and output transfer remain tick-responsive.
          if (range && (system.currentTick & 2) === breakerWorkPhase(marker, 4)) tickBreakerBackgroundFrameSweep(marker, range);
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
        if (BREAKER_FINISHED_SLEEP.has(breakerLiquidMonitorKey(marker))) continue;
        // BR-F44: stagger expensive frame/beam maintenance across four phases.
        if ((system.currentTick & 3) !== breakerWorkPhase(marker, 4)) continue;
        const range = getRange(block);
        const beamKeyBeforeSpawn = breakerLiquidMonitorKey(marker);
        if (!range) BREAKER_BEAM_READY.delete(beamKeyBeforeSpawn);
        if (range) {
          const head = findOwnedHead(marker);
          let cursorY;
          try { cursorY = Number(head?.getDynamicProperty(CURSOR_Y)); } catch {}
          if (isBreakerMiningFinishedY(cursorY)) tickBreakerInitialFrameCleanup(block, marker, range);
          else tickBreakerFrameConstruction(block, marker, range);
        }
        let breakerBeamSpawned = false;
        for (let up = 1; up <= BREAKER_BEAM_HEIGHT; up++) {
          const beamKey = breakerLiquidMonitorKey(marker);
          try {
            block.dimension.spawnParticle(BREAKER_BEAM, {
              x: block.location.x + 0.5,
              y: block.location.y + up + 0.5,
              z: block.location.z + 0.5,
            });
            breakerBeamSpawned = true;
            if (breakerBeamSpawned) {
              BREAKER_BEAM_READY.add(beamKey);
              notifyBreakerBeamStartupSuccess(block, marker, range);
            }
          } catch {
              BREAKER_BEAM_READY.delete(beamKey);
              break;
		  }
        }
      } catch {}
    }
  }
}, BREAKER_FRAME_BUILD_INTERVAL_TICKS);

world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  if (ev.block.typeId !== BREAKER_NODE_BLOCK) return;
  // BR-F54: a newly placed Breaker at the same coordinates is a new lifecycle.
  // Clear every coordinate-keyed runtime state that could survive the old marker.
  const placementKey = `${ev.block.dimension.id}:${Math.floor(ev.block.location.x)},${Math.floor(ev.block.location.y)},${Math.floor(ev.block.location.z)}`;
  BREAKER_FAST_START_DONE.delete(placementKey);
  BREAKER_STALE_FRAME_CLEAN_Y.delete(placementKey);
  BREAKER_BACKGROUND_FRAME_SWEEP.delete(placementKey);
  BREAKER_BEAM_READY.delete(placementKey);
  RANGE_CACHE.clear();
  system.run(() => {
    const marker = initializeBreakerMarker(ensureBreakerMarker(ev.block));
    const ownerKey = marker ? breakerLiquidMonitorKey(marker) : placementKey;
    BREAKER_FINISHED_SLEEP.delete(ownerKey);
    BREAKER_STARTUP_RANGE_STATE.delete(ownerKey);
    BREAKER_STARTUP_READY_NOTIFIED.delete(ownerKey);
    BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED.delete(ownerKey);
      BREAKER_BEAM_READY.delete(ownerKey);
    BREAKER_FAST_START_DONE.delete(ownerKey);
    BREAKER_STALE_FRAME_CLEAN_Y.delete(ownerKey);
    BREAKER_BACKGROUND_FRAME_SWEEP.delete(ownerKey);
    const staleJob = BREAKER_STARTUP_HEAD_CLEANUP_JOBS.get(ownerKey);
    if (staleJob !== undefined) { try { system.clearJob(staleJob); } catch {} BREAKER_STARTUP_HEAD_CLEANUP_JOBS.delete(ownerKey); }
    const range = getRange(ev.block);
    if (marker) notifyBreakerRangeState(ev.block, marker, range);
    if (marker && range) {
      const head = ensureHead(marker, range);
      if (head) ensureStartupOrphanHeadCleanup(marker, range, head);
      ensureBreakerLiquidMonitor(marker);
      ensureBreakerRangeArea(ev.block, marker, range);
      requestBreakerTickingArea(ev.block, marker, range.start.location);
    }
  });
});
world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const marker = findMarkerAtBlock(ev.block, BREAKER_NODE_ENTITY); if (!marker) return;
  removeGuardMarker(marker);
  // BR-F46: resolve/capture the range before removing the persistent marker.
  // Ticking areas remain alive until the yielded startup-frame decay finishes.
  const range = getRange(ev.block);
  stopBreakerLiquidMonitor(marker);
  const cleanupKey = breakerLiquidMonitorKey(marker);
  BREAKER_FINISHED_SLEEP.delete(cleanupKey);
  BREAKER_STARTUP_RANGE_STATE.delete(cleanupKey);
  BREAKER_STARTUP_READY_NOTIFIED.delete(cleanupKey);
  BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED.delete(cleanupKey);
  BREAKER_BEAM_READY.delete(cleanupKey);
  BREAKER_FAST_START_DONE.delete(cleanupKey);
  BREAKER_STALE_FRAME_CLEAN_Y.delete(cleanupKey);
  BREAKER_BACKGROUND_FRAME_SWEEP.delete(cleanupKey);
  RANGE_CACHE.clear();
  const cleanupJob = BREAKER_STARTUP_HEAD_CLEANUP_JOBS.get(cleanupKey);
  if (cleanupJob !== undefined) { try { system.clearJob(cleanupJob); } catch {} BREAKER_STARTUP_HEAD_CLEANUP_JOBS.delete(cleanupKey); }
  const head = findOwnedHead(marker); if (head) head.remove(); marker.remove();
  if (range) scheduleBreakerInitialFrameDecay(ev.block, range);
  else removeBreakerTickingArea(ev.block);
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
          const ownerKey = breakerLiquidMonitorKey(marker);
          // BR-F53: Start/End edits mean a new setup attempt. Wake a completed Breaker
          // so marker guide beams and range validation are allowed to run again.
          BREAKER_FINISHED_SLEEP.delete(ownerKey);
          BREAKER_STARTUP_RANGE_STATE.delete(ownerKey);
          BREAKER_STARTUP_READY_NOTIFIED.delete(ownerKey);
          BREAKER_STARTUP_BEAM_SUCCESS_NOTIFIED.delete(ownerKey);
      BREAKER_BEAM_READY.delete(ownerKey);
          const range = getRange(node);
          notifyBreakerRangeState(node, marker, range);
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
  if (broken === BREAKER_START_BLOCK || broken === BREAKER_END_BLOCK) {
    system.run(() => {
      for (const marker of ev.dimension.getEntities({ type: BREAKER_NODE_ENTITY })) {
        try {
          const p = marker.location;
          const node = getBlock(ev.dimension, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
          if (node?.typeId !== BREAKER_NODE_BLOCK) continue;
          const ownerKey = breakerLiquidMonitorKey(marker);
          BREAKER_FINISHED_SLEEP.delete(ownerKey);
          BREAKER_STARTUP_RANGE_STATE.delete(ownerKey);
          BREAKER_STARTUP_READY_NOTIFIED.delete(ownerKey);
        } catch {}
      }
    });
  }
});