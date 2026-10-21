import { eventSource, event_types, main_api, saveSettingsDebounced } from '../../../../script.js';
import { oai_settings, openai_settings, openai_setting_names, promptManager } from '../../../openai.js';
import { extension_settings } from '../../../extensions.js';
import { user_avatar } from '../../../personas.js';
import { power_user } from '../../../power-user.js';
import { Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup } from '../../../popup.js';
import { download } from '../../../utils.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'presetSets';
const LOG = '[Preset Sets]';
const EXPORT_FORMAT = 'preset-sets';
const EXPORT_VERSION = 1;

const defaultSettings = {
    /** Apply the linked set whenever the persona, chat or preset changes, and before each generation. */
    autoApply: true,
    /** Show a notice when a set is applied automatically. */
    notify: true,
    /**
     * Sets, per Chat Completion preset name:
     * { [presetName]: { sets: { [setName]: { ids: string[], updated: string } }, defaultSet: string|null, locked: boolean } }
     * A locked preset can only change its toggles through sets, and can't be updated, renamed or deleted.
     */
    presets: {},
    /** Which set each persona uses, per preset: { [personaAvatar]: { [presetName]: setName } } */
    links: {},
};

/** Missing-prompt warnings already shown this session, so a stale set doesn't warn on every message. */
const warnedMissing = new Set();

/** The last automatic or manual apply, for the status line. */
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

    if (data) {
        data.sets ??= {};
        data.locked = Boolean(data.locked);

        if (data.defaultSet === undefined) {
            data.defaultSet = null;
        }

        // Guarded prompts were removed in favour of the preset lock.
        delete data.guarded;
    }

    return data || null;
}

function personaName(avatar = user_avatar) {
    return power_user.personas?.[avatar] || avatar || 'no persona';
}

function setNames(data = presetData()) {
    return data ? Object.keys(data.sets).sort((a, b) => a.localeCompare(b)) : [];
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

/** The identifiers of every switched-on prompt, which is what a set stores. */
function captureIds() {
    return readRows().filter(row => row.enabled).map(row => row.id);
}

/** Every prompt in the active order, toggleable or not. */
function orderIds() {
    const pm = promptManager;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter) || [];
    return new Set(order.map(entry => entry?.identifier).filter(Boolean));
}

/**
 * What applying a set would change, without changing anything. A set listing a prompt that
 * can't be toggled (a marker, say) simply leaves it alone; only prompts the preset doesn't
 * have at all count as missing.
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
 * Switch prompts on and off to match a set. Prompts the set doesn't list are switched off.
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

/**
 * The set that should be active: the persona's link for this preset if it exists, otherwise the
 * preset's set for unlinked personas, otherwise none. A link to a deleted set falls through to the
 * unlinked set, so a missing set never leaves an unexpected state in place.
 */
function targetFor(avatar = user_avatar, preset = currentPresetName()) {
    const data = presetData(preset);

    if (!data) {
        return null;
    }

    const linked = getSettings().links?.[avatar]?.[preset];

    if (linked && data.sets[linked]) {
        return { name: linked, source: 'persona', set: data.sets[linked] };
    }

    if (data.defaultSet && data.sets[data.defaultSet]) {
        return { name: data.defaultSet, source: 'default', set: data.sets[data.defaultSet], brokenLink: linked || null };
    }

    return linked ? { name: null, source: 'none', set: null, brokenLink: linked } : null;
}

