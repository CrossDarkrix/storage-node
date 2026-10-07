import { world, system, ItemStack } from "@minecraft/server";
const BLOCK = "vfh:large_container",
  ENTITY = "vfh:large_container_storage",
  WAND = "vfh:debug_wand";
const pending = new Map();
function pendingEntry(e, home, p) {
  return { e, home, playerId: p?.id ?? "" };
}
function key(d, q) {
  return `${d.id}|${q.x}|${q.y}|${q.z}`;
}
function sameBlock(b, e) {
  const q = e.location;
  return (
    Math.floor(q.x) === b.x &&
    Math.floor(q.y) === b.y &&
    Math.floor(q.z) === b.z
  );
}
function centerOf(b) {
  return { x: b.location.x + 0.5, y: b.location.y, z: b.location.z + 0.5 };
}
function find(b) {
  for (const e of b.dimension.getEntities({
    type: ENTITY,
    location: centerOf(b),
    maxDistance: 0.75,
  }))
    if (e?.isValid && sameBlock(b, e)) return e;
  return null;
}
function spawnStorageEntity(b) {
  if (!b || b.typeId !== BLOCK) return null;
  try {
    const e = b.dimension.spawnEntity(ENTITY, centerOf(b));
    if (!e?.isValid) return null;
    if (!e.getComponent("minecraft:inventory")?.container) {
      try {
        e.remove();
      } catch {}
      return null;
    }
    return e;
  } catch (err) {
    (() => {})(`[LC-2A] spawn failed: ${err}`);
    return null;
  }
}
function ensure(b) {
  let e = find(b);
  if (!e) e = spawnStorageEntity(b);
  if (!e) return null;
  try {
    e.teleport(centerOf(b));
    e.nameTag = "Large Container";
  } catch {}
  return e;
}

