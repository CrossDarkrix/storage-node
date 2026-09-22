import {
    STORAGE_NODE_BLOCK,
    VACUUM_NODE_BLOCK,
    SIDE_NODE_BLOCK,
    CENTER_NODE_BLOCK,
    CENTER_NODE_ENTITY,
    SIDE_NODE_ENTITY
} from "../config/constants.js";

export const ALL_DIRECTIONS = Object.freeze([
    "east",
    "west",
    "up",
    "down",
    "south",
    "north"
]);

const DIRECTION_SET = new Set(ALL_DIRECTIONS);

const OPPOSITE_DIRECTIONS = Object.freeze({
    east: "west",
    west: "east",
    up: "down",
    down: "up",
    south: "north",
    north: "south"
});

/*
 * Side Node S1-C2 confirmed convention:
 * player-facing north -> input west
 * player-facing south -> input east
 * player-facing east  -> input north
 * player-facing west  -> input south
 */
/* CENTER NODE C3 DIRECTION START */
const CENTER_FACE_PROPERTY_BY_DIRECTION = Object.freeze({
    east: "center_face_east",
    west: "center_face_west",
    up: "center_face_up",
    down: "center_face_down",
    south: "center_face_south",
    north: "center_face_north",
});

const CENTER_FACE_MODE_INPUT = 1;
const CENTER_FACE_MODE_OUTPUT = 2;

function getCenterMarker(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK) {
        return null;
    }

    return block.dimension
        .getEntities({ type: CENTER_NODE_ENTITY })
        .find(entity =>
            Math.floor(entity.location.x) === block.location.x &&
            Math.floor(entity.location.y) === block.location.y &&
            Math.floor(entity.location.z) === block.location.z
        ) ?? null;
}

function getCenterFaceMode(marker, direction) {
    if (!marker) return 0;

    const propertyName =
        CENTER_FACE_PROPERTY_BY_DIRECTION[direction];

    if (!propertyName) return 0;

    const value = marker.getDynamicProperty(propertyName);

    return Number.isInteger(value) && value >= 0 && value <= 2
        ? value
        : 0;
}

function getCenterFacesByMode(block, mode) {
    const marker = getCenterMarker(block);
    if (!marker) return [];

    return ALL_DIRECTIONS.filter(direction =>
        getCenterFaceMode(marker, direction) === mode
    );
}
/* CENTER NODE C3 DIRECTION END */

const SIDE_INPUT_BY_FACING = Object.freeze({
    north: "west",
    south: "east",
    east: "north",
    west: "south"
});

function normalizeDirection(direction) {
    return DIRECTION_SET.has(direction) ? direction : null;
}

function getCardinalDirection(block) {
    if (!block) return null;
    try {
        const direction = block.permutation.getState(
            "minecraft:cardinal_direction"
        );
        return typeof direction === "string" ? direction : null;
    } catch {
        return null;
    }
}

export function getOppositeDirection(direction) {
    const normalized = normalizeDirection(direction);
    return normalized ? OPPOSITE_DIRECTIONS[normalized] : null;
}

export function getNodeInputFaces(block) {
    /* SIDE S2-A DIRECTION V3 */
    if (block?.typeId === SIDE_NODE_BLOCK) {
        const marker = block.dimension.getEntities({ type: SIDE_NODE_ENTITY }).find(entity =>
            Math.floor(entity.location.x) === block.location.x &&
            Math.floor(entity.location.y) === block.location.y &&
            Math.floor(entity.location.z) === block.location.z
        );
        const saved = marker?.getDynamicProperty("side_input_direction");
        if (typeof saved === "string" && ALL_DIRECTIONS.includes(saved)) return [saved];
        const legacy = getCardinalDirection(block);
        return legacy ? [legacy] : [];
    }

    if (block?.typeId === CENTER_NODE_BLOCK) {
        return getCenterFacesByMode(
            block,
            CENTER_FACE_MODE_INPUT
        );
    }

    if (!block) return [];

    switch (block.typeId) {
        case STORAGE_NODE_BLOCK:
            return ["up"];

        case SIDE_NODE_BLOCK: {
            const facing = getCardinalDirection(block);
            const input = SIDE_INPUT_BY_FACING[facing];
            return input ? [input] : [];
        }

        case VACUUM_NODE_BLOCK:
            /* Vacuum obtains items from the world, not from a network input face. */
            return [];

        default:
            return [];
    }
}

export function getNodeOutputFaces(block) {
    if (block?.typeId === CENTER_NODE_BLOCK) {
        return getCenterFacesByMode(
            block,
            CENTER_FACE_MODE_OUTPUT
        );
    }

    if (!block) return [];

    switch (block.typeId) {
        case STORAGE_NODE_BLOCK:
            return ALL_DIRECTIONS.filter(direction => direction !== "up");

        case SIDE_NODE_BLOCK: {
            const inputs = getNodeInputFaces(block);
            if (inputs.length !== 1) return [];
            const input = inputs[0];
            return ALL_DIRECTIONS.filter(direction => direction !== input);
        }

        case VACUUM_NODE_BLOCK:
            return [...ALL_DIRECTIONS];

        default:
            return [];
    }
}

export function isNodeInputFace(block, direction) {
    const normalized = normalizeDirection(direction);
    if (!normalized) return false;
    return getNodeInputFaces(block).includes(normalized);
}

export function isNodeOutputFace(block, direction) {
    const normalized = normalizeDirection(direction);
    if (!normalized) return false;
    return getNodeOutputFaces(block).includes(normalized);
}

/*
 * Common Node-to-Node connection rule.
 * sourceDirection is expressed from the source block toward the target block.
 * A valid connection requires:
 *   1. source face is OUTPUT
 *   2. opposite target face is INPUT
 */
/* CENTER NODE C4 CONNECTION POLICY START */
function isCenterNodeBlock(block) {
    return block?.typeId === CENTER_NODE_BLOCK;
}

function isAllowedNodePair(sourceBlock, targetBlock) {
    if (!sourceBlock || !targetBlock) return false;

    const sourceIsCenter = isCenterNodeBlock(sourceBlock);
    const targetIsCenter = isCenterNodeBlock(targetBlock);

    // C4 policy:
    // normal Node -> normal Node : blocked
    // normal Node -> Center      : allowed
    // Center -> normal Node      : allowed
    // Center -> Center           : blocked for now
    return sourceIsCenter !== targetIsCenter;
}
/* CENTER NODE C4 CONNECTION POLICY END */

export function canNodeConnectToNode(
    sourceBlock,
    sourceDirection,
    targetBlock
) {
    if (!isAllowedNodePair(sourceBlock, targetBlock)) {
        return false;
    }

    const normalized = normalizeDirection(sourceDirection);
    if (!sourceBlock || !targetBlock || !normalized) {
        return false;
    }

    if (!isNodeOutputFace(sourceBlock, normalized)) {
        return false;
    }

    const targetDirection = getOppositeDirection(normalized);
    if (!targetDirection) {
        return false;
    }

    return isNodeInputFace(targetBlock, targetDirection);
}
