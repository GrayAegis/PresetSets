import { eventSource, event_types, main_api, saveSettingsDebounced } from '../../../../script.js';
import { oai_settings, openai_settings, openai_setting_names, promptManager } from '../../../openai.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { user_avatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import { download } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import {
    allDependants, applyChanges, changesBetween, checkAll, directDependants, excludes, inherited,
    normaliseReference, normaliseSet, possibleBases, readMarkers, removeKeeping, renameReferences, resolve,
} from './layers.js';

const MODULE_NAME = 'presetSets';
const LOG = '[Preset Sets]';
const EXPORT_FORMAT = 'preset-sets';
const EXPORT_VERSION = 2;

const defaultSettings = {
    /** Apply the linked set whenever the persona, chat or preset changes, and before each generation. */
    autoApply: true,
    /** Show a notice when a set is applied automatically. */
    notify: true,
    /**
     * Per Chat Completion preset name:
     * { sets: { [name]: Set }, defaultSet, locked, known: string[], markers: { groups, withIds } }
     * A Set is { kind: 'set'|'modifier', base, modifiers, on, off, updated }, and a modifier may
     * also have context: { base, modifiers }, what it was made against (see layers.js).
     * `known` is every prompt seen so far, so new prompts can be offered to sets.
     * `markers` caches which prompts exclude each other, read from the prompt text.
     */
    presets: {},
    /** Persona links: { [personaAvatar]: { [preset]: setName } } */
    links: {},
    /** Character card (or group chat) links: { [cardKey]: { [preset]: setName } } */
    cardLinks: {},
    /** Persona modifiers, stacked on whatever set applies: { [personaAvatar]: { [preset]: modifierName } } */
    personaMods: {},
};

const EMPTY_RULES = Object.freeze({ groupOf: new Map(), withIds: new Map() });

/** How long an apply waits for SillyTavern to save the toggles before carrying on. */
const SAVE_WAIT_MS = 2500;

/** Notices already shown this session, so a stale set doesn't warn on every message. */
const warnedMissing = new Set();
const reportedProblems = new Set();

/** The last automatic or manual apply. */
let lastApplied = null;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    const settings = extension_settings[MODULE_NAME];

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }

    // Persona-with-card links were replaced by persona modifiers.
    delete settings.pairLinks;
    return settings;
}

/** The name of the Chat Completion preset currently loaded. */
function currentPresetName() {
    return oai_settings?.preset_settings_openai || null;
}

const normalised = new WeakSet();

/** The stored sets for a preset. With `create`, an empty record is made if there is none. */
function presetData(name = currentPresetName(), create = false) {
    if (!name) {
        return null;
    }

    const settings = getSettings();

    if (!settings.presets[name] && create) {
        settings.presets[name] = { sets: {}, defaultSet: null, locked: false };
    }

    const data = settings.presets[name];

    if (data && !normalised.has(data)) {
        data.sets ??= {};

        // Version 1 sets were full lists; they become sets with no base.
        for (const [setName, raw] of Object.entries(data.sets)) {
            const set = normaliseSet(raw);

            if (set) {
                data.sets[setName] = set;
            } else {
                delete data.sets[setName];
            }
        }

        data.locked = Boolean(data.locked);

        if (data.defaultSet === undefined) {
            data.defaultSet = null;
        }

        // Guarded prompts were removed in favour of the preset lock.
        delete data.guarded;
        normalised.add(data);
    }

    return data || null;
}

function personaName(avatar = user_avatar) {
    return power_user.personas?.[avatar] || avatar || 'no persona';
}

/** Names in this preset, sorted. `kind` limits them to sets or to modifiers. */
function setNames(data = presetData(), kind = null) {
    if (!data) {
        return [];
    }

    return Object.keys(data.sets)
        .filter(name => !kind || data.sets[name].kind === kind)
        .sort((a, b) => a.localeCompare(b));
}

function cleanName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------
// Prompt state
// ---------------------------------------------------------------------------------------------

/** Sets only work with Chat Completion, once its prompt manager has loaded. */
function isReady() {
    const pm = promptManager;
    return main_api === 'openai'
        && Boolean(pm?.activeCharacter)
        && Array.isArray(pm?.serviceSettings?.prompts)
        && typeof pm.getPromptOrderForCharacter === 'function';
}

/**
 * The prompts in the active order, with their current state.
 * Prompts SillyTavern doesn't allow to be toggled (markers and the like) are left out,
 * so a set never tries to change them.
 */
function readRows() {
    const pm = promptManager;
    const prompts = new Map(pm.serviceSettings.prompts.map(prompt => [prompt.identifier, prompt]));
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    const rows = [];

    for (const entry of order) {
        const prompt = prompts.get(entry?.identifier);

        if (!prompt) {
            continue;
        }

        const allowed = typeof pm.isPromptToggleAllowed === 'function'
            ? Boolean(pm.isPromptToggleAllowed(prompt))
            : true;

        if (!allowed) {
            continue;
        }

        rows.push({ entry, id: entry.identifier, name: prompt.name || entry.identifier, enabled: Boolean(entry.enabled) });
    }

    return rows;
}

/** The identifiers of every switched-on prompt. */
function captureIds() {
    return readRows().filter(row => row.enabled).map(row => row.id);
}

/** Every prompt in the active order, toggleable or not, in order. */
function orderIds() {
    const pm = promptManager;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    return new Set(order.map(entry => entry?.identifier).filter(Boolean));
}

/**
 * What applying a list of prompts would change, without changing anything. A prompt that can't be
 * toggled (a marker, say) is left alone; only prompts the preset doesn't have count as missing.
 */
function planApply(ids, rows = readRows()) {
    const wanted = new Set(ids);
    const present = orderIds();

    return {
        changes: rows.filter(row => row.enabled !== wanted.has(row.id)),
        missing: ids.filter(id => !present.has(id)),
    };
}

/**
 * Switch prompts on and off to match a list. Prompts not listed are switched off.
 * Only the live toggles change; the preset file on disk is not touched.
 */
async function applyIds(ids) {
    const pm = promptManager;
    const before = planApply(ids);

    for (const row of before.changes) {
        row.entry.enabled = !row.enabled;
    }

    if (before.changes.length) {
        // SillyTavern's save only resolves once the settings save succeeds, and never if it fails.
        // The toggles are already live in memory, so wait a little for it, never indefinitely.
        try {
            await Promise.race([
                Promise.resolve(pm.saveServiceSettings?.()),
                new Promise(resolve => setTimeout(resolve, SAVE_WAIT_MS)),
            ]);
        } catch (error) {
            console.warn(LOG, 'Saving the prompt toggles failed', error);
        }

        // NemoPresetExt can keep the text of switched-off prompts out of memory. Its own save
        // hook loads newly enabled prompts, but asking again here is cheap and makes sure the
        // text is in place before anything is sent.
        try {
            await globalThis.NemoColdPrompts?.ready?.();
        } catch (error) {
            console.warn(LOG, 'NemoPresetExt reported a problem loading prompts', error);
        }

        try {
            pm.render?.(false);
        } catch (error) {
            console.warn(LOG, 'Could not redraw the prompt manager', error);
        }
    }

    const after = planApply(ids);

    return {
        changed: before.changes.length,
        missing: before.missing,
        remaining: after.changes.map(row => row.name),
    };
}

/** Run applies one at a time, so overlapping events can't interleave their changes. */
let queue = Promise.resolve();

