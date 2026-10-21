import { eventSource, event_types, main_api, saveSettingsDebounced } from '../../../../script.js';
import { oai_settings, promptManager } from '../../../openai.js';
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
     * { [presetName]: { sets: { [setName]: { ids: string[], updated: string } }, defaultSet: string|null, guarded: string[] } }
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
        settings.presets[name] = { sets: {}, defaultSet: null, guarded: [] };
    }

    const data = settings.presets[name];

    if (data) {
        data.sets ??= {};
        data.guarded ??= [];

        if (data.defaultSet === undefined) {
            data.defaultSet = null;
        }
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

/** What applying a set would change, without changing anything. */
function planApply(ids, rows = readRows()) {
    const wanted = new Set(ids);
    const present = new Set(rows.map(row => row.id));

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
        await pm.saveServiceSettings?.();

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
 * Runs before every generation (registered as the manifest's generate_interceptor).
 * It applies the linked set, then checks the preset's guarded prompts: if one is switched on
 * while the active set has it off, generation is stopped. The check runs even when automatic
 * applying is turned off, and only ever stops a guarded prompt from being on; it never blocks
 * because one is off.
 */
globalThis.presetSetsPreflight = async function (_chat, _contextSize, abort, _type) {
    if (!isReady()) {
        return;
    }

    let failure = null;

    try {
        await autoApply();
    } catch (error) {
        failure = error;
        console.error(LOG, 'Applying the set before generation failed', error);
    }

    const target = targetFor();
    const guarded = new Set(presetData()?.guarded || []);

    if (!target?.set) {
        if (target?.brokenLink && guarded.size) {
            abort(true);
            toastr.error(`Generation stopped: ${personaName()} is linked to "${target.brokenLink}", which no longer exists, and there is no set for unlinked personas.`, 'Preset Sets', { timeOut: 10000 });
        }
        return;
    }

    if (!guarded.size) {
        if (failure) {
            toastr.warning('The set could not be applied before generating. Check the prompt toggles.', 'Preset Sets');
        }
        return;
    }

    const wanted = new Set(target.set.ids);
    const wrong = readRows().filter(row => guarded.has(row.id) && row.enabled && !wanted.has(row.id));

    if (wrong.length) {
        abort(true);
        toastr.error(`Generation stopped: ${wrong.map(row => row.name).join(', ')} ${wrong.length === 1 ? 'is' : 'are'} switched on, but "${target.name}" has ${wrong.length === 1 ? 'it' : 'them'} off.`, 'Preset Sets', { timeOut: 10000 });
    }
};

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

async function chooseGuarded() {
    if (!isReady()) {
        toastr.warning('Load a Chat Completion preset first.', 'Preset Sets');
        return;
    }

    const data = presetData(currentPresetName(), true);
    const guarded = new Set(data.guarded);
    const rows = readRows();

    const content = document.createElement('div');
    content.classList.add('ps-guard-popup');

    const heading = document.createElement('h3');
    heading.textContent = 'Guarded prompts';

    const hint = document.createElement('div');
    hint.classList.add('opacity50p');
    hint.textContent = 'If a guarded prompt is switched on while the active set has it off, generation is stopped. Use it for anything that must never be on by mistake.';

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.classList.add('text_pole');
    filter.placeholder = 'Filter prompts';

    const list = document.createElement('div');
    list.classList.add('ps-guard-list');

    for (const row of rows) {
        const label = document.createElement('label');
        label.classList.add('checkbox_label');
        label.dataset.name = row.name.toLowerCase();

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = row.id;
        box.checked = guarded.has(row.id);

        const text = document.createElement('span');
        text.textContent = row.name;

        label.append(box, text);
        list.appendChild(label);
    }

    filter.addEventListener('input', () => {
        const query = filter.value.trim().toLowerCase();

        for (const label of list.children) {
            label.hidden = Boolean(query) && !label.dataset.name.includes(query);
        }
    });

    content.append(heading, hint, filter, list);

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });

    await popup.show();

    if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    // Guards for prompts this preset no longer lists are kept, in case they come back.
    const shown = new Set(rows.map(row => row.id));
    const kept = data.guarded.filter(id => !shown.has(id));
    const picked = [...list.querySelectorAll('input[type="checkbox"]')].filter(box => box.checked).map(box => box.value);

    data.guarded = [...kept, ...picked];
    saveSettingsDebounced();
    refreshUI();
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
        guarded: data.guarded,
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

    if (Array.isArray(payload.guarded)) {
        data.guarded = [...new Set([...data.guarded, ...payload.guarded.filter(id => typeof id === 'string')])];
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

    return parts.join(' ');
}

function refreshUI(selectName) {
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
    document.getElementById('ps_guard_count').textContent = `${data?.guarded?.length || 0} guarded`;
    document.getElementById('ps_status').textContent = describeState();

    /** @type {HTMLInputElement} */ (document.getElementById('ps_auto')).checked = settings.autoApply;
    /** @type {HTMLInputElement} */ (document.getElementById('ps_notify')).checked = settings.notify;

    const hasSet = names.length > 0;

    for (const id of ['ps_apply', 'ps_update', 'ps_rename', 'ps_delete']) {
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
                    <div id="ps_save_new" class="menu_button" title="Save the prompts switched on now as a new set">Save as new…</div>
                    <div id="ps_update" class="menu_button" title="Replace this set with the prompts switched on now">Update</div>
                    <div id="ps_rename" class="menu_button">Rename…</div>
                    <div id="ps_delete" class="menu_button redWarningBG">Delete</div>
                </div>
                <label for="ps_link">Set for <b id="ps_persona_name"></b> in this preset</label>
                <select id="ps_link" class="text_pole"></select>
                <label for="ps_default">Set for personas with no link</label>
                <select id="ps_default" class="text_pole"></select>
                <div class="ps-buttons">
                    <div id="ps_guard" class="menu_button" title="Prompts that stop generation if they are on when the active set has them off">Guarded prompts…</div>
                    <span id="ps_guard_count" class="opacity50p"></span>
                </div>
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
                    makes that set the preset's own defaults.
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
    $('#ps_guard').on('click', () => chooseGuarded());
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
    addSettingsPanel();
    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => autoApply());
    eventSource.on(event_types.PERSONA_CHANGED, () => autoApply());
    eventSource.on(event_types.CHAT_CHANGED, () => autoApply());

    // Switching presets reloads its saved toggles, so the persona's set for that preset is applied
    // again once the prompt manager has the new preset.
    eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => setTimeout(() => autoApply(), 0));

    if (event_types.PERSONA_DELETED) {
        eventSource.on(event_types.PERSONA_DELETED, onPersonaDeleted);
    }
});
