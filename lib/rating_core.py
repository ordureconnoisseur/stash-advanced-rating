# Shared logic for Advanced Rating plugin (scene + performer).
# Domain-agnostic: caller passes in entity-specific defaults, settings prefix,
# and tag-parent definition.

import re

TAG_PATTERN = re.compile(r"^(.+?)\s*:\s*([0-5])$")
TAG_SUFFIX = " ★"

SVG_TAG_IMG = (
    "data:image/svg+xml;base64,PCFET0NUWVBFIHN2ZyBQVUJMSUMgIi0vL1czQy8vRFREIFNWRyAxLjEvL0VOIi"
    "AiaHR0cDovL3d3dy53My5vcmcvR3JhcGhpY3MvU1ZHLzEuMS9EVEQvc3ZnMTEuZHRkIj4KDTwhLS0gVXBsb2FkZW"
    "QgdG86IFNWRyBSZXBvLCB3d3cuc3ZncmVwby5jb20sIFRyYW5zZm9ybWVkIGJ5OiBTVkcgUmVwbyBNaXhlciBUb2"
    "9scyAtLT4KPHN2ZyB3aWR0aD0iODAwcHgiIGhlaWdodD0iODAwcHgiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD"
    "0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KDTxnIGlkPSJTVkdSZXBvX2JnQ2Fycm"
    "llciIgc3Ryb2tlLXdpZHRoPSIwIi8+Cg08ZyBpZD0iU1ZHUmVwb190cmFjZXJDYXJyaWVyIiBzdHJva2UtbGluZW"
    "NhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KDTxnIGlkPSJTVkdSZXBvX2ljb25DYXJyaWVyIj"
    "4gPHBhdGggZD0iTTUuNjM2MDUgNS42MzYwNUwxOC4zNjQgMTguMzY0TTUuNjM2MDUgMTguMzY0TDE4LjM2NCA1Lj"
    "YzNjA1TTIxIDEyQzIxIDE2Ljk3MDYgMTYuOTcwNiAyMSAxMiAyMUM3LjAyOTQ0IDIxIDMgMTYuOTcwNiAzIDEyQz"
    "MgNy4wMjk0NCA3LjAyOTQ0IDMgMTIgM0MxNi45NzA2IDMgMjEgNy4wMjk0NCAyMSAxMloiIHN0cm9rZT0iI2ZmZm"
    "ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPiA8L2c+Cg08L3N2Zz4="
)

STAR_PRECISION_MAP = {"FULL": 20, "HALF": 10, "QUARTER": 5, "TENTH": 1}
MINIMUM_REQUIRED_TAGS = 1


def coerce_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    if isinstance(value, (int, float)):
        return value != 0
    return default