function reportApply(name, result, automatic) {
    const settings = getSettings();
    const key = `${currentPresetName()}\u0000${name}`;

    if (result.changed && (!automatic || settings.notify)) {
        toastr.info(`Applied "${name}" for ${personaName()} (${result.changed} change${result.changed === 1 ? '' : 's'}).`, 'Preset Sets');
    } else if (!automatic && !result.changed) {
        toastr.info(`"${name}" is already applied.`, 'Preset Sets');
    }

    if (result.missing.length && (!automatic || !warnedMissing.has(key))) {
        warnedMissing.add(key);
        toastr.warning(`"${name}" lists ${result.missing.length} prompt(s) this preset no longer has. Update the set to clear this.`, 'Preset Sets');
    }

    if (result.remaining.length) {
        toastr.error(`Some prompts could not be switched: ${result.remaining.slice(0, 5).join(', ')}${result.remaining.length > 5 ? '…' : ''}`, 'Preset Sets');
    }
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

        if (!target?.set) {
            refreshUI();
            return null;
        }

        const result = await applyIds(target.set.ids);
        lastApplied = { preset: currentPresetName(), name: target.name, source: target.source, persona: user_avatar, ...result };
        reportApply(target.name, result, true);
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

    return serial(async () => {
        const result = await applyIds(data.sets[name].ids);
        lastApplied = { preset: currentPresetName(), name, source: 'manual', persona: user_avatar, ...result };
        reportApply(name, result, false);
        refreshUI();
        return result;
    });
}

/**
 * Runs before every generation (registered as the manifest's generate_interceptor), so the
 * persona's set is in place whatever happened to the toggles since it was last applied.
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

/** True while this extension is switching prompts itself, so the lock lets those changes through. */
let applying = false;
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
    const set = lastApplied?.preset === preset && lastApplied.name ? presetData(preset)?.sets[lastApplied.name] : null;
    return set ? set.ids : savedPresetIds(preset);
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

    const locked = async function (...args) {
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

    pm.saveServiceSettings = locked;
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

    for (const links of Object.values(settings.links)) {
        if (links?.[oldName]) {
            links[newName] = links[oldName];
            delete links[oldName];
        }
    }

    if (lastApplied?.preset === oldName) {
        lastApplied.preset = newName;
    }

    saveSettingsDebounced();
    refreshUI();
}

// ---------------------------------------------------------------------------------------------
// Set management
// ---------------------------------------------------------------------------------------------

function cleanName(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
}

async function saveCurrentAsNew(nameArg) {
    if (!isReady()) {
        toastr.warning('Load a Chat Completion preset first.', 'Preset Sets');
        return null;
    }

    const name = cleanName(nameArg ?? await callGenericPopup('Name for the new set', POPUP_TYPE.INPUT, ''));

    if (!name) {
        return null;
    }

    const data = presetData(currentPresetName(), true);

    if (data.sets[name] && nameArg === undefined) {
        const confirmed = await callGenericPopup(`A set called "${name}" already exists. Replace it with the current toggles?`, POPUP_TYPE.CONFIRM);

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return null;
        }
    }

    data.sets[name] = { ids: captureIds(), updated: new Date().toISOString() };
    saveSettingsDebounced();
    refreshUI(name);
    toastr.success(`Saved "${name}" with ${data.sets[name].ids.length} prompt(s) on.`, 'Preset Sets');
    return name;
}

async function updateSelected(name) {
    const data = presetData();

    if (!data?.sets[name] || !isReady()) {
        return;
    }

    const confirmed = await callGenericPopup(`Replace "${name}" with the prompts switched on right now?`, POPUP_TYPE.CONFIRM);

    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    data.sets[name] = { ids: captureIds(), updated: new Date().toISOString() };
    warnedMissing.delete(`${currentPresetName()}\u0000${name}`);
    saveSettingsDebounced();
    refreshUI(name);
    toastr.success(`Updated "${name}".`, 'Preset Sets');
}

function relinkName(preset, from, to) {
    const settings = getSettings();
    const data = presetData(preset);

    if (data && data.defaultSet === from) {
        data.defaultSet = to;
    }

    for (const links of Object.values(settings.links)) {
        if (links?.[preset] === from) {
            if (to) {
                links[preset] = to;
            } else {
                delete links[preset];
            }
        }
    }
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
        toastr.error(`A set called "${next}" already exists.`, 'Preset Sets');
        return;
    }

    data.sets[next] = data.sets[name];
    delete data.sets[name];
    relinkName(currentPresetName(), name, next);
    saveSettingsDebounced();
    refreshUI(next);
}

