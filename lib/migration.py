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

MIGRATION_FLAG = "migration_done"
SHARED_DESTRUCTIVE_KEY = "allow_destructive_actions"


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
        return True
    except Exception as e:
        log.error(f"MIGRATE: Failed to write merged config: {e}")
        return False
