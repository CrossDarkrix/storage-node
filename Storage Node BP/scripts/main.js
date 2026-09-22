import "./nodes/side_node.js";
import {
    world,
} from "@minecraft/server";

import {
    findMarkerAtBlock,
    dropEntityInventory
} from "./core/marker.js"; /* Marker */

import "./nodes/storage_node.js"; /* Storage Node */

import "./nodes/vacuum_node.js"; /* vacuum Node */
import "./nodes/center_node.js"; /* Center Node C1 */
import "./nodes/ender_node.js"; /* Ender Node EN-2A */
import { removeEnderRegistryAt } from "./nodes/ender_node.js";

import {
    VACUUM_NODE_ENTITY,
    STORAGE_NODE_ENTITY,
    ENDER_NODE_ENTITY
} from "./config/constants.js";

/* =========================================================
   REMOVE MARKER
========================================================= */

world.afterEvents.playerBreakBlock.subscribe(
    ev => {

        const enderMarker = findMarkerAtBlock(ev.block, ENDER_NODE_ENTITY);
        if (enderMarker) {
            removeEnderRegistryAt(ev.block.dimension.id, ev.block.location);
        }

        for (
            const type of [
                STORAGE_NODE_ENTITY,
                VACUUM_NODE_ENTITY,
                ENDER_NODE_ENTITY
            ]
        ) {

            const marker =
                findMarkerAtBlock(
                    ev.block,
                    type
                );

            if (marker) {

                dropEntityInventory(
                    marker
                );

                marker.remove();

            }

        }

    }
);
