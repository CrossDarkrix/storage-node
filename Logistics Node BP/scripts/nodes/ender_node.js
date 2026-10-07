import { system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { findMarkerAtBlock, ensureMarkerForBlock } from "../core/marker.js";
import { moveBlockToEntity, moveContainerItems } from "../core/transfer.js";
import {
  getAdjacentContainers,
  getBlockContainer,
  getRoundRobinTargets,
  advanceRoundRobin,
} from "../core/container.js";
import { ENDER_NODE_BLOCK, ENDER_NODE_ENTITY } from "../config/constants.js";
import {
  discoverNetworkGraph,
  isNetworkNodeBlock,
} from "../core/network_graph.js";

export const ENDER_CHANNEL_PROPERTY = "ender_channel"; // legacy display/fallback
export const ENDER_CHANNEL_ID_PROPERTY = "ender_channel_id";
export const ENDER_ENDPOINT_ID_PROPERTY = "ender_endpoint_id";
export const ENDER_ENDPOINT_NAME_PROPERTY = "ender_endpoint_name";
export const ENDER_TARGET_PROPERTY = "ender_target";
export const ENDER_REGISTRY_PROPERTY = "vfh:ender_nodes";
export const ENDER_CHANNEL_MAX_LENGTH = 32;
export const ENDER_ENDPOINT_NAME_MAX_LENGTH = 32;
export const ENDER_MODE_PROPERTY = "ender_mode";
export const ENDER_MODE_SEND = "send";
export const ENDER_MODE_RECEIVE = "receive";
const ENDER_REGISTRY_VERSION = 4;
const ENDER_DELIVERY_PRIORITY = "priority";
const ENDER_DELIVERY_ROUND_ROBIN = "round_robin";

function normalizeChannel(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, ENDER_CHANNEL_MAX_LENGTH);
}
function normalizeEndpointName(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, ENDER_ENDPOINT_NAME_MAX_LENGTH);
}
function normalizeId(value, prefix) {
  if (typeof value !== "string") return "";
  const v = value.trim();
  return new RegExp(`^${prefix}_[1-9][0-9]*$`).test(v) ? v : "";
}
function idNumber(value, prefix) {
  const v = normalizeId(value, prefix);
  return v ? Number(v.slice(prefix.length + 1)) : 0;
}
function normalizeCoordinate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}
function normalizeRole(value) {
  return value === ENDER_MODE_SEND ? ENDER_MODE_SEND : ENDER_MODE_RECEIVE;
}
function normalizeDeliveryMode(value) {
  return value === ENDER_DELIVERY_ROUND_ROBIN
    ? ENDER_DELIVERY_ROUND_ROBIN
    : ENDER_DELIVERY_PRIORITY;
}
function normalizeTargetKeys(value) {
  const result = [];
  const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== "string" || !item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return undefined;
  const dimension = typeof entry.dimension === "string" ? entry.dimension : "";
  const x = normalizeCoordinate(entry.x),
    y = normalizeCoordinate(entry.y),
    z = normalizeCoordinate(entry.z);
  if (!dimension || x === undefined || y === undefined || z === undefined)
    return undefined;
  return {
    channel: normalizeChannel(entry.channel),
    channelId: normalizeId(entry.channelId, "ch"),
    endpointId: normalizeId(entry.endpointId, "ep"),
    endpointName: normalizeEndpointName(entry.endpointName),
    role: normalizeRole(entry.role),
    target: typeof entry.target === "string" ? entry.target : "",
    deliveryMode: normalizeDeliveryMode(entry.deliveryMode),
    targets: normalizeTargetKeys(entry.targets),
    roundRobinCursor: Math.max(
      0,
      Math.floor(Number(entry.roundRobinCursor)) || 0,
    ),
    dimension,
    x,
    y,
    z,
  };
}
function entryKey(entry) {
  return `${entry.dimension}|${entry.x}|${entry.y}|${entry.z}`;
}
function targetKey(entry) {
  const n = normalizeEntry(entry);
  return n ? entryKey(n) : "";
}
function emptyRegistry() {
  return {
    version: ENDER_REGISTRY_VERSION,
    nextChannelId: 1,
    nextEndpointId: 1,
    channels: [],
    endpoints: [],
  };
}
function normalizeRegistryV2(value) {
  const r = emptyRegistry(),
    channelIds = new Set();
  for (const x of Array.isArray(value?.channels) ? value.channels : []) {
    const id = normalizeId(x?.id, "ch"),
      name = normalizeChannel(x?.name);
    if (id && !channelIds.has(id)) {
      channelIds.add(id);
      r.channels.push({ id, name });
      r.nextChannelId = Math.max(r.nextChannelId, idNumber(id, "ch") + 1);
    }
  }
  const locations = new Map();
  for (const x of Array.isArray(value?.endpoints) ? value.endpoints : []) {
    const e = normalizeEntry(x);
    if (!e || !e.endpointId || !e.channelId || !channelIds.has(e.channelId))
      continue;
    locations.set(entryKey(e), e);
    r.nextEndpointId = Math.max(
      r.nextEndpointId,
      idNumber(e.endpointId, "ep") + 1,
    );
  }
  r.endpoints = [...locations.values()];
  r.nextChannelId = Math.max(
    r.nextChannelId,
    normalizeCoordinate(value?.nextChannelId) || 1,
  );
  r.nextEndpointId = Math.max(
    r.nextEndpointId,
    normalizeCoordinate(value?.nextEndpointId) || 1,
  );
  return r;
}
function loadRegistryObject() {
  try {
    const raw = world.getDynamicProperty(ENDER_REGISTRY_PROPERTY);
    if (typeof raw !== "string" || !raw) return emptyRegistry();
    const parsed = JSON.parse(raw);
    if (
      parsed?.version === 2 ||
      parsed?.version === 3 ||
      parsed?.version === ENDER_REGISTRY_VERSION
    )
      return normalizeRegistryV2(parsed);
  } catch {}
  return emptyRegistry();
}
function saveRegistryObject(value) {
  const r = normalizeRegistryV2(value);
  world.setDynamicProperty(ENDER_REGISTRY_PROPERTY, JSON.stringify(r));
  return r;
}
function ensureChannelByName(r, name) {
  const n = normalizeChannel(name);
  if (!n) return undefined;
  let ch = r.channels.find((x) => x.name === n);
  if (!ch) {
    ch = { id: `ch_${r.nextChannelId++}`, name: n };
    r.channels.push(ch);
  }
  return ch;
}
function ensureEndpointAt(
  r,
  dimensionId,
  location,
  channelName,
  role = ENDER_MODE_RECEIVE,
) {
  const channel = ensureChannelByName(r, channelName);
  if (!channel) return undefined;
  const key = `${dimensionId}|${Math.floor(location.x)}|${Math.floor(location.y)}|${Math.floor(location.z)}`;
  let e = r.endpoints.find((x) => entryKey(x) === key);
  if (!e) {
    e = {
      channel: channel.name,
      channelId: channel.id,
      endpointId: `ep_${r.nextEndpointId++}`,
      role: normalizeRole(role),
      target: "",
      deliveryMode: ENDER_DELIVERY_PRIORITY,
      targets: [],
      dimension: dimensionId,
      x: Math.floor(location.x),
      y: Math.floor(location.y),
      z: Math.floor(location.z),
    };
    r.endpoints.push(e);
  } else {
    e.channel = channel.name;
    e.channelId = channel.id;
    e.role = normalizeRole(role);
  }
  return e;
}

