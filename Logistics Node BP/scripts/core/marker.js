const OWNER_DIMENSION_PROPERTY = "vfh:owner_dimension";
const OWNER_X_PROPERTY = "vfh:owner_x";
const OWNER_Y_PROPERTY = "vfh:owner_y";
const OWNER_Z_PROPERTY = "vfh:owner_z";

function blockLocation(block) {
  return {
    x: Math.floor(block.location.x),
    y: Math.floor(block.location.y),
    z: Math.floor(block.location.z),
  };
}

export function getMarkerOwner(marker) {
  if (!marker) return null;
  try {
    const dimension = marker.getDynamicProperty(OWNER_DIMENSION_PROPERTY);
    const x = Number(marker.getDynamicProperty(OWNER_X_PROPERTY));
    const y = Number(marker.getDynamicProperty(OWNER_Y_PROPERTY));
    const z = Number(marker.getDynamicProperty(OWNER_Z_PROPERTY));
    if (
      typeof dimension !== "string" ||
      !dimension ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      !Number.isInteger(z)
    )
      return null;
    return { dimension, x, y, z };
  } catch {
    return null;
  }
}

export function setMarkerOwner(marker, block) {
  if (!marker || !block) return false;
  const pos = blockLocation(block);
  try {
    marker.setDynamicProperty(OWNER_DIMENSION_PROPERTY, block.dimension.id);
    marker.setDynamicProperty(OWNER_X_PROPERTY, pos.x);
    marker.setDynamicProperty(OWNER_Y_PROPERTY, pos.y);
    marker.setDynamicProperty(OWNER_Z_PROPERTY, pos.z);
    return true;
  } catch {
    return false;
  }
}

function ownerMatchesBlock(owner, block) {
  if (!owner || !block) return false;
  const pos = blockLocation(block);
  return (
    owner.dimension === block.dimension.id &&
    owner.x === pos.x &&
    owner.y === pos.y &&
    owner.z === pos.z
  );
}

function entityAtBlock(entity, block) {
  if (!entity || !block) return false;
  const pos = blockLocation(block);
  return (
    entity.dimension.id === block.dimension.id &&
    Math.floor(entity.location.x) === pos.x &&
    Math.floor(entity.location.y) === pos.y &&
    Math.floor(entity.location.z) === pos.z
  );
}

function inventoryAmount(marker) {
  try {
    const inventory = marker.getComponent("minecraft:inventory")?.container;
    if (!inventory) return 0;
    let total = 0;
    for (let slot = 0; slot < inventory.size; slot++)
      total += inventory.getItem(slot)?.amount ?? 0;
    return total;
  } catch {
    return 0;
  }
}

function mergeInventory(sourceMarker, targetMarker) {
  const source = sourceMarker?.getComponent("minecraft:inventory")?.container;
  const target = targetMarker?.getComponent("minecraft:inventory")?.container;
  if (!source || !target) return false;
  for (let slot = 0; slot < source.size; slot++) {
    const item = source.getItem(slot);
    if (!item) continue;
    const leftover = target.addItem(item);
    if (!leftover) source.setItem(slot, undefined);
    else source.setItem(slot, leftover);
  }
  return true;
}

function selectCanonicalMarker(candidates, block) {
  if (!candidates || candidates.length === 0) return undefined;
  return candidates.reduce((best, current) => {
    const bestOwned = ownerMatchesBlock(getMarkerOwner(best), block);
    const currentOwned = ownerMatchesBlock(getMarkerOwner(current), block);
    if (currentOwned !== bestOwned) return currentOwned ? current : best;
    const bestAmount = inventoryAmount(best);
    const currentAmount = inventoryAmount(current);
    if (currentAmount !== bestAmount) return currentAmount > bestAmount ? current : best;
    return String(current.id) < String(best.id) ? current : best;
  });
}

function consolidateDuplicateMarkers(candidates, marker, block) {
  if (!marker) return undefined;
  if (!setMarkerOwner(marker, block)) return undefined;
  for (const duplicate of candidates) {
    if (duplicate.id === marker.id) continue;
    try {
      mergeInventory(duplicate, marker);
    } catch {}
    // Do not drop duplicate inventory into the world. Any leftover that could not
    // be merged remains protected in the duplicate marker instead of being lost.
    if (inventoryAmount(duplicate) > 0) continue;
    try {
      duplicate.remove();
    } catch {}
  }
  return marker;
}

