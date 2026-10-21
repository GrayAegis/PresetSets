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

The list shows the sets and modifiers in this preset, each by name first, then what it's made of in
the order things apply: `Fantasy: Romance (Base + Fantasy + [Romance])` is Base, then Fantasy, then
the Romance modifier, then the set's own changes. Modifiers are in square brackets, and show what
they were made against: `[Persona] (made against Base + [World])`. The list is sorted like the
tree, so each set sits under what it builds on. The set and modifier in use are marked with ●. The
buttons are:

- ✓ **Apply**: apply the chosen set.
- ✎ **Edit**: change the chosen set or modifier (see below).
- ⟳ **Update**: make the set switch on exactly the prompts that are on now. Hidden while the
  preset is locked.
- \+ **New**: make a new set or modifier.
- 🔗 **Links**: choose the stack for this chat's card and for this persona (see below). It lights
  up when either has a link.
- 🔒 **Lock**: lock or unlock the preset (see below).

The line underneath says which set applies, why, and whether the toggles match it.

## Editing

**Edit** opens the prompts grouped under the preset's own section headers, with on/total counts
for each section. Hover over a prompt to see its description (its `@tooltip` marker, or the start
of its text). You can search, and choose what to show: everything, only what's switched on,
only what this set changes, or only what differs from another set you pick under
**Compare with…**.

For a set, choose what it **builds on** (each choice shows what it's made of, such as `Fantasy (Base)`)
and which **modifiers** it uses, then tick the prompts it should switch on or off on top. A new set
starts from exactly what it builds on, so building on Base and ticking a modifier shows Base plus
that modifier, ready for your own changes. Only the differences are stored. A dot marks each
prompt this set changes; click the dot to follow the base again, or use **Follow all** to undo
every change. **Start from what's on now** ticks exactly the prompts switched on at the moment.

Changing what a set builds on, or its modifiers, keeps the changes made in the set itself;
everything else follows the new layers. Modifiers apply in the order they were ticked, shown as
1, 2, 3; where two disagree, the later one wins. Untick a modifier and tick it again to move it
last.

For a modifier, each prompt cycles between **–** (leave alone), **On** and **Off**. Choose what the
modifier is **made against**: a set (or the preset's own toggles), and under **After**, any modifiers
it is meant to go after, in order. Each prompt then shows whether it is on or off there already,
and a change that matches, such as switching on something already on, is dimmed since it does
nothing there. What it's made against is saved with the modifier and decides where it is listed,
so `[Persona] (made against Base + [World])` sits right after `[World]`. It never changes what the modifier
does: a set still ticks each modifier it uses.

Saving a change to the set in use, or to anything it builds on, applies it straight away. The
editor lists the sets a change will also reach.

## Links

Each chat's card and each persona can be linked to a **stack**: a set, then any modifiers in order.
What applies is built from both:

1. **the set**: the persona's, if its stack has one; otherwise the card's; otherwise the **Set for
   anything without a link** (or the preset's own toggles if there is none);
2. **then the card's modifiers**, in order;
3. **then the persona's modifiers**, in order.

So the card brings the world and the persona brings itself. Link a fantasy card to
`Base + [Fantasy]` and a persona to `[Wren]`, and that chat gets `Base + [Fantasy] + [Wren]`. Open a
modern card linked to `Base + [Modern]` with the same persona, and you get `Base + [Modern] + [Wren]`,
with no named set for either combination. Named sets are still there for anything you'd rather
pin as one piece. Links to sets or modifiers that no longer exist are skipped.

Press 🔗 on the bar (or **Edit links…** in the Extensions panel) to set both stacks for the chat
that's open; it shows what you'll get before you save. Applying a set by hand with ✓ applies just
that set, without any modifiers from links, and lasts until the next automatic apply: a persona
or chat change, a preset switch, or the next message.

With **Apply the linked set automatically** on, links are applied when you change persona, open a
chat, switch preset, and again just before each generation.

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
