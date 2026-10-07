// SN-9A: Remote Storage Topology Bridge
// Read-only topology discovery only. This module does not aggregate remote
// inventory and does not perform remote Extract/Deposit.

import { findMarkerAtBlock } from "../core/marker.js";
import { world } from "@minecraft/server";
import { ADJACENT_DIRECTIONS } from "./container.js";
import { ENDER_NODE_BLOCK, ENDER_NODE_ENTITY } from "../config/constants.js";
import {
    getEnderChannel,
    getEnderMode,
    getEnderTarget,
    findEnderEntryByTargetKey,
    loadEnderRegistry,
    inspectEnderEntry,
    applyEnderTargetArea,
    ENDER_MODE_SEND,
    ENDER_MODE_RECEIVE,
} from "../nodes/ender_node.js";
import { discoverNetworkGraph, isNetworkNodeBlock } from "./network_graph.js";

function blockKey(block) {
    if (!block) return "";
    return `${block.dimension.id}|${block.location.x}|${block.location.y}|${block.location.z}`;
}

function entryKey(entry) {
    if (!entry) return "";
    return `${entry.dimension}|${entry.x}|${entry.y}|${entry.z}`;
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

function findAdjacentEnderNodes(graph) {
    const found = new Map();
    for (const node of graph?.nodes ?? []) {
        for (const direction of ADJACENT_DIRECTIONS) {
            const block = adjacentBlock(node, direction);
            if (!block || block.typeId !== ENDER_NODE_BLOCK) continue;
            const key = blockKey(block);
            if (!key || found.has(key)) continue;
            const marker = findMarkerAtBlock(block, ENDER_NODE_ENTITY);
            if (!marker) continue;
            found.set(key, { block, marker, attachedNode: node, direction: direction.name });
        }
    }
    return [...found.values()];
}

function findRemoteGraphStart(enderBlock) {
    for (const direction of ADJACENT_DIRECTIONS) {
        const block = adjacentBlock(enderBlock, direction);
        if (!block || !isNetworkNodeBlock(block)) continue;
        return { block, direction: direction.name };
    }
    return null;
}

function resolveSelectedTargetEntry(marker) {
    if (!marker) return { ok: false, reason: "marker_missing" };
    const channel = getEnderChannel(marker);
    if (!channel) return { ok: false, reason: "channel_empty", channel };
    if (getEnderMode(marker) !== ENDER_MODE_SEND) {
        return { ok: false, reason: "source_not_send", channel };
    }
    const target = getEnderTarget(marker);
    if (!target) return { ok: false, reason: "target_empty", channel, target };
    const entry = findEnderEntryByTargetKey(target);
    if (!entry) return { ok: false, reason: "target_not_registered", channel, target };
    if (entry.channel !== channel)
        return { ok: false, reason: "channel_mismatch", channel, target, entry };
    return { ok: true, channel, target, entry };
}

function registryEntryMatchesReceive(entry, marker) {
    if (!entry || !marker) return false;
    return (
        entry.dimension === marker.dimension.id &&
        entry.x === Math.floor(marker.location.x) &&
        entry.y === Math.floor(marker.location.y) &&
        entry.z === Math.floor(marker.location.z)
    );
}

function resolveIncomingSendEntries(receiveMarker) {
    const channel = getEnderChannel(receiveMarker);
    if (!channel) return [];
    const receiveEntry = loadEnderRegistry().find(
        (entry) => entry.channel === channel && registryEntryMatchesReceive(entry, receiveMarker),
    );
    if (!receiveEntry) return [];
    const receiveKey = entryKey(receiveEntry);
    const senders = [];
    for (const entry of loadEnderRegistry()) {
        if (entry.channel !== channel || entryKey(entry) === receiveKey) continue;
        const inspected = inspectEnderEntry(entry);
        if (!inspected.loaded || !inspected.blockPresent || !inspected.markerPresent) continue;
        try {
            const dimension = world.getDimension(entry.dimension);
            const block = dimension.getBlock({ x: entry.x, y: entry.y, z: entry.z });
            const marker = findMarkerAtBlock(block, ENDER_NODE_ENTITY);
            if (!marker || getEnderMode(marker) !== ENDER_MODE_SEND) continue;
            if (getEnderChannel(marker) !== channel) continue;
            if (getEnderTarget(marker) !== receiveKey) continue;
            senders.push({ entry, block, marker, inspection: inspected });
        } catch {}
    }
    return senders;
}

function topologyResultForRemoteEnder(block, marker, base) {
    const remoteStart = findRemoteGraphStart(block);
    if (!remoteStart)
        return {
            ...base,
            ok: true,
            reason: "remote_network_not_attached",
            remoteEnderBlock: block,
            remoteMarker: marker,
            remoteGraph: null,
        };
    return {
        ...base,
        ok: true,
        reason: "ok",
        remoteEnderBlock: block,
        remoteMarker: marker,
        remoteStart: remoteStart.block,
        remoteStartDirection: remoteStart.direction,
        remoteGraph: discoverNetworkGraph(remoteStart.block),
    };
}

async function resolveIncomingSendEntriesLoaded(receiveMarker) {
    const channel = getEnderChannel(receiveMarker);
    if (!channel) return [];
    const receiveEntry = loadEnderRegistry().find(
        (entry) => entry.channel === channel && registryEntryMatchesReceive(entry, receiveMarker),
    );
    if (!receiveEntry) return [];
    const receiveKey = entryKey(receiveEntry);
    const senders = [];
    for (const entry of loadEnderRegistry()) {
        if (entry.channel !== channel || entryKey(entry) === receiveKey) continue;
        // RECEIVE-side inverse resolution must load the candidate SEND before
        // inspecting its block/marker. Otherwise an unloaded SEND is silently
        // discarded even when its persisted target points at this RECEIVE.
        const area = await applyEnderTargetArea(entry);
        if (!area.ok) continue;
        const inspected = inspectEnderEntry(entry);
        if (!inspected.loaded || !inspected.blockPresent || !inspected.markerPresent) continue;
        try {
            const dimension = world.getDimension(entry.dimension);
            const block = dimension.getBlock({ x: entry.x, y: entry.y, z: entry.z });
            const marker = findMarkerAtBlock(block, ENDER_NODE_ENTITY);
            if (!marker || getEnderMode(marker) !== ENDER_MODE_SEND) continue;
            if (getEnderChannel(marker) !== channel) continue;
            if (getEnderTarget(marker) !== receiveKey) continue;
            senders.push({ entry, block, marker, inspection: inspected, area });
        } catch {}
    }
    return senders;
}

export async function resolveIncomingRemoteStorageTopologiesLoaded(receiveMarker) {
    const channel = getEnderChannel(receiveMarker);
    if (!receiveMarker) return [{ ok: false, reason: "marker_missing" }];
    if (!channel) return [{ ok: false, reason: "channel_empty", channel }];
    if (getEnderMode(receiveMarker) !== ENDER_MODE_RECEIVE)
        return [{ ok: false, reason: "source_not_receive", channel }];
    const incoming = await resolveIncomingSendEntriesLoaded(receiveMarker);
    if (incoming.length === 0)
        return [
            { ok: false, reason: "incoming_send_not_found", channel, role: ENDER_MODE_RECEIVE },
        ];
    return incoming.map((sender) =>
        topologyResultForRemoteEnder(sender.block, sender.marker, {
            channel,
            role: ENDER_MODE_RECEIVE,
            remoteRole: ENDER_MODE_SEND,
            incoming: true,
            entry: sender.entry,
            inspection: sender.inspection,
            area: sender.area,
        }),
    );
}

export function resolveIncomingRemoteStorageTopologies(receiveMarker) {
    const channel = getEnderChannel(receiveMarker);
    if (!receiveMarker) return [{ ok: false, reason: "marker_missing" }];
    if (!channel) return [{ ok: false, reason: "channel_empty", channel }];
    if (getEnderMode(receiveMarker) !== ENDER_MODE_RECEIVE)
        return [{ ok: false, reason: "source_not_receive", channel }];
    const incoming = resolveIncomingSendEntries(receiveMarker);
    if (incoming.length === 0)
        return [
            { ok: false, reason: "incoming_send_not_found", channel, role: ENDER_MODE_RECEIVE },
        ];
    return incoming.map((sender) =>
        topologyResultForRemoteEnder(sender.block, sender.marker, {
            channel,
            role: ENDER_MODE_RECEIVE,
            remoteRole: ENDER_MODE_SEND,
            incoming: true,
            entry: sender.entry,
            inspection: sender.inspection,
        }),
    );
}

// Synchronous resolver for SN-9A after the existing Ender target has already
// been loaded by the Ender node's target-selection / ticking-area machinery.
export function resolveRemoteStorageTopologyFromEnder(marker) {
    const selected = resolveSelectedTargetEntry(marker);
    if (!selected.ok) return selected;

    const inspection = inspectEnderEntry(selected.entry);
    if (!inspection.loaded)
        return { ...selected, ok: false, reason: "target_chunk_not_loaded", inspection };
    if (!inspection.blockPresent)
        return { ...selected, ok: false, reason: "target_block_missing", inspection };
    if (!inspection.markerPresent)
        return { ...selected, ok: false, reason: "target_marker_missing", inspection };

    let block;
    try {
        const remoteDimension = world.getDimension(selected.entry.dimension);
        if (
            !remoteDimension.isChunkLoaded({
                x: selected.entry.x,
                y: selected.entry.y,
                z: selected.entry.z,
            })
        ) {
            return { ...selected, ok: false, reason: "target_chunk_not_loaded", inspection };
        }
        block = remoteDimension.getBlock({
            x: selected.entry.x,
            y: selected.entry.y,
            z: selected.entry.z,
        });
    } catch {
        block = undefined;
    }

    if (!block) return { ...selected, ok: false, reason: "remote_block_unavailable" };
    const remoteMarker = findMarkerAtBlock(block, ENDER_NODE_ENTITY);
    if (!remoteMarker) return { ...selected, ok: false, reason: "target_marker_missing" };
    if (getEnderChannel(remoteMarker) !== selected.channel)
        return { ...selected, ok: false, reason: "target_marker_channel_mismatch" };
    if (getEnderMode(remoteMarker) !== ENDER_MODE_RECEIVE)
        return { ...selected, ok: false, reason: "target_not_receive" };

    const remoteStart = findRemoteGraphStart(block);
    if (!remoteStart)
        return {
            ...selected,
            ok: true,
            reason: "remote_network_not_attached",
            remoteEnderBlock: block,
            remoteMarker,
            remoteGraph: null,
        };
    const remoteGraph = discoverNetworkGraph(remoteStart.block);
    return {
        ...selected,
        ok: true,
        reason: "ok",
        remoteEnderBlock: block,
        remoteMarker,
        remoteStart: remoteStart.block,
        remoteStartDirection: remoteStart.direction,
        remoteGraph,
    };
}

export function discoverRemoteStorageTopology(startBlock) {
    const localGraph = discoverNetworkGraph(startBlock);
    if (!localGraph.start) return { localGraph, bridges: [] };
    const attachedEnders = findAdjacentEnderNodes(localGraph);
    const bridges = [];
    for (const source of attachedEnders) {
        const role = getEnderMode(source.marker);
        if (role === ENDER_MODE_SEND) {
            // SEND already owns a target ticking area; reuse the synchronous resolver.
            bridges.push({
                source,
                role,
                result: resolveRemoteStorageTopologyFromEnder(source.marker),
            });
            continue;
        }
        const incoming = resolveIncomingRemoteStorageTopologies(source.marker);
        for (const result of incoming) bridges.push({ source, role, result });
    }
    return { localGraph, bridges };
}

export async function discoverRemoteStorageTopologyLoaded(startBlock) {
    const localGraph = discoverNetworkGraph(startBlock);
    if (!localGraph.start) return { localGraph, bridges: [] };
    const attachedEnders = findAdjacentEnderNodes(localGraph);
    const bridges = [];
    for (const source of attachedEnders) {
        const role = getEnderMode(source.marker);
        if (role === ENDER_MODE_SEND) {
            // SEND already owns a target ticking area; reuse the synchronous resolver.
            bridges.push({
                source,
                role,
                result: resolveRemoteStorageTopologyFromEnder(source.marker),
            });
            continue;
        }
        const incoming = await resolveIncomingRemoteStorageTopologiesLoaded(source.marker);
        for (const result of incoming) bridges.push({ source, role, result });
    }
    return { localGraph, bridges };
}
