/**
 * Layered sets. Pure functions with no SillyTavern imports, so they can be tested on their own.
 *
 * A set is { kind, base, modifiers, on, off, updated }:
 * - kind 'set' can be applied and linked. It starts from its base set (or from nothing), then
 *   applies each modifier in order, then its own changes.
 * - kind 'modifier' is only a list of changes (switch these on, switch these off). It can't be
 *   applied by itself; sets stack it on top of their base.
 *
 * Exclusive prompts (one Vex, one length and so on, marked in the prompt text) are respected when
 * layers combine: a layer that switches one on switches off any inherited prompt it excludes.
 *
 * rules = { groupOf: Map<id, groupName>, withIds: Map<id, id[]> }, either may be empty.
 */

const unique = (list) => Array.isArray(list)
    ? [...new Set(list.filter(id => typeof id === 'string' && id.length > 0))]
    : [];

/** Bring a stored or imported set to the current shape. Version 1 sets stored the full list as `ids`. */
export function normaliseSet(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const kind = raw.kind === 'modifier' ? 'modifier' : 'set';

    const set = {
        kind,
        base: kind === 'set' && typeof raw.base === 'string' && raw.base ? raw.base : null,
        modifiers: kind === 'set' ? unique(raw.modifiers) : [],
        on: raw.on !== undefined ? unique(raw.on) : unique(raw.ids),
        off: unique(raw.off),
        updated: typeof raw.updated === 'string' ? raw.updated : new Date().toISOString(),
    };

    // What a modifier was made against (a set plus other modifiers), for showing and editing it.
    // It never changes what the modifier does.
    if (kind === 'modifier' && raw.context && typeof raw.context === 'object') {
        set.context = {
            base: typeof raw.context.base === 'string' && raw.context.base ? raw.context.base : null,
            modifiers: unique(raw.context.modifiers),
        };
    }

    return set;
}

/** True when switching `id` on should switch `other` off (same exclusive group, or named). */
export function excludes(rules, id, other) {
    const group = rules?.groupOf?.get(id);

    return (group && rules.groupOf.get(other) === group)
        || (rules?.withIds?.get(id) || []).includes(other)
        || (rules?.withIds?.get(other) || []).includes(id);
}

/** Apply one layer's changes to a state, in place. */
export function applyChanges(state, on, off, rules) {
    for (const id of off) {
        state.delete(id);
    }

    const ownOn = new Set(on);

    for (const id of on) {
        // Prompts this layer switches on itself are never pushed out by each other.
        for (const other of [...state]) {
            if (other !== id && !ownOn.has(other) && excludes(rules, id, other)) {
                state.delete(other);
            }
        }

        state.add(id);
    }

    return state;
}

/**
 * The prompts a set switches on, as a Set, plus any problems found on the way (a missing base or
 * modifier, or sets that build on each other in a loop). Problems never throw; the broken part is
 * left out and reported.
 */
export function resolve(sets, name, rules, trail = []) {
    const problems = [];
    const ids = resolveInto(sets, name, rules, trail, problems);
    return { ids, problems };
}

function resolveInto(sets, name, rules, trail, problems) {
    if (trail.includes(name)) {
        problems.push(`"${name}" builds on itself (${[...trail, name].join(' → ')}).`);
        return new Set();
    }

    const set = sets[name];

    if (!set) {
        problems.push(`"${name}" no longer exists.`);
        return new Set();
    }

    const state = inheritedInto(sets, name, set, rules, [...trail, name], problems);
    return applyChanges(state, set.on, set.off, rules);
}

function inheritedInto(sets, name, layers, rules, trail, problems) {
    if (layers.kind === 'modifier') {
        return new Set();
    }

    const state = layers.base ? resolveInto(sets, layers.base, rules, trail, problems) : new Set();

    for (const modName of layers.modifiers || []) {
        const mod = sets[modName];

        if (!mod || mod.kind !== 'modifier') {
            problems.push(`"${name}" uses "${modName}", which is not a modifier any more.`);
            continue;
        }

        applyChanges(state, mod.on, mod.off, rules);
    }

    return state;
}

/**
 * What a set gets before its own changes: its base, then its modifiers. `layers` can be a draft
 * ({ kind, base, modifiers }) so the editor can preview a different base before saving.
 */
export function inherited(sets, name, layers, rules) {
    const problems = [];
    const ids = inheritedInto(sets, name, layers, rules, name ? [name] : [], problems);
    return { ids, problems };
}

/**
 * The smallest own changes that turn `from` into exactly `target`. Checked by replaying them, so
 * the saved set always comes out as the toggles that were on when it was saved.
 */
export function changesBetween(from, target, rules, order = null) {
    const wanted = new Set(target);
    const on = [...wanted].filter(id => !from.has(id));
    const off = [...from].filter(id => !wanted.has(id));

    // If the target itself has two prompts that exclude each other, the replay would drop one;
    // listing it as switched on here keeps it.
    for (let pass = 0; pass < 5; pass++) {
        const replay = applyChanges(new Set(from), on, off, rules);
        const lost = [...wanted].filter(id => !replay.has(id));

        if (!lost.length) {
            break;
        }

        on.push(...lost.filter(id => !on.includes(id)));
    }

    if (order) {
        const rank = new Map(order.map((id, index) => [id, index]));
        const byOrder = (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity);
        on.sort(byOrder);
        off.sort(byOrder);
    }

    return { on, off };
}