export function loadEnderRegistry() {
  return loadRegistryObject().endpoints.map((e) => ({
    ...e,
    channel:
      loadRegistryObject().channels.find((c) => c.id === e.channelId)?.name ||
      e.channel ||
      "",
  }));
}
export function saveEnderRegistry(entries) {
  const old = loadRegistryObject(),
    r = emptyRegistry();
  r.nextChannelId = old.nextChannelId;
  r.nextEndpointId = old.nextEndpointId;
  const byId = new Map(old.channels.map((c) => [c.id, c]));
  for (const v of Array.isArray(entries) ? entries : []) {
    const e = normalizeEntry(v);
    if (!e) continue;
    let ch = e.channelId ? byId.get(e.channelId) : undefined;
    if (!ch) ch = ensureChannelByName(r, e.channel);
    else if (!r.channels.some((c) => c.id === ch.id)) r.channels.push(ch);
    if (!ch) continue;
    let endpointId = e.endpointId;
    if (!endpointId) endpointId = `ep_${r.nextEndpointId++}`;
    r.endpoints.push({ ...e, channel: ch.name, channelId: ch.id, endpointId });
  }
  saveRegistryObject(r);
}
export function getEnderChannel(marker) {
  try {
    const channelId = normalizeId(
      marker?.getDynamicProperty(ENDER_CHANNEL_ID_PROPERTY),
      "ch",
    );
    if (channelId) {
      const c = loadRegistryObject().channels.find((x) => x.id === channelId);
      if (c) return c.name;
    }
    return normalizeChannel(marker?.getDynamicProperty(ENDER_CHANNEL_PROPERTY));
  } catch {
    return "";
  }
}
export function getEnderMode(marker) {
  try {
    const v = marker?.getDynamicProperty(ENDER_MODE_PROPERTY);
    return v === ENDER_MODE_SEND || v === ENDER_MODE_RECEIVE
      ? v
      : ENDER_MODE_RECEIVE;
  } catch {
    return ENDER_MODE_RECEIVE;
  }
}
export function getEnderEndpointName(marker) {
  try {
    return normalizeEndpointName(
      marker?.getDynamicProperty(ENDER_ENDPOINT_NAME_PROPERTY),
    );
  } catch {
    return "";
  }
}
export function setEnderEndpointName(marker, value) {
  const name = normalizeEndpointName(value);
  try {
    marker.setDynamicProperty(ENDER_ENDPOINT_NAME_PROPERTY, name);
  } catch {}
  const channel = getEnderChannel(marker);
  if (channel) {
    const r = loadRegistryObject();
    const e = ensureEndpointAt(
      r,
      marker.dimension.id,
      marker.location,
      channel,
      getEnderMode(marker),
    );
    if (e) {
      e.endpointName = name;
      saveRegistryObject(r);
      try {
        marker.setDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY, e.endpointId);
        marker.setDynamicProperty(ENDER_CHANNEL_ID_PROPERTY, e.channelId);
      } catch {}
    }
  }
  return name;
}
export function setEnderMode(marker, value) {
  const mode = value === ENDER_MODE_SEND ? ENDER_MODE_SEND : ENDER_MODE_RECEIVE;
  marker.setDynamicProperty(ENDER_MODE_PROPERTY, mode);
  if (mode === ENDER_MODE_RECEIVE) setEnderTarget(marker, "");
  updateEnderRegistryAt(
    marker.dimension.id,
    marker.location,
    getEnderChannel(marker),
    mode,
    marker,
  );
  return mode;
}
export function getEnderTarget(marker) {
  try {
    const v = marker?.getDynamicProperty(ENDER_TARGET_PROPERTY);
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
export function setEnderTarget(marker, value) {
  const v = typeof value === "string" ? value : "";
  marker.setDynamicProperty(ENDER_TARGET_PROPERTY, v);
  return v;
}
export function setEnderChannel(marker, value) {
  const channel = normalizeChannel(value),
    old = getEnderChannel(marker);
  if (channel !== old) setEnderTarget(marker, "");
  if (!channel) {
    marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY, "");
    marker.setDynamicProperty(ENDER_CHANNEL_ID_PROPERTY, undefined);
    marker.setDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY, undefined);
    removeEnderRegistryAt(marker.dimension.id, marker.location);
    return "";
  }
  const r = loadRegistryObject(),
    e = ensureEndpointAt(
      r,
      marker.dimension.id,
      marker.location,
      channel,
      getEnderMode(marker),
    );
  saveRegistryObject(r);
  marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY, channel);
  marker.setDynamicProperty(ENDER_CHANNEL_ID_PROPERTY, e.channelId);
  marker.setDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY, e.endpointId);
  return channel;
}
export function updateEnderRegistryAt(
  dimensionId,
  location,
  channel = "",
  role = ENDER_MODE_RECEIVE,
  marker = undefined,
) {
  const n = normalizeChannel(channel);
  if (!n) return false;
  const r = loadRegistryObject(),
    e = ensureEndpointAt(r, dimensionId, location, n, role);
  if (!e) return false;
  if (marker) {
    const markerName = getEnderEndpointName(marker);
    if (markerName || !e.endpointName) e.endpointName = markerName;
  }
  saveRegistryObject(r);
  if (marker) {
    try {
      marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY, n);
      marker.setDynamicProperty(ENDER_CHANNEL_ID_PROPERTY, e.channelId);
      marker.setDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY, e.endpointId);
      marker.setDynamicProperty(
        ENDER_ENDPOINT_NAME_PROPERTY,
        e.endpointName || "",
      );
    } catch {}
  }
  return true;
}
export function removeEnderRegistryAt(dimensionId, location) {
  const r = loadRegistryObject(),
    key = `${dimensionId}|${Math.floor(location.x)}|${Math.floor(location.y)}|${Math.floor(location.z)}`,
    before = r.endpoints.length;
  r.endpoints = r.endpoints.filter((e) => entryKey(e) !== key);
  if (r.endpoints.length === before) return false;
  saveRegistryObject(r);
  return true;
}
export function findEnderChannelEntries(
  channel,
  excludeDimensionId,
  excludeLocation,
) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return [];
  const r = loadRegistryObject(),
    ids = new Set(
      r.channels.filter((c) => c.name === normalized).map((c) => c.id),
    );
  let excludeKey = "";
  if (excludeDimensionId && excludeLocation)
    excludeKey = `${excludeDimensionId}|${Math.floor(excludeLocation.x)}|${Math.floor(excludeLocation.y)}|${Math.floor(excludeLocation.z)}`;
  return r.endpoints
    .filter(
      (e) =>
        ids.has(e.channelId) && (!excludeKey || entryKey(e) !== excludeKey),
    )
    .map((e) => ({ ...e, channel: normalized }));
}
export function findLinkedEnderEntries(marker) {
  if (!marker) return [];
  try {
    const channelId = normalizeId(
      marker.getDynamicProperty(ENDER_CHANNEL_ID_PROPERTY),
      "ch",
    );
    const endpointId = normalizeId(
      marker.getDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY),
      "ep",
    );
    if (!channelId || !endpointId) return [];
    const r = loadRegistryObject();
    const selfKey = entryKey({
      dimension: marker.dimension.id,
      x: marker.location.x,
      y: marker.location.y,
      z: marker.location.z,
    });
    const ch = r.channels.find((c) => c.id === channelId);
    return r.endpoints
      .filter((e) => e.channelId === channelId && entryKey(e) !== selfKey)
      .map((e) => ({ ...e, channel: ch?.name || "" }));
  } catch {
    return [];
  }
}