async function deleteSelected(name) {
    const data = presetData();

    if (!data?.sets[name]) {
        return;
    }

    const confirmed = await callGenericPopup(`Delete the set "${name}"? Personas linked to it will use the set for unlinked personas instead.`, POPUP_TYPE.CONFIRM);

    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    delete data.sets[name];
    relinkName(currentPresetName(), name, null);
    saveSettingsDebounced();
    refreshUI();
}

function setLink(avatar, preset, name) {
    const settings = getSettings();

    if (!avatar || !preset) {
        return;
    }

    settings.links[avatar] ??= {};

    if (name) {
        settings.links[avatar][preset] = name;
    } else {
        delete settings.links[avatar][preset];

        if (!Object.keys(settings.links[avatar]).length) {
            delete settings.links[avatar];
        }
    }

    saveSettingsDebounced();
}

// ---------------------------------------------------------------------------------------------
// Set editor
// ---------------------------------------------------------------------------------------------

const SECTION_HEADER = /^=+\s*.+?\s*=+$/;
const SUB_HEADER = /^<.+>$/;

/**
 * NemoPresetExt marks prompts that can't be on together with directives in the prompt text:
 * `@mutual-exclusive-group <name>` (or `@exclusive-with-category`) and `@exclusive-with <ids>`.
 * NemoPresetExt can keep switched-off prompts' text out of memory, so it is read through its API.
 */
async function readExclusions(rows) {
    const prompts = new Map(promptManager.serviceSettings.prompts.map(prompt => [prompt.identifier, prompt]));
    const cold = globalThis.NemoColdPrompts;
    const result = new Map();

    await Promise.all(rows.map(async row => {
        const prompt = prompts.get(row.id);
        let text = prompt?.content ?? '';

        if (typeof cold?.readBody === 'function') {
            try {
                text = (await cold.readBody(prompt)) ?? text;
            } catch (error) {
                console.warn(LOG, `Could not read "${row.name}" through NemoPresetExt`, error);
            }
        }

        text = String(text || '');
        const group = text.match(/\{\{\/\/\s*@(?:mutual-exclusive-group|exclusive-with-category)\s+([^}]*?)\s*\}\}/)?.[1] || null;
        const withIds = text.match(/\{\{\/\/\s*@exclusive-with\s+([^}]*?)\s*\}\}/)?.[1]?.split(',').map(id => id.trim()).filter(Boolean) || [];

        if (group || withIds.length) {
            result.set(row.id, { group, withIds });
        }
    }));

    return result;
}

function makeCheckbox(row, checked, exclusion) {
    const label = document.createElement('label');
    label.classList.add('checkbox_label', 'ps-editor-row');
    label.dataset.name = row.name.toLowerCase();

    if (SUB_HEADER.test(row.name)) {
        label.classList.add('ps-editor-sub');
    }

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = row.id;
    box.checked = checked;

    if (exclusion?.group) {
        box.dataset.group = exclusion.group;
    }

    const text = document.createElement('span');
    text.textContent = row.name;

    label.append(box, text);
    return label;
}

