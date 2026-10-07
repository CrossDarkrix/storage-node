export const NODE_CONNECTION_DIRECTIONS = Object.freeze([
  { name: "north", x: 0, y: 0, z: -1, h: 1, v: 0 },
  { name: "south", x: 0, y: 0, z: 1, h: 2, v: 0 },
  { name: "east", x: 1, y: 0, z: 0, h: 4, v: 0 },
  { name: "west", x: -1, y: 0, z: 0, h: 8, v: 0 },
  { name: "up", x: 0, y: 1, z: 0, h: 0, v: 1 },
  { name: "down", x: 0, y: -1, z: 0, h: 0, v: 2 },
]);
const NODE_TYPES = new Set([
  "vfh:center_node",
  "vfh:storage_node",
  "vfh:vacuum_node",
  "vfh:sort_node",
  "vfh:side_node",
  "vfh:network_controller",
  "vfh:ender_node",
  "vfh:craft_node",
  "vfh:large_container",
  "vfh:insert_node",
  "vfh:placer_node",
  "vfh:output_node",
  "vfh:trash_node",
]);
const VANILLA_CONTAINER_JOINT_EXCLUDED_NODES = new Set([
  "vfh:network_controller",
  "vfh:large_container",
]);

function isVanillaBlockContainer(block) {
  if (!block?.typeId?.startsWith("minecraft:")) return false;
  try {
    return !!block.getComponent("inventory")?.container;
  } catch {
    return false;
  }
}

export function isConnectionNode(b) {
  return !!b && NODE_TYPES.has(b.typeId);
}
export function getConnectionNeighbor(b, d) {
  try {
    return b.dimension.getBlock({
      x: b.location.x + d.x,
      y: b.location.y + d.y,
      z: b.location.z + d.z,
    });
  } catch {
    return undefined;
  }
}
export function isDirectionConnected(b, d) {
  const n = getConnectionNeighbor(b, d);
  if (!n) return false;
  if (n.typeId === "minecraft:air") return false;
  if (isConnectionNode(n)) return true;

  // Vanilla Container Joint: the joint remains a Node-side half joint.
  // Network Controller and Large Container intentionally do not expose
  // joints toward vanilla block inventories. Side Node input/output color
  // selection remains render-only through vfh:side_input_visual.
  if (VANILLA_CONTAINER_JOINT_EXCLUDED_NODES.has(b?.typeId)) return false;
  if (isVanillaBlockContainer(n)) return true;

  return false;
}
export function getNodePairConnections(b) {
  const r = {};
  for (const d of NODE_CONNECTION_DIRECTIONS)
    r[d.name] = isDirectionConnected(b, d);
  return r;
}
export function getNodePairStateBits(b) {
  const connections = getNodePairConnections(b);
  return { horizontal: 0, vertical: 0, ...connections };
}