def coerce_float(value, default=1.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def get_rating_precision(stash, log):
    """STARS: FULL→20, HALF→10, QUARTER→5, TENTH→1 (default FULL).
    DECIMAL: 1, since rating100 is stored in single-unit steps."""
    try:
        config = stash.get_configuration() or {}
        ui = config.get("ui") or {}
        rso = ui.get("ratingSystemOptions") or {}
        type_ = (rso.get("type") or "").upper()
        sp = (rso.get("starPrecision") or "").upper()
        if type_ == "DECIMAL":
            return 1
        return STAR_PRECISION_MAP.get(sp, 20)
    except Exception as e:
        log.warning(f"GET RATING PRECISION: Falling back to 20: {e}")
        return 20


def load_groups(settings, default_groups, prefix):
    """Build groups from `<prefix>group_*` settings, falling back to defaults."""
    raw_ids = settings.get(f"{prefix}group_ids")
    if not raw_ids or not isinstance(raw_ids, str):
        return [dict(g) for g in default_groups]
    ids = [s.strip() for s in raw_ids.split(",") if s.strip()]
    result = []
    for gid in ids:
        default = next((d for d in default_groups if d["id"] == gid), None)
        name = settings.get(f"{prefix}group_name_{gid}") or (default["name"] if default else gid.title())
        weight = coerce_float(settings.get(f"{prefix}group_weight_{gid}"), default["weight"] if default else 1.0)
        result.append({"id": gid, "name": name, "weight": weight})
    return result or [dict(g) for g in default_groups]


def load_criteria(settings, default_criteria, groups, prefix):
    """Build criteria from `<prefix>*` keys; fall back to defaults (with legacy
    `<prefix>disable_X` flags honored) when the new schema isn't configured."""
    valid_group_ids = {g["id"] for g in groups}
    fallback_group = groups[0]["id"] if groups else (default_criteria[0]["group"] if default_criteria else "overall")

    raw_ids = settings.get(f"{prefix}criteria_ids")
    if not raw_ids or not isinstance(raw_ids, str):
        return _criteria_from_legacy_defaults(settings, default_criteria, valid_group_ids, fallback_group, prefix)

    ids = [s.strip() for s in raw_ids.split(",") if s.strip()]
    result = []
    for cid in ids:
        default = next((d for d in default_criteria if d["id"] == cid), None)
        name = settings.get(f"{prefix}name_{cid}") or (default["name"] if default else cid.title())
        group = settings.get(f"{prefix}group_{cid}") or (default["group"] if default else fallback_group)
        if group not in valid_group_ids:
            group = fallback_group
        weight = coerce_float(settings.get(f"{prefix}weight_{cid}"), default["weight"] if default else 1.0)
        enabled = coerce_bool(settings.get(f"{prefix}enabled_{cid}"), default["enabled"] if default else True)
        result.append({"id": cid, "name": name, "group": group, "weight": weight, "enabled": enabled})
    return result


def _criteria_from_legacy_defaults(settings, default_criteria, valid_group_ids, fallback_group, prefix):
    out = []
    for d in default_criteria:
        # Migrated legacy keys live under `<prefix>disable_X`; pre-migration
        # configs (handled at install time by migration.py) won't reach here.
        legacy_key = d.get("legacy_key")
        legacy_disabled = coerce_bool(settings.get(f"{prefix}{legacy_key}") if legacy_key else None, False)
        group = d["group"] if d["group"] in valid_group_ids else fallback_group
        out.append({
            "id": d["id"],
            "name": d["name"],
            "group": group,
            "weight": d["weight"],
            "enabled": d["enabled"] and not legacy_disabled,
        })
    return out


def tag_prefix(criterion):
    return f"{criterion['name']}{TAG_SUFFIX}"


def calculate_rating(entity, criteria, groups, precision, log):
    """Compute new rating100 from tag matches; return int or None if no change is
    appropriate. Caller decides whether to push the update."""
    enabled = [c for c in criteria if c["enabled"]]
    if not enabled:
        return None
    by_prefix = {tag_prefix(c): c for c in enabled}

    hits_by_group = {g["id"]: [] for g in groups}
    tags = [tag["name"] for tag in (entity.get("tags") or [])]
    for tag in tags:
        match = TAG_PATTERN.match(tag)
        if not match:
            continue
        category, score = match.groups()
        category = category.strip()
        c = by_prefix.get(category)
        if not c:
            continue
        bucket = hits_by_group.get(c["group"])
        if bucket is None:
            continue
        bucket.append((int(score), float(c["weight"])))

    total_hits = sum(len(h) for h in hits_by_group.values())
    if total_hits < MINIMUM_REQUIRED_TAGS:
        return None

    def weighted_avg(hits):
        tw = sum(w for _, w in hits)
        if tw <= 0:
            return None
        return sum(s * w for s, w in hits) / tw

    contributions = []
    for g in groups:
        gavg = weighted_avg(hits_by_group.get(g["id"], []))
        if gavg is None:
            continue
        gw = float(g.get("weight", 1.0))
        if gw <= 0:
            continue
        contributions.append((gavg, gw))
    if not contributions:
        return None
    total_gw = sum(w for _, w in contributions)
    final_avg = sum(a * w for a, w in contributions) / total_gw

    precision = max(1, precision)
    final_rating100 = round(round(final_avg * 20 / precision) * precision)
    final_rating100 = max(precision, min(100, final_rating100))
    log.debug(f"AVERAGE: {final_avg:.2f}/5, NEW: {final_rating100}/100")
    return final_rating100


def find_tag(stash, name, log, create=False, parent_id=None):
    try:
        tag = stash.find_tag(name, create=False)
    except Exception as e:
        log.error(f"FIND TAG: Error searching for '{name}': {e}")
        return None
    if tag is None and create:
        try:
            tag = stash.create_tag({"name": name})
            if tag:
                update_data = {"id": tag["id"], "ignore_auto_tag": True}
                if parent_id:
                    update_data["parent_ids"] = [parent_id]
                stash.update_tag(update_data)
            else:
                log.error(f"FIND TAG: Failed to create '{name}'")
        except Exception as e:
            log.error(f"FIND TAG: Error creating '{name}': {e}")
            tag = None
    return tag


def create_tags(stash, tag_parent_def, criteria, log):
    log.info("CREATING TAGS ...")
    root_tag = find_tag(stash, tag_parent_def["name"], log, create=True)
    if not root_tag:
        log.error("CREATE TAGS: Failed to create or retrieve root tag.")
        return
    parent_id = root_tag["id"]
    for c in criteria:
        prefix = tag_prefix(c)
        cat_tag = find_tag(stash, prefix, log, create=True, parent_id=parent_id)
        if not cat_tag:
            log.error(f"CREATE TAGS: Failed to create '{prefix}', skipping.")
            continue
        cat_id = cat_tag["id"]
        for i in range(0, 6):
            num_tag_name = f"{prefix}: {i}"
            if not find_tag(stash, num_tag_name, log, create=True, parent_id=cat_id):
                log.error(f"CREATE TAGS: Failed to create subtag '{num_tag_name}'")


def remove_tags(stash, tag_parent_def, criteria, allow_destructive, log):
    log.info("REMOVING TAGS ...")
    if not allow_destructive:
        log.warning("REMOVE TAGS: Destructive actions disabled.")
        return

    def _remove(name):
        try:
            tag = stash.find_tag(name)
            if tag:
                stash.destroy_tag(tag["id"])
        except Exception as e:
            log.error(f"REMOVE TAG: Failed to remove '{name}': {e}")

    for c in criteria:
        prefix = tag_prefix(c)
        for i in range(0, 6):
            _remove(f"{prefix}: {i}")
        _remove(prefix)
    _remove(tag_parent_def["name"])