function capacityRedstonePower(c) {
  if (!c) return 0;
  let fullness = 0,
    nonEmpty = false;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (!it) continue;
    nonEmpty = true;
    const max = Math.max(1, Number(it.maxAmount ?? 64));
    fullness += it.amount / max;
  }
  if (!nonEmpty) return 0;
  return Math.max(1, Math.min(15, Math.floor(1 + 14 * (fullness / c.size))));
}
function syncCapacityRedstone(b, e) {
  if (!b || b.typeId !== BLOCK || !e?.isValid) return;
  const c = e.getComponent("minecraft:inventory")?.container;
  if (!c) return;
  const power = capacityRedstonePower(c);
  try {
    if (b.permutation.getState("vfh:redstone_power") !== power)
      b.setPermutation(b.permutation.withState("vfh:redstone_power", power));
  } catch (err) {
    (() => {})(`[LC-RS] sync failed: ${err}`);
  }
}
function empty(c) {
  for (let i = 0; i < c.size; i++) if (c.getItem(i)) return false;
  return true;
}
function drain(e, pos) {
  const c = e?.getComponent("minecraft:inventory")?.container;
  if (!c) return false;
  for (let i = 0; i < c.size; i++) {
    const it = c.getItem(i);
    if (!it) continue;
    try {
      e.dimension.spawnItem(it, pos);
      c.setItem(i, undefined);
    } catch (err) {
      (() => {})(`[LC-2A] slot ${i} drop failed: ${err}`);
      return false;
    }
  }
  return empty(c);
}
function giveRecovery(dim, pos) {
  try {
    dim.spawnItem(new ItemStack(WAND, 1), pos);
  } catch (err) {
    (() => {})(`[LC-2A] recovery wand drop failed: ${err}`);
  }
}
function finishRemoval(e, pos, dropRecovery = true) {
  if (!e?.isValid) return true;
  if (!drain(e, pos)) {
    if (dropRecovery) giveRecovery(e.dimension, pos);
    return false;
  }
  try {
    e.remove();
    return true;
  } catch (err) {
    (() => {})(`[LC-2A] entity remove failed: ${err}`);
    if (dropRecovery) giveRecovery(e.dimension, pos);
    return false;
  }
}
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  if (ev.block?.typeId !== BLOCK) return;
  const d = ev.block.dimension,
    q = { ...ev.block.location };
  system.run(() => {
    try {
      const b = d.getBlock(q);
      if (b?.typeId === BLOCK) {
        const e = ensure(b);
        if (e) syncCapacityRedstone(b, e);
      }
    } catch {}
  });
});
world.beforeEvents.playerInteractWithEntity.subscribe((ev) => {
  const p = ev.player,
    e = ev.target;
  if (!p?.isSneaking || e?.typeId !== ENTITY) return;
  ev.cancel = true;
  const loc = e.location,
    home = {
      x: Math.floor(loc.x) + 0.5,
      y: Math.floor(loc.y) + 0.5,
      z: Math.floor(loc.z) + 0.5,
    };
  system.run(() => {
    if (!e?.isValid) return;
    try {
      e.teleport({ x: home.x, y: home.y + 10, z: home.z });
      pending.set(
        key(e.dimension, {
          x: Math.floor(home.x),
          y: Math.floor(home.y),
          z: Math.floor(home.z),
        }),
        pendingEntry(e, home, p),
      );
    } catch (err) {
      (() => {})(`[LC-2B] pre-interact evacuation failed: ${err}`);
    }
  });
});
world.afterEvents.entityHitEntity.subscribe((ev) => {
  const p = ev.damagingEntity,
    e = ev.hitEntity;
  if (p?.typeId !== "minecraft:player" || !p.isSneaking || e?.typeId !== ENTITY)
    return;
  const loc = e.location,
    q = { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) },
    home = { x: q.x + 0.5, y: q.y + 0.5, z: q.z + 0.5 },
    dim = e.dimension;
  system.run(() => {
    if (!e?.isValid) return;
    try {
      e.teleport({ x: home.x, y: home.y + 10, z: home.z });
      const b = dim.getBlock(q);
      if (b?.typeId !== BLOCK) {
        try {
          e.teleport(home);
        } catch {}
        return;
      }
      const blockDrop = b.permutation.getItemStack(1);
      b.setType("minecraft:air");
      if (blockDrop) dim.spawnItem(blockDrop, home);
      finishRemoval(e, home, true);
      pending.delete(key(dim, q));
    } catch (err) {
      (() => {})(`[LC-2E] one-click removal failed: ${err}`);
      try {
        if (e?.isValid) e.teleport(home);
      } catch {}
    }
  });
});
world.beforeEvents.playerBreakBlock.subscribe((ev) => {
  if (ev.block?.typeId !== BLOCK) return;
  const p = ev.player;
  if (!p?.isSneaking) {
    ev.cancel = true;
    return;
  }
  const b = ev.block,
    e = find(b);
  if (!e) return;
  const home = centerOf(b),
    up = { x: home.x, y: home.y + 10, z: home.z };
  try {
    e.teleport(up);
    pending.set(key(b.dimension, b.location), pendingEntry(e, home, p));
  } catch (err) {
    ev.cancel = true;
    (() => {})(`[LC-2A] pre-break teleport failed: ${err}`);
  }
});
world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const id =
    ev.brokenBlockPermutation?.type?.id ??
    ev.brokenBlockPermutation?.typeId ??
    "";
  if (id !== BLOCK) return;
  const q = ev.block.location,
    k = key(ev.dimension, q),
    r = pending.get(k);
  pending.delete(k);
  const pos = { x: q.x + 0.5, y: q.y + 0.5, z: q.z + 0.5 };
  if (r?.e?.isValid) {
    finishRemoval(r.e, pos, true);
    return;
  }
  for (const e of ev.dimension.getEntities({
    type: ENTITY,
    location: pos,
    maxDistance: 11.5,
  }))
    if (e?.isValid) finishRemoval(e, pos, true);
});
world.afterEvents.playerInteractWithBlock.subscribe((ev) => {
  const p = ev.player,
    b = ev.block;
  if (b?.typeId !== BLOCK || !p?.isSneaking) return;
  const dim = b.dimension,
    q = { ...b.location },
    home = centerOf(b);
  system.run(() => {
    try {
      const current = dim.getBlock(q);
      if (current?.typeId !== BLOCK) return;
      const e = ensure(current);
      if (!e?.isValid) return;
      e.teleport({ x: home.x, y: home.y + 10, z: home.z });
      pending.set(key(dim, q), pendingEntry(e, home, p));
    } catch (err) {
      (() => {})(`[LC-2F] block-interact evacuation failed: ${err}`);
    }
  });
});
system.runInterval(() => {
  for (const [k, r] of pending) {
    if (!r.e?.isValid) {
      pending.delete(k);
      continue;
    }
    let p = null;
    try {
      p = world.getAllPlayers().find((x) => x.id === r.playerId) ?? null;
    } catch {}
    if (p?.isSneaking) continue;
    const parts = k.split("|");
    if (parts.length < 4) {
      pending.delete(k);
      continue;
    }
    let b = null;
    try {
      b = r.e.dimension.getBlock({
        x: Number(parts[1]),
        y: Number(parts[2]),
        z: Number(parts[3]),
      });
    } catch {}
    if (b?.typeId !== BLOCK) continue;
    try {
      r.e.teleport(r.home);
    } catch (err) {
      (() => {})(`[LC-2D] sneak-release return failed: ${err}`);
      continue;
    }
    pending.delete(k);
  }
}, 2);
// P2: spread capacity-redstone verification across ticks instead of rescanning every Large Container every 10 ticks.
// VFH has no documented entity-inventory change event in the 2.7 surface used here, so a bounded
// round-robin verifier preserves direct inventory/external mutation detection without burst scanning.
const CAPACITY_VERIFY_PER_TICK = 1;
let capacityVerifyQueue = [];
let capacityVerifyCursor = 0;
function refillCapacityVerifyQueue() {
  const next = [];
  for (const id of [
    "minecraft:overworld",
    "minecraft:nether",
    "minecraft:the_end",
  ]) {
    let dim = null;
    try {
      dim = world.getDimension(id);
    } catch {}
    if (!dim) continue;
    try {
      for (const e of dim.getEntities({ type: ENTITY }))
        if (e?.isValid) next.push(e);
    } catch {}
  }
  capacityVerifyQueue = next;
  capacityVerifyCursor = 0;
}
function verifyOneLargeContainer(e) {
  if (!e?.isValid) return;
  const q = {
    x: Math.floor(e.location.x),
    y: Math.floor(e.location.y),
    z: Math.floor(e.location.z),
  };
  try {
    const b = e.dimension.getBlock(q);
    if (b?.typeId === BLOCK) {
      syncCapacityRedstone(b, e);
      return;
    }
    for (const r of pending.values()) if (r.e?.id === e.id) return;
    const pos = { x: q.x + 0.5, y: q.y + 0.5, z: q.z + 0.5 };
    finishRemoval(e, pos, true);
  } catch {}
}
system.runInterval(() => {
  let budget = CAPACITY_VERIFY_PER_TICK;
  while (budget-- > 0) {
    if (capacityVerifyCursor >= capacityVerifyQueue.length) {
      refillCapacityVerifyQueue();
      if (capacityVerifyQueue.length === 0) return;
    }
    verifyOneLargeContainer(capacityVerifyQueue[capacityVerifyCursor++]);
  }
}, 1);
export function tryEmergencyLargeContainerRemove(target, player) {
  if (!target?.isValid || target.typeId !== ENTITY) return false;
  const p = target.location,
    pos = {
      x: Math.floor(p.x) + 0.5,
      y: Math.floor(p.y) + 0.5,
      z: Math.floor(p.z) + 0.5,
    };
  const ok = finishRemoval(target, pos, false);
  if (ok)
    try {
      player?.sendMessage(
        "§a[Large Container] 一時コンテナ削除に成功しました。",
      );
    } catch {}
  else
    try {
      player?.sendMessage(
        "§c[Large Container] 削除できませんでした。アイテムは保持されています。",
      );
    } catch {}
  return ok;
}