/**
 * Edit which prompts a set switches on, without touching the prompt manager. With no name, this
 * makes a new set starting from the prompts switched on now.
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

    const rows = readRows();
    const exclusions = await readExclusions(rows);
    const start = new Set(name ? data.sets[name].ids : captureIds());

    const content = document.createElement('div');
    content.classList.add('ps-editor');

    const heading = document.createElement('h3');
    heading.textContent = name ? `Edit "${name}"` : 'New set';
    content.appendChild(heading);

    let nameInput = null;

    if (!name) {
        nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.classList.add('text_pole');
        nameInput.placeholder = 'Name for the new set';
        content.appendChild(nameInput);
    }

    const tools = document.createElement('div');
    tools.classList.add('ps-editor-tools');

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.classList.add('text_pole');
    filter.placeholder = 'Find a prompt';

    const onlyOnLabel = document.createElement('label');
    onlyOnLabel.classList.add('checkbox_label');
    const onlyOn = document.createElement('input');
    onlyOn.type = 'checkbox';
    const onlyOnText = document.createElement('span');
    onlyOnText.textContent = 'Only show prompts that are on';
    onlyOnLabel.append(onlyOn, onlyOnText);

    const total = document.createElement('span');
    total.classList.add('ps-editor-total');

    tools.append(filter, onlyOnLabel, total);
    content.appendChild(tools);

    if (exclusions.size) {
        const hint = document.createElement('div');
        hint.classList.add('opacity50p');
        hint.textContent = 'Prompts that only work one at a time (one Vex, one length and so on) switch each other off here too.';
        content.appendChild(hint);
    }

    // Group rows under the preset's own section headers when it has them (NemoEngine does).
    const list = document.createElement('div');
    list.classList.add('ps-editor-list');
    const sections = [];
    let current = null;
    const hasSections = rows.some(row => SECTION_HEADER.test(row.name));

    for (const row of rows) {
        if (hasSections && (SECTION_HEADER.test(row.name) || !current)) {
            const details = document.createElement('details');
            details.classList.add('ps-editor-section');
            const summary = document.createElement('summary');
            const title = document.createElement('span');
            title.textContent = SECTION_HEADER.test(row.name) ? row.name.replace(/^=+\s*|\s*=+$/g, '') : 'Before the first section';
            const count = document.createElement('span');
            count.classList.add('ps-editor-count');
            summary.append(title, count);
            const body = document.createElement('div');
            body.classList.add('ps-editor-body');
            details.append(summary, body);
            list.appendChild(details);
            current = { details, body, count };
            sections.push(current);
        }

        (current?.body ?? list).appendChild(makeCheckbox(row, start.has(row.id), exclusions.get(row.id)));
    }

    content.appendChild(list);

    const boxes = () => /** @type {HTMLInputElement[]} */ ([...list.querySelectorAll('input[type="checkbox"]')]);

    function updateCounts() {
        for (const section of sections) {
            const inside = [...section.body.querySelectorAll('input[type="checkbox"]')];
            section.count.textContent = `${inside.filter(box => box.checked).length}/${inside.length}`;
        }

        total.textContent = `${boxes().filter(box => box.checked).length} on`;
    }

    function updateVisibility() {
        const query = filter.value.trim().toLowerCase();

        for (const box of boxes()) {
            const label = /** @type {HTMLElement} */ (box.closest('label'));
            label.hidden = (Boolean(query) && !label.dataset.name.includes(query)) || (onlyOn.checked && !box.checked);
        }

        for (const section of sections) {
            const visible = [...section.body.querySelectorAll('label')].some(label => !label.hidden);
            section.details.hidden = !visible;

            if (query || onlyOn.checked) {
                section.details.open = visible;
            }
        }
    }

    list.addEventListener('change', event => {
        const box = /** @type {HTMLInputElement} */ (event.target);

        if (!(box instanceof HTMLInputElement) || !box.checked) {
            updateCounts();
            return;
        }

        const mine = exclusions.get(box.value);

        for (const other of boxes()) {
            if (other === box || !other.checked) {
                continue;
            }

            const theirs = exclusions.get(other.value);
            const sameGroup = mine?.group && theirs?.group === mine.group;
            const named = mine?.withIds.includes(other.value) || theirs?.withIds.includes(box.value);

            if (sameGroup || named) {
                other.checked = false;
            }
        }

        updateCounts();
        updateVisibility();
    });

    filter.addEventListener('input', updateVisibility);
    onlyOn.addEventListener('change', updateVisibility);
    updateCounts();

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
                toastr.warning('Give the set a name.', 'Preset Sets');
                return false;
            }

            if (data.sets[finalName]) {
                toastr.warning(`A set called "${finalName}" already exists.`, 'Preset Sets');
                return false;
            }

            return true;
        },
    });

    await popup.show();

    if (popup.result !== POPUP_RESULT.AFFIRMATIVE || !finalName) {
        return null;
    }

    // Saved in prompt order. Prompts the preset no longer has are dropped, as Update does.
    const ids = boxes().filter(box => box.checked).map(box => box.value);
    data.sets[finalName] = { ids, updated: new Date().toISOString() };
    warnedMissing.delete(`${preset}\u0000${finalName}`);
    saveSettingsDebounced();
    toastr.success(`Saved "${finalName}" with ${ids.length} prompt(s) on.`, 'Preset Sets');

    // An edit to the set in use takes effect straight away.
    const inUse = (lastApplied?.preset === preset && lastApplied.name === finalName) || targetFor()?.name === finalName;

    if (inUse && currentPresetName() === preset) {
        await serial(async () => {
            const result = await applyIds(ids);
            lastApplied = { preset, name: finalName, source: 'edit', persona: user_avatar, ...result };
            reportApply(finalName, result, true);
        });
    }

    refreshUI(finalName);
    return finalName;
}