function serial(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

// ---------------------------------------------------------------------------------------------
// Exclusive prompts and layers
// ---------------------------------------------------------------------------------------------

const rulesCache = new WeakMap();

function toRules(markers) {
    if (!markers) {
        return EMPTY_RULES;
    }

    let rules = rulesCache.get(markers);

    if (!rules) {
        rules = {
            groupOf: new Map(Object.entries(markers.groups || {})),
            withIds: new Map(Object.entries(markers.withIds || {})),
        };
        rulesCache.set(markers, rules);
    }

    return rules;
}

/** Which prompts exclude each other in this preset, as last read from the prompt text. */
function rulesFor(data = presetData()) {
    return toRules(data?.markers);
}

/**
 * Read prompts' text. NemoPresetExt can keep switched-off prompts' text out of memory, so the text
 * is read through it when it is installed.
 */
async function readPromptTexts(prompts = promptManager.serviceSettings.prompts) {
    const cold = globalThis.NemoColdPrompts;

    const found = await Promise.all(prompts.map(async prompt => {
        let text = prompt?.content ?? '';

        if (typeof cold?.readBody === 'function') {
            try {
                text = (await cold.readBody(prompt)) ?? text;
            } catch (error) {
                console.warn(LOG, `Could not read "${prompt?.name}" through NemoPresetExt`, error);
            }
        }

        return [prompt.identifier, String(text || '')];
    }));

    return new Map(found);
}

/**
 * The exclusivity markers in a set of prompt texts, in prompt order. `@exclusive-with` may name
 * prompts by id or by name, as NemoPresetExt allows; both are turned into ids here.
 */
function markersFrom(texts, prompts = promptManager?.serviceSettings?.prompts || []) {
    const groups = {};
    const withIds = {};
    const byReference = new Map();

    for (const prompt of prompts) {
        byReference.set(normaliseReference(prompt.identifier), prompt.identifier);

        if (prompt.name && !byReference.has(normaliseReference(prompt.name))) {
            byReference.set(normaliseReference(prompt.name), prompt.identifier);
        }
    }

    const toId = (reference) => (texts.has(reference) ? reference : byReference.get(normaliseReference(reference)) ?? reference);

    for (const [id, text] of texts) {
        const marks = readMarkers(text);

        if (marks.group) {
            groups[id] = marks.group;
        }

        if (marks.withIds.length) {
            withIds[id] = [...new Set(marks.withIds.map(toId))].filter(other => other !== id);
        }
    }

    return { groups, withIds };
}

/** The prompt texts read last, kept in memory only (never saved), for descriptions in the editor. */
let lastTexts = null;

/** Re-read the markers, keep them with the preset's sets, and return the rules. */
async function refreshRules() {
    if (!isReady()) {
        return EMPTY_RULES;
    }

    const preset = currentPresetName();
    const texts = await readPromptTexts();
    lastTexts = { preset, texts };
    const markers = markersFrom(texts);
    const data = presetData();

    if (!data || currentPresetName() !== preset) {
        return toRules(markers);
    }

    if (JSON.stringify(markers) !== JSON.stringify(data.markers)) {
        data.markers = markers;
        saveSettingsDebounced();
    }

    return rulesFor(data);
}

/**
 * A short description of a prompt for hover text: its `@tooltip` marker if it has one (leading
 * [tags] dropped), otherwise the start of its text with macros and markup taken out.
 */
function describePrompt(text) {
    const source = String(text || '');
    const tooltip = readMarkers(source).tooltip;

    if (tooltip) {
        return tooltip.replace(/^(\s*\[[^\]]*\]\s*)+/, '').trim();
    }

    const plain = source
        .replace(/\{\{\/\/[\s\S]*?\}\}/g, ' ')
        .replace(/\{\{[^{}]*\}\}/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return plain.length > 280 ? `${plain.slice(0, 277).trimEnd()}…` : plain;
}

/** The prompts a set switches on, with its base and modifiers worked in. */
function setIds(name, data = presetData()) {
    if (!data?.sets[name]) {
        return null;
    }

    const { ids, problems } = resolve(data.sets, name, rulesFor(data));

    for (const problem of problems) {
        const key = `${currentPresetName()}\u0000${problem}`;

        if (!reportedProblems.has(key)) {
            reportedProblems.add(key);
            toastr.warning(problem, 'Preset Sets');
        }
    }

    return [...ids];
}

/** Remember every prompt the preset has, so later additions can be offered to sets. */
function ensureKnown(data) {
    if (data && !Array.isArray(data.known) && isReady()) {
        data.known = readRows().map(row => row.id);
    }
}

// ---------------------------------------------------------------------------------------------
// Links: persona set, card set, persona modifier
// ---------------------------------------------------------------------------------------------

/** The open character card, or group chat, as a stable key and a display name. */
function currentCard() {
    let context;

    try {
        context = getContext();
    } catch {
        return null;
    }

    if (context?.groupId) {
        const group = context.groups?.find(item => String(item.id) === String(context.groupId));
        return { key: `group:${context.groupId}`, name: group?.name || 'this group chat' };
    }

    const character = context?.characterId !== undefined ? context.characters?.[context.characterId] : null;
    return character?.avatar ? { key: character.avatar, name: character.name || character.avatar } : null;
}

function linkPath(kind, preset, avatar, card) {
    const settings = getSettings();

    if (kind === 'persona') {
        return [settings.links, [avatar, preset]];
    }

    if (kind === 'card') {
        return [settings.cardLinks, [card, preset]];
    }

    // 'personaMod': the modifier a persona stacks on top of whatever set applies.
    return [settings.personaMods, [avatar, preset]];
}

function getLink(kind, preset = currentPresetName(), avatar = user_avatar, card = currentCard()?.key) {
    const [root, keys] = linkPath(kind, preset, avatar, card);

    if (keys.some(key => !key)) {
        return null;
    }

    return keys.reduce((node, key) => node?.[key], root) ?? null;
}

function setLink(kind, name, preset = currentPresetName(), avatar = user_avatar, card = currentCard()?.key) {
    const [root, keys] = linkPath(kind, preset, avatar, card);

    if (keys.some(key => !key)) {
        return;
    }

    let node = root;
    const trail = [];

    for (const key of keys.slice(0, -1)) {
        node[key] ??= {};
        trail.push([node, key]);
        node = node[key];
    }

    if (name) {
        node[keys.at(-1)] = name;
    } else {
        delete node[keys.at(-1)];

        // Tidy away empty records.
        for (const [parent, key] of trail.reverse()) {
            if (Object.keys(parent[key]).length) {
                break;
            }

            delete parent[key];
        }
    }

    saveSettingsDebounced();
}

/**
 * What should be active: a set, and the persona's modifier on top of it.
 *
 * The set is the persona's link if it has one, then the card's link, then the preset's set for
 * anything without a link. The persona's modifier, if it has one, goes on top of that set, or on
 * top of the preset's own toggles when no set applies. A link to something that no longer exists
 * is skipped, so a missing set never leaves an unexpected state in place.
 */
function targetFor(avatar = user_avatar, preset = currentPresetName(), card = currentCard()?.key) {
    const data = presetData(preset);

    if (!data) {
        return null;
    }

    const broken = [];
    let found = null;
    const candidates = [
        ['persona', getLink('persona', preset, avatar, card)],
        ['card', getLink('card', preset, avatar, card)],
        ['default', data.defaultSet],
    ];

    for (const [source, name] of candidates) {
        if (!name) {
            continue;
        }

        if (data.sets[name]?.kind === 'set') {
            found = { name, source };
            break;
        }

        broken.push(name);
    }

    let modifier = getLink('personaMod', preset, avatar, card);

    if (modifier && data.sets[modifier]?.kind !== 'modifier') {
        broken.push(modifier);
        modifier = null;
    }

    if (!found && !modifier) {
        return broken.length ? { name: null, source: 'none', modifier: null, broken } : null;
    }

    return { name: found?.name ?? null, source: found?.source ?? 'none', modifier, broken };
}

/** "DC + [Mei]", or "the preset's toggles + [Mei]" when only a modifier applies. */
function targetLabel(target) {
    const base = target?.name ?? 'the preset\'s own toggles';
    return target?.modifier ? `${base} + [${target.modifier}]` : base;
}

/** The prompts a target switches on: its set (or the preset's own toggles), then the persona's modifier. */
function targetIds(target, data = presetData()) {
    if (!target || (!target.name && !target.modifier)) {
        return null;
    }

    const base = target.name ? setIds(target.name, data) : savedPresetIds();

    if (!base) {
        return null;
    }

    const mod = target.modifier ? data?.sets[target.modifier] : null;
    return mod ? [...applyChanges(new Set(base), mod.on, mod.off, rulesFor(data))] : base;
}

function sourceText(target) {
    const card = currentCard()?.name || 'this card';
    const parts = [];

    switch (target?.source) {
        case 'persona': parts.push(`set linked to ${personaName()}`); break;
        case 'card': parts.push(`set linked to ${card}`); break;
        case 'default': parts.push('set for anything without a link'); break;
        case 'manual': parts.push('applied by hand'); break;
        default: break;
    }

    if (target?.modifier) {
        parts.push(`${personaName()}'s modifier`);
    }

    return parts.join(', ');
}

/** When a set or modifier is renamed or deleted, move or drop every link and default that named it. */
function relinkName(preset, from, to) {
    const settings = getSettings();
    const data = presetData(preset);

    if (data && data.defaultSet === from) {
        data.defaultSet = to;
    }

    const fix = (record) => {
        if (record?.[preset] === from) {
            if (to) {
                record[preset] = to;
            } else {
                delete record[preset];
            }
        }
    };

    Object.values(settings.links).forEach(fix);
    Object.values(settings.cardLinks).forEach(fix);
    Object.values(settings.personaMods).forEach(fix);
}

/** Choose where a set (persona, card) or a modifier (stacked for a persona) is used. */
async function chooseLinks(name) {
    const data = presetData();
    const item = data?.sets[name];

    if (!item) {
        return;
    }

    const card = currentCard();
    const content = document.createElement('div');
    content.classList.add('ps-links');

    const heading = document.createElement('h3');
    heading.textContent = item.kind === 'set' ? `Use "${name}" for` : `Stack [${name}] for`;
    content.appendChild(heading);

    const choices = item.kind === 'set'
        ? [
            ['persona', `${personaName()}, with any card`],
            ['card', card ? `${card.name}, for any persona without a set of its own` : 'a character card (open a chat first)'],
        ]
        : [
            ['personaMod', `${personaName()}, on top of whatever set applies`],
        ];

    const boxes = {};

    for (const [kind, label] of choices) {
        const row = document.createElement('label');
        row.classList.add('checkbox_label');

        const box = document.createElement('input');
        box.type = 'checkbox';
        const current = getLink(kind);
        box.checked = current === name;
        box.disabled = kind === 'card' && !card;

        const text = document.createElement('span');
        text.textContent = label;
        row.append(box, text);

        if (current && current !== name) {
            const now = document.createElement('span');
            now.classList.add('opacity50p');
            now.textContent = kind === 'personaMod' ? ` (now [${current}])` : ` (now "${current}")`;
            row.appendChild(now);
        }

        boxes[kind] = { box, current };
        content.appendChild(row);
    }

    const hint = document.createElement('div');
    hint.classList.add('opacity50p');
    hint.textContent = 'The set comes from the persona\'s link, then the card\'s, then the set for anything without a link. The persona\'s modifier goes on top of it.';
    content.appendChild(hint);

    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { okButton: 'Save', cancelButton: 'Cancel' });

    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    for (const [kind, { box, current }] of Object.entries(boxes)) {
        if (box.disabled) {
            continue;
        }

        if (box.checked) {
            setLink(kind, name);
        } else if (current === name) {
            setLink(kind, null);
        }
    }

    refreshUI(name);
    await autoApply();
}

// ---------------------------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------------------------

function reportApply(label, result, automatic) {
    const settings = getSettings();
    const key = `${currentPresetName()}\u0000${label}`;

    if (result.changed && (!automatic || settings.notify)) {
        toastr.info(`Applied ${label} (${plural(result.changed, 'change')}).`, 'Preset Sets');
    } else if (!automatic && !result.changed) {
        toastr.info(`${label} is already applied.`, 'Preset Sets');
    }

    if (result.missing.length && (!automatic || !warnedMissing.has(key))) {
        warnedMissing.add(key);
        toastr.warning(`${label} lists ${plural(result.missing.length, 'prompt')} this preset no longer has. Edit or update the set to clear this.`, 'Preset Sets');
    }

    if (result.remaining.length) {
        toastr.error(`Some prompts could not be switched: ${result.remaining.slice(0, 5).join(', ')}${result.remaining.length > 5 ? '…' : ''}`, 'Preset Sets');
    }
}

/**
 * Apply a target ({ name, modifier, source }) and remember it as the one in use. It is recorded
 * before the toggles change, so a locked preset holds them to this target throughout, including
 * hand toggles made while the save is in progress.
 */
async function applyTarget(target, automatic) {
    const ids = targetIds(target);
    const preset = currentPresetName();

    if (!ids) {
        return null;
    }

    lastApplied = { preset, name: target.name, modifier: target.modifier || null, source: target.source, missing: [] };
    const result = await applyIds(ids);

    // The preset was switched while saving: the result belongs to the old one, so don't report it.
    if (currentPresetName() !== preset) {
        return null;
    }

    Object.assign(lastApplied, result);
    reportApply(`"${targetLabel(target)}"`, result, automatic);
    return result;
}

/** Apply the linked set and modifier, if there are any and automatic applying is on. */
async function autoApply() {
    installLockHook();

    if (!getSettings().autoApply || !isReady()) {
        refreshUI();
        return null;
    }

    return serial(async () => {
        const target = targetFor();

        if (!target?.name && !target?.modifier) {
            refreshUI();
            return null;
        }

        const result = await applyTarget(target, true);
        refreshUI();
        return { target, result };
    });
}

/** Apply a set by hand, exactly as it is (without the persona's modifier). */
async function applyNamed(name) {
    const data = presetData();

    if (!isReady()) {
        toastr.warning('Preset Sets only works with a Chat Completion preset loaded.', 'Preset Sets');
        return null;
    }

    if (!data?.sets[name]) {
        toastr.error(`No set called "${name}" in this preset.`, 'Preset Sets');
        return null;
    }

    if (data.sets[name].kind !== 'set') {
        toastr.warning(`"${name}" is a modifier. Modifiers are stacked onto sets, not applied by themselves.`, 'Preset Sets');
        return null;
    }

    return serial(async () => {
        const result = await applyTarget({ name, modifier: null, source: 'manual' }, false);
        refreshUI();
        return result;
    });
}

