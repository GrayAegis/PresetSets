# Preset Sets

Named sets of prompt toggles inside one Chat Completion preset, linked to personas.

Keep one base preset with every module in it. Save the combinations you use as sets, such as
"DC: Street", "DC: Mei" or "SM: Manga", and link each persona to the set it should use. When you
update the base preset, every set picks up the changes, because a set only records which prompts
are switched on.

Works with any Chat Completion preset, including NemoEngine with NemoPresetExt.

## Install

Copy the `PresetSets` folder into `SillyTavern/public/scripts/extensions/third-party/`, then
reload SillyTavern.

The everyday controls sit under the Chat Completion preset list. Everything else is under
**Extensions → Preset Sets**.

## What a set is

A set is a list of the prompts that are switched on. Applying it switches those on and every
other toggleable prompt off. It never changes prompt text, prompt order, samplers or context
size, and it never writes to the preset file. Sets belong to the preset they were saved in.

## The bar under the preset list

The list shows the sets in this preset, with the one in use marked "(active)". The buttons are:

- ✓ **Apply**: apply the chosen set.
- ✎ **Edit**: choose which prompts the set switches on (see below).
- ⟳ **Update**: replace the set with the prompts switched on now. Hidden while the preset is
  locked.
- \+ **New**: make a new set, starting from the prompts switched on now.
- 🔗 **Link**: use the chosen set for the current persona in this preset. It lights up when the
  set is linked; click again to unlink.
- 🔒 **Lock**: lock or unlock the preset (see below).

The line underneath says which set applies to the persona and whether the toggles match it.

With **Apply the linked set automatically** on (in the Extensions panel), the persona's set is
applied when you change persona, open a chat, switch preset, and again just before each
generation. Personas with no link use the **Set for personas with no link**, if there is one.

## Editing a set

**Edit** opens the set's prompts grouped under the preset's own section headers, with on/total
counts for each section. You can search, or show only the prompts that are on.

Prompts that only work one at a time switch each other off here as they do in NemoPresetExt: one
Vex, one length, one tense and so on. This uses NemoPresetExt's `@mutual-exclusive-group` and
`@exclusive-with` markers in the prompt text.

Saving an edit to the set in use applies it straight away.

## Locking a preset

A locked preset only changes its toggles through sets:

- Switching a prompt by hand, whether with SillyTavern's switches or NemoPresetExt's trays and
  section toggles, is undone straight away with a notice.
- The preset's own **Update**, **Rename** and **Delete** buttons do nothing.
- Prompt text and order can still be edited, but can't be saved to the preset file.

To change the base preset itself, unlock it, make the change, save the preset, and lock it again.
Importing a new version of the preset over it still works while it is locked.

While locked, the toggles are held to the set applied last. If no set has been applied since the
preset was loaded, they are held to the preset's own saved toggles.

## Keep the base preset safe

If the extension is turned off, fails to load, or a persona has no set, the preset's own saved
toggles are what you get. Keep those saved toggles as the safe default, and put anything riskier
in a set.

Saving the preset while a set is applied saves that set's toggles as the preset's defaults. That
is what the lock prevents.

## After updating the base preset

- New prompts start off in every set. Use **Edit** to add them to the sets that should have them.
- If a set lists a prompt the preset no longer has, a warning names how many. Editing or updating
  the set clears it.
- Renaming the preset (while unlocked) carries its sets and persona links over to the new name.

## Moving sets

**Export sets** saves the current preset's sets and persona links to a file. **Import sets…**
always imports into the preset that is loaded now, so you can carry sets over to a renamed or new
copy of a preset. Sets with the same name are replaced.

## Slash commands

- `/presetset <name>` applies a set. With no name it lists the sets in the current preset.
- `/presetset-save <name>` saves the prompts switched on now as a set, replacing one with the same
  name.

## Console

`PresetSets.target()` shows which set applies right now, and `PresetSets.plan()` shows what
applying it would change, without changing anything.
