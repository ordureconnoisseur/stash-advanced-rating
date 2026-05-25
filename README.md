# Advanced Rating

Rate Stash scenes **and** performers across configurable criteria. The overall Stash rating (`rating100`) is calculated as a weighted average of per-criterion tag scores, grouped into weight-balanced buckets.

This plugin supersedes two predecessor plugins:

- [stash-advanced-scene-rating](https://github.com/ordureconnoisseur/stash-advanced-scene-rating) (archived)
- `stash-advanced-performer-rating` — renamed to this repo, so its old URL redirects here

Existing settings from either predecessor are imported automatically the first time the plugin runs (see [Migration](#migration) below). Existing rating tags continue to work unchanged.

## Install

### Option 1 — Automatic (recommended)

1. In Stash go to **Settings → Plugins → Available Plugins → Add Source** and enter:
   ```
   https://ordureconnoisseur.github.io/plugins/main/index.yml
   ```
2. Find **Advanced Rating** in the plugin browser and click **Install**.
3. Open **Settings → Plugins → Advanced Rating** to configure groups/criteria and to trigger automatic migration from the old plugins.

### Option 2 — Manual

1. Download this repository (Code → Download ZIP) and extract it.
2. Place the extracted folder into your Stash plugins directory (e.g. `~/.stash/plugins/advancedRating/`).
3. In Stash: **Settings → Plugins → Reload Plugins**.
4. Open **Settings → Plugins → Advanced Rating** to configure groups/criteria and to trigger automatic migration from the old plugins.

## How it works

Each criterion has a Stash tag named `<Criterion Name> ★`, with child tags `<Criterion Name> ★: 0` through `<Criterion Name> ★: 5`. Tagging a scene or performer with `<Criterion> ★: 3` records a score of 3/5 for that criterion. The plugin's `Scene.Update.Post` / `Performer.Update.Post` hooks recompute the entity's overall rating as a weighted mean, mapped to Stash's `rating100` according to your configured star precision.

## Configuration

The settings panel (Settings → Plugins → Advanced Rating) is split into:

- **General** — rating precision (read from Stash's own Rating System setting) and a destructive-actions toggle (gates "Remove orphaned tags" and "Delete all rating tags").
- **Scenes** — groups, criteria, weights, descriptions, plus per-domain actions (Save, Recalculate all scenes, Reset to defaults, Remove orphaned tags, Delete all rating tags).
- **Performers** — same controls, scoped to performer rating tags.

Each domain stores config under its own key namespace (`scene_*` and `performer_*`) inside the single `advancedRating` plugin config, so the two domains stay independent.

## Migration

When the plugin first runs (either via a hook firing or via opening the settings panel), it imports settings from the two predecessor plugins:

| Source plugin                  | Migrates to                       |
|--------------------------------|-----------------------------------|
| `advancedSceneRating`          | `scene_*` keys under `advancedRating` |
| `advancedPerformerRating`      | `performer_*` keys under `advancedRating` |

The `allow_destructive_actions` flag is OR-ed from both old configs into a single shared flag. After migration, a `migration_done: true` flag is written so the import only happens once.

You can re-run the migration manually via the **Migrate Settings From Old Plugins** plugin task.

After migration:

- Existing rating tags continue to work unchanged — tag names (`Production Quality ★`, `Face ★`, etc.) are not renamed.
- The old plugins can be uninstalled at your convenience; their settings remain in Stash's config (unused) until you remove them manually.

## Hooks & tasks

| Hook trigger          | What runs                                       |
|-----------------------|-------------------------------------------------|
| `Scene.Update.Post`   | Recalculates that scene's `rating100`           |
| `Performer.Update.Post` | Recalculates that performer's `rating100`     |

Tasks available from **Settings → Tasks → Plugin Tasks**:

- **Process All Scenes** / **Process All Performers** — bulk recalculate
- **Create Scene Rating Tags** / **Create Performer Rating Tags** — pre-create the tag hierarchy
- **Remove Scene Rating Tags** / **Remove Performer Rating Tags** — destructive cleanup (requires `allow_destructive_actions`)
- **Migrate Settings From Old Plugins** — re-run the one-shot import

## Credits

Based on [stashapp-plugin-advanced-scene-ratings](https://github.com/shackofnoreturn/stashapp-plugin-advanced-scene-ratings) by **shackofnoreturn**. Licensed under AGPL v3.
