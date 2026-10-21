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
    allDependants, changesBetween, checkAll, directDependants, excludes, inherited,
    normaliseSet, possibleBases, readMarkers, removeKeeping, renameReferences, resolve,
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
     * A Set is { kind: 'set'|'modifier', base, modifiers, on, off, updated } (see layers.js).
     * `known` is every prompt seen so far, so new prompts can be offered to sets.
     * `markers` caches which prompts exclude each other, read from the prompt text.
     */
    presets: {},
    /** Persona links: { [personaAvatar]: { [preset]: setName } } */
    links: {},
    /** Character card (or group chat) links: { [cardKey]: { [preset]: setName } } */
    cardLinks: {},
    /** Persona-with-card links: { [personaAvatar]: { [cardKey]: { [preset]: setName } } } */
    pairLinks: {},
};

const EMPTY_RULES = Object.freeze({ groupOf: new Map(), withIds: new Map() });

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

/** True while this extension is switching prompts itself, so the lock lets those changes through. */
let applying = false;

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
        applying = true;

        try {
            await pm.saveServiceSettings?.();
        } finally {
            applying = false;
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
 * Read the exclusivity markers from every prompt's text. NemoPresetExt can keep switched-off
 * prompts' text out of memory, so the text is read through it when it is installed.
 */
async function readAllMarkers() {
    const cold = globalThis.NemoColdPrompts;
    const prompts = promptManager.serviceSettings.prompts;

    const found = await Promise.all(prompts.map(async prompt => {
        let text = prompt?.content ?? '';

        if (typeof cold?.readBody === 'function') {
            try {
                text = (await cold.readBody(prompt)) ?? text;
            } catch (error) {
                console.warn(LOG, `Could not read "${prompt?.name}" through NemoPresetExt`, error);
            }
        }

        return [prompt.identifier, readMarkers(text)];
    }));

    const groups = {};
    const withIds = {};

    for (const [id, marks] of found) {
        if (marks.group) {
            groups[id] = marks.group;
        }

        if (marks.withIds.length) {
            withIds[id] = marks.withIds;
        }
    }

    return { groups, withIds };
}

/** Re-read the markers, keep them with the preset's sets, and return the rules. */
async function refreshRules() {
    if (!isReady()) {
        return EMPTY_RULES;
    }

    const preset = currentPresetName();
    const markers = await readAllMarkers();
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
// Links: persona, character card, persona with card
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

    return [settings.pairLinks, [avatar, card, preset]];
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
 * The set that should be active. The most specific link wins: this persona with this card, then
 * this persona, then this card, then the preset's set for anything without a link. A link to a set
 * that no longer exists is skipped, so a missing set never leaves an unexpected state in place.
 */
function targetFor(avatar = user_avatar, preset = currentPresetName(), card = currentCard()?.key) {
    const data = presetData(preset);

    if (!data) {
        return null;
    }

    const broken = [];
    const candidates = [
        ['pair', getLink('pair', preset, avatar, card)],
        ['persona', getLink('persona', preset, avatar, card)],
        ['card', getLink('card', preset, avatar, card)],
        ['default', data.defaultSet],
    ];

    for (const [source, name] of candidates) {
        if (!name) {
            continue;
        }

        if (data.sets[name]?.kind === 'set') {
            return { name, source, broken };
        }

        broken.push(name);
    }

    return broken.length ? { name: null, source: 'none', broken } : null;
}

function sourceText(source) {
    const card = currentCard()?.name || 'this card';

    switch (source) {
        case 'pair': return `linked to ${personaName()} with ${card}`;
        case 'persona': return `linked to ${personaName()}`;
        case 'card': return `linked to ${card}`;
        default: return 'for anything without a link';
    }
}

/** When a set is renamed or deleted, move or drop every link and default that named it. */
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
    Object.values(settings.pairLinks).forEach(byCard => Object.values(byCard || {}).forEach(fix));
}

async function chooseLinks(name) {
    const data = presetData();

    if (!data?.sets[name] || data.sets[name].kind !== 'set') {
        return;
    }

    const card = currentCard();
    const content = document.createElement('div');
    content.classList.add('ps-links');

    const heading = document.createElement('h3');
    heading.textContent = `Use "${name}" for`;
    content.appendChild(heading);

    const choices = [
        ['persona', `${personaName()}, with any card`],
        ['card', card ? `${card.name}, with any persona that has no link of its own` : 'a character card (open a chat first)'],
        ['pair', card ? `${personaName()} with ${card.name}` : `${personaName()} with a card (open a chat first)`],
    ];

    const boxes = {};

    for (const [kind, label] of choices) {
        const row = document.createElement('label');
        row.classList.add('checkbox_label');

        const box = document.createElement('input');
        box.type = 'checkbox';
        const current = getLink(kind);
        box.checked = current === name;
        box.disabled = kind !== 'persona' && !card;

        const text = document.createElement('span');
        text.textContent = label;
        row.append(box, text);

        if (current && current !== name) {
            const now = document.createElement('span');
            now.classList.add('opacity50p');
            now.textContent = ` (now "${current}")`;
            row.appendChild(now);
        }

        boxes[kind] = { box, current };
        content.appendChild(row);
    }

    const hint = document.createElement('div');
    hint.classList.add('opacity50p');
    hint.textContent = 'The most specific link wins: persona with card, then persona, then card, then the set for anything without a link.';
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

function reportApply(name, result, automatic) {
    const settings = getSettings();
    const key = `${currentPresetName()}\u0000${name}`;

    if (result.changed && (!automatic || settings.notify)) {
        toastr.info(`Applied "${name}" (${plural(result.changed, 'change')}).`, 'Preset Sets');
    } else if (!automatic && !result.changed) {
        toastr.info(`"${name}" is already applied.`, 'Preset Sets');
    }

    if (result.missing.length && (!automatic || !warnedMissing.has(key))) {
        warnedMissing.add(key);
        toastr.warning(`"${name}" lists ${plural(result.missing.length, 'prompt')} this preset no longer has. Edit or update the set to clear this.`, 'Preset Sets');
    }

    if (result.remaining.length) {
        toastr.error(`Some prompts could not be switched: ${result.remaining.slice(0, 5).join(', ')}${result.remaining.length > 5 ? '…' : ''}`, 'Preset Sets');
    }
}

async function applySet(name, source, automatic) {
    const ids = setIds(name);

    if (!ids) {
        return null;
    }

    const result = await applyIds(ids);
    lastApplied = { preset: currentPresetName(), name, source, ...result };
    reportApply(name, result, automatic);
    return result;
}

/** Apply the linked set, if there is one and automatic applying is on. */
async function autoApply() {
    installLockHook();

    if (!getSettings().autoApply || !isReady()) {
        refreshUI();
        return null;
    }

    return serial(async () => {
        const target = targetFor();

        if (!target?.name) {
            refreshUI();
            return null;
        }

        const result = await applySet(target.name, target.source, true);
        refreshUI();
        return { target, result };
    });
}

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
        const result = await applySet(name, 'manual', false);
        refreshUI();
        return result;
    });
}

