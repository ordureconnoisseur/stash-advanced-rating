# Advanced Rating — combined plugin (scene + performer).
# Replaces stash-advanced-scene-rating and stash-advanced-performer-rating.
# Based on stashapp-plugin-advanced-scene-ratings by shackofnoreturn
# Original: https://github.com/shackofnoreturn/stashapp-plugin-advanced-scene-ratings
# License: AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

import os
import sys
import json

try:
    import stashapi.log as log
    from stashapi.stashapp import StashInterface
except ModuleNotFoundError:
    import subprocess
    import importlib
    import site
    _installed = False
    for flags in [[], ["--break-system-packages"], ["--user"]]:
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "stashapp-tools", "--quiet", "--timeout", "5"] + flags
            )
            _installed = True
            break
        except subprocess.CalledProcessError:
            continue
    if _installed:
        importlib.invalidate_caches()
        user_site = site.getusersitepackages()
        if user_site not in sys.path:
            sys.path.insert(0, user_site)
    else:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor"))
    import stashapi.log as log
    from stashapi.stashapp import StashInterface

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
import rating_core as core
import migration as migration_mod

PLUGIN_ID = "advancedRating"

# Scene domain
SCENE_PREFIX = "scene_"
SCENE_TAG_PARENT = {
    "name": "Advanced Rating System",
    "sort_name": "#Advanced Rating System",
    "description": "Advanced Rating System",
    "auto_ignore_tag": True,
    "image": core.SVG_TAG_IMG,
}
SCENE_DEFAULT_GROUPS = [
    {"id": "overall", "name": "Overall", "weight": 1.0},
]
SCENE_DEFAULT_CRITERIA = [
    {"id": "production_quality", "name": "Production Quality", "group": "overall", "weight": 1.0, "enabled": True, "legacy_key": "disable_production_quality"},
    {"id": "chemistry",          "name": "Chemistry",          "group": "overall", "weight": 1.0, "enabled": True, "legacy_key": "disable_chemistry"},
    {"id": "performance",        "name": "Performance",        "group": "overall", "weight": 1.0, "enabled": True, "legacy_key": "disable_performance"},
    {"id": "aesthetics",         "name": "Aesthetics",         "group": "overall", "weight": 1.0, "enabled": True, "legacy_key": "disable_aesthetics"},
    {"id": "creativity",         "name": "Creativity",         "group": "overall", "weight": 1.0, "enabled": True, "legacy_key": "disable_creativity"},
]

# Performer domain
PERFORMER_PREFIX = "performer_"
PERFORMER_TAG_PARENT = {
    "name": "Advanced Performer Rating",
    "sort_name": "#Advanced Performer Rating",
    "description": "Advanced Performer Rating System",
    "auto_ignore_tag": True,
    "image": core.SVG_TAG_IMG,
}
PERFORMER_DEFAULT_GROUPS = [
    {"id": "physical",    "name": "Physical",    "weight": 1.0},
    {"id": "performance", "name": "Performance", "weight": 1.0},
]
PERFORMER_DEFAULT_CRITERIA = [
    {"id": "face",       "name": "Face",              "group": "physical",    "weight": 1.0, "enabled": True, "legacy_key": "disable_face"},
    {"id": "breasts",    "name": "Breasts",           "group": "physical",    "weight": 1.0, "enabled": True, "legacy_key": "disable_breasts"},
    {"id": "ass",        "name": "Ass",               "group": "physical",    "weight": 1.0, "enabled": True, "legacy_key": "disable_ass"},
    {"id": "body",       "name": "Body Overall",      "group": "physical",    "weight": 1.0, "enabled": True, "legacy_key": "disable_body_overall"},
    {"id": "genitals",   "name": "Genitals",          "group": "physical",    "weight": 1.0, "enabled": True, "legacy_key": "disable_genitals"},
    {"id": "technique",  "name": "Technique",         "group": "performance", "weight": 1.0, "enabled": True, "legacy_key": "disable_technique"},
    {"id": "energy",     "name": "Energy & Presence", "group": "performance", "weight": 1.0, "enabled": True, "legacy_key": "disable_energy_presence"},
    {"id": "sluttiness", "name": "Sluttiness",        "group": "performance", "weight": 1.0, "enabled": True, "legacy_key": "disable_sluttiness"},
]


