import { system, world, ItemStack } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
import { discoverNetworkGraph } from "../core/network_graph.js";
import { buildNetworkItemIndexFromGraph } from "../core/network_item_index.js";

const CRAFT_NODE_BLOCK = "vfh:craft_node";
const STORAGE_NODE_BLOCK = "vfh:storage_node";
const NETWORK_CONTROLLER_BLOCK = "vfh:network_controller";
const NETWORK_DIRECTIONS = [
    { name: "north", x: 0, y: 0, z: -1 },
    { name: "south", x: 0, y: 0, z: 1 },
    { name: "east", x: 1, y: 0, z: 0 },
    { name: "west", x: -1, y: 0, z: 0 },
    { name: "up", x: 0, y: 1, z: 0 },
    { name: "down", x: 0, y: -1, z: 0 },
];
const CRAFT_NODE_SETTINGS = "vfh:craft_node_settings";
const PATTERN_ENTITY = "entity:craft_node_pattern_terminal";
const patternSessions = new Map();
const CRAFT_NODE_ID_NEXT_KEY = "vfh:craft_node:next_id";
const CRAFT_NODE_ID_INDEX_KEY = "vfh:craft_node:index";
const CRAFT_NODE_RECORD_PREFIX = "vfh:craft_node:";
function adjacentStorageNodes(block) {
    const found = [];
    if (!block?.dimension) return found;
    for (const d of NETWORK_DIRECTIONS) {
        let b = null;
        try {
            b = block.dimension.getBlock({
                x: block.location.x + d.x,
                y: block.location.y + d.y,
                z: block.location.z + d.z,
            });
        } catch {}
        if (b?.typeId === STORAGE_NODE_BLOCK) found.push({ direction: d.name, block: b });
    }
    return found;
}
export function detectCraftNodeNetwork(block) {
    if (!block || block.typeId !== CRAFT_NODE_BLOCK)
        return {
            connected: false,
            reason: "invalid_craft_node",
            entry: null,
            graph: { start: null, nodes: [], edges: [] },
            storageNodes: [],
            controllers: [],
        };
    const entries = adjacentStorageNodes(block);
    if (entries.length === 0)
        return {
            connected: false,
            reason: "no_adjacent_storage_node",
            entry: null,
            graph: { start: null, nodes: [], edges: [] },
            storageNodes: [],
            controllers: [],
        };
    let best = null;
    for (const entry of entries) {
        const graph = discoverNetworkGraph(entry.block);
        const storageNodes = (graph.nodes ?? []).filter((b) => b?.typeId === STORAGE_NODE_BLOCK);
        const controllers = (graph.nodes ?? []).filter(
            (b) => b?.typeId === NETWORK_CONTROLLER_BLOCK,
        );
        const result = { connected: true, reason: "ok", entry, graph, storageNodes, controllers };
        if (!best || (graph.nodes?.length ?? 0) > (best.graph.nodes?.length ?? 0)) best = result;
    }
    return best;
}
function logCraftNodeNetworkDiagnostic(block) {
    let r;
    try {
        r = detectCraftNodeNetwork(block);
    } catch (err) {
        (() => {})(`[Craft Node NETWORK] Detection=ERROR Error=${err}`);
        return;
    }
    const entry = r?.entry;
    const entryBlock = entry?.block;
    const entryPos = entryBlock?.location;
    const controllerCount = r?.controllers?.length ?? 0;
    const nodeCount = r?.graph?.nodes?.length ?? 0;
    const storageCount = r?.storageNodes?.length ?? 0;
    (() => {})(
        `[Craft Node NETWORK] Adjacent Storage Node=${entryBlock ? "FOUND" : "NOT_FOUND"} Direction=${entry?.direction ?? "-"} Network=${r?.connected ? "FOUND" : "NOT_FOUND"} Reason=${r?.reason ?? "unknown"} Nodes=${nodeCount} Storage Nodes=${storageCount} Controller=${controllerCount > 0 ? "FOUND" : "NOT_FOUND"}${entryPos ? ` Entry=${entryPos.x},${entryPos.y},${entryPos.z}` : ""}`,
    );
}
function requiredRecipeItems(recipe) {
    const required = new Map();
    for (const item of recipe?.pattern ?? []) {
        if (!item?.typeId) continue;
        required.set(item.typeId, (required.get(item.typeId) ?? 0) + 1);
    }
    return required;
}
export function checkCraftNodeRecipeAvailability(block, recipe = getCraftNodeRecipe(block)) {
    const network = detectCraftNodeNetwork(block);
    if (!network?.connected)
        return {
            craftable: false,
            reason: network?.reason ?? "network_not_found",
            network,
            required: [],
            missing: [],
        };
    if (!recipe?.result?.typeId)
        return {
            craftable: false,
            reason: "recipe_not_registered",
            network,
            required: [],
            missing: [],
        };
    const index = buildNetworkItemIndexFromGraph(network.graph);
    const required = Array.from(requiredRecipeItems(recipe), ([typeId, amount]) => {
        const available = Math.max(0, Number(index.byTypeId.get(typeId)?.total) || 0);
        return { typeId, required: amount, available, enough: available >= amount };
    });
    const missing = required.filter((x) => !x.enough);
    return {
        craftable: missing.length === 0,
        reason: missing.length === 0 ? "ok" : "missing_ingredients",
        network,
        index,
        required,
        missing,
    };
}