function exportSets() {
    const preset = currentPresetName();
    const data = presetData(preset);

    if (!data || !setNames(data).length) {
        toastr.info('This preset has no sets to export.', 'Preset Sets');
        return;
    }

    const links = {};

    for (const [avatar, byPreset] of Object.entries(getSettings().links)) {
        if (byPreset?.[preset]) {
            links[avatar] = byPreset[preset];
        }
    }

    const payload = {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        preset,
        sets: data.sets,
        defaultSet: data.defaultSet,
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
    let count = 0;

    for (const [name, set] of Object.entries(payload.sets)) {
        const clean = cleanName(name);

        if (!clean || !Array.isArray(set?.ids) || !set.ids.every(id => typeof id === 'string')) {
            continue;
        }

        data.sets[clean] = { ids: [...set.ids], updated: typeof set.updated === 'string' ? set.updated : new Date().toISOString() };
        count++;
    }

    if (typeof payload.defaultSet === 'string' && data.sets[payload.defaultSet]) {
        data.defaultSet = payload.defaultSet;
    }

    if (payload.links && typeof payload.links === 'object') {
        for (const [avatar, name] of Object.entries(payload.links)) {
            if (typeof name === 'string' && data.sets[name]) {
                setLink(avatar, preset, name);
            }
        }
    }

    saveSettingsDebounced();
    refreshUI();
    toastr.success(`Imported ${count} set(s) into "${preset}".`, 'Preset Sets');
    await autoApply();
}

// ---------------------------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------------------------

function fillSelect(select, names, value, emptyLabel) {
    select.innerHTML = '';

    if (emptyLabel !== undefined) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = emptyLabel;
        select.appendChild(option);
    }

    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    }

    select.value = names.includes(value) ? value : (emptyLabel !== undefined ? '' : (names[0] ?? ''));
}

