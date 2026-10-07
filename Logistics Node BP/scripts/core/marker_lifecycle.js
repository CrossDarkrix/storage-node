import { world, system } from "@minecraft/server";
import { repairOwnedMarker } from "./marker.js";
import {
    VACUUM_NODE_ENTITY,
    VACUUM_NODE_BLOCK,
    SIDE_NODE_ENTITY,
    SIDE_NODE_BLOCK,
    CENTER_NODE_ENTITY,
    CENTER_NODE_BLOCK,
    ENDER_NODE_ENTITY,
    ENDER_NODE_BLOCK,
    DIMENSION_IDS,
} from "../config/constants.js";

const NODE_TYPES = Object.freeze([
    [VACUUM_NODE_ENTITY, VACUUM_NODE_BLOCK],
    [SIDE_NODE_ENTITY, SIDE_NODE_BLOCK],
    [CENTER_NODE_ENTITY, CENTER_NODE_BLOCK],
    [ENDER_NODE_ENTITY, ENDER_NODE_BLOCK],
]);

system.runInterval(() => {
    for (const dimensionId of DIMENSION_IDS) {
        let dimension;
        try {
            dimension = world.getDimension(dimensionId);
        } catch {
            continue;
        }
        for (const [entityType, blockType] of NODE_TYPES) {
            let markers = [];
            try {
                markers = dimension.getEntities({ type: entityType });
            } catch {
                continue;
            }
            for (const marker of markers) repairOwnedMarker(marker, entityType, blockType);
        }
    }
}, 5);