def read_stdin_json():
    try:
        raw_input = sys.stdin.read()
        if not raw_input.strip():
            raise ValueError("No input received from stdin")
        return json.loads(raw_input)
    except (json.JSONDecodeError, ValueError) as e:
        log.error(f"READ STDIN JSON: {e}")
    return {}


def connect_to_stash(json_input):
    try:
        return StashInterface(json_input["server_connection"])
    except KeyError:
        log.error("STASH INTERFACE: Missing 'server_connection' in input.")
    except Exception as e:
        log.error(f"STASH INTERFACE: Failed to connect: {e}")
    return None


def load_settings(stash):
    try:
        plugins = stash.get_configuration().get("plugins", {}) or {}
    except Exception as e:
        log.error(f"PLUGIN CONFIGURATION: Failed to load: {e}")
        return {}
    own = plugins.get(PLUGIN_ID, {}) or {}
    return dict(own)


def load_domain(settings, defaults_groups, defaults_criteria, prefix):
    groups = core.load_groups(settings, defaults_groups, prefix)
    criteria = core.load_criteria(settings, defaults_criteria, groups, prefix)
    return groups, criteria


def handle_scene_hook(stash, hook, settings, precision):
    scene_id = hook.get("id") or hook.get("input", {}).get("id")
    if not scene_id:
        log.error("HANDLE HOOKS: Missing scene ID in hook context.")
        return
    scene = stash.find_scene(scene_id, fragment="id title rating100 tags { id name }")
    if not scene:
        log.error(f"HANDLE HOOKS: Scene {scene_id} not found.")
        return
    groups, criteria = load_domain(settings, SCENE_DEFAULT_GROUPS, SCENE_DEFAULT_CRITERIA, SCENE_PREFIX)
    new_rating = core.calculate_rating(scene, criteria, groups, precision, log)
    if new_rating is None:
        return
    current = scene.get("rating100") or 0
    if current != new_rating:
        try:
            stash.update_scene({"id": scene["id"], "rating100": new_rating})
            log.info(f"Updating Scene {scene.get('title', scene['id'])} rating to {new_rating}/100")
        except Exception as e:
            log.error(f"CALCULATE RATING: Failed to update scene {scene.get('id', '?')}: {e}")


def handle_performer_hook(stash, hook, settings, precision):
    performer_id = hook.get("id") or hook.get("input", {}).get("id")
    if not performer_id:
        log.error("HANDLE HOOKS: Missing performer ID in hook context.")
        return
    performer = stash.find_performer(performer_id)
    if not performer:
        log.error(f"HANDLE HOOKS: Performer {performer_id} not found.")
        return
    groups, criteria = load_domain(settings, PERFORMER_DEFAULT_GROUPS, PERFORMER_DEFAULT_CRITERIA, PERFORMER_PREFIX)
    new_rating = core.calculate_rating(performer, criteria, groups, precision, log)
    if new_rating is None:
        return
    current = performer.get("rating100") or 0
    if current != new_rating:
        try:
            stash.update_performer({"id": performer["id"], "rating100": new_rating})
            log.info(f"Updating Performer {performer.get('name', performer['id'])} rating to {new_rating}/100")
        except Exception as e:
            log.error(f"CALCULATE RATING: Failed to update performer {performer.get('id', '?')}: {e}")


def process_all_scenes(stash, settings, precision):
    log.info("PROCESSING ALL SCENES")
    try:
        scenes = stash.find_scenes({}, get_count=False, fragment="id title rating100 tags { id name }")
    except Exception as e:
        log.error(f"PROCESS SCENES: Failed to fetch scenes: {e}")
        return
    groups, criteria = load_domain(settings, SCENE_DEFAULT_GROUPS, SCENE_DEFAULT_CRITERIA, SCENE_PREFIX)
    total = len(scenes)
    log.info(f"PROCESS SCENES: Found {total} scenes")
    for scene in scenes:
        try:
            new_rating = core.calculate_rating(scene, criteria, groups, precision, log)
            if new_rating is None:
                continue
            current = scene.get("rating100") or 0
            if current != new_rating:
                stash.update_scene({"id": scene["id"], "rating100": new_rating})
        except Exception as e:
            log.error(f"PROCESS SCENES: Failed on scene {scene.get('id', '?')}: {e}")
    log.info(f"PROCESS SCENES: Done ({total} processed)")