export function inspectEnderEntry(entry) {
  const n = normalizeEntry(entry);
  if (!n)
    return {
      entry: undefined,
      loaded: false,
      blockPresent: false,
      markerPresent: false,
    };
  try {
    const d = world.getDimension(n.dimension),
      l = { x: n.x, y: n.y, z: n.z };
    if (!d.isChunkLoaded(l))
      return {
        entry: n,
        loaded: false,
        blockPresent: false,
        markerPresent: false,
      };
    const b = d.getBlock(l),
      blockPresent = b?.typeId === ENDER_NODE_BLOCK,
      markerPresent = blockPresent
        ? !!findMarkerAtBlock(b, ENDER_NODE_ENTITY)
        : false;
    return { entry: n, loaded: true, blockPresent, markerPresent };
  } catch {
    return {
      entry: n,
      loaded: false,
      blockPresent: false,
      markerPresent: false,
    };
  }
}
export function inspectLinkedEnderNodes(marker) {
  return findLinkedEnderEntries(marker).map(inspectEnderEntry);
}

export function getRegisteredEnderChannels() {
  return [
    ...new Set(
      loadEnderRegistry()
        .map((e) => normalizeChannel(e.channel))
        .filter(Boolean),
    ),
  ].sort((a, b) => a.localeCompare(b));
}
export function deleteEnderChannelByName(channel) {
  const name = normalizeChannel(channel);
  if (!name) return false;
  const r = loadRegistryObject();
  const ids = new Set(
    r.channels.filter((c) => c.name === name).map((c) => c.id),
  );
  if (!ids.size) return false;
  r.channels = r.channels.filter((c) => !ids.has(c.id));
  r.endpoints = r.endpoints.filter((e) => !ids.has(e.channelId));
  saveRegistryObject(r);
  return true;
}