/** The set and modifier in use in this preset, if they still exist. */
function keptTarget(data = presetData()) {
    if (lastApplied?.preset !== currentPresetName()) {
        return null;
    }

    const name = data?.sets[lastApplied.name]?.kind === 'set' ? lastApplied.name : null;
    const modifier = data?.sets[lastApplied.modifier]?.kind === 'modifier' ? lastApplied.modifier : null;
    return name || modifier ? { name, modifier, source: lastApplied.source } : null;
}

/**
 * After a set or modifier changes, put the one in use back in place, since its prompts (or those
 * of a set it builds on) may have changed.
 */
async function reapplyInUse() {
    if (!isReady()) {
        refreshUI();
        return;
    }

    // With automatic applying on, what's linked now wins (a set applied by hand lasts only until
    // the next automatic apply anyway); otherwise keep what was applied last.
    const linked = getSettings().autoApply ? targetFor() : null;
    const target = linked?.name || linked?.modifier ? linked : keptTarget();

    if (target?.name || target?.modifier) {
        await serial(() => applyTarget(target, true));
    }

    refreshUI();
}

/**
 * Runs before every generation (registered as the manifest's generate_interceptor), so the
 * linked set is in place whatever happened to the toggles since it was last applied.
 */
globalThis.presetSetsPreflight = async function () {
    if (!isReady()) {
        return;
    }

    try {
        await autoApply();
    } catch (error) {
        console.error(LOG, 'Applying the set before generation failed', error);
        toastr.warning('The set could not be applied before generating. Check the prompt toggles.', 'Preset Sets');
    }
};

// ---------------------------------------------------------------------------------------------
// Preset lock
// ---------------------------------------------------------------------------------------------

let lockNoticeAt = 0;

function isLocked(preset = currentPresetName()) {
    return Boolean(presetData(preset)?.locked);
}

/** The toggles the preset file itself has saved, for the profile in use. */
function savedPresetIds(preset = currentPresetName()) {
    const file = openai_settings?.[openai_setting_names?.[preset]];
    const activeId = promptManager?.activeCharacter?.id;
    const profile = file?.prompt_order?.find(entry => String(entry?.character_id) === String(activeId));

    return Array.isArray(profile?.order)
        ? profile.order.filter(entry => entry?.enabled).map(entry => entry.identifier)
        : null;
}

/**
 * What a locked preset holds its toggles to: the set applied last in this preset, or, if none has
 * been applied since the preset was loaded, the preset's own saved toggles.
 */
function enforcedIds() {
    const kept = keptTarget();
    return kept ? targetIds(kept) : savedPresetIds(currentPresetName());
}

function lockNotice(message) {
    // Bulk toggles can save several times in a row; one notice is enough.
    if (Date.now() - lockNoticeAt < 1500) {
        return;
    }

    lockNoticeAt = Date.now();
    toastr.warning(message, 'Preset locked');
}

/**
 * Every way of toggling a prompt, SillyTavern's own switches and NemoPresetExt's trays and
 * section toggles alike, ends by saving the prompt manager's settings. On a locked preset, that
 * save puts the toggles back to the active set first. Prompt text and order still save as normal.
 */
const lockedManagers = new WeakSet();

function installLockHook() {
    const pm = promptManager;

    // Once per prompt manager. Other extensions (NemoPresetExt's cold prompts) wrap the same
    // function and only ever unwrap themselves, so this stays in the chain either way.
    if (!pm || typeof pm.saveServiceSettings !== 'function' || lockedManagers.has(pm)) {
        return;
    }

    lockedManagers.add(pm);

    const original = pm.saveServiceSettings;

    pm.saveServiceSettings = async function (...args) {
        let reverted = 0;

        if (isReady() && isLocked()) {
            const ids = enforcedIds();

            if (ids) {
                const { changes } = planApply(ids);

                for (const row of changes) {
                    row.entry.enabled = !row.enabled;
                }

                reverted = changes.length;
            }
        }

        if (reverted) {
            lockNotice('Prompts can only be switched through Preset Sets while this preset is locked. Edit the set instead, or unlock the preset.');
        }

        const result = await original.apply(this, args);

        if (reverted) {
            try {
                pm.render?.(false);
            } catch (error) {
                console.warn(LOG, 'Could not redraw the prompt manager', error);
            }
        }

        scheduleBarRefresh();
        return result;
    };
}

/** The preset's own update, rename and delete buttons do nothing while it is locked. */
const LOCKED_BUTTONS = '#update_oai_preset, [data-preset-manager-rename="openai"], #delete_oai_preset';

function blockLockedButtons() {
    document.addEventListener('click', event => {
        if (!(event.target instanceof Element) || !event.target.closest(LOCKED_BUTTONS) || !isLocked()) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        lockNotice(`"${currentPresetName()}" is locked, so it can't be updated, renamed or deleted. Unlock it with the lock button under the preset list.`);
    }, true);
}

function setLocked(value) {
    const data = presetData(currentPresetName(), true);

    if (!data) {
        return;
    }

    data.locked = Boolean(value);
    saveSettingsDebounced();
    installLockHook();
    refreshUI();
    toastr.info(data.locked ? `"${currentPresetName()}" is locked. Its prompts now change only through sets.` : `"${currentPresetName()}" is unlocked.`, 'Preset Sets');
}

/** Sets are stored by preset name, so they follow the preset when it is renamed. */
function onPresetRenamed({ apiId, oldName, newName } = {}) {
    const settings = getSettings();

    if (apiId !== 'openai' || !oldName || !newName || !settings.presets[oldName] || settings.presets[newName]) {
        return;
    }

    settings.presets[newName] = settings.presets[oldName];
    delete settings.presets[oldName];

    const move = (record) => {
        if (record?.[oldName]) {
            record[newName] = record[oldName];
            delete record[oldName];
        }
    };

    Object.values(settings.links).forEach(move);
    Object.values(settings.cardLinks).forEach(move);
    Object.values(settings.personaMods).forEach(move);

    if (lastApplied?.preset === oldName) {
        lastApplied.preset = newName;
    }

    saveSettingsDebounced();
    refreshUI();
}

// ---------------------------------------------------------------------------------------------
// Set management
// ---------------------------------------------------------------------------------------------

/** Save the toggles switched on now into a set, keeping what it builds on. */
function storeToggles(data, name) {
    const rules = rulesFor(data);
    const order = [...orderIds()];
    const existing = data.sets[name];
    const target = captureIds();

    if (existing && existing.kind === 'set') {
        const from = inherited(data.sets, name, existing, rules).ids;
        const { on, off } = changesBetween(from, target, rules, order);
        data.sets[name] = { ...existing, on, off, updated: new Date().toISOString() };
    } else {
        data.sets[name] = { kind: 'set', base: null, modifiers: [], on: target, off: [], updated: new Date().toISOString() };
    }

    ensureKnown(data);
    warnedMissing.delete(`${currentPresetName()}\u0000${name}`);
    saveSettingsDebounced();
}

async function saveFromToggles(name) {
    if (!isReady()) {
        toastr.warning('Load a Chat Completion preset first.', 'Preset Sets');
        return null;
    }

    const data = presetData(currentPresetName(), true);

    if (data.sets[name]?.kind === 'modifier') {
        toastr.error(`"${name}" is a modifier. Edit it instead.`, 'Preset Sets');
        return null;
    }

    storeToggles(data, name);
    await reapplyInUse();
    refreshUI(name);
    toastr.success(`Saved "${name}" with ${plural(setIds(name).length, 'prompt')} on.`, 'Preset Sets');
    return name;
}

async function updateSelected(name) {
    const data = presetData();

    if (!data?.sets[name] || !isReady()) {
        return;
    }

    if (data.sets[name].kind !== 'set') {
        toastr.info(`"${name}" is a modifier. Use Edit to change it.`, 'Preset Sets');
        return;
    }

    const preset = currentPresetName();
    const confirmed = await callGenericPopup(textBlock(`Make "${name}" switch on exactly the prompts that are on right now?`), POPUP_TYPE.CONFIRM);

    if (confirmed !== POPUP_RESULT.AFFIRMATIVE || currentPresetName() !== preset || !data.sets[name]) {
        return;
    }

    storeToggles(data, name);
    await reapplyInUse();
    refreshUI(name);
    toastr.success(`Updated "${name}".`, 'Preset Sets');
}

async function renameSelected(name) {
    const data = presetData();

    if (!data?.sets[name]) {
        return;
    }

    const preset = currentPresetName();
    const answer = await callGenericPopup(textBlock(`New name for "${name}"`), POPUP_TYPE.INPUT, name);

    // Cancel gives false and Escape gives null; only a typed answer is a name.
    if (typeof answer !== 'string' || currentPresetName() !== preset || !data.sets[name]) {
        return;
    }

    const next = cleanName(answer);

    if (!next || next === name) {
        return;
    }

    if (data.sets[next]) {
        toastr.error(`"${next}" already exists.`, 'Preset Sets');
        return;
    }

    data.sets[next] = data.sets[name];
    delete data.sets[name];
    renameReferences(data.sets, name, next);
    relinkName(currentPresetName(), name, next);

    if (lastApplied?.name === name) {
        lastApplied.name = next;
    }

    if (lastApplied?.modifier === name) {
        lastApplied.modifier = next;
    }

    saveSettingsDebounced();
    refreshUI(next);
}

async function deleteSelected(name) {
    const data = presetData();

    if (!data?.sets[name]) {
        return;
    }

    const dependants = directDependants(data.sets, name);
    const lines = [`Delete "${name}"?`];

    if (dependants.length) {
        lines.push(`${plural(dependants.length, 'set')} use${dependants.length === 1 ? 's' : ''} it (${dependants.join(', ')}). They will keep switching on exactly the prompts they do now.`);
    }

    if (data.sets[name].kind === 'set') {
        lines.push('Anything linked to it uses its next link instead.');
    }

    const preset = currentPresetName();
    const confirmed = await callGenericPopup(textBlock(...lines), POPUP_TYPE.CONFIRM);

    if (confirmed !== POPUP_RESULT.AFFIRMATIVE || currentPresetName() !== preset || !data.sets[name]) {
        return;
    }

    removeKeeping(data.sets, name, rulesFor(data), [...orderIds()]);
    relinkName(preset, name, null);

    if (lastApplied?.name === name || lastApplied?.modifier === name) {
        lastApplied = null;
    }

    saveSettingsDebounced();
    refreshUI();
    await autoApply();
}

