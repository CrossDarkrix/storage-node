import { world, system } from "@minecraft/server";
import {
    NODE_CONNECTION_DIRECTIONS,
    isConnectionNode,
    getConnectionNeighbor,
    getNodePairConnections,
} from "./node_connection.js";

const STATE_BY_DIRECTION = Object.freeze({
    north: "vfh:joint_north",
    south: "vfh:joint_south",
    east: "vfh:joint_east",
    west: "vfh:joint_west",
    up: "vfh:joint_up",
    down: "vfh:joint_down",
});

function syncBlock(block) {
    if (!isConnectionNode(block)) return;
    const desired = getNodePairConnections(block);
    try {
        let p = block.permutation;
        let changed = false;
        for (const d of NODE_CONNECTION_DIRECTIONS) {
            const stateName = STATE_BY_DIRECTION[d.name];
            const current = p.getState(stateName);
            if (current === undefined) return;
            const next = desired[d.name] ? 1 : 0;
            if (current !== next) {
                p = p.withState(stateName, next);
                changed = true;
            }
        }
        if (changed) block.setPermutation(p);
    } catch {}
}

function syncPairNeighborhood(block) {
    syncBlock(block);
    for (const direction of NODE_CONNECTION_DIRECTIONS)
        syncBlock(getConnectionNeighbor(block, direction));
}

world.afterEvents.playerPlaceBlock.subscribe((event) => {
    system.run(() => syncPairNeighborhood(event.block));
});
world.afterEvents.playerBreakBlock.subscribe((event) => {
    system.run(() => {
        for (const direction of NODE_CONNECTION_DIRECTIONS) {
            try {
                const neighbor = event.dimension.getBlock({
                    x: event.block.location.x + direction.x,
                    y: event.block.location.y + direction.y,
                    z: event.block.location.z + direction.z,
                });
                syncBlock(neighbor);
            } catch {}
        }
    });
});
