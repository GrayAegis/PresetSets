# Preset Sets

Named sets of prompt toggles inside one Chat Completion preset, linked to personas and character
cards.

Keep one preset with every prompt you use in it. Save the combinations you switch between as
sets, and link each persona or card to the set it should use. Sets can build on each other, so a
change made once reaches every set built on it.

Works with any Chat Completion preset. NemoPresetExt is not needed; if it's installed, Preset Sets
works alongside it.

## Install

In SillyTavern, open **Extensions → Install Extension** and paste:

```
https://github.com/GrayAegis/PresetSets
```

The everyday controls sit under the Chat Completion preset list. Everything else is under
**Extensions → Preset Sets**.

## Sets and modifiers

A **set** decides which prompts are switched on. Applying it switches those on and every other
toggleable prompt off. It never changes prompt text, prompt order, samplers or context size, and
it never writes to the preset file. Sets belong to the preset they were saved in.

A set can **build on** another set. It starts from everything that set switches on and stores only
its own differences. When the set it builds on changes, it follows, except for the prompts it
changed itself. For example:

```
Core
├─ Fantasy
│  ├─ Fantasy: Dark
│  └─ Fantasy: Romance   = Fantasy + [Romance]
└─ Modern
   └─ Modern: Romance    = Modern + [Romance]
```

A **modifier** is a list of changes on its own: switch these on, switch these off. Sets stack
modifiers on top of what they build on. Here, both romance sets use the same Romance modifier, so
changing it once changes both. A modifier can't be applied or linked by itself.

Prompts marked as only working one at a time keep working that way when layers combine: if a set
switches one on, any inherited prompt it excludes is switched off. This reads the
`@mutual-exclusive-group` and `@exclusive-with` markers in the prompt text, for presets that use
them.

## The bar under the preset list

The list shows the sets and modifiers in this preset, with the set in use marked "(active)". The
buttons are:

- ✓ **Apply**: apply the chosen set.
- ✎ **Edit**: change the chosen set or modifier (see below).
- ⟳ **Update**: make the set switch on exactly the prompts that are on now. Hidden while the
  preset is locked.
- \+ **New**: make a new set or modifier, starting from the prompts switched on now.
- 🔗 **Link**: choose where the set is used (see below). It lights up when the set is linked for
  the current persona or card.
- 🔒 **Lock**: lock or unlock the preset (see below).

The line underneath says which set applies, why, and whether the toggles match it.

## Editing

**Edit** opens the prompts grouped under the preset's own section headers, with on/total counts
for each section. You can search, and choose what to show: everything, only what's switched on,
only what this set changes, or only what differs from another set you pick under
**Compare with…**.

For a set, choose what it **builds on** and which **modifiers** it uses, then tick the prompts it
should switch on. Only the differences are stored. A dot marks each prompt this set changes; click
the dot to follow the base again, or use **Follow all** to undo every change. Changing what a set
builds on keeps its current toggles and works out the differences again.

For a modifier, each prompt cycles between **–** (leave alone), **On** and **Off**.

Saving a change to the set in use, or to anything it builds on, applies it straight away. The
editor lists the sets a change will also reach.

## Links

A set can be linked to:

- a **persona**, wherever it's used;
- a **character card** (or group chat), for any persona without a link of its own;
- a **persona with a card**, for that pairing only.

The most specific link wins: persona with card, then persona, then card. If none applies, the
**Set for anything without a link** is used, if there is one. A link to a set that no longer
exists is skipped.

With **Apply the linked set automatically** on, the linked set is applied when you change persona,
open a chat, switch preset, and again just before each generation.

## Locking a preset

A locked preset only changes its toggles through sets:

- Switching a prompt by hand is undone straight away with a notice. This includes other
  extensions' prompt switches, such as NemoPresetExt's.
- The preset's own **Update**, **Rename** and **Delete** buttons do nothing.
- Prompt text and order can still be edited, but can't be saved to the preset file.

To change the preset itself, unlock it, make the change, save the preset, and lock it again.
Importing a new version of the preset over it still works while it is locked.

While locked, the toggles are held to the set applied last. If no set has been applied since the
preset was loaded, they are held to the preset's own saved toggles.

## When the preset gains new prompts

When a preset has prompts it didn't have last time, for example after importing a new version,
Preset Sets asks which sets or modifiers each new prompt should be on in. Ticking a set also
reaches everything built on it. Anything left unticked stays off everywhere. Choose **Ask me
later** to decide next time the preset loads.

If a set lists a prompt the preset no longer has, a warning says how many. Editing or updating the
set clears it.

## Keep the preset's own toggles safe

If the extension is turned off, fails to load, or nothing is linked, the preset's own saved
toggles are what you get. Keep those as a safe default, and put anything riskier in a set.

Saving the preset while a set is applied saves that set's toggles as the preset's defaults. That
is what the lock prevents.

## Renaming and deleting

Renaming a set or modifier updates everything that uses it, including links. Deleting one keeps
every other set switching on exactly what it did: sets built on a deleted set move to what it
built on, and sets using a deleted modifier have its changes worked into their own. **Delete
several…** in the Extensions panel deletes any number at once. Renaming the preset (while
unlocked) carries its sets and links over to the new name.

## Moving sets

**Export sets** saves the current preset's sets, modifiers and links to a file. **Import sets…**
always imports into the preset that is loaded now, so you can carry sets over to a renamed or new
copy of a preset. If the preset already has sets, you choose to **Replace all** of them with the
file's, or **Add to them**, which replaces only sets with the same name. Links to sets that are
replaced away are removed. Files from older versions of Preset Sets import as sets that build on
nothing.

## Slash commands

- `/presetset <name>` applies a set. With no name it lists the sets in the current preset.
- `/presetset-save <name>` makes the set switch on the prompts that are on now. A new name makes a
  new set; an existing set keeps what it builds on.

## Console

`PresetSets.target()` shows which set applies right now and why, `PresetSets.plan()` shows what
applying it would change without changing anything, and `PresetSets.problems()` lists any sets
that build on something missing or on each other.
