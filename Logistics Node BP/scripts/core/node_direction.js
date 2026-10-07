import {
    STORAGE_NODE_BLOCK,
    VACUUM_NODE_BLOCK,
    SIDE_NODE_BLOCK,
    CENTER_NODE_BLOCK,
    CENTER_NODE_ENTITY,
    SIDE_NODE_ENTITY,
    NETWORK_CONTROLLER_BLOCK,
} from "../config/constants.js";

const SORT_NODE_BLOCK = "vfh:sort_node";

export const ALL_DIRECTIONS = Object.freeze(["east", "west", "up", "down", "south", "north"]);
const DIRECTION_SET = new Set(ALL_DIRECTIONS);
const OPPOSITE_DIRECTIONS = Object.freeze({
    east: "west",
    west: "east",
    up: "down",
    down: "up",
    south: "north",
    north: "south",
});
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
const CENTER_MODE_PROPERTY = "center_node_mode";
const CENTER_MODE_STORAGE = 1;

function isEntityAtBlock(entity, block) {
    return (
        !!entity &&
        !!block &&
        Math.floor(entity.location.x) === block.location.x &&
        Math.floor(entity.location.y) === block.location.y &&
        Math.floor(entity.location.z) === block.location.z
    );
}

function getCenterMarker(block) {
    if (!block || block.typeId !== CENTER_NODE_BLOCK) return null;
    try {
        const local = block.dimension
            .getEntitiesAtBlockLocation(block.location)
            .find((entity) => entity.typeId === CENTER_NODE_ENTITY);
        if (local) return local;
    } catch {}
    try {
        return (
            block.dimension
                .getEntities({ type: CENTER_NODE_ENTITY })
                .find((entity) => isEntityAtBlock(entity, block)) ?? null
        );
    } catch {
        return null;
    }
}

function normalizeCenterFaceMode(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 2 ? number : 0;
}

function getCenterFaceMode(marker, direction) {
    if (!marker) return 0;
    const propertyName = CENTER_FACE_PROPERTY_BY_DIRECTION[direction];
    if (!propertyName) return 0;
    try {
        return normalizeCenterFaceMode(marker.getDynamicProperty(propertyName));
    } catch {
        return 0;
    }
}

function getCenterMode(marker) {
    if (!marker) return 0;
    try {
        const value = Number(marker.getDynamicProperty(CENTER_MODE_PROPERTY));
        return value === CENTER_MODE_STORAGE ? CENTER_MODE_STORAGE : 0;
    } catch {
        return 0;
    }
}
function getCenterFacesByMode(block, mode) {
    const marker = getCenterMarker(block);
    if (!marker) return [];
    if (getCenterMode(marker) === CENTER_MODE_STORAGE) {
        return mode === CENTER_FACE_MODE_INPUT ? [...ALL_DIRECTIONS] : [];
    }
    return ALL_DIRECTIONS.filter((direction) => getCenterFaceMode(marker, direction) === mode);
}

function normalizeDirection(direction) {
    return DIRECTION_SET.has(direction) ? direction : null;
}

function getCardinalDirection(block) {
    if (!block) return null;
    try {
        const direction = block.permutation.getState("minecraft:cardinal_direction");
        return typeof direction === "string" ? direction : null;
    } catch {
        return null;
    }
}

export function getOppositeDirection(direction) {
    const normalized = normalizeDirection(direction);
    return normalized ? OPPOSITE_DIRECTIONS[normalized] : null;
}

function getSortFaceMode(block, direction) {
    if (block?.typeId !== SORT_NODE_BLOCK || direction === "up") return "";
    try {
        const v = block.permutation.getState(`vfh:sort_${direction}`);
        return v === "input" || v === "filter" || v === "normal" ? v : "";
    } catch {
        return "";
    }
}
export function getNodeInputFaces(block) {
    if (block?.typeId === SORT_NODE_BLOCK)
        return ALL_DIRECTIONS.filter(
            (direction) => direction !== "up" && getSortFaceMode(block, direction) === "input",
        );
    if (block?.typeId === SIDE_NODE_BLOCK) {
        try {
            const marker = block.dimension
                .getEntitiesAtBlockLocation(block.location)
                .find((entity) => entity.typeId === SIDE_NODE_ENTITY);
            const saved = marker?.getDynamicProperty("side_input_direction");
            if (typeof saved === "string" && ALL_DIRECTIONS.includes(saved)) return [saved];
        } catch {}
        const legacy = getCardinalDirection(block);
        return legacy ? [legacy] : [];
    }
    if (block?.typeId === CENTER_NODE_BLOCK)
        return getCenterFacesByMode(block, CENTER_FACE_MODE_INPUT);
    if (block?.typeId === NETWORK_CONTROLLER_BLOCK) return [];
    if (!block) return [];
    switch (block.typeId) {
        case STORAGE_NODE_BLOCK:
            return ["up"];
        case VACUUM_NODE_BLOCK:
            return [];
        default:
            return [];
    }
}

export function getNodeOutputFaces(block) {
    if (block?.typeId === SORT_NODE_BLOCK)
        return ALL_DIRECTIONS.filter(
            (direction) =>
                direction !== "up" &&
                ["filter", "normal"].includes(getSortFaceMode(block, direction)),
        );
    if (block?.typeId === CENTER_NODE_BLOCK)
        return getCenterFacesByMode(block, CENTER_FACE_MODE_OUTPUT);
    if (block?.typeId === NETWORK_CONTROLLER_BLOCK) return [];
    if (!block) return [];
    switch (block.typeId) {
        case STORAGE_NODE_BLOCK:
            return ALL_DIRECTIONS.filter((direction) => direction !== "up");
        case SIDE_NODE_BLOCK: {
            const inputs = getNodeInputFaces(block);
            if (inputs.length !== 1) return [];
            return ALL_DIRECTIONS.filter((direction) => direction !== inputs[0]);
        }
        case VACUUM_NODE_BLOCK:
            return [...ALL_DIRECTIONS];
        default:
            return [];
    }
}

export function isNodeInputFace(block, direction) {
    const normalized = normalizeDirection(direction);
    return !!normalized && getNodeInputFaces(block).includes(normalized);
}

export function isNodeOutputFace(block, direction) {
    const normalized = normalizeDirection(direction);
    return !!normalized && getNodeOutputFaces(block).includes(normalized);
}

function isCenterNodeBlock(block) {
    return block?.typeId === CENTER_NODE_BLOCK;
}

function isAllowedNodePair(sourceBlock, targetBlock) {
    if (!sourceBlock || !targetBlock) return false;
    if (sourceBlock.typeId === SORT_NODE_BLOCK || targetBlock.typeId === SORT_NODE_BLOCK)
        return true;
    return isCenterNodeBlock(sourceBlock) !== isCenterNodeBlock(targetBlock);
}

export function canNodeConnectToNode(sourceBlock, sourceDirection, targetBlock) {
    if (!isAllowedNodePair(sourceBlock, targetBlock)) return false;
    const normalized = normalizeDirection(sourceDirection);
    if (!sourceBlock || !targetBlock || !normalized) return false;
    if (!isNodeOutputFace(sourceBlock, normalized)) return false;
    const targetDirection = getOppositeDirection(normalized);
    if (!targetDirection) return false;
    return isNodeInputFace(targetBlock, targetDirection);
}