/**
 * After a set changes, put the set in use back in place, since its prompts (or those of a set it
 * builds on) may have changed.
 */
async function reapplyInUse() {
    if (!isReady()) {
        refreshUI();
        return;
    }

    const data = presetData();
    const preset = currentPresetName();
    const kept = lastApplied?.preset === preset && data?.sets[lastApplied.name]?.kind === 'set' ? lastApplied : null;
    const target = kept ? { name: kept.name, source: kept.source } : (getSettings().autoApply ? targetFor() : null);

    if (target?.name) {
        await serial(() => applySet(target.name, target.source, true));
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
    const preset = currentPresetName();
    const data = presetData(preset);
    const name = lastApplied?.preset === preset && data?.sets[lastApplied.name]?.kind === 'set' ? lastApplied.name : null;
    return name ? setIds(name, data) : savedPresetIds(preset);
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

        if (!applying && isReady() && isLocked()) {
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
    Object.values(settings.pairLinks).forEach(byCard => Object.values(byCard || {}).forEach(move));

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

    const confirmed = await callGenericPopup(`Make "${name}" switch on exactly the prompts that are on right now?`, POPUP_TYPE.CONFIRM);

    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
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

    const next = cleanName(await callGenericPopup(`New name for "${name}"`, POPUP_TYPE.INPUT, name));

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

    const confirmed = await callGenericPopup(lines.join('\n\n'), POPUP_TYPE.CONFIRM);

    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    removeKeeping(data.sets, name, rulesFor(data), [...orderIds()]);
    relinkName(currentPresetName(), name, null);

    if (lastApplied?.name === name) {
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

    if (picked.includes(lastApplied?.name)) {
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

            block.append(title, chips);
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
    const rows = readRows();
    const order = [...orderIds()];
    const existing = name ? data.sets[name] : null;
    const modifiers = setNames(data, 'modifier');

    const state = {
        kind: existing?.kind ?? 'set',
        base: existing?.base ?? null,
        modifiers: [...(existing?.modifiers ?? [])],
        final: new Set(existing ? (existing.kind === 'set' ? resolve(data.sets, name, rules).ids : []) : captureIds()),
        change: new Map(existing?.kind === 'modifier'
            ? [...existing.on.map(id => [id, 'on']), ...existing.off.map(id => [id, 'off'])]
            : []),
        from: new Set(),
        compare: null,
        compareName: '',
        show: 'all',
    };

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
            view.control.textContent = value === 'on' ? 'On' : value === 'off' ? 'Off' : '–';
            view.control.dataset.state = value;
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
        const baseSelect = makeSelect([['', '— Nothing —'], ...bases.sort((a, b) => a.localeCompare(b)).map(item => [item, item])], state.base);
        baseSelect.addEventListener('change', () => {
            state.base = baseSelect.value || null;
            recomputeFrom();
            updateAll();
        });
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
                box.addEventListener('change', () => {
                    state.modifiers = modifiers.filter(item => item === modName ? box.checked : state.modifiers.includes(item));
                    recomputeFrom();
                    updateAll();
                });
                chip.append(box, element('span', null, modName));
                chips.appendChild(chip);
            }

            modRow.appendChild(chips);
            layerBox.appendChild(modRow);
        }

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
            : [['all', 'All prompts'], ['changed', 'Changed by this modifier']];
        const show = makeSelect(showOptions, state.show);
        show.title = 'Show';
        show.addEventListener('change', () => {
            state.show = show.value;
            updateVisibility(search.value.trim().toLowerCase());
        });
        toolBox.appendChild(show);

        if (state.kind === 'set') {
            const others = setNames(data, 'set').filter(item => item !== name);
            const compare = makeSelect([['', 'Compare with…'], ...others.map(item => [item, item])], state.compareName);
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

                label.append(view.control, element('span', null, row.name));
            }

            (current?.body ?? list).appendChild(label);
            rowViews.push(view);
        }
    }

    function build() {
        buildLayers();
        buildTools();
        hintBox.textContent = state.kind === 'set'
            ? [groupHint, state.base || state.modifiers.length ? 'A dot marks a prompt changed in this set; click it to follow the base again.' : ''].filter(Boolean).join(' ')
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

    // Prompts the preset no longer has are dropped, as Update does.
    const present = new Set(rows.map(row => row.id));
    const updated = new Date().toISOString();

    if (state.kind === 'set') {
        const { on, off } = changesBetween(state.from, [...state.final].filter(id => present.has(id)), rules, order);
        data.sets[finalName] = { kind: 'set', base: state.base, modifiers: [...state.modifiers], on, off, updated };
    } else {
        const pick = (value) => order.filter(id => state.change.get(id) === value);
        data.sets[finalName] = { kind: 'modifier', base: null, modifiers: [], on: pick('on'), off: pick('off'), updated };
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
    const links = { persona: {}, card: {}, pair: {} };

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

    for (const [avatar, byCard] of Object.entries(settings.pairLinks)) {
        for (const [card, byPreset] of Object.entries(byCard || {})) {
            if (byPreset?.[preset]) {
                links.pair[avatar] ??= {};
                links.pair[avatar][card] = byPreset[preset];
            }
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
            `"${preset}" already has ${plural(existing.length, 'set')}. Replace them all with the ones in this file, or add these to them? Adding replaces only sets with the same name.`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Replace all', cancelButton: 'Cancel', customButtons: [{ text: 'Add to them', result: POPUP_RESULT.CUSTOM1 }] },
        );

        if (choice === POPUP_RESULT.AFFIRMATIVE) {
            const incoming = new Set(Object.keys(payload.sets).map(cleanName));

            for (const name of existing) {
                if (!incoming.has(name)) {
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

        for (const [avatar, byCard] of Object.entries(links.pair || {})) {
            for (const [card, name] of Object.entries(byCard || {})) {
                if (usable(name)) {
                    setLink('pair', name, preset, avatar, card);
                }
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
function fillSetSelect(select, data, value, { emptyLabel, withModifiers = false, mark = null } = {}) {
    select.innerHTML = '';

    const add = (parent, optionValue, label) => {
        const option = element('option', null, label);
        option.value = optionValue;
        parent.appendChild(option);
    };

    if (emptyLabel !== undefined) {
        add(select, '', emptyLabel);
    }

    const sets = setNames(data, 'set');
    const mods = withModifiers ? setNames(data, 'modifier') : [];

    if (mods.length) {
        const setGroup = element('optgroup');
        setGroup.label = 'Sets';
        sets.forEach(name => add(setGroup, name, name === mark ? `${name} (active)` : name));
        const modGroup = element('optgroup');
        modGroup.label = 'Modifiers';
        mods.forEach(name => add(modGroup, name, name));
        select.append(setGroup, modGroup);
    } else {
        sets.forEach(name => add(select, name, name === mark ? `${name} (active)` : name));
    }

    const all = [...sets, ...mods];

    if (!all.length && emptyLabel === undefined) {
        add(select, '', 'No sets in this preset yet');
    }

    select.value = all.includes(value) ? value : (emptyLabel !== undefined ? '' : (all[0] ?? ''));
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

    if (!target?.name) {
        parts.push('No set applies here, so the preset\'s own toggles are in use.');
    } else {
        const pending = planApply(setIds(target.name)).changes.length;
        parts.push(`Active set: "${target.name}" (${sourceText(target.source)}). ${pending ? `${plural(pending, 'prompt')} currently differ from it.` : 'The toggles match it.'}`);

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
    fillSetSelect(document.getElementById('ps_pair_link'), data, getLink('pair'), { emptyLabel: card ? '— No link —' : '— Open a chat first —' });
    fillSetSelect(document.getElementById('ps_default'), data, data?.defaultSet ?? '', { emptyLabel: '— None: keep the preset\'s toggles —' });

    document.getElementById('ps_card_link').toggleAttribute('disabled', !card);
    document.getElementById('ps_pair_link').toggleAttribute('disabled', !card);
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
                    <div id="ps_new" class="menu_button" title="Make a new set or modifier, starting from the prompts switched on now">New…</div>
                    <div id="ps_update" class="menu_button" title="Make this set switch on exactly the prompts that are on now">Update</div>
                    <div id="ps_rename" class="menu_button">Rename…</div>
                    <div id="ps_delete" class="menu_button redWarningBG">Delete</div>
                    <div id="ps_delete_many" class="menu_button redWarningBG" title="Tick several sets and modifiers to delete at once">Delete several…</div>
                </div>
                <label for="ps_link">Set for <b class="ps_persona_name"></b></label>
                <select id="ps_link" class="text_pole"></select>
                <label for="ps_card_link">Set for <b class="ps_card_name"></b></label>
                <select id="ps_card_link" class="text_pole"></select>
                <label for="ps_pair_link">Set for <b class="ps_persona_name"></b> with <b class="ps_card_name"></b></label>
                <select id="ps_pair_link" class="text_pole"></select>
                <label for="ps_default">Set for anything without a link</label>
                <select id="ps_default" class="text_pole"></select>
                <div class="opacity50p">The most specific link wins: persona with card, then persona, then card.</div>
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
    linkSelect('#ps_pair_link', 'pair');

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

    if (!target?.name) {
        parts.push(target?.broken?.length
            ? `Linked set "${target.broken[0]}" no longer exists. The preset's own toggles are in use`
            : 'No set applies here. The preset\'s own toggles are in use');
    } else {
        const pending = planApply(setIds(target.name)).changes.length;
        parts.push(`"${target.name}" (${sourceText(target.source)})`);
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
    const context = `${preset}\u0000${user_avatar}\u0000${card?.key ?? ''}\u0000${target?.name ?? ''}`;

    // Keep the user's choice while they work; show the active set again when the preset, persona,
    // card or active set changes.
    const wanted = selectName ?? (context !== barContext ? target?.name : select.value);
    barContext = context;

    fillSetSelect(select, data, wanted, { withModifiers: true, mark: target?.name });

    const chosen = select.value;
    const isSet = data?.sets[chosen]?.kind === 'set';
    const linkedHere = isSet && ['pair', 'persona', 'card'].some(kind => getLink(kind) === chosen);
    const link = document.getElementById('ps_bar_link');
    link.classList.toggle('ps-on', linkedHere);
    link.title = `Choose where "${chosen || 'this set'}" is used: this persona, this card, or both together`;

    document.getElementById('ps_bar_edit').classList.toggle('disabled', !chosen);

    for (const id of ['ps_bar_apply', 'ps_bar_update', 'ps_bar_link']) {
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
            <div id="ps_bar_new" class="menu_button menu_button_icon" title="New set or modifier, starting from the prompts switched on now">
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

function onPersonaDeleted(avatar) {
    const settings = getSettings();

    if (avatar) {
        delete settings.links[avatar];
        delete settings.pairLinks[avatar];
        saveSettingsDebounced();
    }

    refreshUI();
}

function onCharacterDeleted(event) {
    const key = event?.character?.avatar;

    if (!key) {
        return;
    }

    const settings = getSettings();
    delete settings.cardLinks[key];
    Object.values(settings.pairLinks).forEach(byCard => { delete byCard?.[key]; });
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
    Object.values(settings.pairLinks).forEach(move);
    saveSettingsDebounced();
}

/** A console handle for checking what the extension sees. Read-only apart from `apply`. */
globalThis.PresetSets = {
    get preset() { return currentPresetName(); },
    get persona() { return user_avatar; },
    get card() { return currentCard(); },
    target: () => targetFor(),
    ids: (name) => setIds(name ?? targetFor()?.name),
    plan: (name) => {
        const ids = setIds(name ?? targetFor()?.name);
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