/** Delete several sets and modifiers at once. Every set left keeps switching on what it does now. */
async function deleteSeveral() {
    const preset = currentPresetName();
    const data = presetData(preset);
    const names = [...setNames(data, 'set'), ...setNames(data, 'modifier')];

    if (!names.length) {
        toastr.info('This preset has no sets.', 'Preset Sets');
        return;
    }

    const content = element('div', 'ps-links');
    content.appendChild(element('h3', null, 'Delete sets and modifiers'));

    const allLabel = element('label', 'checkbox_label');
    const all = element('input');
    all.type = 'checkbox';
    allLabel.append(all, element('b', null, 'Select all'));
    content.appendChild(allLabel);

    const boxes = names.map(name => {
        const label = element('label', 'checkbox_label');
        const box = element('input');
        box.type = 'checkbox';
        box.value = name;
        label.append(box, element('span', null, data.sets[name].kind === 'modifier' ? `${name} (modifier)` : name));
        content.appendChild(label);
        return box;
    });

    all.addEventListener('change', () => boxes.forEach(box => { box.checked = all.checked; }));
    content.appendChild(element('div', 'opacity50p', 'Sets you keep go on switching on exactly what they do now, even if they built on one you delete. Links to deleted sets are removed.'));

    const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', { okButton: 'Delete', cancelButton: 'Cancel', allowVerticalScrolling: true });
    const picked = boxes.filter(box => box.checked).map(box => box.value);

    if (result !== POPUP_RESULT.AFFIRMATIVE || !picked.length || currentPresetName() !== preset) {
        return;
    }

    const rules = rulesFor(data);
    const order = [...orderIds()];

    for (const name of picked) {
        if (data.sets[name]) {
            removeKeeping(data.sets, name, rules, order);
            relinkName(preset, name, null);
        }
    }

    if (picked.includes(lastApplied?.name) || picked.includes(lastApplied?.modifier)) {
        lastApplied = null;
    }

    saveSettingsDebounced();
    toastr.success(`Deleted ${plural(picked.length, 'set')}.`, 'Preset Sets');
    refreshUI();
    await autoApply();
}

// ---------------------------------------------------------------------------------------------
// New prompts
// ---------------------------------------------------------------------------------------------

let noticeOpen = false;

/** Switch a prompt on in a set or modifier, replacing anything in it that the prompt excludes. */
function addPrompt(set, id, rules, order) {
    set.off = set.off.filter(other => other !== id);

    if (!set.on.includes(id)) {
        set.on = set.on.filter(other => !excludes(rules, id, other));
        set.on.push(id);
        const rank = new Map(order.map((item, index) => [item, index]));
        set.on.sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity));
    }

    set.updated = new Date().toISOString();
}

/**
 * When the preset has prompts it didn't have last time (a new version imported, say), ask which
 * sets each should be on in. Anything left unticked stays off everywhere.
 */
async function checkNewPrompts() {
    if (!isReady() || noticeOpen) {
        return;
    }

    const preset = currentPresetName();
    const data = presetData(preset);

    if (!data || !Object.keys(data.sets).length) {
        return;
    }

    const rows = readRows();
    const current = rows.map(row => row.id);

    if (!Array.isArray(data.known)) {
        data.known = current;
        saveSettingsDebounced();
        return;
    }

    const known = new Set(data.known);
    const fresh = rows.filter(row => !known.has(row.id));

    if (!fresh.length) {
        if (known.size !== current.length) {
            data.known = current;
            saveSettingsDebounced();
        }

        return;
    }

    noticeOpen = true;

    try {
        const freshIds = new Set(fresh.map(row => row.id));
        const texts = await readPromptTexts(promptManager.serviceSettings.prompts.filter(prompt => freshIds.has(prompt.identifier)));
        const names = [...setNames(data, 'set'), ...setNames(data, 'modifier')];
        const content = document.createElement('div');
        content.classList.add('ps-new');

        const heading = document.createElement('h3');
        heading.textContent = `${plural(fresh.length, 'new prompt')} in "${preset}"`;

        const hint = document.createElement('div');
        hint.classList.add('opacity50p');
        hint.textContent = 'Tick the sets each one should be on in. Sets that build on a ticked set, or use a ticked modifier, get it too. Anything left unticked stays off everywhere, and you won\'t be asked about it again.';

        content.append(heading, hint);
        const picks = [];

        for (const row of fresh) {
            const block = document.createElement('div');
            block.classList.add('ps-new-row');

            const title = document.createElement('b');
            title.textContent = row.name;
            const about = describePrompt(texts.get(row.id));

            const chips = document.createElement('div');
            chips.classList.add('ps-chips');

            for (const name of names) {
                const label = document.createElement('label');
                label.classList.add('checkbox_label', 'ps-chip');

                const box = document.createElement('input');
                box.type = 'checkbox';

                const text = document.createElement('span');
                text.textContent = data.sets[name].kind === 'modifier' ? `${name} (modifier)` : name;

                const reaches = allDependants(data.sets, name);
                label.title = reaches.length ? `Also reaches ${reaches.join(', ')}` : '';

                label.append(box, text);
                chips.appendChild(label);
                picks.push({ id: row.id, name, box });
            }

            block.append(title);

            if (about) {
                block.appendChild(element('div', 'ps-new-about', about));
            }

            block.appendChild(chips);
            content.appendChild(block);
        }

        const result = await callGenericPopup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Save',
            cancelButton: 'Ask me later',
            wide: true,
            allowVerticalScrolling: true,
        });

        if (result !== POPUP_RESULT.AFFIRMATIVE || currentPresetName() !== preset) {
            return;
        }

        const rules = rulesFor(data);
        const order = [...orderIds()];
        let added = 0;

        for (const pick of picks) {
            if (pick.box.checked && data.sets[pick.name]) {
                addPrompt(data.sets[pick.name], pick.id, rules, order);
                added++;
            }
        }

        data.known = current;
        saveSettingsDebounced();

        if (added) {
            toastr.success(`Added ${plural(added, 'prompt')} to sets.`, 'Preset Sets');
            await reapplyInUse();
        }

        refreshUI();
    } finally {
        noticeOpen = false;
    }
}

// ---------------------------------------------------------------------------------------------
// Set editor
// ---------------------------------------------------------------------------------------------

const SECTION_HEADER = /^=+\s*.+?\s*=+$/;
const SUB_HEADER = /^<.+>$/;

/** Popup text built as elements: SillyTavern inserts a plain-string popup as HTML. */
function textBlock(...paragraphs) {
    const block = element('div', 'ps-text');

    for (const text of paragraphs) {
        block.appendChild(element('p', null, text));
    }

    return block;
}