function describeState() {
    if (!isReady()) {
        return 'Sets work with Chat Completion presets. Load one to use them.';
    }

    const target = targetFor();
    const parts = [];

    if (target?.brokenLink) {
        parts.push(`${personaName()} is linked to "${target.brokenLink}", which no longer exists.`);
    }

    if (!target?.set) {
        parts.push('No set applies to this persona in this preset, so the preset\'s own toggles are in use.');
        return parts.join(' ');
    }

    const from = target.source === 'persona' ? `linked to ${personaName()}` : 'the set for unlinked personas';
    const pending = planApply(target.set.ids).changes.length;
    parts.push(`Active set: "${target.name}" (${from}). ${pending ? `${pending} prompt(s) currently differ from it.` : 'The toggles match it.'}`);

    if (lastApplied?.missing?.length && lastApplied.name === target.name && lastApplied.preset === currentPresetName()) {
        parts.push(`It lists ${lastApplied.missing.length} prompt(s) this preset no longer has.`);
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
    const names = setNames(data);

    const setSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ps_set'));
    const linkSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ps_link'));
    const defaultSelect = /** @type {HTMLSelectElement} */ (document.getElementById('ps_default'));

    fillSelect(setSelect, names, selectName ?? setSelect.value);
    fillSelect(linkSelect, names, settings.links?.[user_avatar]?.[preset] ?? '', '— No link —');
    fillSelect(defaultSelect, names, data?.defaultSet ?? '', '— None: keep the preset\'s toggles —');

    document.getElementById('ps_preset_name').textContent = preset || 'none';
    document.getElementById('ps_persona_name').textContent = personaName();
    /** @type {HTMLInputElement} */ (document.getElementById('ps_lock')).checked = Boolean(data?.locked);
    document.getElementById('ps_lock').toggleAttribute('disabled', !preset);
    document.getElementById('ps_status').textContent = describeState();

    /** @type {HTMLInputElement} */ (document.getElementById('ps_auto')).checked = settings.autoApply;
    /** @type {HTMLInputElement} */ (document.getElementById('ps_notify')).checked = settings.notify;

    const hasSet = names.length > 0;

    for (const id of ['ps_apply', 'ps_edit', 'ps_update', 'ps_rename', 'ps_delete']) {
        document.getElementById(id).classList.toggle('disabled', !hasSet);
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
                <label for="ps_set">Sets in this preset</label>
                <select id="ps_set" class="text_pole"></select>
                <div class="ps-buttons">
                    <div id="ps_apply" class="menu_button" title="Switch prompts to match this set">Apply</div>
                    <div id="ps_edit" class="menu_button" title="Choose which prompts this set switches on">Edit…</div>
                    <div id="ps_save_new" class="menu_button" title="Save the prompts switched on now as a new set">Save as new…</div>
                    <div id="ps_update" class="menu_button" title="Replace this set with the prompts switched on now">Update</div>
                    <div id="ps_rename" class="menu_button">Rename…</div>
                    <div id="ps_delete" class="menu_button redWarningBG">Delete</div>
                </div>
                <label for="ps_link">Set for <b id="ps_persona_name"></b> in this preset</label>
                <select id="ps_link" class="text_pole"></select>
                <label for="ps_default">Set for personas with no link</label>
                <select id="ps_default" class="text_pole"></select>
                <label class="checkbox_label" for="ps_lock" title="Prompts can only be switched through sets, and the preset can't be updated, renamed or deleted">
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

    $('#ps_apply').on('click', () => selected() && applyNamed(selected()));
    $('#ps_save_new').on('click', () => saveCurrentAsNew());
    $('#ps_update').on('click', () => selected() && updateSelected(selected()));
    $('#ps_rename').on('click', () => selected() && renameSelected(selected()));
    $('#ps_delete').on('click', () => selected() && deleteSelected(selected()));
    $('#ps_edit').on('click', () => selected() && editSet(selected()));
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

    $('#ps_link').on('change', async event => {
        setLink(user_avatar, currentPresetName(), /** @type {HTMLSelectElement} */ (event.target).value || null);
        refreshUI();
        await autoApply();
    });

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

/** Preset, persona and active set the bar last showed, so it follows the active set when they change. */
let barContext = null;
let barRefreshTimer = null;

function shortStatus(target) {
    if (!isReady()) {
        return '';
    }

    const persona = personaName();

    if (!target?.set) {
        const text = target?.brokenLink
            ? `${persona} is linked to "${target.brokenLink}", which no longer exists. The preset's own toggles are in use.`
            : `No set for ${persona} here. The preset's own toggles are in use.`;
        return isLocked() ? `${text} · locked` : text;
    }

    const pending = planApply(target.set.ids).changes.length;
    const parts = [
        `${persona}: "${target.name}" (${target.source === 'persona' ? 'linked' : 'for unlinked personas'})`,
        pending ? `${pending} prompt${pending === 1 ? ' differs' : 's differ'}` : 'toggles match',
    ];

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
    const names = setNames();
    const target = isReady() ? targetFor() : null;
    const linked = getSettings().links?.[user_avatar]?.[preset] ?? null;
    const context = `${preset}\u0000${user_avatar}\u0000${target?.name ?? ''}`;

    // Keep the user's choice while they work; show the active set again when the preset, persona
    // or active set changes.
    const wanted = selectName ?? (context !== barContext ? target?.name : select.value);
    barContext = context;

    select.innerHTML = '';

    if (!names.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No sets in this preset yet';
        select.appendChild(option);
    }

    for (const name of names) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name === target?.name ? `${name} (active)` : name;
        select.appendChild(option);
    }

    select.value = names.includes(wanted) ? wanted : (names[0] ?? '');

    const chosen = select.value;
    const isLinked = Boolean(chosen) && chosen === linked;
    const link = document.getElementById('ps_bar_link');
    link.classList.toggle('ps-on', isLinked);
    link.title = isLinked
        ? `Unlink "${chosen}" from ${personaName()}`
        : `Link this set to ${personaName()} in this preset`;

    for (const id of ['ps_bar_apply', 'ps_bar_edit', 'ps_bar_update', 'ps_bar_link']) {
        document.getElementById(id).classList.toggle('disabled', !chosen);
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
            <select id="ps_bar_set" class="flex1 text_pole" title="Sets in this preset"></select>
        </div>
        <div class="flex-container gap3px ps-bar-buttons">
            <div id="ps_bar_apply" class="menu_button menu_button_icon" title="Apply this set">
                <i class="fa-fw fa-solid fa-check"></i>
            </div>
            <div id="ps_bar_edit" class="menu_button menu_button_icon" title="Choose which prompts this set switches on">
                <i class="fa-fw fa-solid fa-pen-to-square"></i>
            </div>
            <div id="ps_bar_update" class="menu_button menu_button_icon" title="Update this set with the prompts switched on now">
                <i class="fa-fw fa-solid fa-arrows-rotate"></i>
            </div>
            <div id="ps_bar_new" class="menu_button menu_button_icon" title="New set, starting from the prompts switched on now">
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
    $('#ps_bar_lock').on('click', () => currentPresetName() && setLocked(!isLocked()));

    $('#ps_bar_link').on('click', async () => {
        const name = chosen();
        const preset = currentPresetName();

        if (!name || !preset) {
            return;
        }

        const linked = getSettings().links?.[user_avatar]?.[preset];
        setLink(user_avatar, preset, linked === name ? null : name);
        refreshUI(name);
        await autoApply();
    });

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
                return setNames().join('\n');
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
                toastr.warning('Give the set a name, e.g. /presetset-save DC: Street', 'Preset Sets');
                return '';
            }

            return (await saveCurrentAsNew(name)) || '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'name for the set; an existing set with this name is replaced',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Saves the prompts switched on now as a Preset Sets set in the current preset.',
    }));
}

