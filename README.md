# Preset Sets

Named sets of prompt toggles inside one Chat Completion preset, linked to personas.

Keep one base preset with every module in it. Save the combinations you use as sets, such as
"DC: Street", "DC: Mei" or "SM: Manga", and link each persona to the set it should use. When you
update the base preset, every set picks up the changes, because a set only records which prompts
are switched on.

Works with any Chat Completion preset, including NemoEngine with NemoPresetExt.

## Install

Copy the `PresetSets` folder into `SillyTavern/public/scripts/extensions/third-party/`, then
reload SillyTavern. The panel is under **Extensions → Preset Sets**.

## What a set is

A set is a list of the prompts that are switched on. Applying it switches those on and every
other toggleable prompt off. It never changes prompt text, prompt order, samplers or context
size, and it never writes to the preset file. Sets belong to the preset they were saved in.

## Using it

1. Load the preset and switch prompts on and off the way you want them.
2. **Save as new…** and give the set a name.
3. Repeat for each combination you use.
4. With a persona selected, choose its set under **Set for <persona> in this preset**.
5. Optionally choose a **Set for personas with no link**. This is what applies when the persona
   has no link of its own.

With **Apply the linked set automatically** on, the persona's set is applied when you change
persona, open a chat, switch preset, and again just before each generation.

**Apply** applies the selected set by hand. **Update** replaces the selected set with the prompts
switched on now.

## Guarded prompts

**Guarded prompts…** lets you mark prompts that must never be on by mistake. Before each
generation, if a guarded prompt is switched on while the active set has it off, generation is
stopped with a message naming the prompt.

The check only ever stops a guarded prompt from being on. It runs even when automatic applying is
off. It also stops generation if the persona is linked to a set that no longer exists, there is
no set for unlinked personas, and the preset has guarded prompts.

## Keep the base preset safe

If the extension is turned off, fails to load, or a persona has no set, the preset's own saved
toggles are what you get. Keep those saved toggles as the safe default, and put anything riskier
in a set.

Saving the preset while a set is applied saves that set's toggles as the preset's defaults. If
you mean to update the base preset's text or modules, apply the safe set first, then save.

## After updating the base preset

- New prompts start off in every set until you add them with **Update**.
- If a set lists a prompt the preset no longer has, a warning names how many. **Update** the set
  to clear it.
- The status line at the bottom of the panel shows which set applies and whether the toggles
  currently match it.

## Moving sets

**Export sets** saves the current preset's sets, its guarded prompts and its persona links to a
file. **Import sets…** always imports into the preset that is loaded now, so you can carry sets
over to a renamed or new copy of a preset. Sets with the same name are replaced.

## Slash commands

- `/presetset <name>` applies a set. With no name it lists the sets in the current preset.
- `/presetset-save <name>` saves the prompts switched on now as a set, replacing one with the same
  name.

## Console

`PresetSets.target()` shows which set applies right now, and `PresetSets.plan()` shows what
applying it would change, without changing anything.