function element(tag, className, text) {
    const node = document.createElement(tag);

    if (className) {
        node.className = className;
    }

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

function makeSelect(options, value) {
    const select = element('select', 'text_pole');

    for (const [optionValue, label] of options) {
        const option = element('option', null, label);
        option.value = optionValue;
        select.appendChild(option);
    }

    select.value = value ?? '';
    return select;
}

/**
 * Edit a set or modifier, or make a new one (no name). A set is edited as the prompts it switches
 * on, and only its differences from what it builds on are stored. A modifier is edited as a list
 * of changes: switch on, switch off, or leave alone.
 */
async function editSet(name = null) {
    if (!isReady()) {
        toastr.warning('Load a Chat Completion preset first.', 'Preset Sets');
        return null;
    }

    const preset = currentPresetName();
    const data = presetData(preset, true);

    if (name && !data.sets[name]) {
        return null;
    }

    const rules = await refreshRules();
    const texts = lastTexts?.preset === preset ? lastTexts.texts : new Map();
    const rows = readRows();
    const order = [...orderIds()];
    const existing = name ? data.sets[name] : null;
    const modifiers = setNames(data, 'modifier');

    const state = {
        kind: existing?.kind ?? 'set',
        base: existing?.base ?? null,
        modifiers: (existing?.modifiers ?? []).filter(mod => data.sets[mod]?.kind === 'modifier'),
        final: new Set(existing?.kind === 'set' ? resolve(data.sets, name, rules).ids : []),
        change: new Map(existing?.kind === 'modifier'
            ? [...existing.on.map(id => [id, 'on']), ...existing.off.map(id => [id, 'off'])]
            : []),
        from: new Set(),
        compare: null,
        compareName: '',
        show: 'all',
        refName: '',
        refMods: [],
        ref: new Set(),
    };

    // A modifier is made against a reference (a set, plus other modifiers in order), so each row
    // says whether the prompt is on there already. The reference is saved with the modifier and
    // decides where it is listed; it never changes what the modifier does. Without one saved, it
    // starts at the bottom of the first chain that uses the modifier (Base, say).
    const PRESET_OWN = '\u0000preset';
    const refIds = () => {
        const ids = state.refName === PRESET_OWN
            ? new Set(savedPresetIds() || [])
            : (data.sets[state.refName] ? resolve(data.sets, state.refName, rules).ids : new Set());

        for (const modName of state.refMods) {
            const mod = data.sets[modName];

            if (mod?.kind === 'modifier' && modName !== name) {
                applyChanges(ids, mod.on, mod.off, rules);
            }
        }

        return ids;
    };
    {
        const context = existing?.context;

        if (context) {
            state.refName = context.base && data.sets[context.base] ? context.base : PRESET_OWN;
            state.refMods = context.modifiers.filter(mod => data.sets[mod]?.kind === 'modifier' && mod !== name);
        } else {
            const user = name ? directDependants(data.sets, name).find(item => data.sets[item].kind === 'set') : null;
            const roots = setNames(data, 'set').filter(item => !data.sets[item].base);
            state.refName = user ? setChain(data, user).key.split('\u0000')[0] : (roots[0] || PRESET_OWN);
        }

        state.ref = refIds();
    }
    const refLabel = () => [state.refName === PRESET_OWN ? 'the preset' : state.refName, ...state.refMods.map(mod => `[${mod}]`)].join(' + ');

    const recomputeFrom = () => {
        state.from = state.kind === 'set'
            ? inherited(data.sets, name, { kind: 'set', base: state.base, modifiers: state.modifiers }, rules).ids
            : new Set();
    };

    recomputeFrom();

    // ----- layout -----
    const content = element('div', 'ps-editor');
    content.appendChild(element('h3', null, name ? `Edit "${name}"` : 'New set'));

    let nameInput = null;

    if (!name) {
        nameInput = element('input', 'text_pole');
        nameInput.type = 'text';
        nameInput.placeholder = 'Name';
        content.appendChild(nameInput);

        const kinds = element('div', 'ps-editor-kinds');

        for (const [value, label] of [['set', 'Set'], ['modifier', 'Modifier: only changes, stacked onto sets']]) {
            const option = element('label', 'checkbox_label');
            const radio = element('input');
            radio.type = 'radio';
            radio.name = 'ps_kind';
            radio.value = value;
            radio.checked = value === state.kind;
            radio.addEventListener('change', () => {
                state.kind = value;
                state.show = 'all';
                recomputeFrom();
                build();
            });
            option.append(radio, element('span', null, label));
            kinds.appendChild(option);
        }

        content.appendChild(kinds);
    }

    const layerBox = element('div', 'ps-editor-layers');
    const toolBox = element('div', 'ps-editor-tools');
    const hintBox = element('div', 'opacity50p');
    const list = element('div', 'ps-editor-list');
    content.append(layerBox, toolBox, hintBox, list);

    const dependants = name ? allDependants(data.sets, name) : [];

    let sections = [];
    let rowViews = [];
    let total = null;

    const groupHint = rules.groupOf.size || rules.withIds.size
        ? 'Prompts marked as only working one at a time switch each other off here too.'
        : '';

    function isChanged(view) {
        return state.kind === 'set'
            ? state.final.has(view.id) !== state.from.has(view.id)
            : state.change.has(view.id);
    }

    function isDifferent(view) {
        return Boolean(state.compare) && state.final.has(view.id) !== state.compare.has(view.id);
    }

    function updateRow(view) {
        if (state.kind === 'set') {
            view.control.checked = state.final.has(view.id);
            view.mark.hidden = !(state.base || state.modifiers.length) || !isChanged(view);
            view.mark.title = state.from.has(view.id)
                ? 'Switched off here, on in what this set builds on. Click to follow it again.'
                : 'Switched on here, off in what this set builds on. Click to follow it again.';
            view.diff.hidden = !isDifferent(view);
            view.diff.textContent = isDifferent(view) ? (state.compare.has(view.id) ? `on in ${state.compareName}` : `off in ${state.compareName}`) : '';
        } else {
            const value = state.change.get(view.id) || '';
            const already = state.ref.has(view.id);
            view.control.textContent = value === 'on' ? 'On' : value === 'off' ? 'Off' : '–';
            view.control.dataset.state = value;
            view.control.classList.toggle('ps-noop', (value === 'on' && already) || (value === 'off' && !already));
            view.ref.textContent = already ? 'on' : 'off';
            view.ref.dataset.state = already ? 'on' : 'off';
            view.ref.title = `${already ? 'On' : 'Off'} in ${refLabel()}${value && view.control.classList.contains('ps-noop') ? ', so this change does nothing there' : ''}`;
        }
    }

    function updateCounts() {
        for (const section of sections) {
            const inside = rowViews.filter(view => view.section === section);
            section.count.textContent = state.kind === 'set'
                ? `${inside.filter(view => state.final.has(view.id)).length}/${inside.length}`
                : `${inside.filter(view => state.change.has(view.id)).length} changed`;
        }

        if (state.kind === 'set') {
            const changed = rowViews.filter(isChanged).length;
            total.textContent = `${state.final.size} on${state.base || state.modifiers.length ? ` · ${changed} changed here` : ''}`;
        } else {
            const values = [...state.change.values()];
            total.textContent = `${values.filter(v => v === 'on').length} on · ${values.filter(v => v === 'off').length} off`;
        }
    }

    function updateVisibility(query = '') {
        const filtering = Boolean(query) || state.show !== 'all';

        for (const view of rowViews) {
            let visible = !query || view.search.includes(query);

            if (state.show === 'on') {
                visible &&= state.final.has(view.id);
            } else if (state.show === 'changed') {
                visible &&= isChanged(view);
            } else if (state.show === 'different') {
                visible &&= isDifferent(view);
            } else if (state.show === 'refon') {
                visible &&= state.ref.has(view.id);
            }

            view.label.hidden = !visible;
        }

        for (const section of sections) {
            const visible = rowViews.some(view => view.section === section && !view.label.hidden);
            section.details.hidden = !visible;

            if (filtering) {
                section.details.open = visible;
            }
        }
    }

    let search = null;

    function updateAll() {
        rowViews.forEach(updateRow);
        updateCounts();
        updateVisibility(search?.value.trim().toLowerCase() || '');
    }

    /** Switch a prompt on in the final state, and off anything it excludes. */
    function switchOn(id) {
        for (const other of [...state.final]) {
            if (other !== id && excludes(rules, id, other)) {
                state.final.delete(other);
            }
        }

        state.final.add(id);
    }

    /**
     * Change what the set builds on, or its modifiers, keeping the changes made in this set: the
     * rest follows the new layers.
     */
    function relayerKeepingOwn(change, redrawLayers = false) {
        const own = changesBetween(state.from, [...state.final], rules);
        change();
        recomputeFrom();
        state.final = applyChanges(new Set(state.from), own.on, own.off, rules);

        if (redrawLayers) {
            buildLayers();
        }

        updateAll();
    }

    function buildLayers() {
        layerBox.innerHTML = '';

        if (state.kind !== 'set') {
            if (dependants.length) {
                layerBox.appendChild(element('div', 'opacity50p', `Used by: ${dependants.join(', ')}.`));
            }

            return;
        }

        const bases = possibleBases(data.sets, name);
        const baseRow = element('label', 'ps-editor-field');
        baseRow.appendChild(element('span', null, 'Builds on'));
        // Each choice shows what it is built from (Base › DC), sorted like the tree.
        const chains = bases.map(item => [item, setChain(data, item)]).sort((a, b) => a[1].key.localeCompare(b[1].key));
        const baseSelect = makeSelect([['', '— Nothing —'], ...chains.map(([item, chain]) => [item, chain.label])], state.base);
        baseSelect.addEventListener('change', () => relayerKeepingOwn(() => {
            state.base = baseSelect.value || null;
        }, true));
        baseRow.appendChild(baseSelect);
        layerBox.appendChild(baseRow);

        if (modifiers.length) {
            const modRow = element('div', 'ps-editor-field');
            modRow.appendChild(element('span', null, 'Modifiers'));
            const chips = element('div', 'ps-chips');

            for (const modName of modifiers) {
                const chip = element('label', 'checkbox_label ps-chip');
                const box = element('input');
                box.type = 'checkbox';
                box.checked = state.modifiers.includes(modName);
                // Modifiers apply in the order they were ticked; untick and tick again to move one last.
                box.addEventListener('change', () => relayerKeepingOwn(() => {
                    state.modifiers = box.checked
                        ? [...state.modifiers.filter(item => item !== modName), modName]
                        : state.modifiers.filter(item => item !== modName);
                }, true));
                const place = state.modifiers.indexOf(modName);
                chip.append(box, element('span', null, place === -1 ? modName : `${place + 1}. ${modName}`));
                chips.appendChild(chip);
            }

            modRow.appendChild(chips);
            layerBox.appendChild(modRow);
        }

        const steps = [state.base, ...state.modifiers.map(mod => `[${mod}]`)].filter(Boolean);
        layerBox.appendChild(element('div', 'opacity50p', steps.length
            ? `Applied in order: ${steps.join(', then ')}, then this set's own changes.${state.modifiers.length > 1 ? ' Where modifiers disagree, the later one wins; untick and tick one again to move it last.' : ''}`
            : 'Builds on nothing: the set is exactly the prompts ticked below.'));

        if (dependants.length) {
            layerBox.appendChild(element('div', 'opacity50p', `Changes here also reach: ${dependants.join(', ')}.`));
        }
    }

    function buildTools() {
        toolBox.innerHTML = '';

        search = element('input', 'text_pole');
        search.type = 'search';
        search.placeholder = 'Find a prompt';
        search.addEventListener('input', () => updateVisibility(search.value.trim().toLowerCase()));
        toolBox.appendChild(search);

        const showOptions = state.kind === 'set'
            ? [['all', 'All prompts'], ['on', 'Switched on'], ['changed', 'Changed in this set'], ['different', 'Different from the compared set']]
            : [['all', 'All prompts'], ['changed', 'Changed by this modifier'], ['refon', 'On in the reference']];
        const show = makeSelect(showOptions, state.show);
        show.title = 'Show';
        show.addEventListener('change', () => {
            state.show = show.value;
            updateVisibility(search.value.trim().toLowerCase());
        });
        toolBox.appendChild(show);

        if (state.kind === 'set') {
            const others = setNames(data, 'set').filter(item => item !== name);
            const compareChains = others.map(item => [item, setChain(data, item)]).sort((a, b) => a[1].key.localeCompare(b[1].key));
            const compare = makeSelect([['', 'Compare with…'], ...compareChains.map(([item, chain]) => [item, chain.label])], state.compareName);
            compare.addEventListener('change', () => {
                state.compareName = compare.value;
                state.compare = compare.value ? resolve(data.sets, compare.value, rules).ids : null;

                if (state.compare && state.show === 'all') {
                    state.show = 'different';
                    show.value = 'different';
                }

                updateAll();
            });
            toolBox.appendChild(compare);

            const reset = element('div', 'menu_button', 'Follow all');
            reset.title = 'Undo every change made in this set, so it switches on exactly what it builds on';
            reset.addEventListener('click', () => {
                state.final = new Set(state.from);
                updateAll();
            });
            toolBox.appendChild(reset);

            const now = element('div', 'menu_button', 'Start from what\'s on now');
            now.title = 'Tick exactly the prompts switched on right now, keeping what this set builds on';
            now.addEventListener('click', () => {
                state.final = new Set(captureIds());
                updateAll();
            });
            toolBox.appendChild(now);
        } else {
            const refChains = setNames(data, 'set').map(item => [item, setChain(data, item)]).sort((a, b) => a[1].key.localeCompare(b[1].key));
            const refRow = element('label', 'ps-editor-field ps-editor-ref');
            refRow.appendChild(element('span', null, 'Made against'));
            const refSelect = makeSelect([...refChains.map(([item, chain]) => [item, chain.label]), [PRESET_OWN, 'The preset\'s own toggles']], state.refName);
            refSelect.title = 'Each row shows whether the prompt is already on here, so you can tell what a change will do';
            refSelect.addEventListener('change', () => {
                state.refName = refSelect.value;
                state.ref = refIds();
                updateAll();
            });
            refRow.appendChild(refSelect);
            toolBox.appendChild(refRow);

            const others = setNames(data, 'modifier').filter(item => item !== name);

            if (others.length) {
                const modRow = element('div', 'ps-editor-field ps-editor-ref');
                modRow.appendChild(element('span', null, 'After'));
                const chips = element('div', 'ps-chips');

                const drawChips = () => {
                    chips.innerHTML = '';

                    for (const modName of others) {
                        const chip = element('label', 'checkbox_label ps-chip');
                        const box = element('input');
                        box.type = 'checkbox';
                        box.checked = state.refMods.includes(modName);
                        box.addEventListener('change', () => {
                            state.refMods = box.checked
                                ? [...state.refMods.filter(item => item !== modName), modName]
                                : state.refMods.filter(item => item !== modName);
                            state.ref = refIds();
                            drawChips();
                            updateAll();
                        });
                        const place = state.refMods.indexOf(modName);
                        chip.append(box, element('span', null, place === -1 ? `[${modName}]` : `${place + 1}. [${modName}]`));
                        chips.appendChild(chip);
                    }
                };

                drawChips();
                modRow.title = 'Modifiers this one is made to go after. It is shown against them, and listed after them; a set still ticks each one it uses.';
                modRow.appendChild(chips);
                toolBox.appendChild(modRow);
            }
        }

        total = element('span', 'ps-editor-total');
        toolBox.appendChild(total);
    }

    function buildList() {
        list.innerHTML = '';
        sections = [];
        rowViews = [];

        const hasSections = rows.some(row => SECTION_HEADER.test(row.name));
        let current = null;

        for (const row of rows) {
            if (hasSections && (SECTION_HEADER.test(row.name) || !current)) {
                const details = element('details', 'ps-editor-section');
                const summary = element('summary');
                const title = SECTION_HEADER.test(row.name) ? row.name.replace(/^=+\s*|\s*=+$/g, '') : 'Before the first section';
                const count = element('span', 'ps-editor-count');
                summary.append(element('span', null, title), count);
                const body = element('div', 'ps-editor-body');
                details.append(summary, body);
                list.appendChild(details);
                current = { details, body, count };
                sections.push(current);
            }

            const label = element('label', 'checkbox_label ps-editor-row');
            label.title = describePrompt(texts.get(row.id));

            if (SUB_HEADER.test(row.name)) {
                label.classList.add('ps-editor-sub');
            }

            const view = { id: row.id, label, section: current, search: row.name.toLowerCase() };

            if (state.kind === 'set') {
                view.control = element('input');
                view.control.type = 'checkbox';
                view.control.addEventListener('change', () => {
                    if (view.control.checked) {
                        switchOn(row.id);
                    } else {
                        state.final.delete(row.id);
                    }

                    updateAll();
                });

                view.mark = element('span', 'ps-mark fa-solid fa-circle');
                view.mark.addEventListener('click', event => {
                    event.preventDefault();

                    if (state.from.has(row.id)) {
                        switchOn(row.id);
                    } else {
                        state.final.delete(row.id);
                    }

                    updateAll();
                });

                view.diff = element('span', 'ps-diff');
                label.append(view.control, element('span', null, row.name), view.mark, view.diff);
            } else {
                view.control = element('div', 'menu_button ps-tri');
                view.control.title = 'Click to cycle: leave alone, switch on, switch off';
                view.control.addEventListener('click', event => {
                    event.preventDefault();
                    const next = { '': 'on', on: 'off', off: '' }[state.change.get(row.id) || ''];

                    if (next) {
                        state.change.set(row.id, next);
                    } else {
                        state.change.delete(row.id);
                    }

                    if (next === 'on') {
                        for (const [other, value] of [...state.change]) {
                            if (other !== row.id && value === 'on' && excludes(rules, row.id, other)) {
                                state.change.delete(other);
                            }
                        }
                    }

                    updateAll();
                });

                view.ref = element('span', 'ps-ref');
                label.append(view.control, view.ref, element('span', null, row.name));
            }

            (current?.body ?? list).appendChild(label);
            rowViews.push(view);
        }
    }

    function build() {
        buildLayers();
        buildTools();
        hintBox.textContent = state.kind === 'set'
            ? [groupHint, 'Once a set builds on something, a dot marks each prompt it changes; click the dot to follow the base again. Hover a prompt for its description.'].filter(Boolean).join(' ')
            : [groupHint, 'Changes apply to every set that uses this modifier, on top of its base.'].filter(Boolean).join(' ');
        buildList();
        updateAll();
    }

    build();

    let finalName = name;

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        onClosing: (instance) => {
            if (name || instance.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            finalName = cleanName(nameInput.value);

            if (!finalName) {
                toastr.warning('Give it a name.', 'Preset Sets');
                return false;
            }

            if (data.sets[finalName]) {
                toastr.warning(`"${finalName}" already exists.`, 'Preset Sets');
                return false;
            }

            return true;
        },
    });

    await popup.show();

    if (popup.result !== POPUP_RESULT.AFFIRMATIVE || !finalName || currentPresetName() !== preset) {
        return null;
    }

    // Prompts the preset no longer has are dropped, as Update does. Prompts that can't be toggled
    // (section headers, markers) are kept as inherited, never stored as switched off.
    const present = orderIds();
    const updated = new Date().toISOString();

    if (state.kind === 'set') {
        const { on, off } = changesBetween(state.from, [...state.final].filter(id => present.has(id)), rules, order);
        data.sets[finalName] = { kind: 'set', base: state.base, modifiers: [...state.modifiers], on, off, updated };
    } else {
        const pick = (value) => order.filter(id => state.change.get(id) === value);
        const context = { base: state.refName === PRESET_OWN ? null : state.refName, modifiers: [...state.refMods] };
        data.sets[finalName] = { kind: 'modifier', base: null, modifiers: [], on: pick('on'), off: pick('off'), updated };

        if (context.base || context.modifiers.length) {
            data.sets[finalName].context = context;
        }
    }

    ensureKnown(data);
    warnedMissing.delete(`${preset}\u0000${finalName}`);
    saveSettingsDebounced();

    const reach = allDependants(data.sets, finalName);
    toastr.success(`Saved "${finalName}".${reach.length ? ` ${plural(reach.length, 'set')} built on it follow${reach.length === 1 ? 's' : ''} the change.` : ''}`, 'Preset Sets');

    await reapplyInUse();
    refreshUI(finalName);
    return finalName;
}