// ---------------------------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------------------------

function onPersonaDeleted(avatar) {
    const settings = getSettings();

    if (avatar && settings.links[avatar]) {
        delete settings.links[avatar];
        saveSettingsDebounced();
    }

    refreshUI();
}

/** A console handle for checking what the extension sees. Read-only apart from `apply`. */
globalThis.PresetSets = {
    get preset() { return currentPresetName(); },
    get persona() { return user_avatar; },
    target: () => targetFor(),
    plan: (name) => {
        const set = name ? presetData()?.sets[name] : targetFor()?.set;
        return set && isReady() ? planApply(set.ids) : null;
    },
    apply: (name) => applyNamed(name),
};

jQuery(async () => {
    getSettings();
    addPresetBar();
    addSettingsPanel();
    registerSlashCommands();
    blockLockedButtons();
    installLockHook();

    eventSource.on(event_types.APP_READY, () => {
        installLockHook();
        return autoApply();
    });
    eventSource.on(event_types.PERSONA_CHANGED, () => autoApply());
    eventSource.on(event_types.CHAT_CHANGED, () => autoApply());

    // Switching presets reloads its saved toggles, so the persona's set for that preset is applied
    // again once the prompt manager has the new preset.
    // The newly loaded toggles are the preset's own until a set is applied, which is what a locked
    // preset holds to if no set applies.
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
        lastApplied = null;
        setTimeout(() => autoApply(), 0);
    });

    if (event_types.PRESET_RENAMED) {
        eventSource.on(event_types.PRESET_RENAMED, onPresetRenamed);
    }

    if (event_types.PERSONA_DELETED) {
        eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);
    }
});