function craftNodeLocationKey(block) {
    const l = block.location;
    return `${block.dimension.id}|${l.x}|${l.y}|${l.z}`;
}
export function readCraftNodeIndex() {
    try {
        const raw = world.getDynamicProperty(CRAFT_NODE_ID_INDEX_KEY);
        if (typeof raw !== "string" || !raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}
function writeCraftNodeIndex(index) {
    world.setDynamicProperty(CRAFT_NODE_ID_INDEX_KEY, JSON.stringify(index));
}
function craftNodeRecordKey(cnId) {
    return `${CRAFT_NODE_RECORD_PREFIX}${cnId}`;
}
export function readCraftNodeRecord(cnId) {
    if (!cnId) return null;
    try {
        const raw = world.getDynamicProperty(craftNodeRecordKey(cnId));
        if (typeof raw !== "string" || !raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}
function writeCraftNodeRecord(cnId, record) {
    if (!cnId) throw new Error("Craft Node ID is required");
    world.setDynamicProperty(craftNodeRecordKey(cnId), JSON.stringify(record));
}
function allocateCraftNodeId() {
    const raw = world.getDynamicProperty(CRAFT_NODE_ID_NEXT_KEY);
    const current = Number(raw);
    const next = Number.isSafeInteger(current) && current >= 1 ? current : 1;
    const cnId = `CN-${String(next).padStart(8, "0")}`;
    world.setDynamicProperty(CRAFT_NODE_ID_NEXT_KEY, next + 1);
    return cnId;
}
function ensureCraftNodeId(block) {
    const locationKey = craftNodeLocationKey(block),
        index = readCraftNodeIndex(),
        existing = index[locationKey];
    if (typeof existing === "string" && existing) return existing;
    const cnId = allocateCraftNodeId();
    const record = {
        schema: 1,
        id: cnId,
        location: {
            dimensionId: block.dimension.id,
            x: block.location.x,
            y: block.location.y,
            z: block.location.z,
        },
        recipe: null,
    };
    writeCraftNodeRecord(cnId, record);
    index[locationKey] = cnId;
    writeCraftNodeIndex(index);
    return cnId;
}
function getCraftNodeId(block) {
    const id = readCraftNodeIndex()[craftNodeLocationKey(block)];
    return typeof id === "string" && id ? id : null;
}
function getCraftNodeRecipe(block) {
    const id = getCraftNodeId(block);
    return id ? (readCraftNodeRecord(id)?.recipe ?? null) : null;
}
function saveCraftNodeRecipe(block, recipe) {
    const id = ensureCraftNodeId(block),
        record = readCraftNodeRecord(id) ?? { schema: 1, id };
    record.schema = 1;
    record.id = id;
    record.location = {
        dimensionId: block.dimension.id,
        x: block.location.x,
        y: block.location.y,
        z: block.location.z,
    };
    record.recipe = recipe;
    writeCraftNodeRecord(id, record);
    return id;
}
function clearCraftNodeRecipe(block) {
    const id = getCraftNodeId(block);
    if (!id) return false;
    const record = readCraftNodeRecord(id);
    if (!record) return false;
    record.recipe = null;
    writeCraftNodeRecord(id, record);
    return true;
}
function removeCraftNodeIdentity(block) {
    const locationKey = craftNodeLocationKey(block),
        index = readCraftNodeIndex(),
        id = index[locationKey];
    if (typeof id !== "string" || !id) return false;
    world.setDynamicProperty(craftNodeRecordKey(id), undefined);
    delete index[locationKey];
    writeCraftNodeIndex(index);
    return true;
}
const patternParkState = new Map();
function homeBlockFromSession(e) {
    const s = patternSessions.get(e.id);
    if (!s) return null;
    try {
        return world.getDimension(s.dimensionId).getBlock(s.location);
    } catch {
        return null;
    }
}
function parkPatternEntity(e, player) {
    if (!e?.isValid || !player?.isValid) return;
    const s = patternSessions.get(e.id);
    if (!s) return;
    try {
        e.teleport(
            { x: player.location.x, y: player.location.y + 10, z: player.location.z },
            { dimension: player.dimension },
        );
        patternParkState.set(e.id, player.id);
    } catch {}
}
function restorePatternEntity(e) {
    if (!e?.isValid) return;
    const s = patternSessions.get(e.id);
    if (!s) return;
    try {
        const dim = world.getDimension(s.dimensionId);
        e.teleport(
            { x: s.location.x + 0.5, y: s.location.y + 0.5, z: s.location.z + 0.5 },
            { dimension: dim },
        );
        patternParkState.delete(e.id);
    } catch {}
}

function key(block) {
    const l = block.location;
    return `${block.dimension.id}|${l.x}|${l.y}|${l.z}`;
}
function center(block) {
    const l = block.location;
    return { x: l.x + 0.5, y: l.y + 0.5, z: l.z + 0.5 };
}
function t(player, ja, en) {
    try {
        return player?.getDynamicProperty?.("vfh:language") === "en" ? en : ja;
    } catch {
        return ja;
    }
}
function validBlock(block) {
    return !!block && block.typeId === CRAFT_NODE_BLOCK;
}
function findPatternEntity(block) {
    if (!validBlock(block)) return null;
    const k = key(block);
    for (const e of block.dimension.getEntities({
        type: PATTERN_ENTITY,
        location: center(block),
        maxDistance: 0.9,
    })) {
        try {
            if (e.getDynamicProperty("vfh:craft_node_home") === k) return e;
        } catch {}
    }
    return null;
}
function ensurePatternEntity(block, player) {
    let e = findPatternEntity(block);
    if (!e) {
        e = block.dimension.spawnEntity(PATTERN_ENTITY, center(block));
    }
    e.nameTag = "Craft Node Pattern 3x3";
    try {
        e.setDynamicProperty("vfh:craft_node_home", key(block));
    } catch {}
    try {
        e.teleport(center(block), { dimension: block.dimension });
    } catch {}
    patternSessions.set(e.id, {
        blockKey: key(block),
        dimensionId: block.dimension.id,
        location: { ...block.location },
        playerId: player?.id ?? null,
    });
    return e;
}
function patternItems(block) {
    const e = findPatternEntity(block),
        inv = e?.getComponent("minecraft:inventory")?.container;
    if (!inv) return [];
    const a = [];
    for (let i = 0; i < 9; i++) {
        const it = inv.getItem(i);
        a.push(it ? { slot: i, typeId: it.typeId, amount: it.amount } : null);
    }
    return a;
}
function fmtPattern(items) {
    const rows = [];
    for (let r = 0; r < 3; r++) {
        rows.push(
            items
                .slice(r * 3, r * 3 + 3)
                .map((x) => (x ? x.typeId.replace("minecraft:", "") : "[ ]"))
                .join(" | "),
        );
    }
    return rows.join("\n");
}
function recipePatternItems(recipe) {
    return Array.from({ length: 9 }, (_, i) => {
        const x = recipe?.pattern?.[i];
        return x?.typeId ? { slot: i, typeId: x.typeId, amount: 1 } : null;
    });
}
function fmtRegisteredRecipe(recipe) {
    if (!recipe) return "";
    const pattern = fmtPattern(recipePatternItems(recipe));
    const result = recipe.result?.typeId
        ? `${recipe.result.typeId} x${Math.max(1, Number(recipe.result.amount) || 1)}`
        : "-";
    return `${pattern}\nResult: ${result}`;
}
function clearPattern(block) {
    const e = findPatternEntity(block),
        inv = e?.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    for (let i = 0; i < 11; i++) inv.setItem(i, undefined);
}
function isEmpty(block) {
    return patternItems(block).every((x) => !x);
}
function removeEmptyPatternEntity(block) {
    const e = findPatternEntity(block);
    if (!e) return;
    if (isEmpty(block)) {
        patternSessions.delete(e.id);
        try {
            e.remove();
        } catch {}
    }
}
export async function openPatternInput(player, block) {
    if (!validBlock(block)) return;
    ensureCraftNodeId(block);
    const e = ensurePatternEntity(block, player);
    player.sendMessage({
        rawtext: [
            { text: "§6[Craft Node] " },
            { translate: "vfh.message.craft_node.pattern_opened" },
        ],
    });
    // Native entity container opens by interacting with the spawned entity at block center.
}
export async function openCraftNodeMenu(player, block) {
    if (!validBlock(block)) return;
    ensureCraftNodeId(block);
    logCraftNodeNetworkDiagnostic(block);
    const recipe = getCraftNodeRecipe(block),
        has = !!recipe;
    const form = new ActionFormData()
        .title({ translate: "vfh.ui.craft_node.title" })
        .body(
            has
                ? {
                      rawtext: [
                          { translate: "vfh.ui.craft_node.registered" },
                          { text: ":\n" },
                          { text: fmtRegisteredRecipe(recipe) },
                      ],
                  }
                : { translate: "vfh.ui.craft_node.unregistered" },
        )
        .button({ translate: "vfh.ui.craft_node.pattern_input" }, "textures/blocks/craft_node")
        .button({ translate: "vfh.ui.craft_node.view_pattern" }, "textures/blocks/craft_node")
        .button({ translate: "vfh.ui.craft_node.clear_pattern" }, "textures/ui/trash_default")
        .button({ translate: "vfh.ui.craft_node.close" });
    const r = await form.show(player).catch(() => null);
    if (!r || r.canceled) return;
    if (r.selection === 0) {
        await openPatternInput(player, block);
    } else if (r.selection === 1) {
        const current = getCraftNodeRecipe(block);
        player.sendMessage(
            current
                ? `§6[Craft Node]\n${fmtRegisteredRecipe(current)}`
                : {
                      rawtext: [
                          { text: "§e[Craft Node] " },
                          { translate: "vfh.message.craft_node.not_registered" },
                      ],
                  },
        );
    } else if (r.selection === 2) {
        clearPattern(block);
        clearCraftNodeRecipe(block);
        player.sendMessage({
            rawtext: [{ text: "§a[Craft Node] " }, { translate: "vfh.message.craft_node.cleared" }],
        });
    }
}

system.beforeEvents.startup.subscribe((event) => {
    event.blockComponentRegistry.registerCustomComponent(CRAFT_NODE_SETTINGS, {
        onPlayerInteract(ev) {
            const p = ev.player,
                b = ev.block;
            if (!p || !validBlock(b)) return;
            system.run(() => openCraftNodeMenu(p, b));
        },
    });
});

world.afterEvents.playerBreakBlock.subscribe((ev) => {
    if (ev.brokenBlockPermutation?.type?.id !== CRAFT_NODE_BLOCK) return;
    const l = ev.block.location,
        dim = ev.block.dimension,
        k = `${dim.id}|${l.x}|${l.y}|${l.z}`;
    removeCraftNodeIdentity(ev.block);
    for (const e of dim.getEntities({
        type: PATTERN_ENTITY,
        location: { x: l.x + 0.5, y: l.y + 0.5, z: l.z + 0.5 },
        maxDistance: 1.0,
    })) {
        try {
            if (e.getDynamicProperty("vfh:craft_node_home") !== k) continue;
        } catch {
            continue;
        }
        const inv = e.getComponent("minecraft:inventory")?.container;
        if (inv) {
            for (let i = 0; i < inv.size; i++) inv.setItem(i, undefined);
        }
        patternSessions.delete(e.id);
        try {
            e.remove();
        } catch {}
    }
});

const COPY_PREFIX = "§r§8[VFH Pattern] §r";
const RESULT_PREFIX = "§r§8[VFH Result] §r";
function ownerPlayer(e) {
    const s = patternSessions.get(e.id);
    return s?.playerId ? world.getPlayers().find((p) => p.id === s.playerId) : null;
}
function giveBack(player, item) {
    if (!player || !item) return;
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return;
    const x = item.clone();
    x.nameTag = undefined;
    const rem = inv.addItem(x);
    if (rem) {
        try {
            player.dimension.spawnItem(rem, player.location);
        } catch {}
    }
}
function displayCopy(typeId) {
    const x = new ItemStack(typeId, 1);
    x.nameTag = COPY_PREFIX + typeId;
    return x;
}
function resultCopy(typeId, amount) {
    const x = new ItemStack(typeId, Math.max(1, amount || 1));
    x.nameTag = RESULT_PREFIX + typeId;
    return x;
}
function readPatternState(e) {
    try {
        const r = e.getDynamicProperty("vfh:pattern_state");
        if (!r) return Array(9).fill(null);
        const a = JSON.parse(r);
        return Array.from({ length: 9 }, (_, i) => a?.[i] || null);
    } catch {
        return Array(9).fill(null);
    }
}
function writePatternState(e, a) {
    try {
        e.setDynamicProperty("vfh:pattern_state", JSON.stringify(a));
    } catch {}
}
function isPatternCopy(it) {
    return !!it?.nameTag?.startsWith(COPY_PREFIX);
}
function isResultCopy(it) {
    return !!it?.nameTag?.startsWith(RESULT_PREFIX);
}
function purgeEscapedCopies() {
    for (const player of world.getPlayers()) {
        const inv = player.getComponent("minecraft:inventory")?.container;
        if (!inv) continue;
        for (let i = 0; i < inv.size; i++) {
            const it = inv.getItem(i);
            if (isPatternCopy(it) || isResultCopy(it)) inv.setItem(i, undefined);
        }
        for (const ent of player.dimension.getEntities({
            type: "minecraft:item",
            location: player.location,
            maxDistance: 8,
        })) {
            const it = ent.getComponent("minecraft:item")?.itemStack;
            if (isPatternCopy(it) || isResultCopy(it)) {
                try {
                    ent.remove();
                } catch {}
            }
        }
    }
}
function syncPattern(e, inv, state, player) {
    for (let i = 0; i < 9; i++) {
        const cur = inv.getItem(i),
            saved = state[i];
        if (!saved) {
            if (!cur) continue;
            if (isPatternCopy(cur)) {
                inv.setItem(i, undefined);
                continue;
            }
            const real = cur.clone();
            // Claim the terminal slot first. Returning the real stack can immediately
            // affect the player's open container transaction, so writing the display
            // copy before giveBack prevents the replacement from being lost/ejected.
            state[i] = { typeId: real.typeId };
            inv.setItem(i, displayCopy(real.typeId));
            giveBack(player, real);
            continue;
        }
        if (!cur) {
            state[i] = null;
            continue;
        }
        if (isPatternCopy(cur)) {
            if (cur.typeId !== saved.typeId) inv.setItem(i, displayCopy(saved.typeId));
            continue;
        }
        const real = cur.clone();
        if (real.typeId === saved.typeId) {
            // Putting the same real item onto an occupied pattern slot means clear it.
            state[i] = null;
            inv.setItem(i, undefined);
            giveBack(player, real);
        } else {
            // Replace the pattern atomically before returning the real input.
            state[i] = { typeId: real.typeId };
            inv.setItem(i, displayCopy(real.typeId));
            giveBack(player, real);
        }
    }
}

// CN-P1 Result Preview Detector: vanilla Crafter probe using saved typeIds only.
// Pattern display copies are never loaded into the probe and Pattern inventory is never consumed.
const patternPreviewMachines = new Map();
const PREVIEW_PLACE_SETTLE = 4,
    PREVIEW_LOAD_SETTLE = 4,
    PREVIEW_PULSE = 2,
    PREVIEW_POST_SETTLE = 4,
    PREVIEW_DROP_TIMEOUT = 20;
function patternKey(state) {
    return state.map((x) => x?.typeId ?? "empty").join("|");
}
function previewConfig(d) {
    if (d === "minecraft:nether" || d === "minecraft:the_end") return { y: 0 };
    return { y: -64 };
}
function previewWorkspace(dim, p) {
    return [p, { x: p.x, y: p.y + 1, z: p.z }, { x: p.x + 1, y: p.y, z: p.z }].map((q) => ({
        q,
        permutation: dim.getBlock(q)?.permutation,
    }));
}
function restorePreview(m) {
    for (const x of [...m.saved].reverse()) {
        try {
            if (x.permutation) m.dim.getBlock(x.q)?.setPermutation(x.permutation);
        } catch (err) {
            (() => {})(`[Craft Node CN-P1] restore failed: ${err}`);
        }
    }
}
function nearbyItemIds(dim, p) {
    return new Set(
        dim
            .getEntities({
                type: "minecraft:item",
                location: { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 },
                maxDistance: 4,
            })
            .map((x) => x.id),
    );
}
function newDrops(m) {
    return m.dim
        .getEntities({
            type: "minecraft:item",
            location: { x: m.p.x + 0.5, y: m.p.y + 0.5, z: m.p.z + 0.5 },
            maxDistance: 4,
        })
        .filter((x) => !m.before.has(x.id));
}
function stopPreview(e, clearResult = false) {
    const m = patternPreviewMachines.get(e.id);
    if (m) {
        for (const x of newDrops(m)) {
            try {
                x.remove();
            } catch {}
        }
        restorePreview(m);
        patternPreviewMachines.delete(e.id);
    }
    if (clearResult) {
        try {
            e.setDynamicProperty("vfh:pattern_result", undefined);
        } catch {}
    }
}
function startPreview(e, state) {
    const k = patternKey(state),
        old = e.getDynamicProperty("vfh:pattern_detect_key");
    if (old === k || patternPreviewMachines.has(e.id)) return;
    if (state.every((x) => !x)) {
        stopPreview(e, true);
        e.setDynamicProperty("vfh:pattern_detect_key", k);
        return;
    }
    stopPreview(e, true);
    const home = patternSessions.get(e.id);
    if (!home) return;
    let dim;
    try {
        dim = world.getDimension(home.dimensionId);
    } catch {
        return;
    }
    const cfg = previewConfig(home.dimensionId),
        p = { x: Math.floor(home.location.x), y: cfg.y, z: Math.floor(home.location.z) };
    patternPreviewMachines.set(e.id, {
        dim,
        p,
        saved: previewWorkspace(dim, p),
        before: nearbyItemIds(dim, p),
        phase: "place",
        phaseTick: system.currentTick,
        key: k,
        state: state.map((x) => (x ? { typeId: x.typeId } : null)),
    });
}
function tickPreview(e, state) {
    const m = patternPreviewMachines.get(e.id);
    if (!m) return;
    if (patternKey(state) !== m.key) {
        stopPreview(e, true);
        return;
    }
    try {
        if (m.phase === "place") {
            m.dim.runCommand(
                `setblock ${m.p.x} ${m.p.y} ${m.p.z} crafter ["orientation"="up_east"]`,
            );
            m.dim.runCommand(`setblock ${m.p.x} ${m.p.y + 1} ${m.p.z} air`);
            m.dim.runCommand(`setblock ${m.p.x + 1} ${m.p.y} ${m.p.z} air`);
            m.phase = "load";
            m.phaseTick = system.currentTick;
            return;
        }
        if (m.phase === "load") {
            if (system.currentTick - m.phaseTick < PREVIEW_PLACE_SETTLE) return;
            for (let i = 0; i < 9; i++) {
                const x = m.state[i];
                m.dim.runCommand(
                    x
                        ? `replaceitem block ${m.p.x} ${m.p.y} ${m.p.z} slot.container ${i} ${x.typeId} 1`
                        : `replaceitem block ${m.p.x} ${m.p.y} ${m.p.z} slot.container ${i} air`,
                );
            }
            m.phase = "pulseOn";
            m.phaseTick = system.currentTick;
            return;
        }
        if (m.phase === "pulseOn") {
            if (system.currentTick - m.phaseTick < PREVIEW_LOAD_SETTLE) return;
            m.dim.runCommand(`setblock ${m.p.x + 1} ${m.p.y} ${m.p.z} redstone_block`);
            m.phase = "pulseOff";
            m.phaseTick = system.currentTick;
            return;
        }
        if (m.phase === "pulseOff") {
            if (system.currentTick - m.phaseTick < PREVIEW_PULSE) return;
            m.dim.runCommand(`setblock ${m.p.x + 1} ${m.p.y} ${m.p.z} air`);
            m.phase = "post";
            m.phaseTick = system.currentTick;
            return;
        }
        if (m.phase === "post") {
            if (system.currentTick - m.phaseTick < PREVIEW_POST_SETTLE) return;
            m.phase = "wait";
            m.phaseTick = system.currentTick;
            return;
        }
        if (m.phase === "wait") {
            const drops = newDrops(m),
                valid = drops
                    .map((x) => ({ e: x, stack: x.getComponent("minecraft:item")?.itemStack }))
                    .filter((x) => x.stack);
            if (valid.length === 1) {
                const out = valid[0].stack;
                for (const x of drops) {
                    try {
                        x.remove();
                    } catch {}
                }
                e.setDynamicProperty(
                    "vfh:pattern_result",
                    JSON.stringify({ typeId: out.typeId, amount: Math.max(1, out.amount ?? 1) }),
                );
                e.setDynamicProperty("vfh:pattern_detect_key", m.key);
                restorePreview(m);
                patternPreviewMachines.delete(e.id);
                return;
            }
            if (valid.length > 1 || system.currentTick - m.phaseTick >= PREVIEW_DROP_TIMEOUT) {
                for (const x of drops) {
                    try {
                        x.remove();
                    } catch {}
                }
                e.setDynamicProperty("vfh:pattern_result", undefined);
                e.setDynamicProperty("vfh:pattern_detect_key", m.key);
                restorePreview(m);
                patternPreviewMachines.delete(e.id);
            }
        }
    } catch (err) {
        (() => {})(`[Craft Node CN-P1] detector failed: ${err}`);
        stopPreview(e, true);
        try {
            e.setDynamicProperty("vfh:pattern_detect_key", m.key);
        } catch {}
    }
}
const AUTO_REGISTER_STABLE_TICKS = 60;
const autoRegisterStable = new Map();
function tryAutoCommitDetectedRecipe(e, state, player) {
    const key = patternKey(state);
    if (!state.some(Boolean)) {
        autoRegisterStable.delete(e.id);
        return false;
    }
    let result;
    try {
        result = JSON.parse(e.getDynamicProperty("vfh:pattern_result") || "null");
    } catch {
        autoRegisterStable.delete(e.id);
        return false;
    }
    if (!result?.typeId) {
        autoRegisterStable.delete(e.id);
        return false;
    }
    const detected = String(e.getDynamicProperty("vfh:pattern_detect_key") ?? "");
    if (detected !== key) {
        autoRegisterStable.delete(e.id);
        return false;
    }
    const resultKey = `${result.typeId}#${Math.max(1, Number(result.amount) || 1)}`,
        stable = autoRegisterStable.get(e.id);
    if (!stable || stable.patternKey !== key || stable.resultKey !== resultKey) {
        autoRegisterStable.set(e.id, { patternKey: key, resultKey, startTick: system.currentTick });
        return false;
    }
    if (system.currentTick - stable.startTick < AUTO_REGISTER_STABLE_TICKS) return false;
    const home = homeBlockFromSession(e);
    if (!home) {
        autoRegisterStable.delete(e.id);
        return false;
    }
    const recipe = {
        schema: 1,
        pattern: state.map((x) => (x?.typeId ? { typeId: x.typeId } : null)),
        result: { typeId: result.typeId, amount: Math.max(1, Number(result.amount) || 1) },
    };
    saveCraftNodeRecipe(home, recipe);
    autoRegisterStable.delete(e.id);
    if (player)
        player.sendMessage({
            rawtext: [
                { text: "§a[Craft Node] " },
                { translate: "vfh.message.craft_node.auto_registered" },
            ],
        });
    cleanupRegisteredPatternEntity(e);
    return true;
}
function cleanupRegisteredPatternEntity(e) {
    if (!e?.isValid) return;
    stopPreview(e, false);
    patternSessions.delete(e.id);
    patternParkState.delete(e.id);
    autoRegisterStable.delete(e.id);
    try {
        e.remove();
    } catch {}
}
function syncResult(e, inv, state) {
    const spec = (() => {
        try {
            return JSON.parse(e.getDynamicProperty("vfh:pattern_result") || "null");
        } catch {
            return null;
        }
    })();
    const cur = inv.getItem(9);
    if (!spec) {
        if (cur) inv.setItem(9, undefined);
        return;
    }
    if (!cur || !isResultCopy(cur) || cur.typeId !== spec.typeId || cur.amount !== spec.amount)
        inv.setItem(9, resultCopy(spec.typeId, spec.amount));
}
system.runInterval(() => {
    purgeEscapedCopies();
    for (const dimId of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
        let dim;
        try {
            dim = world.getDimension(dimId);
        } catch {
            continue;
        }
        for (const e of dim.getEntities({ type: PATTERN_ENTITY })) {
            const inv = e.getComponent("minecraft:inventory")?.container;
            if (!inv) continue;
            const player = ownerPlayer(e),
                state = readPatternState(e);
            syncPattern(e, inv, state, player);
            writePatternState(e, state);
            startPreview(e, state);
            tickPreview(e, state);
            if (tryAutoCommitDetectedRecipe(e, state, player)) continue;
            syncResult(e, inv, state);
        }
    }
}, 1);

// CN-P1 Pattern terminal park lifecycle: frees Craft Node hitbox while sneaking for adjacent placement/breaking.
system.runInterval(() => {
    for (const dimId of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
        let dim;
        try {
            dim = world.getDimension(dimId);
        } catch {
            continue;
        }
        for (const e of dim.getEntities({ type: PATTERN_ENTITY })) {
            const s = patternSessions.get(e.id);
            if (!s) continue;
            const owner = s.playerId ? world.getPlayers().find((p) => p.id === s.playerId) : null;
            if (!owner?.isValid) {
                if (patternParkState.has(e.id)) restorePatternEntity(e);
                continue;
            }
            if (owner.isSneaking) {
                if (!patternParkState.has(e.id)) parkPatternEntity(e, owner);
                else
                    try {
                        e.teleport(
                            { x: owner.location.x, y: owner.location.y + 10, z: owner.location.z },
                            { dimension: owner.dimension },
                        );
                    } catch {}
            } else if (patternParkState.has(e.id)) restorePatternEntity(e);
        }
    }
}, 1);
world.afterEvents.playerBreakBlock.subscribe((ev) => {
    if (ev.brokenBlockPermutation?.type?.id !== CRAFT_NODE_BLOCK) return;
    const l = ev.block.location,
        k = `${ev.dimension.id}|${l.x}|${l.y}|${l.z}`;
    for (const dimId of ["minecraft:overworld", "minecraft:nether", "minecraft:the_end"]) {
        let dim;
        try {
            dim = world.getDimension(dimId);
        } catch {
            continue;
        }
        for (const e of dim.getEntities({ type: PATTERN_ENTITY })) {
            let h;
            try {
                h = e.getDynamicProperty("vfh:craft_node_home");
            } catch {}
            if (h !== k) continue;
            stopPreview(e, false);
            patternSessions.delete(e.id);
            patternParkState.delete(e.id);
            try {
                e.remove();
            } catch {}
        }
    }
});