// ---------------------------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------------------------

function exportSets() {
    const preset = currentPresetName();
    const data = presetData(preset);

    if (!data || !setNames(data).length) {
        toastr.info('This preset has no sets to export.', 'Preset Sets');
        return;
    }

    const settings = getSettings();
    const links = { persona: {}, card: {}, personaModifier: {} };

    for (const [avatar, byPreset] of Object.entries(settings.links)) {
        if (byPreset?.[preset]) {
            links.persona[avatar] = byPreset[preset];
        }
    }

    for (const [card, byPreset] of Object.entries(settings.cardLinks)) {
        if (byPreset?.[preset]) {
            links.card[card] = byPreset[preset];
        }
    }

    for (const [avatar, byPreset] of Object.entries(settings.personaMods)) {
        if (byPreset?.[preset]) {
            links.personaModifier[avatar] = byPreset[preset];
        }
    }

    const payload = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        preset,
        sets: data.sets,
        defaultSet: data.defaultSet,
        known: data.known,
        links,
    };

    const safeName = String(preset).replace(/[^\w\- ]+/g, '_');
    download(JSON.stringify(payload, null, 2), `preset-sets-${safeName}.json`, 'application/json');
}

/** Imported sets always go into the preset that is loaded now, so sets survive a preset rename. */
async function importSets(file) {
    if (!isReady()) {
        toastr.warning('Load the Chat Completion preset to import into first.', 'Preset Sets');
        return;
    }

    let payload;

    try {
        payload = JSON.parse(await file.text());
    } catch {
        toastr.error('That file is not valid JSON.', 'Preset Sets');
        return;
    }

    if (payload?.format !== EXPORT_FORMAT || typeof payload.sets !== 'object' || !payload.sets) {
        toastr.error('That file is not a Preset Sets export.', 'Preset Sets');
        return;
    }

    const preset = currentPresetName();
    const data = presetData(preset, true);
    const existing = setNames(data);
    let count = 0;

    // With sets already here, choose: replace them all, or add these and replace same names only.
    if (existing.length) {
        const choice = await callGenericPopup(
            textBlock(`"${preset}" already has ${plural(existing.length, 'set')}. Replace them all with the ones in this file, or add these to them? Adding replaces only sets with the same name.`),
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Replace all', cancelButton: 'Cancel', customButtons: [{ text: 'Add to them', result: POPUP_RESULT.CUSTOM1 }] },
        );

        if (choice === POPUP_RESULT.AFFIRMATIVE) {
            const incoming = new Map(Object.entries(payload.sets).map(([name, raw]) => [cleanName(name), normaliseSet(raw)?.kind]));

            for (const name of existing) {
                if (incoming.get(name) !== data.sets[name].kind) {
                    relinkName(preset, name, null);
                }
            }

            data.sets = {};
            lastApplied = null;
        } else if (choice !== POPUP_RESULT.CUSTOM1) {
            return;
        }
    }

    for (const [name, raw] of Object.entries(payload.sets)) {
        const clean = cleanName(name);
        const set = normaliseSet(raw);

        if (clean && set) {
            data.sets[clean] = set;
            count++;
        }
    }

    if (typeof payload.defaultSet === 'string' && data.sets[payload.defaultSet]?.kind === 'set') {
        data.defaultSet = payload.defaultSet;
    }

    if (Array.isArray(payload.known)) {
        data.known = payload.known.filter(id => typeof id === 'string');
    }

    const usable = (name) => typeof name === 'string' && data.sets[name]?.kind === 'set';
    const links = payload.links || {};

    // Version 1 files held persona links directly: { avatar: setName }.
    const personaLinks = payload.version >= 2 ? links.persona : links;

    for (const [avatar, name] of Object.entries(personaLinks || {})) {
        if (usable(name)) {
            setLink('persona', name, preset, avatar, null);
        }
    }

    if (payload.version >= 2) {
        for (const [card, name] of Object.entries(links.card || {})) {
            if (usable(name)) {
                setLink('card', name, preset, null, card);
            }
        }

        for (const [avatar, name] of Object.entries(links.personaModifier || {})) {
            if (typeof name === 'string' && data.sets[name]?.kind === 'modifier') {
                setLink('personaMod', name, preset, avatar, null);
            }
        }
    }

    await refreshRules();
    ensureKnown(data);
    saveSettingsDebounced();

    const problems = checkAll(data.sets, rulesFor(data));
    toastr.success(`Imported ${plural(count, 'set')} into "${preset}".`, 'Preset Sets');

    if (problems.length) {
        toastr.warning(problems.slice(0, 3).join(' '), 'Preset Sets');
    }

    refreshUI();
    await autoApply();
    await checkNewPrompts();
}

// ---------------------------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------------------------

/** Fill a select with sets, and optionally modifiers in their own group. */
function fillSetSelect(select, data, value, { emptyLabel, withModifiers = false, mark = null, markMod = null } = {}) {
    select.innerHTML = '';

    const add = (parent, optionValue, label) => {
        const option = element('option', null, label);
        option.value = optionValue;
        parent.appendChild(option);
    };

    if (emptyLabel !== undefined) {
        add(select, '', emptyLabel);
    }

    // Sets read as their chain (Base › DC › DC: Mei + [Mei]) and sort by it, so the list reads
    // like the tree. The active set is marked at the front, where a narrow box won't cut it off.
    const sets = setNames(data, 'set')
        .map(name => ({ name, chain: setChain(data, name) }))
        .sort((a, b) => a.chain.key.localeCompare(b.chain.key));
    const mods = withModifiers
        ? setNames(data, 'modifier').sort((a, b) => modifierChain(data, a).key.localeCompare(modifierChain(data, b).key))
        : [];
    const label = ({ name, chain }) => `${name === mark ? '● ' : ''}${chain.label}`;
    const modLabel = (name) => {
        const users = directDependants(data.sets, name).length;
        return `${name === markMod ? '● ' : ''}${modifierChain(data, name).label}${users ? ` · used by ${users}` : ''}`;
    };

    if (mods.length) {
        const setGroup = element('optgroup');
        setGroup.label = 'Sets';
        sets.forEach(item => add(setGroup, item.name, label(item)));
        const modGroup = element('optgroup');
        modGroup.label = 'Modifiers';
        mods.forEach(name => add(modGroup, name, modLabel(name)));
        select.append(setGroup, modGroup);
    } else {
        sets.forEach(item => add(select, item.name, label(item)));
    }

    const all = [...sets.map(item => item.name), ...mods];

    if (!all.length && emptyLabel === undefined) {
        add(select, '', 'No sets in this preset yet');
    }

    select.value = all.includes(value) ? value : (emptyLabel !== undefined ? '' : (all[0] ?? ''));
    select.title = select.selectedOptions[0]?.textContent || '';
}

