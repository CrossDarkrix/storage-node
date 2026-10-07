import {
    discoverSafeNetworkStorage,
    discoverSafeNetworkStorageFromGraph,
} from "./storage_discovery.js";

function makeItemKey(item) {
    if (!item?.typeId) return null;
    // SN-3 initially aggregates by Minecraft item type only.
    // Location records keep each physical stack so SN-6 can later extract safely.
    return item.typeId;
}

function buildNetworkItemIndexFromStorage(storage) {
    const items = new Map();
    let totalStacks = 0;
    let totalItems = 0;

    for (const storageEntry of storage.containers) {
        const container = storageEntry.container;
        if (!container) continue;

        let size;
        try {
            if (!container.isValid) continue;
            size = container.size;
        } catch {
            continue;
        }

        for (let slot = 0; slot < size; slot++) {
            let item;
            try {
                item = container.getItem(slot);
            } catch {
                continue;
            }
            if (!item?.typeId || !Number.isFinite(item.amount) || item.amount <= 0) continue;
            if (String(item.nameTag ?? "").includes("[VFH_CRAFTABLE]")) {
                try {
                    container.setItem(slot, undefined);
                } catch {}
                continue;
            }

            const key = makeItemKey(item);
            if (!key) continue;

            let aggregate = items.get(key);
            if (!aggregate) {
                aggregate = { key, typeId: item.typeId, total: 0, stacks: 0, locations: [] };
                items.set(key, aggregate);
            }

            aggregate.total += item.amount;
            aggregate.stacks += 1;
            aggregate.locations.push({
                containerKey: storageEntry.key,
                dimensionId: storageEntry.dimensionId,
                location: { ...storageEntry.location },
                containerTypeId: storageEntry.typeId,
                storageNodeLocation: { ...storageEntry.storageNode.location },
                direction: storageEntry.direction,
                slot,
                amount: item.amount,
            });
            totalStacks += 1;
            totalItems += item.amount;
        }
    }

    const entries = Array.from(items.values()).sort((a, b) => a.typeId.localeCompare(b.typeId));
    return {
        storage,
        entries,
        byTypeId: items,
        uniqueItems: entries.length,
        totalStacks,
        totalItems,
    };
}

export function buildNetworkItemIndex(startBlock) {
    return buildNetworkItemIndexFromStorage(discoverSafeNetworkStorage(startBlock));
}

export function buildNetworkItemIndexFromGraph(graph) {
    return buildNetworkItemIndexFromStorage(discoverSafeNetworkStorageFromGraph(graph));
}