const ENDER_TICKING_PREFIX = "vfh_en";
function areaNum(v) {
  const n = Math.floor(Number(v));
  return n < 0 ? `m${-n}` : `${n}`;
}
function areaDimTag(id) {
  if (id === "minecraft:overworld") return "o";
  if (id === "minecraft:nether") return "n";
  if (id === "minecraft:the_end") return "e";
  return "x";
}
export function enderTargetAreaName(entry) {
  const n = normalizeEntry(entry);
  return n
    ? `${ENDER_TICKING_PREFIX}_${areaDimTag(n.dimension)}_${areaNum(n.x)}_${areaNum(n.y)}_${areaNum(n.z)}`
    : "";
}
function adjacentBlock(block, direction) {
  try {
    return block.dimension.getBlock({
      x: block.location.x + direction.x,
      y: block.location.y + direction.y,
      z: block.location.z + direction.z,
    });
  } catch {
    return null;
  }
}
function findEnderNetworkStart(enderBlock) {
  for (const direction of [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ]) {
    const block = adjacentBlock(enderBlock, direction);
    if (block && isNetworkNodeBlock(block)) return block;
  }
  return null;
}
function includePoint(bounds, location) {
  if (!location) return bounds;
  const x = Math.floor(location.x),
    y = Math.floor(location.y),
    z = Math.floor(location.z);
  if (!bounds) return { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
  bounds.minX = Math.min(bounds.minX, x);
  bounds.maxX = Math.max(bounds.maxX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxY = Math.max(bounds.maxY, y);
  bounds.minZ = Math.min(bounds.minZ, z);
  bounds.maxZ = Math.max(bounds.maxZ, z);
  return bounds;
}
function discoverEnderNetworkBounds(entry) {
  const n = normalizeEntry(entry);
  if (!n) return undefined;
  const dimension = world.getDimension(n.dimension);
  const enderLocation = { x: n.x, y: n.y, z: n.z };
  let bounds = includePoint(null, enderLocation);
  if (!dimension.isChunkLoaded(enderLocation))
    return { dimension, bounds, graph: null };
  const enderBlock = dimension.getBlock(enderLocation);
  const start = findEnderNetworkStart(enderBlock);
  if (!start) return { dimension, bounds, graph: null };
  const graph = discoverNetworkGraph(start);
  for (const block of graph.nodes ?? [])
    bounds = includePoint(bounds, block.location);
  // Include all six neighbor positions of every network node so adjacent storage
  // containers, including both halves of a large chest, are inside the area.
  for (const block of graph.nodes ?? []) {
    for (const direction of [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ]) {
      bounds = includePoint(bounds, {
        x: block.location.x + direction.x,
        y: block.location.y + direction.y,
        z: block.location.z + direction.z,
      });
    }
  }
  return { dimension, bounds, graph };
}
function enderTargetAreaOptions(entry) {
  const n = normalizeEntry(entry);
  if (!n) return undefined;
  const discovered = discoverEnderNetworkBounds(n);
  if (!discovered) return undefined;
  const { dimension, bounds } = discovered;
  const options = {
    dimension,
    from: { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
    to: { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ },
  };
  return options;
}
export function removeEnderTargetArea(entry) {
  const n = normalizeEntry(entry);
  if (!n) return { ok: false, error: "invalid target" };
  const name = enderTargetAreaName(n);
  try {
    const manager = world.tickingAreaManager;
    if (manager.hasTickingArea(name)) manager.removeTickingArea(name);
    return { ok: true, name };
  } catch (err) {
    return { ok: false, name, error: String(err?.message ?? err) };
  }
}
const ENDER_BOOTSTRAP_RADIUS_BLOCKS = 16;
const ENDER_BOOTSTRAP_MAX_RADIUS_BLOCKS = 128;

function enderBootstrapOptions(dimension, point, radius) {
  return {
    dimension,
    from: { x: point.x - radius, y: point.y - 1, z: point.z - radius },
    to: { x: point.x + radius, y: point.y + 1, z: point.z + radius },
  };
}

export async function applyEnderTargetArea(entry) {
  const n = normalizeEntry(entry);
  if (!n) return { ok: false, error: "invalid target" };
  const name = enderTargetAreaName(n);
  try {
    const manager = world.tickingAreaManager;
    const dimension = world.getDimension(n.dimension);
    const point = { x: n.x, y: n.y, z: n.z };

    // Progressive bootstrap: grow the temporary area around the remote Ender,
    // rediscover the graph, and stop once two consecutive passes resolve the
    // same graph and bounds.
    let previousSignature = "";
    let stablePasses = 0;
    let finalOptions = null;

    for (
      let radius = ENDER_BOOTSTRAP_RADIUS_BLOCKS;
      radius <= ENDER_BOOTSTRAP_MAX_RADIUS_BLOCKS;
      radius *= 2
    ) {
      const bootstrap = enderBootstrapOptions(dimension, point, radius);
      if (manager.hasTickingArea(name)) manager.removeTickingArea(name);
      if (!manager.hasCapacity(bootstrap))
        return { ok: false, name, error: "ticking area capacity exceeded" };
      await manager.createTickingArea(name, bootstrap);
      const bootstrapArea = manager.getTickingArea(name);
      if (!bootstrapArea?.isFullyLoaded)
        return { ok: false, name, error: "ticking area not fully loaded" };

      const discovered = discoverEnderNetworkBounds(n);
      if (!discovered)
        return { ok: false, name, error: "invalid target options" };
      const bounds = discovered.bounds;
      const graphNodes = discovered.graph?.nodes?.length ?? 0;
      const graphEdges = discovered.graph?.edges?.length ?? 0;
      const options = {
        dimension,
        from: { x: bounds.minX, y: bounds.minY, z: bounds.minZ },
        to: { x: bounds.maxX, y: bounds.maxY, z: bounds.maxZ },
      };
      const signature = `${graphNodes}|${graphEdges}|${options.from.x},${options.from.y},${options.from.z}|${options.to.x},${options.to.y},${options.to.z}`;
      finalOptions = options;
      if (signature === previousSignature) stablePasses += 1;
      else stablePasses = 0;
      previousSignature = signature;
      if (stablePasses >= 1) break;
    }

    if (!finalOptions)
      return { ok: false, name, error: "invalid target options" };
    if (manager.hasTickingArea(name)) manager.removeTickingArea(name);
    if (!manager.hasCapacity(finalOptions))
      return { ok: false, name, error: "ticking area capacity exceeded" };
    await manager.createTickingArea(name, finalOptions);
    const area = manager.getTickingArea(name);
    return {
      ok: !!area?.isFullyLoaded,
      name,
      reused: false,
      error: area?.isFullyLoaded ? "" : "ticking area not fully loaded",
      from: finalOptions.from,
      to: finalOptions.to,
      chunkCount: area?.chunkCount,
    };
  } catch (err) {
    return { ok: false, name, error: String(err?.message ?? err) };
  }
}
export async function ensureEnderTargetArea(marker) {
  const target = getEnderTarget(marker);
  const entry = findEnderEntryByTargetKey(target);
  if (!entry) return { ok: false, error: "target not registered" };
  if (entry.channel !== getEnderChannel(marker))
    return { ok: false, error: "channel mismatch", entry };
  return { ...(await applyEnderTargetArea(entry)), entry };
}

export async function resolveEnderRemoteEndpoint(marker) {
  const channel = getEnderChannel(marker);
  const target = getEnderTarget(marker);
  if (!marker)
    return {
      ok: false,
      reason: "source_marker_missing",
      channel: "",
      target: "",
    };
  if (getEnderMode(marker) !== ENDER_MODE_SEND)
    return { ok: false, reason: "source_not_send", channel, target };
  if (!channel) return { ok: false, reason: "channel_empty", channel, target };
  if (!target) return { ok: false, reason: "target_empty", channel, target };
  const entry = findEnderEntryByTargetKey(target);
  if (!entry)
    return { ok: false, reason: "target_not_registered", channel, target };
  if (entry.channel !== channel)
    return { ok: false, reason: "channel_mismatch", channel, target, entry };
  const area = await applyEnderTargetArea(entry);
  if (!area.ok)
    return {
      ok: false,
      reason: "target_chunk_unavailable",
      channel,
      target,
      entry,
      area,
    };
  try {
    const dimension = world.getDimension(entry.dimension);
    const location = { x: entry.x, y: entry.y, z: entry.z };
    if (!dimension.isChunkLoaded(location))
      return {
        ok: false,
        reason: "target_chunk_not_loaded",
        channel,
        target,
        entry,
        area,
        dimension,
      };
    const block = dimension.getBlock(location);
    if (!block || block.typeId !== ENDER_NODE_BLOCK)
      return {
        ok: false,
        reason: "target_block_missing",
        channel,
        target,
        entry,
        area,
        dimension,
        block,
      };
    const targetMarker = findMarkerAtBlock(block, ENDER_NODE_ENTITY);
    if (!targetMarker)
      return {
        ok: false,
        reason: "target_marker_missing",
        channel,
        target,
        entry,
        area,
        dimension,
        block,
      };
    if (getEnderChannel(targetMarker) !== channel)
      return {
        ok: false,
        reason: "target_marker_channel_mismatch",
        channel,
        target,
        entry,
        area,
        dimension,
        block,
        marker: targetMarker,
      };
    if (getEnderMode(targetMarker) !== ENDER_MODE_RECEIVE)
      return {
        ok: false,
        reason: "target_not_receive",
        channel,
        target,
        entry,
        area,
        dimension,
        block,
        marker: targetMarker,
      };
    return {
      ok: true,
      reason: "ok",
      channel,
      target,
      entry,
      area,
      dimension,
      block,
      marker: targetMarker,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "endpoint_error",
      channel,
      target,
      entry,
      area,
      error: String(error?.message ?? error),
    };
  }
}

export async function transferEnderMarkerToRemoteMarker(marker, maxItems = 1) {
  const limit = Math.max(0, Math.floor(Number(maxItems)) || 0);
  if (!marker)
    return { ok: false, reason: "source_marker_missing", transferred: 0 };
  if (limit <= 0)
    return { ok: false, reason: "invalid_max_items", transferred: 0 };
  const endpoint = await resolveEnderRemoteEndpoint(marker);
  if (!endpoint.ok)
    return { ok: false, reason: endpoint.reason, transferred: 0, endpoint };
  if (endpoint.marker.id === marker.id)
    return { ok: false, reason: "same_marker", transferred: 0, endpoint };
  try {
    const source = marker.getComponent("minecraft:inventory")?.container;
    if (!source || !source.isValid)
      return {
        ok: false,
        reason: "source_inventory_missing",
        transferred: 0,
        endpoint,
      };
    const target = endpoint.marker.getComponent(
      "minecraft:inventory",
    )?.container;
    if (!target || !target.isValid)
      return {
        ok: false,
        reason: "target_inventory_missing",
        transferred: 0,
        endpoint,
      };
    const transferred = moveContainerItems(source, target, limit);
    return {
      ok: true,
      reason: transferred > 0 ? "transferred" : "nothing_transferred",
      transferred,
      endpoint,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "transfer_error",
      transferred: 0,
      endpoint,
      error: String(error?.message ?? error),
    };
  }
}

function canContainerAcceptAnyItem(source, target, maxItems) {
  if (!source?.isValid || !target?.isValid) return false;
  let remaining = Math.max(0, Math.floor(Number(maxItems)) || 0);
  if (remaining <= 0) return false;
  for (
    let sourceSlot = 0;
    sourceSlot < source.size && remaining > 0;
    sourceSlot++
  ) {
    const item = source.getItem(sourceSlot);
    if (!item) continue;
    const amount = Math.min(item.amount, remaining);
    for (let targetSlot = 0; targetSlot < target.size; targetSlot++) {
      const existing = target.getItem(targetSlot);
      if (!existing) return true;
      try {
        if (
          existing.isStackableWith(item) &&
          existing.amount < existing.maxAmount
        )
          return true;
      } catch {}
    }
    remaining -= amount;
  }
  return false;
}

function remoteEndpointCanAcceptSource(endpoint, source, maxItems) {
  if (!endpoint?.ok || !endpoint.marker?.isValid) return false;
  try {
    const p = endpoint.marker.location;
    const block = endpoint.marker.dimension.getBlock({
      x: Math.floor(p.x),
      y: Math.floor(p.y),
      z: Math.floor(p.z),
    });
    if (!block || block.typeId !== ENDER_NODE_BLOCK) return false;
    const outputs = getAdjacentContainers(
      block,
      getBlockContainer,
      null,
      endpoint.marker,
    );
    for (const output of outputs)
      if (canContainerAcceptAnyItem(source, output.container, maxItems))
        return true;
    return false;
  } catch {
    return false;
  }
}

async function hasAcceptingConfiguredDestination(marker, source, maxItems) {
  const limit = Math.max(0, Math.floor(Number(maxItems)) || 0);
  if (!marker || !source?.isValid || limit <= 0) return false;
  const channel = getEnderChannel(marker);
  const config = getEnderMultiTargetConfig(marker);
  if (config.targets.length === 0) return true;

  const targetCount = config.targets.length;
  const roundRobin = config.deliveryMode === ENDER_DELIVERY_ROUND_ROBIN;
  const startIndex = roundRobin ? config.roundRobinCursor % targetCount : 0;
  const orderedTargets = [];
  for (let offset = 0; offset < targetCount; offset++)
    orderedTargets.push(config.targets[(startIndex + offset) % targetCount]);

  const legacyPrimary = getEnderTarget(marker);
  try {
    for (const key of orderedTargets) {
      const entry = findEnderEntryByTargetKey(key);
      if (
        !entry ||
        entry.channel !== channel ||
        normalizeRole(entry.role) !== ENDER_MODE_RECEIVE
      )
        continue;
      setEnderTarget(marker, key);
      const endpoint = await resolveEnderRemoteEndpoint(marker);
      if (
        endpoint?.ok &&
        remoteEndpointCanAcceptSource(endpoint, source, limit)
      )
        return true;
    }
    return false;
  } finally {
    setEnderTarget(marker, legacyPrimary);
  }
}

async function transferEnderPriorityTargets(marker, maxItems) {
  const limit = Math.max(0, Math.floor(Number(maxItems)) || 0);
  if (!marker || limit <= 0)
    return { ok: false, reason: "invalid_priority_transfer", transferred: 0 };

  const channel = getEnderChannel(marker);
  const config = getEnderMultiTargetConfig(marker);
  if (config.targets.length === 0)
    return transferEnderMarkerToRemoteMarker(marker, limit);

  const legacyPrimary = config.targets[0] || "";
  const targetCount = config.targets.length;
  const roundRobin = config.deliveryMode === ENDER_DELIVERY_ROUND_ROBIN;
  const startIndex = roundRobin ? config.roundRobinCursor % targetCount : 0;
  const orderedTargets = [];
  for (let offset = 0; offset < targetCount; offset++)
    orderedTargets.push(config.targets[(startIndex + offset) % targetCount]);

  let transferred = 0;
  let lastResult;
  let lastSuccessfulIndex = -1;
  try {
    for (const key of orderedTargets) {
      if (transferred >= limit) break;
      const entry = findEnderEntryByTargetKey(key);
      if (
        !entry ||
        entry.channel !== channel ||
        normalizeRole(entry.role) !== ENDER_MODE_RECEIVE
      )
        continue;

      setEnderTarget(marker, key);
      const endpoint = await resolveEnderRemoteEndpoint(marker);
      lastResult = endpoint?.ok
        ? { ok: true, reason: "destination_full", transferred: 0, endpoint }
        : {
            ok: false,
            reason: endpoint?.reason ?? "resolve_failed",
            transferred: 0,
            endpoint,
          };
      if (!endpoint?.ok) continue;
      const source = marker.getComponent("minecraft:inventory")?.container;
      if (!source || !source.isValid) {
        lastResult = {
          ok: false,
          reason: "source_inventory_missing",
          transferred: 0,
          endpoint,
        };
        break;
      }
      if (!remoteEndpointCanAcceptSource(endpoint, source, limit - transferred))
        continue;
      const result = await transferEnderMarkerToRemoteMarker(
        marker,
        limit - transferred,
      );
      lastResult = result;
      if (result.transferred > 0) {
        transferred += result.transferred;
        lastSuccessfulIndex = config.targets.indexOf(key);
      }
    }
  } finally {
    setEnderTarget(marker, legacyPrimary);
  }

  // EN2-3C-5: only a successful target advances the next Round Robin start.
  // Failed/full/unavailable targets by themselves never move the cursor.
  if (roundRobin && lastSuccessfulIndex >= 0)
    saveEnderRoundRobinCursor(marker, (lastSuccessfulIndex + 1) % targetCount);

  return {
    ok: transferred > 0 || !!lastResult?.ok,
    reason:
      transferred > 0
        ? roundRobin
          ? "round_robin_transferred"
          : "priority_transferred"
        : (lastResult?.reason ??
          (roundRobin
            ? "round_robin_no_valid_target"
            : "priority_no_valid_target")),
    transferred,
    endpoint: lastResult?.endpoint,
  };
}

const ENDER_PARTICLE_ID = "minecraft:end_chest";
const ENDER_PARTICLE_INTERVAL = 7;

export function spawnEnderNodeParticle(marker) {
  try {
    if (!marker) return false;
    const pos = {
      x: Math.floor(marker.location.x),
      y: Math.floor(marker.location.y),
      z: Math.floor(marker.location.z),
    };
    const block = marker.dimension.getBlock(pos);
    if (!block || block.typeId !== ENDER_NODE_BLOCK) return false;
    marker.dimension.spawnParticle(ENDER_PARTICLE_ID, {
      x: pos.x + 0.5,
      y: pos.y + 0.6,
      z: pos.z + 0.5,
    });
    return true;
  } catch {
    return false;
  }
}

system.runInterval(() => {
  for (const dimensionId of [
    "minecraft:overworld",
    "minecraft:nether",
    "minecraft:the_end",
  ]) {
    let dimension;
    try {
      dimension = world.getDimension(dimensionId);
    } catch {
      continue;
    }
    for (const marker of dimension.getEntities({ type: ENDER_NODE_ENTITY })) {
      spawnEnderNodeParticle(marker);
    }
  }
}, ENDER_PARTICLE_INTERVAL);

const ENDER_TRANSFER_AMOUNT = 64;
const ENDER_PROCESS_INTERVAL = 20;
const processingEnderMarkers = new Set();
export async function processEnderNode(
  marker,
  maxItems = ENDER_TRANSFER_AMOUNT,
) {
  if (!marker)
    return {
      ok: false,
      reason: "source_marker_missing",
      localIn: 0,
      remote: 0,
      localOut: 0,
    };
  if (processingEnderMarkers.has(marker.id))
    return { ok: false, reason: "busy", localIn: 0, remote: 0, localOut: 0 };
  processingEnderMarkers.add(marker.id);
  try {
    const limit = Math.max(
      1,
      Math.floor(Number(maxItems)) || ENDER_TRANSFER_AMOUNT,
    );
    const pos = {
      x: Math.floor(marker.location.x),
      y: Math.floor(marker.location.y),
      z: Math.floor(marker.location.z),
    };
    const block = marker.dimension.getBlock(pos);
    if (!block || block.typeId !== ENDER_NODE_BLOCK)
      return {
        ok: false,
        reason: "source_block_missing",
        localIn: 0,
        remote: 0,
        localOut: 0,
      };
    const inventory = marker.getComponent("minecraft:inventory")?.container;
    if (!inventory || !inventory.isValid)
      return {
        ok: false,
        reason: "source_inventory_missing",
        localIn: 0,
        remote: 0,
        localOut: 0,
      };
    const mode = getEnderMode(marker);
    if (mode === ENDER_MODE_RECEIVE) {
      let localOut = 0;
      const outputs = getAdjacentContainers(
        block,
        getBlockContainer,
        null,
        marker,
      );
      for (const output of getRoundRobinTargets(marker, outputs)) {
        const moved = moveContainerItems(
          inventory,
          output.container,
          limit - localOut,
        );
        if (moved > 0) {
          localOut += moved;
          advanceRoundRobin(marker, outputs, output);
          break;
        }
      }
      return {
        ok: true,
        reason: localOut > 0 ? "local_out" : "nothing_to_output",
        localIn: 0,
        remote: 0,
        localOut,
      };
    }
    let localIn = 0;
    const inputs = getAdjacentContainers(
      block,
      getBlockContainer,
      null,
      marker,
    );
    for (const input of getRoundRobinTargets(marker, inputs)) {
      if (
        !(await hasAcceptingConfiguredDestination(
          marker,
          input.container,
          limit - localIn,
        ))
      )
        continue;
      const moved = moveContainerItems(
        input.container,
        inventory,
        limit - localIn,
      );
      if (moved > 0) {
        localIn += moved;
        advanceRoundRobin(marker, inputs, input);
        break;
      }
    }
    const remoteResult = await transferEnderPriorityTargets(marker, limit);
    return {
      ok: remoteResult.ok,
      reason: remoteResult.reason,
      localIn,
      remote: remoteResult.transferred || 0,
      localOut: 0,
      endpoint: remoteResult.endpoint,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "process_error",
      localIn: 0,
      remote: 0,
      localOut: 0,
      error: String(error?.message ?? error),
    };
  } finally {
    processingEnderMarkers.delete(marker.id);
  }
}
system.runInterval(() => {
  for (const dimensionId of [
    "minecraft:overworld",
    "minecraft:nether",
    "minecraft:the_end",
  ]) {
    let dimension;
    try {
      dimension = world.getDimension(dimensionId);
    } catch {
      continue;
    }
    for (const marker of dimension.getEntities({ type: ENDER_NODE_ENTITY })) {
      if (!getEnderChannel(marker)) continue;
      if (getEnderMode(marker) === ENDER_MODE_SEND && !getEnderTarget(marker)) {
        const persisted = loadEnderRegistry().find(
          (e) =>
            entryKey(e) ===
            entryKey({
              dimension: marker.dimension.id,
              x: marker.location.x,
              y: marker.location.y,
              z: marker.location.z,
            }),
        );
        if (typeof persisted?.target === "string" && persisted.target)
          setEnderTarget(marker, persisted.target);
        if (!getEnderTarget(marker)) continue;
      }
      processEnderNode(marker).catch(() => {});
    }
  }
}, ENDER_PROCESS_INTERVAL);

export function findEnderEntryByTargetKey(value) {
  const key = typeof value === "string" ? value : "";
  if (!key) return undefined;
  return loadEnderRegistry().find((entry) => targetKey(entry) === key);
}
function dimensionLabel(id) {
  if (id === "minecraft:overworld") return "Overworld";
  if (id === "minecraft:nether") return "Nether";
  if (id === "minecraft:the_end") return "The End";
  return id;
}
function targetLabel(entry) {
  const n = normalizeEntry(entry);
  if (!n) return "?";
  const name = n.endpointName ? `${n.endpointName} | ` : "";
  return `${name}${n.dimension} | ${n.x}, ${n.y}, ${n.z}`;
}
function findChannelSendEntries(channel, excludeDimensionId, excludeLocation) {
  const normalized = normalizeChannel(channel);
  if (!normalized) return [];
  return findEnderChannelEntries(
    normalized,
    excludeDimensionId,
    excludeLocation,
  ).filter((e) => normalizeRole(e.role) === ENDER_MODE_SEND);
}
async function establishEnderConnection(sender, receiveEntry) {
  if (!sender || !receiveEntry)
    return { ok: false, reason: "missing_endpoint" };
  const channel = getEnderChannel(sender);
  if (getEnderMode(sender) !== ENDER_MODE_SEND)
    return { ok: false, reason: "source_not_send" };
  if (
    !channel ||
    receiveEntry.channel !== channel ||
    normalizeRole(receiveEntry.role) !== ENDER_MODE_RECEIVE
  )
    return { ok: false, reason: "endpoint_mismatch" };
  setEnderTarget(sender, targetKey(receiveEntry));
  // Use the same resolver path used by normal SEND operation. This creates/reuses the target ticking area,
  // verifies the target block/marker and resolves the remote network before considering the link established.
  const areaResult = await ensureEnderTargetArea(sender);
  const result = await resolveEnderRemoteEndpoint(sender);
  return result?.ok
    ? { ok: true, result }
    : { ok: false, reason: result?.reason ?? "resolve_failed", result };
}
async function showIncomingSendSelector(player, marker, channel) {
  const entries = findChannelSendEntries(
    channel,
    marker.dimension.id,
    marker.location,
  );
  if (entries.length === 0) {
    player.sendMessage({ translate: "vfh.ui.ender.no_targets" });
    return;
  }
  const labels = entries.map(targetLabel);
  const response = await new ModalFormData()
    .title({ translate: "vfh.ui.ender.target_title" })
    .dropdown({ translate: "vfh.ui.ender.target" }, labels, {
      defaultValueIndex: 0,
    })
    .submitButton({ translate: "vfh.ui.common.save" })
    .show(player);
  if (response.canceled || !response.formValues) return;
  const selectedEntry = entries[Number(response.formValues[0] ?? 0)];
  if (!selectedEntry) return;
  // RECEIVE selection identifies the existing SEND that should point here.
  const receiveEntry = loadEnderRegistry().find(
    (e) =>
      entryKey(e) ===
      entryKey({
        dimension: marker.dimension.id,
        x: marker.location.x,
        y: marker.location.y,
        z: marker.location.z,
      }),
  );
  if (!receiveEntry) return;
  const receiveKey = targetKey(receiveEntry);
  try {
    const r = loadRegistryObject();
    const registrySender = r.endpoints.find(
      (e) => entryKey(e) === entryKey(selectedEntry),
    );
    (() => {})(
      `[ENDER PATH] REGISTRY_SENDER ${JSON.stringify(registrySender ?? null)}`,
    );
    if (!registrySender) return;
    if (normalizeRole(registrySender.role) !== ENDER_MODE_SEND) return;
    if (registrySender.channel !== channel) return;
    registrySender.target = receiveKey;
    saveRegistryObject(r);
    const d = world.getDimension(selectedEntry.dimension);
    if (
      d.isChunkLoaded({
        x: selectedEntry.x,
        y: selectedEntry.y,
        z: selectedEntry.z,
      })
    ) {
      const b = d.getBlock({
        x: selectedEntry.x,
        y: selectedEntry.y,
        z: selectedEntry.z,
      });
      const sender =
        b?.typeId === ENDER_NODE_BLOCK
          ? findMarkerAtBlock(b, ENDER_NODE_ENTITY)
          : undefined;
      if (
        sender &&
        getEnderMode(sender) === ENDER_MODE_SEND &&
        getEnderChannel(sender) === channel
      ) {
        setEnderTarget(sender, receiveKey);
        await establishEnderConnection(sender, receiveEntry);
      }
    }
  } catch {
    return;
  }
}

function getEnderMultiTargetConfig(marker) {
  const key = targetKey({
    dimension: marker.dimension.id,
    x: marker.location.x,
    y: marker.location.y,
    z: marker.location.z,
  });
  const entry = loadRegistryObject().endpoints.find((e) => entryKey(e) === key);
  const legacyTarget = getEnderTarget(marker);
  const targets = normalizeTargetKeys(entry?.targets);
  if (targets.length === 0 && legacyTarget) targets.push(legacyTarget);
  return {
    deliveryMode: normalizeDeliveryMode(entry?.deliveryMode),
    targets,
    roundRobinCursor: Math.max(
      0,
      Math.floor(Number(entry?.roundRobinCursor)) || 0,
    ),
  };
}

function saveEnderRoundRobinCursor(marker, nextIndex) {
  const key = targetKey({
    dimension: marker.dimension.id,
    x: marker.location.x,
    y: marker.location.y,
    z: marker.location.z,
  });
  const r = loadRegistryObject();
  const e = r.endpoints.find((entry) => entryKey(entry) === key);
  if (!e) return false;
  const count = normalizeTargetKeys(e.targets).length;
  e.roundRobinCursor =
    count > 0
      ? (((Math.floor(Number(nextIndex)) || 0) % count) + count) % count
      : 0;
  saveRegistryObject(r);
  return true;
}

function saveEnderMultiTargetConfig(marker, channel, deliveryMode, targets) {
  const r = loadRegistryObject();
  const e = ensureEndpointAt(
    r,
    marker.dimension.id,
    marker.location,
    channel,
    ENDER_MODE_SEND,
  );
  if (!e) return false;
  const previousMode = normalizeDeliveryMode(e.deliveryMode);
  const previousTargets = normalizeTargetKeys(e.targets);
  e.deliveryMode = normalizeDeliveryMode(deliveryMode);
  e.targets = normalizeTargetKeys(targets);
  e.target = e.targets[0] || "";
  if (
    previousMode !== e.deliveryMode ||
    JSON.stringify(previousTargets) !== JSON.stringify(e.targets)
  )
    e.roundRobinCursor = 0;
  saveRegistryObject(r);
  setEnderTarget(marker, e.target);
  try {
    marker.setDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY, e.endpointId);
    marker.setDynamicProperty(ENDER_CHANNEL_ID_PROPERTY, e.channelId);
  } catch {}
  return true;
}

async function showTargetSelector(player, marker, channel) {
  const entries = findEnderChannelEntries(
    channel,
    marker.dimension.id,
    marker.location,
  ).filter((e) => normalizeRole(e.role) === ENDER_MODE_RECEIVE);
  if (entries.length === 0) {
    setEnderChannel(marker, channel);
    setEnderTarget(marker, "");
    saveEnderMultiTargetConfig(marker, channel, ENDER_DELIVERY_PRIORITY, []);
    player.sendMessage({ translate: "vfh.ui.ender.no_targets" });
    return;
  }

  const config = getEnderMultiTargetConfig(marker);
  const labels = ["Not Used", ...entries.map(targetLabel)];
  const modeOptions = ["Priority", "Round Robin"];
  const form = new ModalFormData()
    .title({ translate: "vfh.ui.ender.target_title" })
    .dropdown("Delivery Mode", modeOptions, {
      defaultValueIndex:
        config.deliveryMode === ENDER_DELIVERY_ROUND_ROBIN ? 1 : 0,
    });

  for (let i = 0; i < entries.length; i++) {
    const savedTarget = config.targets[i] || "";
    const found = entries.findIndex((e) => targetKey(e) === savedTarget);
    form.dropdown(`Target ${i + 1}`, labels, {
      defaultValueIndex: found >= 0 ? found + 1 : 0,
    });
  }

  const response = await form
    .submitButton({ translate: "vfh.ui.common.save" })
    .show(player);
  if (response.canceled || !response.formValues) return;

  const deliveryMode =
    Number(response.formValues[0] ?? 0) === 1
      ? ENDER_DELIVERY_ROUND_ROBIN
      : ENDER_DELIVERY_PRIORITY;
  const selectedTargets = [];
  const seen = new Set();
  for (let i = 0; i < entries.length; i++) {
    const selected = Number(response.formValues[i + 1] ?? 0);
    if (selected <= 0) continue;
    const selectedEntry = entries[selected - 1];
    const key = selectedEntry ? targetKey(selectedEntry) : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    selectedTargets.push(key);
  }

  const previousEntry = findEnderEntryByTargetKey(getEnderTarget(marker));
  setEnderChannel(marker, channel);
  if (
    previousEntry &&
    (!selectedTargets[0] || targetKey(previousEntry) !== selectedTargets[0])
  )
    removeEnderTargetArea(previousEntry);

  saveEnderMultiTargetConfig(marker, channel, deliveryMode, selectedTargets);
  if (selectedTargets.length > 0) {
    const primary = findEnderEntryByTargetKey(selectedTargets[0]);
    if (primary) await establishEnderConnection(marker, primary);
  } else {
    setEnderTarget(marker, "");
  }
  player.sendMessage({ translate: "vfh.ui.ender.saved" });
}

async function showEndpointSettings(player, marker, channel) {
  const currentName = getEnderEndpointName(marker);
  const location = marker.location;
  const response = await new ModalFormData()
    .title("Ender Endpoint")
    .textField("Endpoint Name", "e.g. Factory", { defaultValue: currentName })
    .submitButton({ translate: "vfh.ui.common.save" })
    .show(player);
  if (response.canceled || !response.formValues) return;
  setEnderChannel(marker, channel);
  setEnderEndpointName(marker, response.formValues[0]);
  player.sendMessage(
    `Ender Endpoint: ${targetLabel({ endpointName: getEnderEndpointName(marker), dimension: marker.dimension.id, x: location.x, y: location.y, z: location.z, role: getEnderMode(marker) })}`,
  );
  await showRoleSelector(player, marker, channel);
}

async function showRoleSelector(player, marker, channel) {
  const current = getEnderMode(marker);
  const response = await new ModalFormData()
    .title({ translate: "vfh.ui.ender.role_title" })
    .dropdown(
      { translate: "vfh.ui.ender.role" },
      [
        { translate: "vfh.ui.ender.role.send" },
        { translate: "vfh.ui.ender.role.receive" },
      ],
      { defaultValueIndex: current === ENDER_MODE_SEND ? 0 : 1 },
    )
    .submitButton({ translate: "vfh.ui.common.save" })
    .show(player);
  if (response.canceled || !response.formValues) return;
  const mode =
    Number(response.formValues[0] ?? 1) === 0
      ? ENDER_MODE_SEND
      : ENDER_MODE_RECEIVE;
  // SN-9A-2: commit SEND before opening the target selector.
  // Otherwise setEnderChannel() may leave a newly configured node in its
  // default RECEIVE state while the target UI awaits input.
  setEnderChannel(marker, channel);
  if (mode === ENDER_MODE_SEND) {
    setEnderMode(marker, ENDER_MODE_SEND);
    await showTargetSelector(player, marker, channel);
    // 2.2.7: SEND is a persistent role even when no RECEIVE exists yet.
    // A later RECEIVE can become available without silently rewriting this endpoint to RECEIVE.
    return;
  }
  setEnderMode(marker, mode);
  setEnderTarget(marker, "");
  // 2.2.7-11: explicitly commit B through the existing Registry v2 writer.
  // updateEnderRegistryAt -> ensureEndpointAt -> saveRegistryObject, and refreshes marker IDs.
  if (
    !updateEnderRegistryAt(
      marker.dimension.id,
      marker.location,
      channel,
      ENDER_MODE_RECEIVE,
      marker,
    )
  )
    return;
  await showIncomingSendSelector(player, marker, channel);
  player.sendMessage({ translate: "vfh.ui.ender.saved" });
}
async function showNewChannelForm(player, marker) {
  const response = await new ModalFormData()
    .title({ translate: "vfh.ui.ender.new_channel_title" })
    .textField(
      { translate: "vfh.ui.ender.channel" },
      { translate: "vfh.ui.ender.channel_placeholder" },
      { defaultValue: "" },
    )
    .submitButton({ translate: "vfh.ui.ender.continue" })
    .show(player);
  if (response.canceled || !response.formValues) return;
  const channel = normalizeChannel(response.formValues[0] ?? "");
  if (!channel) return;
  setEnderChannel(marker, channel);
  await showEndpointSettings(player, marker, channel);
}

async function showDeleteChannelSelector(player, marker) {
  const channels = getRegisteredEnderChannels();
  if (!channels.length) {
    player.sendMessage("No channels to delete.");
    return;
  }
  const form = new ActionFormData()
    .title("Delete Channel")
    .body(
      "Select a channel to delete. All endpoints registered to that Channel ID will be detached.",
    );
  for (const channel of channels) form.button(channel);
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;
  const channel = channels[response.selection];
  if (!channel) return;
  const confirm = await new ActionFormData()
    .title("Delete Channel")
    .body(
      `Delete channel "${channel}"?\n\nA channel created later with the same name will receive a new Channel ID.`,
    )
    .button("Delete")
    .button("Cancel")
    .show(player);
  if (confirm.canceled || confirm.selection !== 0) return;
  const current = getEnderChannel(marker);
  if (!deleteEnderChannelByName(channel)) return;
  if (current === channel) {
    try {
      marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY, "");
      marker.setDynamicProperty(ENDER_CHANNEL_ID_PROPERTY, undefined);
      marker.setDynamicProperty(ENDER_ENDPOINT_ID_PROPERTY, undefined);
      setEnderTarget(marker, "");
      setEnderMode(marker, ENDER_MODE_RECEIVE);
    } catch {}
  }
  player.sendMessage(`Deleted Ender Channel: ${channel}`);
}

async function showChannelSelector(player, marker) {
  const channels = getRegisteredEnderChannels();
  const current = getEnderChannel(marker);
  const ordered =
    current && channels.includes(current)
      ? [current, ...channels.filter((c) => c !== current)]
      : channels;
  const form = new ActionFormData()
    .title({ translate: "vfh.ui.ender.channel_selector_title" })
    .body({ translate: "vfh.ui.ender.channel_selector_body" });
  for (const channel of ordered) form.button(channel);
  form.button({ translate: "vfh.ui.ender.new_channel" });
  form.button("Delete Channel");
  const response = await form.show(player);
  if (response.canceled || response.selection === undefined) return;
  if (response.selection === ordered.length) {
    await showNewChannelForm(player, marker);
    return;
  }
  if (response.selection === ordered.length + 1) {
    await showDeleteChannelSelector(player, marker);
    return;
  }
  const channel = ordered[response.selection];
  if (channel) await showEndpointSettings(player, marker, channel);
}

function ensureEnderMarker(block) {
  const existing = findMarkerAtBlock(block, ENDER_NODE_ENTITY);
  const marker = ensureMarkerForBlock(
    block,
    ENDER_NODE_ENTITY,
    null,
    ENDER_NODE_BLOCK,
  );
  if (!marker) {
    console.warn(
      `[ENDER ERROR] Marker ensure failed dimension=${block.dimension.id} location=${block.location.x},${block.location.y},${block.location.z}`,
    );
    return null;
  }

  try {
    if (marker.getDynamicProperty(ENDER_CHANNEL_PROPERTY) === undefined)
      marker.setDynamicProperty(ENDER_CHANNEL_PROPERTY, "");
    if (marker.getDynamicProperty(ENDER_ENDPOINT_NAME_PROPERTY) === undefined)
      marker.setDynamicProperty(ENDER_ENDPOINT_NAME_PROPERTY, "");
    if (marker.getDynamicProperty(ENDER_TARGET_PROPERTY) === undefined)
      marker.setDynamicProperty(ENDER_TARGET_PROPERTY, "");
    if (marker.getDynamicProperty(ENDER_MODE_PROPERTY) === undefined)
      marker.setDynamicProperty(ENDER_MODE_PROPERTY, ENDER_MODE_RECEIVE);
  } catch (error) {
    console.warn(
      `[ENDER ERROR] Marker initialization failed dimension=${block.dimension.id} location=${block.location.x},${block.location.y},${block.location.z}: ${error?.stack ?? error?.message ?? String(error)}`,
    );
    return null;
  }

  if (!existing) {
    console.warn(
      `[ENDER SELF-HEAL] Missing marker restored dimension=${block.dimension.id} location=${block.location.x},${block.location.y},${block.location.z}`,
    );
  }

  return marker;
}
const ENDER_FORM_LEASE_TICKS = 80;
const openingEnderForm = new Map();
let nextEnderFormLeaseGeneration = 1;

function acquireEnderFormLease(key) {
  const now = system.currentTick;
  const current = openingEnderForm.get(key);
  if (current && now - current.acquiredTick < ENDER_FORM_LEASE_TICKS)
    return null;

  const lease = {
    generation: nextEnderFormLeaseGeneration++,
    acquiredTick: now,
  };
  openingEnderForm.set(key, lease);
  return lease;
}

function releaseEnderFormLease(key, generation) {
  const current = openingEnderForm.get(key);
  if (!current || current.generation !== generation) return false;
  openingEnderForm.delete(key);
  return true;
}

world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
  const player = event.player;
  if (
    !player.isSneaking ||
    event.block.typeId !== ENDER_NODE_BLOCK ||
    event.itemStack
  )
    return;
  event.cancel = true;
  const dimension = event.block.dimension;
  const location = {
    x: event.block.location.x,
    y: event.block.location.y,
    z: event.block.location.z,
  };
  const key = `${player.id}:${dimension.id}:${location.x}:${location.y}:${location.z}`;
  const lease = acquireEnderFormLease(key);
  if (!lease) return;

  system.run(() => {
    try {
      const block = dimension.getBlock(location);
      if (!block || block.typeId !== ENDER_NODE_BLOCK) {
        releaseEnderFormLease(key, lease.generation);
        return;
      }
      const marker = ensureEnderMarker(block);
      if (!marker) {
        releaseEnderFormLease(key, lease.generation);
        return;
      }
      showChannelSelector(player, marker)
        .catch((error) => {
          console.warn(
            `[ENDER UI ERROR] showChannelSelector key=${key}: ${error?.stack ?? error?.message ?? String(error)}`,
          );
        })
        .finally(() => {
          releaseEnderFormLease(key, lease.generation);
        });
    } catch (error) {
      console.warn(
        `[ENDER ERROR] Interaction self-heal failed key=${key}: ${error?.stack ?? error?.message ?? String(error)}`,
      );
      releaseEnderFormLease(key, lease.generation);
    }
  });
});

world.afterEvents.playerPlaceBlock.subscribe((event) => {
  const block = event.block;
  if (!block || block.typeId !== ENDER_NODE_BLOCK) return;

  const marker = ensureEnderMarker(block);
  if (!marker) return;

  updateEnderRegistryAt(
    block.dimension.id,
    block.location,
    getEnderChannel(marker),
  );
});