def process_all_performers(stash, settings, precision):
    log.info("PROCESSING ALL PERFORMERS")
    try:
        performers = stash.find_performers({}, get_count=False, fragment="id name rating100 tags { id name }")
    except Exception as e:
        log.error(f"PROCESS PERFORMERS: Failed to fetch performers: {e}")
        return
    groups, criteria = load_domain(settings, PERFORMER_DEFAULT_GROUPS, PERFORMER_DEFAULT_CRITERIA, PERFORMER_PREFIX)
    total = len(performers)
    log.info(f"PROCESS PERFORMERS: Found {total} performers")
    for p in performers:
        try:
            new_rating = core.calculate_rating(p, criteria, groups, precision, log)
            if new_rating is None:
                continue
            current = p.get("rating100") or 0
            if current != new_rating:
                stash.update_performer({"id": p["id"], "rating100": new_rating})
        except Exception as e:
            log.error(f"PROCESS PERFORMERS: Failed on performer {p.get('id', '?')}: {e}")
    log.info(f"PROCESS PERFORMERS: Done ({total} processed)")


def handle_actions(json_input, stash, settings, precision):
    args = json_input.get("args", {})
    mode = args.get("mode")
    if mode == "process_scenes":
        process_all_scenes(stash, settings, precision)
    elif mode == "process_performers":
        process_all_performers(stash, settings, precision)
    elif mode == "create_scene_tags":
        _, criteria = load_domain(settings, SCENE_DEFAULT_GROUPS, SCENE_DEFAULT_CRITERIA, SCENE_PREFIX)
        core.create_tags(stash, SCENE_TAG_PARENT, [c for c in criteria if c["enabled"]], log)
    elif mode == "create_performer_tags":
        _, criteria = load_domain(settings, PERFORMER_DEFAULT_GROUPS, PERFORMER_DEFAULT_CRITERIA, PERFORMER_PREFIX)
        core.create_tags(stash, PERFORMER_TAG_PARENT, [c for c in criteria if c["enabled"]], log)
    elif mode == "remove_scene_tags":
        _, criteria = load_domain(settings, SCENE_DEFAULT_GROUPS, SCENE_DEFAULT_CRITERIA, SCENE_PREFIX)
        core.remove_tags(stash, SCENE_TAG_PARENT, criteria,
                         core.coerce_bool(settings.get("allow_destructive_actions"), False), log)
    elif mode == "remove_performer_tags":
        _, criteria = load_domain(settings, PERFORMER_DEFAULT_GROUPS, PERFORMER_DEFAULT_CRITERIA, PERFORMER_PREFIX)
        core.remove_tags(stash, PERFORMER_TAG_PARENT, criteria,
                         core.coerce_bool(settings.get("allow_destructive_actions"), False), log)
    elif mode == "migrate":
        migration_mod.migrate(stash, log, force=True)


def handle_hooks(json_input, stash, settings, precision):
    try:
        args = json_input.get("args", {})
        hook = args.get("hookContext", {}) or {}
        hook_type = hook.get("type")
        if hook_type == "Scene.Update.Post":
            handle_scene_hook(stash, hook, settings, precision)
        elif hook_type == "Performer.Update.Post":
            handle_performer_hook(stash, hook, settings, precision)
    except Exception as e:
        log.error(f"HANDLE HOOKS: Unexpected error: {e}")


def main():
    log.info("RUNNING ...")
    json_input = read_stdin_json()
    stash = connect_to_stash(json_input)
    if not stash:
        return

    migration_mod.migrate(stash, log)

    settings = load_settings(stash)
    precision = core.get_rating_precision(stash, log)

    handle_actions(json_input, stash, settings, precision)
    handle_hooks(json_input, stash, settings, precision)


if __name__ == "__main__":
    main()
