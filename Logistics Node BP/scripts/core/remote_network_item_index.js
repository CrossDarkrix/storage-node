// SN-9B: Remote Read-Only Network Inventory
// Builds a display-only union of the local network item index and every
// reachable remote storage topology discovered through SN-9A.
// No mutation operation consumes this index.

import { buildNetworkItemIndex, buildNetworkItemIndexFromGraph } from "./network_item_index.js";
import {
    discoverRemoteStorageTopology,
    discoverRemoteStorageTopologyLoaded,
} from "./remote_storage_bridge.js";

function locationIdentity(location) {
    if (!location) return "";
    const p = location.location;
    const dimensionId = location.dimensionId ?? "";
    const typeId = location.containerTypeId ?? "";
    // Physical stack identity. Never include bridgeIndex/path/storage-node data here.
    // The same container reached through redundant remote routes must aggregate once.
    return `${dimensionId}|${p?.x}|${p?.y}|${p?.z}|${typeId}|slot:${location.slot}`;
}

function copyLocation(location, scope, bridgeIndex) {
    return {
        ...location,
        location: location?.location ? { ...location.location } : null,
        storageNodeLocation: location?.storageNodeLocation
            ? { ...location.storageNodeLocation }
            : null,
        scope,
        bridgeIndex,
    };
}

function addIndex(target, index, scope, bridgeIndex, seenLocations) {
    for (const entry of index?.entries ?? []) {
        let aggregate = target.get(entry.typeId);
        if (!aggregate) {
            aggregate = {
                key: entry.typeId,
                typeId: entry.typeId,
                total: 0,
                stacks: 0,
                locations: [],
            };
            target.set(entry.typeId, aggregate);
        }
        for (const location of entry.locations ?? []) {
            const identity = locationIdentity(location);
            if (!identity || seenLocations.has(identity)) continue;
            seenLocations.add(identity);
            aggregate.total += Number(location.amount) || 0;
            aggregate.stacks += 1;
            aggregate.locations.push(copyLocation(location, scope, bridgeIndex));
        }
    }
}

export function buildRemoteReadOnlyNetworkItemIndex(startBlock) {
    const localIndex = buildNetworkItemIndex(startBlock);
    const topology = discoverRemoteStorageTopology(startBlock);
    const items = new Map();
    const seenLocations = new Set();
    addIndex(items, localIndex, "local", null, seenLocations);

    const remoteNetworks = [];
    for (let bridgeIndex = 0; bridgeIndex < (topology?.bridges?.length ?? 0); bridgeIndex++) {
        const bridge = topology.bridges[bridgeIndex];
        const result = bridge?.result;
        if (!result?.ok || !result?.remoteStart || !result?.remoteGraph) continue;
        const index = buildNetworkItemIndexFromGraph(result.remoteGraph);
        remoteNetworks.push({ bridgeIndex, role: bridge.role, channel: result.channel, index });
        addIndex(items, index, "remote", bridgeIndex, seenLocations);
    }

    for (const [key, entry] of [...items]) {
        if (entry.stacks <= 0 || entry.total <= 0) items.delete(key);
    }
    const entries = [...items.values()].sort((a, b) => a.typeId.localeCompare(b.typeId));
    return {
        localIndex,
        topology,
        remoteNetworks,
        entries,
        byTypeId: items,
        uniqueItems: entries.length,
        totalStacks: entries.reduce((sum, entry) => sum + entry.stacks, 0),
        totalItems: entries.reduce((sum, entry) => sum + entry.total, 0),
        readOnly: true,
    };
}

// SN-9D: Re-resolve a remote network at mutation time. Callers must not use
// stale location/container objects captured by an earlier read-only index.
export function resolveRemoteMutationIndex(startBlock, bridgeIndex) {
    const topology = discoverRemoteStorageTopology(startBlock);
    const bridge = topology?.bridges?.[bridgeIndex];
    const result = bridge?.result;
    if (!result?.ok || !result?.remoteStart || !result?.remoteGraph) {
        return {
            ok: false,
            reason: result?.reason ?? "remote_bridge_unavailable",
            bridge,
            index: null,
        };
    }
    return {
        ok: true,
        reason: "ok",
        bridge,
        index: buildNetworkItemIndexFromGraph(result.remoteGraph),
    };
}

function bridgeIdentity(bridge) {
    const source = bridge?.source?.block;
    const result = bridge?.result;
    if (!source) return "";
    const target = result?.entry
        ? `${result.entry.dimension}|${result.entry.x}|${result.entry.y}|${result.entry.z}`
        : "";
    return `${source.dimension.id}|${source.location.x}|${source.location.y}|${source.location.z}|${bridge.role ?? ""}|${result?.channel ?? ""}|${target}`;
}

function buildMergedRemoteIndex(localIndex, topology) {
    const items = new Map();
    const seenLocations = new Set();
    addIndex(items, localIndex, "local", null, seenLocations);
    const remoteNetworks = [];
    for (let bridgeIndex = 0; bridgeIndex < (topology?.bridges?.length ?? 0); bridgeIndex++) {
        const bridge = topology.bridges[bridgeIndex];
        const result = bridge?.result;
        if (!result?.ok || !result?.remoteStart || !result?.remoteGraph) continue;
        const index = buildNetworkItemIndexFromGraph(result.remoteGraph);
        remoteNetworks.push({
            bridgeIndex,
            bridgeKey: bridgeIdentity(bridge),
            role: bridge.role,
            channel: result.channel,
            index,
        });
        addIndex(items, index, "remote", bridgeIndex, seenLocations);
    }
    for (const [key, entry] of [...items])
        if (entry.stacks <= 0 || entry.total <= 0) items.delete(key);
    const entries = [...items.values()].sort((a, b) => a.typeId.localeCompare(b.typeId));
    return {
        localIndex,
        topology,
        remoteNetworks,
        entries,
        byTypeId: items,
        uniqueItems: entries.length,
        totalStacks: entries.reduce((sum, entry) => sum + entry.stacks, 0),
        totalItems: entries.reduce((sum, entry) => sum + entry.total, 0),
        readOnly: true,
    };
}

export async function buildRemoteReadOnlyNetworkItemIndexLoaded(startBlock) {
    const localIndex = buildNetworkItemIndex(startBlock);
    const topology = await discoverRemoteStorageTopologyLoaded(startBlock);
    return buildMergedRemoteIndex(localIndex, topology);
}

export async function resolveRemoteMutationIndexLoaded(
    startBlock,
    bridgeIndex,
    expectedBridgeKey = "",
) {
    const topology = await discoverRemoteStorageTopologyLoaded(startBlock);
    const bridge = topology?.bridges?.[bridgeIndex];
    const actualBridgeKey = bridgeIdentity(bridge);
    if (expectedBridgeKey && actualBridgeKey !== expectedBridgeKey) {
        return {
            ok: false,
            reason: "remote_bridge_changed",
            bridge,
            bridgeKey: actualBridgeKey,
            index: null,
        };
    }
    const result = bridge?.result;
    if (!result?.ok || !result?.remoteStart || !result?.remoteGraph) {
        return {
            ok: false,
            reason: result?.reason ?? "remote_bridge_unavailable",
            bridge,
            bridgeKey: actualBridgeKey,
            index: null,
        };
    }
    return {
        ok: true,
        reason: "ok",
        bridge,
        bridgeKey: actualBridgeKey,
        index: buildNetworkItemIndexFromGraph(result.remoteGraph),
    };
}