/** Sets that use `name` directly, as their base or as a modifier. */
export function directDependants(sets, name) {
    return Object.keys(sets).filter(other => sets[other].base === name || (sets[other].modifiers || []).includes(name));
}

/** Sets that would change if `name` changed: everything that builds on it, however far down. */
export function allDependants(sets, name) {
    const found = new Set();
    const queue = [name];

    while (queue.length) {
        for (const other of directDependants(sets, queue.shift())) {
            if (!found.has(other) && other !== name) {
                found.add(other);
                queue.push(other);
            }
        }
    }

    return [...found];
}

/** Sets that `name` may build on: other sets (not modifiers) that don't already build on it. */
export function possibleBases(sets, name) {
    const below = new Set(name ? allDependants(sets, name) : []);
    return Object.keys(sets).filter(other => other !== name && sets[other].kind === 'set' && !below.has(other));
}

/**
 * Change what a set builds on without changing what it switches on now: its own changes are
 * recalculated against the new base and modifiers.
 */
export function relayer(sets, name, base, modifiers, rules, order = null) {
    const set = sets[name];
    const now = resolve(sets, name, rules).ids;
    const draft = { kind: set.kind, base: base || null, modifiers: [...(modifiers || [])] };
    const from = inherited(sets, name, draft, rules).ids;
    const { on, off } = changesBetween(from, now, rules, order);
    return { ...set, base: draft.base, modifiers: draft.modifiers, on, off };
}

/** Point every reference to `from` at `to`. */
export function renameReferences(sets, from, to) {
    for (const set of Object.values(sets)) {
        if (set.base === from) {
            set.base = to;
        }

        set.modifiers = (set.modifiers || []).map(mod => (mod === from ? to : mod)).filter(Boolean);

        if (set.context) {
            set.context.base = set.context.base === from ? to : set.context.base;
            set.context.modifiers = set.context.modifiers.map(mod => (mod === from ? to : mod)).filter(Boolean);

            if (!set.context.base && !set.context.modifiers.length) {
                delete set.context;
            }
        }
    }
}

/**
 * Delete a set or modifier without changing what any other set switches on. Sets built on a
 * deleted set move to its base; sets using a deleted modifier drop it. Their own changes are
 * recalculated so they come out exactly as before.
 */
export function removeKeeping(sets, name, rules, order = null) {
    const gone = sets[name];

    if (!gone) {
        return [];
    }

    const affected = directDependants(sets, name);
    const before = new Map(affected.map(other => [other, resolve(sets, other, rules).ids]));
    const next = { ...sets };
    delete next[name];

    for (const other of affected) {
        const set = sets[other];
        const base = set.base === name ? gone.base : set.base;
        const modifiers = (set.modifiers || []).filter(mod => mod !== name);
        const from = inherited(next, other, { kind: set.kind, base, modifiers }, rules).ids;
        const { on, off } = changesBetween(from, before.get(other), rules, order);
        next[other] = { ...set, base, modifiers, on, off };
    }

    for (const key of Object.keys(sets)) {
        delete sets[key];
    }

    Object.assign(sets, next);

    // A modifier shown against the deleted one is shown against what's left.
    renameReferences(sets, name, null);
    return affected;
}

/** Problems across all sets: loops, and bases or modifiers that are missing or the wrong kind. */
export function checkAll(sets, rules) {
    const problems = new Set();

    for (const name of Object.keys(sets)) {
        for (const problem of resolve(sets, name, rules).problems) {
            problems.add(problem);
        }
    }

    return [...problems];
}

/**
 * Read a prompt's markers the way NemoPresetExt does: every line inside each {{// … }} block.
 * `withIds` holds the references as written (ids or prompt names); see resolveReference.
 */
export function readMarkers(text) {
    const lines = markerLines(text);
    let group = null;
    const withIds = [];
    let tooltip = null;

    for (const line of lines) {
        if (line.startsWith('@mutual-exclusive-group ')) {
            group = line.slice('@mutual-exclusive-group '.length).trim() || null;
        } else if (line.startsWith('@exclusive-with-category ')) {
            group = line.slice('@exclusive-with-category '.length).trim() || null;
        } else if (line.startsWith('@exclusive-with ')) {
            withIds.push(...line.slice('@exclusive-with '.length).split(',').map(id => id.trim()).filter(Boolean));
        } else if (line.startsWith('@tooltip ') && tooltip === null) {
            tooltip = line.slice('@tooltip '.length).trim();
        }
    }

    return { group, withIds, tooltip };
}

/** The trimmed lines inside every {{// … }} block of a prompt's text. */
export function markerLines(text) {
    const lines = [];
    const blocks = /\{\{\/\/([\s\S]*?)\}\}/g;
    let match;

    while ((match = blocks.exec(String(text || ''))) !== null) {
        for (const line of match[1].split(/\r?\n/)) {
            const trimmed = line.trim();

            if (trimmed) {
                lines.push(trimmed);
            }
        }
    }

    return lines;
}

/** How NemoPresetExt compares a reference with a prompt id or name. */
export function normaliseReference(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^[^\p{Letter}\p{Number}]+/u, '')
        .replace(/\s+/g, ' ');
}
