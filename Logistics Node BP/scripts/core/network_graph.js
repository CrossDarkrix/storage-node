import { ADJACENT_DIRECTIONS } from "./container.js";
import {
  CENTER_NODE_BLOCK,
  STORAGE_NODE_BLOCK,
  SIDE_NODE_BLOCK,
  VACUUM_NODE_BLOCK,
  NETWORK_CONTROLLER_BLOCK,
  INSERT_NODE_BLOCK,
  PLACER_NODE_BLOCK,
  OUTPUT_NODE_BLOCK,
  TRASH_NODE_BLOCK,
} from "../config/constants.js";
import {
  canNodeConnectToNode,
  getOppositeDirection,
} from "./node_direction.js";

const NETWORK_NODE_BLOCKS = new Set([
  CENTER_NODE_BLOCK,
  STORAGE_NODE_BLOCK,
  SIDE_NODE_BLOCK,
  VACUUM_NODE_BLOCK,
  NETWORK_CONTROLLER_BLOCK,
  INSERT_NODE_BLOCK,
  OUTPUT_NODE_BLOCK,
  TRASH_NODE_BLOCK,
]);

function getBlockKey(block) {
  if (!block) return "";
  return `${block.dimension.id}|${block.location.x}|${block.location.y}|${block.location.z}`;
}

function getAdjacentNodeBlock(block, direction) {
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

export function isNetworkNodeBlock(block) {
  return !!block && NETWORK_NODE_BLOCKS.has(block.typeId);
}

function isStorageNodeBlock(block) {
  return !!block && block.typeId === STORAGE_NODE_BLOCK;
}

function isNetworkControllerBlock(block) {
  return !!block && block.typeId === NETWORK_CONTROLLER_BLOCK;
}
function isInsertNodeBlock(block) {
  return !!block && block.typeId === INSERT_NODE_BLOCK;
}

function isStorageTopologyNode(block) {
  return (
    isStorageNodeBlock(block) ||
    isNetworkControllerBlock(block) ||
    isInsertNodeBlock(block) ||
    block.typeId === PLACER_NODE_BLOCK ||
    block.typeId === OUTPUT_NODE_BLOCK
  );
}

// SN-8A-3: Storage topology is intentionally separate from item-transfer
// direction. Two directly adjacent Storage Nodes form a topology edge in any
// of the six directions, regardless of their INPUT/OUTPUT faces.
// Other node pairs retain the existing directional connection contract.
export function areStorageTopologyNodesConnected(
  blockA,
  directionFromA,
  blockB,
) {
  if (!isNetworkNodeBlock(blockA) || !isNetworkNodeBlock(blockB)) return false;

  // NC-3: Network Controller is a directionless Storage Topology node.
  // Controller <-> Storage and Controller <-> Controller edges are physical
  // topology edges and do not depend on transfer INPUT/OUTPUT faces.
  if (isStorageTopologyNode(blockA) && isStorageTopologyNode(blockB)) {
    return true;
  }

  const reverseDirection = getOppositeDirection(directionFromA);
  if (!reverseDirection) return false;

  return (
    canNodeConnectToNode(blockA, directionFromA, blockB) ||
    canNodeConnectToNode(blockB, reverseDirection, blockA)
  );
}

// Backward-compatible public name. This function is used by graph discovery,
// not by the transfer engine. Transfer validation remains in node_direction.js
// and transfer.js via canNodeConnectToNode().
export function areNetworkNodesConnected(blockA, directionFromA, blockB) {
  return areStorageTopologyNodesConnected(blockA, directionFromA, blockB);
}

export function discoverNetworkGraph(startBlock) {
  if (!isNetworkNodeBlock(startBlock)) {
    return { start: null, nodes: [], edges: [] };
  }

  const queue = [startBlock];
  const queued = new Set([getBlockKey(startBlock)]);
  const visited = new Set();
  const edgeKeys = new Set();
  const nodes = [];
  const edges = [];

  while (queue.length > 0) {
    const block = queue.shift();
    const key = getBlockKey(block);
    if (!key || visited.has(key)) continue;

    visited.add(key);
    nodes.push(block);

    for (const direction of ADJACENT_DIRECTIONS) {
      const adjacent = getAdjacentNodeBlock(block, direction);
      const adjacentIsNetworkNode = isNetworkNodeBlock(adjacent);
      const connected = adjacentIsNetworkNode
        ? areStorageTopologyNodesConnected(block, direction.name, adjacent)
        : false;

      if (!adjacentIsNetworkNode) continue;
      if (!connected) continue;

      const adjacentKey = getBlockKey(adjacent);
      if (!adjacentKey) continue;

      const edgeKey =
        key < adjacentKey
          ? `${key}<->${adjacentKey}`
          : `${adjacentKey}<->${key}`;

      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push({
          from: block,
          to: adjacent,
          direction: direction.name,
          topology:
            isStorageTopologyNode(block) && isStorageTopologyNode(adjacent)
              ? "storage"
              : "directional",
        });
      }

      if (!visited.has(adjacentKey) && !queued.has(adjacentKey)) {
        queued.add(adjacentKey);
        queue.push(adjacent);
      }
    }
  }

  return { start: startBlock, nodes, edges };
}

export function getNetworkNodeLocations(startBlock) {
  return discoverNetworkGraph(startBlock).nodes.map((block) => ({
    dimension: block.dimension.id,
    typeId: block.typeId,
    x: block.location.x,
    y: block.location.y,
    z: block.location.z,
  }));
}