export function findMarkerAtBlock(block, entityType) {
  if (!block) return undefined;
  let markers = [];
  try {
    markers = block.dimension.getEntities({ type: entityType });
  } catch {
    return undefined;
  }
  const candidates = markers.filter(
    (entity) =>
      ownerMatchesBlock(getMarkerOwner(entity), block) ||
      entityAtBlock(entity, block),
  );
  const marker = selectCanonicalMarker(candidates, block);
  return consolidateDuplicateMarkers(candidates, marker, block);
}

export function ensureMarkerForBlock(
  block,
  entityType,
  initialize = null,
  expectedBlockType = null,
) {
  if (!block) return null;
  if (expectedBlockType && block.typeId !== expectedBlockType) return null;

  let markers = [];
  try {
    markers = block.dimension.getEntities({ type: entityType });
  } catch {
    return null;
  }

  const candidates = markers.filter(
    (entity) =>
      ownerMatchesBlock(getMarkerOwner(entity), block) ||
      entityAtBlock(entity, block),
  );
  let marker = selectCanonicalMarker(candidates, block) ?? null;
  const created = !marker;

  if (created) {
    try {
      marker = block.dimension.spawnEntity(entityType, {
        x: block.location.x + 0.5,
        y: block.location.y + 0.5,
        z: block.location.z + 0.5,
      });
    } catch {
      return null;
    }
    if (!marker) return null;

    try {
      if (typeof initialize === "function") initialize(marker, block);
    } catch {
      try {
        marker.remove();
      } catch {}
      return null;
    }
  }

  if (!setMarkerOwner(marker, block)) {
    if (created) {
      try {
        marker.remove();
      } catch {}
    }
    return null;
  }

  const owner = getMarkerOwner(marker);
  if (!ownerMatchesBlock(owner, block)) {
    if (created) {
      try {
        marker.remove();
      } catch {}
    }
    return null;
  }

  try {
    marker.teleport({
      x: block.location.x + 0.5,
      y: block.location.y + 0.5,
      z: block.location.z + 0.5,
    });
  } catch {}

  return consolidateDuplicateMarkers(candidates, marker, block) ?? null;
}

// Consecutive owner-block mismatches are tracked in memory so a chunk reload
// cannot delete a persistent marker on the first transient bad read.
const OWNER_MISMATCH_LIMIT = 8;
const ownerMismatchCounts = new Map();

export function repairOwnedMarker(marker, entityType, blockType) {
  if (!marker) return false;
  const owner = getMarkerOwner(marker);
  
  if (!owner || owner.dimension !== marker.dimension.id) return false;
  let block;
  try {
    if (!marker.dimension.isChunkLoaded({ x: owner.x, y: owner.y, z: owner.z }))
      return false;
    block = marker.dimension.getBlock({ x: owner.x, y: owner.y, z: owner.z });
  } catch {
    return false;
  }
  if (!block || block.typeId !== blockType) {
    const markerId = marker.id;
    const count = (ownerMismatchCounts.get(markerId) ?? 0) + 1;
    ownerMismatchCounts.set(markerId, count);
    if (count < OWNER_MISMATCH_LIMIT) return false;

    ownerMismatchCounts.delete(markerId);
    dropEntityInventory(marker);
    try {
      marker.remove();
    } catch {}
    return true;
  }

  ownerMismatchCounts.delete(marker.id);
  ensureMarkerForBlock(block, entityType);
  return true;
}

export function dropEntityInventory(marker) {
  const inventory = marker.getComponent("minecraft:inventory")?.container;
  if (!inventory) return;
  for (let slot = 0; slot < inventory.size; slot++) {
    const item = inventory.getItem(slot);
    if (!item) continue;
    marker.dimension.spawnItem(item, {
      x: marker.location.x,
      y: marker.location.y + 0.5,
      z: marker.location.z,
    });
    inventory.setItem(slot, undefined);
  }
}
