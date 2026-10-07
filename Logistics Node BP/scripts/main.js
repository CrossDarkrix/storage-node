import "./core/joint_visual.js";
import "./items/debug_wand.js";
import "./core/marker_lifecycle.js";
import "./nodes/side_node.js";
import { world } from "@minecraft/server";

import {
  findMarkerAtBlock,
  dropEntityInventory,
} from "./core/marker.js"; /* Marker */

import "./nodes/storage_node.js"; /* Storage Node */
import "./nodes/sort_node.js"; /* Sort Node Redstone */

import "./nodes/vacuum_node.js"; /* vacuum Node */
import "./nodes/center_node.js"; /* Center Node C1 */
import "./nodes/ender_node.js"; /* Ender Node EN-2A */
import "./nodes/network_controller.js"; /* Network Controller NC-2 */
import "./nodes/remote_order.js";
import { removeEnderRegistryAt } from "./nodes/ender_node.js";

import {
  VACUUM_NODE_ENTITY,
  STORAGE_NODE_ENTITY,
  ENDER_NODE_ENTITY,
} from "./config/constants.js";


/* =========================================================
   PLACEMENT SOUND
   Play the requested vanilla Bedrock sound when a VFH block
   is placed by a player.
========================================================= */
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
  const block = ev.block;
  if (block?.typeId !== "vfh:breaker_node") return;

  try {
    block.dimension.playSound("random.anvil_land", block.location);
  } catch {
    // Sound failure must not interfere with node placement/setup.
  }
});

/* =========================================================
   REMOVE MARKER
========================================================= */

world.afterEvents.playerBreakBlock.subscribe((ev) => {
  const enderMarker = findMarkerAtBlock(ev.block, ENDER_NODE_ENTITY);
  if (enderMarker) {
    removeEnderRegistryAt(ev.block.dimension.id, ev.block.location);
  }

  for (const type of [
    STORAGE_NODE_ENTITY,
    VACUUM_NODE_ENTITY,
    ENDER_NODE_ENTITY,
  ]) {
    const marker = findMarkerAtBlock(ev.block, type);

    if (marker) {
      dropEntityInventory(marker);

      marker.remove();
    }
  }
});

import "./nodes/large_container.js";
import "./nodes/craft_node.js"; /* Craft Node UI */

import "./nodes/insert_node.js"; /* IN-1 Insert Node */
import "./nodes/breaker_node.js"; /* BR-0 Breaker Head Prototype */
import "./nodes/placer_node.js"; /* PL-1 marker-based Placer Node */
import "./nodes/output_node.js"; /* OUT-1 filtered Output Node */

import "./nodes/trash_node.js"; /* TR-1 destructive sink */
