# One-shot migration of plugin config from the two predecessor plugins
# (advancedSceneRating and advancedPerformerRating) into this combined plugin.
#
# Old plugins both used the `apr_*` key namespace inside their own plugin
# config dict (the namespaces only didn't collide because they lived under
# different plugin IDs). The merged plugin disambiguates by prefix:
#   scene_*     ← migrated from advancedSceneRating
#   performer_* ← migrated from advancedPerformerRating
#
# Anything not matching `apr_*` (eg. legacy `disable_X` flags or
# `allow_destructive_actions`) is also forwarded with the same scene_/performer_
# prefix, except `allow_destructive_actions` which becomes a single shared flag
# (OR of the two old values).

NEW_PLUGIN_ID = "advancedRating"
OLD_SCENE_ID = "advancedSceneRating"
OLD_PERFORMER_ID = "advancedPerformerRating"

# Redundant predecessor config blocks to clear once their settings live under
# advancedRating. Stash's configurePlugin can only replace a block, not delete
# it, so the best we can do via the API is empty it to `{}` (a harmless stub).
# `stashAppAdvancedRating` is an even older orphan whose settings the merged
# plugin no longer reads.
LEGACY_PLUGIN_IDS = [OLD_SCENE_ID, OLD_PERFORMER_ID, "stashAppAdvancedRating"]

MIGRATION_FLAG = "migration_done"
SHARED_DESTRUCTIVE_KEY = "allow_destructive_actions"


def _clear_legacy_blocks(stash, all_plugins, log):
    """Empty any leftover predecessor config blocks to `{}`. Best-effort and
    idempotent: skips blocks that are already empty or absent."""
    for pid in LEGACY_PLUGIN_IDS:
        existing = all_plugins.get(pid)
        if not existing:
            continue
        try:
            stash.configure_plugin(pid, {})
            log.info(f"MIGRATE: Cleared leftover '{pid}' config block.")
        except Exception as e:
            log.error(f"MIGRATE: Failed to clear '{pid}' config: {e}")


def _rewrite_keys(src_config, prefix):
    """Return a new dict with each key from src_config rewritten under prefix.
    `apr_X` becomes `<prefix>X`; everything else (including legacy `disable_X`)
    becomes `<prefix><original_key>`. Skips the destructive-actions key (handled
    separately as a shared flag)."""
    out = {}
    if not isinstance(src_config, dict):
        return out
    for key, value in src_config.items():
        if key == SHARED_DESTRUCTIVE_KEY:
            continue
        if key.startswith("apr_"):
            new_key = f"{prefix}{key[len('apr_'):]}"
        else:
            new_key = f"{prefix}{key}"
        out[new_key] = value
    return out


def migrate(stash, log, force=False):
    """Idempotent. Reads old plugin configs from Stash, writes them into this
    plugin's config under namespaced keys, sets MIGRATION_FLAG to True. Returns
    True if migration ran (or was forced), False if skipped because already done
    or there was nothing to migrate."""
    try:
        all_plugins = (stash.get_configuration() or {}).get("plugins", {}) or {}
    except Exception as e:
        log.error(f"MIGRATE: Failed to read plugin configuration: {e}")
        return False

    own = all_plugins.get(NEW_PLUGIN_ID, {}) or {}
    if not force and own.get(MIGRATION_FLAG):
        # Already migrated, but earlier versions left the predecessor blocks
        # behind — clear them now so existing installs self-heal.
        _clear_legacy_blocks(stash, all_plugins, log)
        return False

    old_scene = all_plugins.get(OLD_SCENE_ID, {}) or {}
    old_performer = all_plugins.get(OLD_PERFORMER_ID, {}) or {}

    if not old_scene and not old_performer and not force:
        # Nothing to migrate, but still set the flag so future runs short-circuit.
        try:
            stash.configure_plugin(NEW_PLUGIN_ID, {MIGRATION_FLAG: True})
            log.info("MIGRATE: No legacy plugin configs found; marked migration_done.")
        except Exception as e:
            log.error(f"MIGRATE: Failed to set migration flag: {e}")
        _clear_legacy_blocks(stash, all_plugins, log)
        return False

    new_values = {}
    new_values.update(_rewrite_keys(old_scene, "scene_"))
    new_values.update(_rewrite_keys(old_performer, "performer_"))

    destructive = bool(old_scene.get(SHARED_DESTRUCTIVE_KEY)) or bool(old_performer.get(SHARED_DESTRUCTIVE_KEY))
    if destructive:
        new_values[SHARED_DESTRUCTIVE_KEY] = True

    new_values[MIGRATION_FLAG] = True

    try:
        stash.configure_plugin(NEW_PLUGIN_ID, new_values)
        log.info(
            f"MIGRATE: Imported {len(_rewrite_keys(old_scene, 'scene_'))} scene keys + "
            f"{len(_rewrite_keys(old_performer, 'performer_'))} performer keys "
            f"from legacy plugins."
        )
        _clear_legacy_blocks(stash, all_plugins, log)
        return True
    except Exception as e:
        log.error(f"MIGRATE: Failed to write merged config: {e}")
        return False