/** Fill a select with the preset's modifiers, for the persona modifier link. */
function fillModifierSelect(select, data, value) {
    select.innerHTML = '';
    const names = setNames(data, 'modifier').sort((a, b) => modifierChain(data, a).key.localeCompare(modifierChain(data, b).key));
    const none = element('option', null, names.length ? '— No modifier —' : '— No modifiers in this preset —');
    none.value = '';
    select.appendChild(none);

    for (const name of names) {
        const option = element('option', null, modifierChain(data, name).label);
        option.value = name;
        select.appendChild(option);
    }

    select.value = names.includes(value) ? value : '';
}

/**
 * What a set is built from, as a label and a sort key: its bases from the bottom up, then the set,
 * then its modifiers in brackets, e.g. "Base › DC › DC: Mei + [Mei]".
 */
function setChain(data, name) {
    const path = [name];
    const seen = new Set(path);
    let base = data.sets[name]?.base;

    while (base && data.sets[base] && !seen.has(base)) {
        path.unshift(base);
        seen.add(base);
        base = data.sets[base].base;
    }

    // In the order things apply: each set's modifiers come before the set's own changes, so
    // "Base › DC + [Ero] › DC: Ero" reads as Base, then DC, then [Ero], then DC: Ero's changes.
    let label = '';

    path.forEach((setName, index) => {
        const mods = (data.sets[setName]?.modifiers || []).map(mod => `[${mod}]`);

        if (index === 0) {
            label = mods.length ? `${mods.join(' + ')} › ${setName}` : setName;
        } else {
            label += `${mods.map(mod => ` + ${mod}`).join('')} › ${setName}`;
        }
    });

    return { label, key: path.join('\u0000') };
}

/**
 * A modifier's label and sort key, shown after what it was made against:
 * "Base + [DC] › [Mei]" sorts straight after "[DC]" made against Base.
 */
function modifierChain(data, name) {
    const context = data.sets[name]?.context;

    if (!context) {
        return { label: `[${name}]`, key: name };
    }

    const base = context.base && data.sets[context.base] ? setChain(data, context.base) : null;
    const mods = context.modifiers.filter(mod => mod !== name && data.sets[mod]?.kind === 'modifier');
    const before = [base?.label, ...mods.map(mod => `[${mod}]`)].filter(Boolean).join(' + ');
    const key = [...(base ? base.key.split('\u0000') : []), ...mods, name].join('\u0000');
    return { label: before ? `${before} › [${name}]` : `[${name}]`, key };
}

function describeState() {
    if (!isReady()) {
        return 'Sets work with Chat Completion presets. Load one to use them.';
    }

    const target = targetFor();
    const parts = [];

    if (target?.broken?.length) {
        parts.push(`Linked to ${target.broken.map(name => `"${name}"`).join(', ')}, which no longer exist${target.broken.length === 1 ? 's' : ''}.`);
    }

    if (!target?.name && !target?.modifier) {
        parts.push('No set applies here, so the preset\'s own toggles are in use.');
    } else {
        const pending = planApply(targetIds(target) || []).changes.length;
        parts.push(`Active: "${targetLabel(target)}" (${sourceText(target)}). ${pending ? `${plural(pending, 'prompt')} currently differ from it.` : 'The toggles match it.'}`);

        if (lastApplied?.missing?.length && lastApplied.name === target.name && lastApplied.preset === currentPresetName()) {
            parts.push(`It lists ${plural(lastApplied.missing.length, 'prompt')} this preset no longer has.`);
        }
    }

    if (isLocked()) {
        parts.push('The preset is locked.');
    }

    return parts.join(' ');
}

/** Redraw everything the extension shows: the bar in the preset section and the full panel. */
function refreshUI(selectName) {
    refreshBar(selectName);
    refreshPanel(selectName);
}

function refreshPanel(selectName) {
    const panel = document.getElementById('preset_sets_panel');

    if (!panel) {
        return;
    }

    const settings = getSettings();
    const preset = currentPresetName();
    const data = presetData();
    const card = currentCard();
    const setSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ps_set'));

    fillSetSelect(setSelect, data, selectName ?? setSelect.value, { withModifiers: true });
    fillSetSelect(document.getElementById('ps_link'), data, getLink('persona'), { emptyLabel: '— No link —' });
    fillSetSelect(document.getElementById('ps_card_link'), data, getLink('card'), { emptyLabel: card ? '— No link —' : '— Open a chat first —' });
    fillModifierSelect(document.getElementById('ps_persona_mod'), data, getLink('personaMod'));
    fillSetSelect(document.getElementById('ps_default'), data, data?.defaultSet ?? '', { emptyLabel: '— None: keep the preset\'s toggles —' });

    document.getElementById('ps_card_link').toggleAttribute('disabled', !card);
    document.getElementById('ps_preset_name').textContent = preset || 'none';
    document.querySelectorAll('.ps_persona_name').forEach(node => { node.textContent = personaName(); });
    document.querySelectorAll('.ps_card_name').forEach(node => { node.textContent = card?.name || 'this card'; });
    document.getElementById('ps_status').textContent = describeState();

    /** @type {HTMLInputElement} */ (document.getElementById('ps_auto')).checked = settings.autoApply;
    /** @type {HTMLInputElement} */ (document.getElementById('ps_notify')).checked = settings.notify;
    /** @type {HTMLInputElement} */ (document.getElementById('ps_lock')).checked = Boolean(data?.locked);
    document.getElementById('ps_lock').toggleAttribute('disabled', !preset);

    const chosen = setSelect.value;
    const isSet = data?.sets[chosen]?.kind === 'set';

    for (const id of ['ps_edit', 'ps_rename', 'ps_delete']) {
        document.getElementById(id).classList.toggle('disabled', !chosen);
    }

    for (const id of ['ps_apply', 'ps_update']) {
        document.getElementById(id).classList.toggle('disabled', !isSet);
    }
}

function addSettingsPanel() {
    const html = `
    <div id="preset_sets_panel" class="preset-sets-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Preset Sets</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="ps-context">Preset: <b id="ps_preset_name"></b></div>
                <label for="ps_set">Sets and modifiers in this preset</label>
                <select id="ps_set" class="text_pole"></select>
                <div class="ps-buttons">
                    <div id="ps_apply" class="menu_button" title="Switch prompts to match this set">Apply</div>
                    <div id="ps_edit" class="menu_button" title="Choose what this set or modifier switches on and off">Edit…</div>
                    <div id="ps_new" class="menu_button" title="Make a new set or modifier">New…</div>
                    <div id="ps_update" class="menu_button" title="Make this set switch on exactly the prompts that are on now">Update</div>
                    <div id="ps_rename" class="menu_button">Rename…</div>
                    <div id="ps_delete" class="menu_button redWarningBG">Delete</div>
                    <div id="ps_delete_many" class="menu_button redWarningBG" title="Tick several sets and modifiers to delete at once">Delete several…</div>
                </div>
                <label for="ps_link">Set for <b class="ps_persona_name"></b></label>
                <select id="ps_link" class="text_pole"></select>
                <label for="ps_card_link">Set for <b class="ps_card_name"></b></label>
                <select id="ps_card_link" class="text_pole"></select>
                <label for="ps_persona_mod">Modifier for <b class="ps_persona_name"></b>, stacked on top</label>
                <select id="ps_persona_mod" class="text_pole"></select>
                <label for="ps_default">Set for anything without a link</label>
                <select id="ps_default" class="text_pole"></select>
                <div class="opacity50p">The persona's set wins over the card's. The persona's modifier goes on top of whichever set applies.</div>
                <label class="checkbox_label marginTop10" for="ps_lock" title="Prompts can only be switched through sets, and the preset can't be updated, renamed or deleted">
                    <input id="ps_lock" type="checkbox">
                    <span>Lock this preset</span>
                </label>
                <label class="checkbox_label" for="ps_auto">
                    <input id="ps_auto" type="checkbox">
                    <span>Apply the linked set automatically</span>
                </label>
                <label class="checkbox_label" for="ps_notify">
                    <input id="ps_notify" type="checkbox">
                    <span>Show a notice when a set is applied automatically</span>
                </label>
                <div class="ps-buttons">
                    <div id="ps_export" class="menu_button">Export sets</div>
                    <div id="ps_import" class="menu_button">Import sets…</div>
                    <input id="ps_import_file" type="file" accept=".json,application/json" hidden>
                </div>
                <div id="ps_status" class="ps-status"></div>
                <div class="opacity50p marginTop10">
                    Sets switch prompts on and off; they never change prompt text, order or samplers,
                    and they don't touch the preset file. Saving the preset while a set is applied
                    makes that set the preset's own defaults, so lock the preset to stop that.
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    const selected = () => /** @type {HTMLSelectElement} */ (document.getElementById('ps_set')).value;

    $('#ps_set').on('change', () => refreshPanel(selected()));
    $('#ps_apply').on('click', () => selected() && applyNamed(selected()));
    $('#ps_edit').on('click', () => selected() && editSet(selected()));
    $('#ps_new').on('click', () => editSet(null));
    $('#ps_update').on('click', () => selected() && updateSelected(selected()));
    $('#ps_rename').on('click', () => selected() && renameSelected(selected()));
    $('#ps_delete').on('click', () => selected() && deleteSelected(selected()));
    $('#ps_delete_many').on('click', () => deleteSeveral());
    $('#ps_lock').on('change', event => setLocked(/** @type {HTMLInputElement} */ (event.target).checked));
    $('#ps_export').on('click', () => exportSets());
    $('#ps_import').on('click', () => document.getElementById('ps_import_file').click());

    $('#ps_import_file').on('change', async event => {
        const input = /** @type {HTMLInputElement} */ (event.target);
        const file = input.files?.[0];
        input.value = '';

        if (file) {
            await importSets(file);
        }
    });

    const linkSelect = (id, kind) => $(id).on('change', async event => {
        setLink(kind, /** @type {HTMLSelectElement} */ (event.target).value || null);
        refreshUI();
        await autoApply();
    });

    linkSelect('#ps_link', 'persona');
    linkSelect('#ps_card_link', 'card');
    linkSelect('#ps_persona_mod', 'personaMod');

    $('#ps_default').on('change', async event => {
        const data = presetData(currentPresetName(), true);

        if (!data) {
            return;
        }

        data.defaultSet = /** @type {HTMLSelectElement} */ (event.target).value || null;
        saveSettingsDebounced();
        refreshUI();
        await autoApply();
    });

    $('#ps_auto').on('change', async event => {
        getSettings().autoApply = /** @type {HTMLInputElement} */ (event.target).checked;
        saveSettingsDebounced();
        await autoApply();
    });

    $('#ps_notify').on('change', event => {
        getSettings().notify = /** @type {HTMLInputElement} */ (event.target).checked;
        saveSettingsDebounced();
    });

    // The status line goes stale when prompts are toggled by hand; refresh it when the drawer opens.
    $('#preset_sets_panel .inline-drawer-toggle').on('click', () => refreshUI());

    refreshUI();
}

// ---------------------------------------------------------------------------------------------
// Bar in the Chat Completion presets section
// ---------------------------------------------------------------------------------------------

/** Preset, persona, card and active set the bar last showed, so it follows the active set when they change. */
let barContext = null;
let barRefreshTimer = null;

function shortStatus(target) {
    if (!isReady()) {
        return '';
    }

    const parts = [];

    if (!target?.name && !target?.modifier) {
        parts.push(target?.broken?.length
            ? `Linked set "${target.broken[0]}" no longer exists. The preset's own toggles are in use`
            : 'No set applies here. The preset\'s own toggles are in use');
    } else {
        const pending = planApply(targetIds(target) || []).changes.length;
        parts.push(`"${targetLabel(target)}" (${sourceText(target)})`);
        parts.push(pending ? `${plural(pending, 'prompt')} ${pending === 1 ? 'differs' : 'differ'}` : 'toggles match');
    }

    if (!getSettings().autoApply) {
        parts.push('automatic applying is off');
    }

    if (isLocked()) {
        parts.push('locked');
    }

    return parts.join(' · ');
}

