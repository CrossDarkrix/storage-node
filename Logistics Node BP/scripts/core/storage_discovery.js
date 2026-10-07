import {
    ADJACENT_DIRECTIONS,
    isSafeBlockContainer,
    getBlockContainer,
    getLogicalBlockContainerId,
    getContainerTargetAtBlock,
} from "./container.js";
const LARGE_CONTAINER_BLOCK = "vfh:large_container";

import { STORAGE_NODE_BLOCK } from "../config/constants.js";
import { discoverNetworkGraph, isNetworkNodeBlock } from "./network_graph.js";

function getBlockKey(block) {
    if (!block) return "";
    return `${block.dimension.id}|${block.location.x}|${block.location.y}|${block.location.z}`;
}

function getAdjacentBlock(block, direction) {
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

function makeRejected(storageNode, block, direction, reason) {
    return {
        storageNode,
        block,
        direction: direction.name,
        reason,
        dimensionId: block?.dimension?.id ?? storageNode.dimension.id,
        location: block ? { ...block.location } : null,
        typeId: block?.typeId ?? null,
    };
}

function collectStorageNodeContainers(storageNode, seenContainers, containers, rejected) {
    for (const direction of ADJACENT_DIRECTIONS) {
        const adjacent = getAdjacentBlock(storageNode, direction);
        if (!adjacent) continue;

        // Storage/Center/Side/Vacuum nodes are topology, not physical storage.
        // Storage-node chaining itself is handled by discoverNetworkGraph(),
        // including vertical (up/down) connections.
        if (isNetworkNodeBlock(adjacent)) continue;

        // Keep the existing production safety boundary: only containers accepted
        // by isSafeBlockContainer() may become part of Logical Storage.
        const isLargeContainer = adjacent.typeId === LARGE_CONTAINER_BLOCK;
        if (!isSafeBlockContainer(adjacent) && !isLargeContainer) {
            if (adjacent.typeId !== "minecraft:air") {
                rejected.push(makeRejected(storageNode, adjacent, direction, "unsafe_namespace"));
            }
            continue;
        }

        const target = isLargeContainer ? getContainerTargetAtBlock(adjacent) : null;
        const container = target?.container ?? getBlockContainer(adjacent);
        if (!container) {
            if (isLargeContainer)
                rejected.push(
                    makeRejected(
                        storageNode,
                        adjacent,
                        direction,
                        "large_container_entity_missing",
                    ),
                );
            continue;
        }

        const key = isLargeContainer
            ? `${getBlockKey(adjacent)}|large_container`
            : getLogicalBlockContainerId(adjacent, container) || getBlockKey(adjacent);
        if (!key || seenContainers.has(key)) continue;
        seenContainers.add(key);

        containers.push({
            key,
            storageNode,
            block: adjacent,
            container,
            direction: direction.name,
            dimensionId: adjacent.dimension.id,
            location: { ...adjacent.location },
            typeId: adjacent.typeId,
            entity: target?.entity ?? null,
            entityInventoryPolicy: target?.entityInventoryPolicy ?? null,
        });
    }
}

// SN-8A-2: Storage Chain Container Discovery
//
// Contract:
// 1. Traverse the complete connected VFH node graph from startBlock.
// 2. Every reachable Storage Node is a storage anchor, including Storage Nodes
//    reached above or below another Storage Node.
// 3. Register every safe block container directly adjacent to each reachable
//    Storage Node in all six directions.
// 4. Do not recursively traverse through containers. Storage Nodes remain the
//    only anchors that admit physical containers into Logical Storage.
// 5. De-duplicate physical containers by dimension + block coordinates.
export function discoverSafeNetworkStorageFromGraph(graph) {
    if (!graph?.start) {
        const emptyGraph = graph ?? { start: null, nodes: [], edges: [] };
        return { graph: emptyGraph, storageNodes: [], containers: [], rejected: [] };
    }

    const storageNodes = (graph.nodes ?? []).filter(
        (block) => block?.typeId === STORAGE_NODE_BLOCK,
    );
    const containers = [];
    const rejected = [];
    const seenContainers = new Set();

    for (const storageNode of storageNodes) {
        collectStorageNodeContainers(storageNode, seenContainers, containers, rejected);
    }

    return { graph, storageNodes, containers, rejected };
}

export function discoverSafeNetworkStorage(startBlock) {
    return discoverSafeNetworkStorageFromGraph(discoverNetworkGraph(startBlock));
}
