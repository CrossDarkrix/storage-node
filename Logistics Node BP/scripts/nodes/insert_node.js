import { system, world } from "@minecraft/server";
import { INSERT_NODE_BLOCK, DIMENSION_IDS } from "../config/constants.js";
import {
  ADJACENT_DIRECTIONS,
  getBlockContainer,
  getContainerTargetAtBlock,
  isSafeBlockContainer,
} from "../core/container.js";
import { buildNetworkItemIndex } from "../core/network_item_index.js";
import { ensureMarkerForBlock, findMarkerAtBlock } from "../core/marker.js";
import { getEnderMode, ENDER_MODE_RECEIVE } from "./ender_node.js";

const INSERT_NODE_ENTITY = "entity:insert_node";
const INTERVAL = 1,
  MAX_ITEMS = 64;
function adjacent(block, d) {
  try {
    return block.dimension.getBlock({
      x: block.location.x + d.x,
      y: block.location.y + d.y,
      z: block.location.z + d.z,
    });
  } catch {
    return undefined;
  }
}
function ensureMarker(block) {
  return ensureMarkerForBlock(
    block,
    INSERT_NODE_ENTITY,
    null,
    INSERT_NODE_BLOCK,
  );
}
function canFit(container, item) {
  for (let i = 0; i < container.size; i++) {
    const e = container.getItem(i);
    if (!e) return true;
    try {
      if (e.isStackableWith(item) && e.amount < e.maxAmount) return true;
    } catch {}
  }
  return false;
}
function chooseFreshTarget(nodeBlock, item) {
  // IN-2A: buildNetworkItemIndex uses storage_discovery, which resolves both
  // vanilla storage and vfh:large_container entity-backed inventories.
  // Rebuild for every transfer attempt so Large Container placement/removal
  // and capacity changes are reflected immediately.
  const index = buildNetworkItemIndex(nodeBlock);
  for (const t of index?.storage?.containers ?? []) {
    const c = t?.container;
    try {
      if (c?.isValid && canFit(c, item)) return { container: c, target: t };
    } catch {}
  }
  return undefined;
}
function process(block) {
  if (block?.typeId !== INSERT_NODE_BLOCK) return;
  for (const d of ADJACENT_DIRECTIONS) {
    const sb = adjacent(block, d);
    if (!sb) continue;
    // IN-2A input: Vanilla safe containers and the entity-backed Large Container
    // are both valid Insert Node sources. getBlockContainer() already applies
    // the Large Container entity type guard.
    const largeContainerSource = sb.typeId === "vfh:large_container";
    const enderSource = sb.typeId === "vfh:ender_node";
    if (!isSafeBlockContainer(sb) && !largeContainerSource && !enderSource)
      continue;

    let source;
    if (enderSource) {
      const enderTarget = getContainerTargetAtBlock(sb);
      if (enderTarget?.entity?.typeId !== "entity:ender_node") continue;
      // Only RECEIVE is an inbound Ender endpoint. This prevents Insert Node
      // from draining SEND buffers and fighting the existing Ender routing.
      if (getEnderMode(enderTarget.entity) !== ENDER_MODE_RECEIVE) continue;
      source = enderTarget.container;
    } else {
      source = getBlockContainer(sb);
    }
    if (!source?.isValid) continue;
    for (let slot = 0; slot < source.size; slot++) {
      const live = source.getItem(slot);
      if (!live) continue;
      const amount = Math.min(live.amount, MAX_ITEMS),
        candidate = live.clone();
      candidate.amount = amount;
      const selected = chooseFreshTarget(block, candidate);
      if (!selected) continue;
      const target = selected.container;
      const leftover = target.addItem(candidate),
        inserted = amount - (leftover?.amount ?? 0);
      if (inserted <= 0) continue;
      const now = source.getItem(slot);
      if (!now || !now.isStackableWith(live) || now.amount < inserted) {
        const undo = candidate.clone();
        undo.amount = inserted;
        /* no unsafe cross-slot deletion: stop; source normally cannot mutate inside this synchronous section */ return;
      }
      if (now.amount === inserted) source.setItem(slot, undefined);
      else {
        now.amount -= inserted;
        source.setItem(slot, now);
      }
      // Continue scanning all source slots/adjacent inputs in this tick.
    }
  }
}
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  if (ev.block?.typeId === INSERT_NODE_BLOCK)
    system.run(() => ensureMarker(ev.block));
});
world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
  if (ev.block?.typeId === INSERT_NODE_BLOCK)
    system.run(() => ensureMarker(ev.block));
});
world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const m = findMarkerAtBlock(ev.block, INSERT_NODE_ENTITY);
  if (m)
    try {
      m.remove();
    } catch {}
});
system.runInterval(() => {
  for (const id of DIMENSION_IDS) {
    const dim = world.getDimension(id);
    for (const m of dim.getEntities({ type: INSERT_NODE_ENTITY })) {
      const b = dim.getBlock({
        x: Math.floor(m.location.x),
        y: Math.floor(m.location.y),
        z: Math.floor(m.location.z),
      });
      if (b?.typeId !== INSERT_NODE_BLOCK) {
        try {
          m.remove();
        } catch {}
        continue;
      }
      process(b);
    }
  }
}, INTERVAL);