function refreshBar(selectName) {
    const select = /** @type {HTMLSelectElement|null} */ (document.getElementById('ps_bar_set'));

    if (!select) {
        return;
    }

    const preset = currentPresetName();
    const data = presetData();
    const target = isReady() ? targetFor() : null;
    const card = currentCard();
    const context = `${preset}\u0000${user_avatar}\u0000${card?.key ?? ''}\u0000${target?.name ?? ''}\u0000${target?.modifier ?? ''}`;

    // Keep the user's choice while they work; show the active set again when the preset, persona,
    // card or active set changes.
    const wanted = selectName ?? (context !== barContext ? target?.name : select.value);
    barContext = context;

    fillSetSelect(select, data, wanted, { withModifiers: true, mark: target?.name, markMod: target?.modifier });

    const chosen = select.value;
    const isSet = data?.sets[chosen]?.kind === 'set';
    const isMod = data?.sets[chosen]?.kind === 'modifier';
    const linkedHere = (isSet && ['persona', 'card'].some(kind => getLink(kind) === chosen)) || (isMod && getLink('personaMod') === chosen);
    const link = document.getElementById('ps_bar_link');
    link.classList.toggle('ps-on', linkedHere);
    link.title = isMod
        ? `Stack [${chosen}] for ${personaName()}, on top of whatever set applies`
        : `Choose where "${chosen || 'this set'}" is used: this persona, or this card`;

    document.getElementById('ps_bar_edit').classList.toggle('disabled', !chosen);
    document.getElementById('ps_bar_link').classList.toggle('disabled', !isSet && !isMod);

    for (const id of ['ps_bar_apply', 'ps_bar_update']) {
        document.getElementById(id).classList.toggle('disabled', !isSet);
    }

    const locked = isLocked();
    const lock = document.getElementById('ps_bar_lock');
    lock.classList.toggle('ps-on', locked);
    lock.classList.toggle('disabled', !preset);
    lock.title = locked
        ? 'Locked: prompts change only through sets. Click to unlock.'
        : 'Lock this preset, so prompts change only through sets and the preset can\'t be updated, renamed or deleted';
    lock.querySelector('i').className = `fa-fw fa-solid ${locked ? 'fa-lock' : 'fa-lock-open'}`;

    // Updating a set from the live toggles makes no sense when they can't be changed by hand.
    document.getElementById('ps_bar_update').hidden = locked;
    $(LOCKED_BUTTONS).toggleClass('ps-preset-locked', locked);

    document.getElementById('ps_bar_status').textContent = shortStatus(target);
}

/** Toggling prompts by hand changes whether they match the set; redraw the bar shortly after. */
function scheduleBarRefresh() {
    clearTimeout(barRefreshTimer);
    barRefreshTimer = setTimeout(() => refreshBar(), 250);
}

function addPresetBar() {
    const anchor = $('#settings_preset_openai').parent();

    if (!anchor.length) {
        console.warn(LOG, 'Could not find the Chat Completion preset list; the preset-section bar is not shown.');
        return;
    }

    const html = `
    <div id="ps_bar" class="ps-bar">
        <div class="flex-container flexNoGap alignItemsCenter">
            <i class="ps-bar-icon fa-fw fa-solid fa-layer-group" title="Preset Sets. More options are under Extensions → Preset Sets."></i>
            <select id="ps_bar_set" class="flex1 text_pole" title="Sets and modifiers in this preset"></select>
        </div>
        <div class="flex-container gap3px ps-bar-buttons">
            <div id="ps_bar_apply" class="menu_button menu_button_icon" title="Apply this set">
                <i class="fa-fw fa-solid fa-check"></i>
            </div>
            <div id="ps_bar_edit" class="menu_button menu_button_icon" title="Choose what this set or modifier switches on and off">
                <i class="fa-fw fa-solid fa-pen-to-square"></i>
            </div>
            <div id="ps_bar_update" class="menu_button menu_button_icon" title="Make this set switch on exactly the prompts that are on now">
                <i class="fa-fw fa-solid fa-arrows-rotate"></i>
            </div>
            <div id="ps_bar_new" class="menu_button menu_button_icon" title="New set or modifier">
                <i class="fa-fw fa-solid fa-plus"></i>
            </div>
            <div id="ps_bar_link" class="menu_button menu_button_icon">
                <i class="fa-fw fa-solid fa-link"></i>
            </div>
            <div id="ps_bar_lock" class="menu_button menu_button_icon">
                <i class="fa-fw fa-solid fa-lock-open"></i>
            </div>
        </div>
        <small id="ps_bar_status" class="ps-bar-status"></small>
    </div>`;

    anchor.after(html);

    const chosen = () => /** @type {HTMLSelectElement} */ (document.getElementById('ps_bar_set')).value;

    $('#ps_bar_set').on('change', () => refreshBar(chosen()));
    $('#ps_bar_apply').on('click', () => chosen() && applyNamed(chosen()));
    $('#ps_bar_edit').on('click', () => chosen() && editSet(chosen()));
    $('#ps_bar_update').on('click', () => chosen() && updateSelected(chosen()));
    $('#ps_bar_new').on('click', () => editSet(null));
    $('#ps_bar_link').on('click', () => chosen() && chooseLinks(chosen()));
    $('#ps_bar_lock').on('click', () => currentPresetName() && setLocked(!isLocked()));

    // Capture phase, so the prompt manager (or NemoPresetExt's version of it) can't swallow the event.
    for (const type of ['click', 'change']) {
        document.addEventListener(type, event => {
            if (event.target instanceof Element && event.target.closest('#completion_prompt_manager')) {
                scheduleBarRefresh();
            }
        }, true);
    }

    refreshBar();
}

// ---------------------------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------------------------

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetset',
        callback: async (_args, value) => {
            const name = cleanName(value);

            if (!name) {
                return setNames(presetData(), 'set').join('\n');
            }

            await applyNamed(name);
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name of the set to apply; leave empty to list the sets in this preset',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Applies a Preset Sets set in the current Chat Completion preset, or lists the sets.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'presetset-save',
        callback: async (_args, value) => {
            const name = cleanName(value);

            if (!name) {
                toastr.warning('Give the set a name, e.g. /presetset-save Evening', 'Preset Sets');
                return '';
            }

            return (await saveFromToggles(name)) || '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name for the set; an existing set keeps what it builds on and takes the prompts switched on now',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Saves the prompts switched on now as a Preset Sets set in the current preset.',
    }));
}

// ---------------------------------------------------------------------------------------------
// Start-up and events
// ---------------------------------------------------------------------------------------------

let loadSeq = 0;

/** A preset was loaded or reloaded: read its markers, apply the linked set, offer new prompts. */
async function onPresetLoaded() {
    const seq = ++loadSeq;
    lastApplied = null;
    installLockHook();

    try {
        await refreshRules();
    } catch (error) {
        console.warn(LOG, 'Could not read the prompts\' exclusivity markers', error);
    }

    if (seq !== loadSeq) {
        return;
    }

    await autoApply();

    if (seq === loadSeq) {
        await checkNewPrompts();
    }
}

function onPersonaDeleted(payload) {
    const settings = getSettings();
    // SillyTavern sends { avatarId, name }; older versions may send the avatar itself.
    const avatar = typeof payload === 'string' ? payload : payload?.avatarId;

    if (avatar) {
        delete settings.links[avatar];
        delete settings.personaMods[avatar];
        saveSettingsDebounced();
    }

    refreshUI();
}

/**
 * A deleted preset keeps its sets and links, so importing it again brings them back, but it is
 * unlocked: a new preset made with the same name shouldn't start out locked.
 */
function onPresetDeleted({ apiId, name } = {}) {
    const data = apiId === 'openai' && name ? getSettings().presets[name] : null;

    if (data?.locked) {
        data.locked = false;
        saveSettingsDebounced();
    }
}

function onCharacterDeleted(event) {
    const key = event?.character?.avatar;

    if (!key) {
        return;
    }

    const settings = getSettings();
    delete settings.cardLinks[key];
    saveSettingsDebounced();
    refreshUI();
}

function onCharacterRenamed(oldAvatar, newAvatar) {
    if (!oldAvatar || !newAvatar || oldAvatar === newAvatar) {
        return;
    }

    const settings = getSettings();
    const move = (record) => {
        if (record?.[oldAvatar]) {
            record[newAvatar] = record[oldAvatar];
            delete record[oldAvatar];
        }
    };

    move(settings.cardLinks);
    saveSettingsDebounced();
}

/** A console handle for checking what the extension sees. Read-only apart from `apply`. */
globalThis.PresetSets = {
    get preset() { return currentPresetName(); },
    get persona() { return user_avatar; },
    get card() { return currentCard(); },
    target: () => targetFor(),
    /** With a name, that set's prompts; without, what's linked now (set plus persona modifier). */
    ids: (name) => (name ? setIds(name) : targetIds(targetFor())),
    plan: (name) => {
        const ids = name ? setIds(name) : targetIds(targetFor());
        return ids && isReady() ? planApply(ids) : null;
    },
    problems: () => checkAll(presetData()?.sets || {}, rulesFor()),
    apply: (name) => applyNamed(name),
};

jQuery(async () => {
    getSettings();
    addPresetBar();
    addSettingsPanel();
    registerSlashCommands();
    blockLockedButtons();
    installLockHook();

    eventSource.on(event_types.APP_READY, () => onPresetLoaded());
    eventSource.on(event_types.PERSONA_CHANGED, () => autoApply());
    eventSource.on(event_types.CHAT_CHANGED, () => autoApply());

    // Switching presets reloads its saved toggles, so the linked set is applied again once the
    // prompt manager has the new preset.
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => setTimeout(() => onPresetLoaded(), 0));

    const optional = [
        [event_types.PRESET_RENAMED, onPresetRenamed],
        [event_types.PRESET_DELETED, onPresetDeleted],
        [event_types.PERSONA_DELETED, onPersonaDeleted],
        [event_types.CHARACTER_DELETED, onCharacterDeleted],
        [event_types.CHARACTER_RENAMED, onCharacterRenamed],
    ];

    for (const [type, handler] of optional) {
        if (type) {
            eventSource.on(type, handler);
        }
    }
});
