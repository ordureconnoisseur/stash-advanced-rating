// Based on stashapp-plugin-advanced-scene-ratings by shackofnoreturn
// Original: https://github.com/shackofnoreturn/stashapp-plugin-advanced-scene-ratings
// License: AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html

(function () {
    const PLUGIN_ID = "advancedPerformerRating";
    const TAG_SUFFIX = " ★";
    const CATEGORY_PATTERN = /^(.+?)\s*:\s*([0-5])$/;
    let pollTimer = null;

    /* ── Defaults & descriptions ─────────────────────────────────────── */
    /* Kept in lockstep with DEFAULT_CRITERIA in advancedPerformerRating.py.
       Descriptions are keyed by stable slug, not display name, so renamed
       criteria keep their tooltip and user-added criteria show nothing. */
    const DEFAULT_GROUPS = [
        { id: "physical",    name: "Physical",    weight: 1 },
        { id: "performance", name: "Performance", weight: 1 },
    ];
    const DEFAULT_CRITERIA = [
        { id: "face",       name: "Face",              group: "physical",    weight: 1, enabled: true },
        { id: "breasts",    name: "Breasts",           group: "physical",    weight: 1, enabled: true },
        { id: "ass",        name: "Ass",               group: "physical",    weight: 1, enabled: true },
        { id: "body",       name: "Body Overall",      group: "physical",    weight: 1, enabled: true },
        { id: "genitals",   name: "Genitals",          group: "physical",    weight: 1, enabled: true },
        { id: "technique",  name: "Technique",         group: "performance", weight: 1, enabled: true },
        { id: "energy",     name: "Energy & Presence", group: "performance", weight: 1, enabled: true },
        { id: "sluttiness", name: "Sluttiness",        group: "performance", weight: 1, enabled: true },
    ];
    const LEGACY_DISABLE_KEYS = {
        face: "disable_face", breasts: "disable_breasts", ass: "disable_ass",
        body: "disable_body_overall", genitals: "disable_genitals",
        technique: "disable_technique", energy: "disable_energy_presence",
        sluttiness: "disable_sluttiness",
    };
    const DESCRIPTIONS = {
        face: "Facial attractiveness, eye appeal, lip shape, skin quality, and how good the face looks in close-ups, during oral, and while moaning or orgasming.",
        breasts: "Shape, size, firmness, symmetry, nipple appearance, and natural movement/jiggle during sex.",
        ass: "Shape, roundness, firmness, tightness, bounce, and visual appeal in doggy, cowgirl, and spanking shots.",
        body: "Proportions, waist-to-hip ratio, muscle tone, skin condition, legs, posture, and overall physical presence on camera.",
        genitals: "Visual appeal and presentation of the performer's sexual organs when aroused and groomed.",
        technique: "Technical ability and proficiency in sex: quality of oral, handjobs, riding rhythm, hip movement, depth control, muscle contractions, kissing, and overall sexual technique.",
        energy: "Visible enthusiasm, stamina, vocalization, authenticity and intensity of pleasure expressions, eye contact, orgasm quality, and how strongly the performer commands attention.",
        sluttiness: "Degree of uninhibitedness and sexual eagerness: willingness to embrace rough sex, anal, deepthroat, degradation, and extreme kinks, visible hunger and greed for cock/pussy, active begging or initiating sex, intensity of dirty talk, and overall attitude of shameless sexual availability.",
    };

    /* ── GraphQL ─────────────────────────────────────────────────────── */
    async function gqlClient(query, variables) {
        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables })
        });
        return res.json();
    }

    async function getPluginConfig() {
        const query = `query Configuration { configuration { plugins } }`;
        const res = await gqlClient(query);
        try { return res.data.configuration.plugins[PLUGIN_ID] || {}; }
        catch (e) { return {}; }
    }

    const STAR_PRECISION_MAP = { FULL: 20, HALF: 10, QUARTER: 5, TENTH: 1 };
    const STAR_PRECISION_LABEL = { 20: "Full star", 10: "Half star", 5: "Quarter star", 1: "Tenth star" };

    /* Read Stash's rating system. When ratingSystemOptions is absent the
       Stash UI defaults to STARS / FULL, so we mirror that. DECIMAL mode
       stores rating100 in 1-unit steps (0–100 from a 10-point input). */
    async function getStashRatingInfo() {
        try {
            const res = await gqlClient(`{ configuration { ui } }`);
            const ui = (res.data && res.data.configuration && res.data.configuration.ui) || {};
            const rso = ui.ratingSystemOptions || {};
            // Stash's UI writes lowercase ("stars", "tenth"); GraphQL also
            // accepts uppercase. Normalize before lookup.
            const type = (rso.type || "").toUpperCase();
            const sp = (rso.starPrecision || "").toUpperCase();
            if (type === "DECIMAL") return { precision: 1, label: "Decimal (10-point)" };
            const precision = STAR_PRECISION_MAP[sp] || 20;
            return { precision, label: STAR_PRECISION_LABEL[precision] || ("Stars (" + precision + ")") };
        } catch (e) {
            return { precision: 20, label: "Full star (default)" };
        }
    }
    async function getStashRatingPrecision() { return (await getStashRatingInfo()).precision; }

    async function configurePlugin(input) {
        const mutation = `mutation ConfigurePlugin($plugin_id: ID!, $input: Map!) {
            configurePlugin(plugin_id: $plugin_id, input: $input)
        }`;
        return gqlClient(mutation, { plugin_id: PLUGIN_ID, input });
    }

    /* ── Criteria config helpers ─────────────────────────────────────── */
    function coerceBool(v, def) {
        if (typeof v === "boolean") return v;
        if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
        if (typeof v === "number") return v !== 0;
        return def;
    }
    function coerceFloat(v, def) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : def;
    }

    function groupsFromConfig(config) {
        const raw = config.apr_group_ids;
        if (typeof raw === "string" && raw.trim()) {
            const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
            const result = ids.map(id => {
                const def = DEFAULT_GROUPS.find(d => d.id === id);
                return {
                    id,
                    name: config[`apr_group_name_${id}`] || (def ? def.name : id),
                    weight: coerceFloat(config[`apr_group_weight_${id}`], def ? def.weight : 1),
                };
            });
            if (result.length) return result;
        }
        return DEFAULT_GROUPS.map(d => Object.assign({}, d));
    }

    function criteriaFromConfig(config, groups) {
        const validGroupIds = new Set(groups.map(g => g.id));
        const fallbackGroup = groups[0] ? groups[0].id : "physical";

        const raw = config.apr_criteria_ids;
        if (typeof raw === "string" && raw.trim()) {
            const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
            return ids.map(id => {
                const def = DEFAULT_CRITERIA.find(d => d.id === id);
                const cfgGroup = config[`apr_group_${id}`];
                const group = validGroupIds.has(cfgGroup)
                    ? cfgGroup
                    : (def && validGroupIds.has(def.group) ? def.group : fallbackGroup);
                return {
                    id,
                    name: config[`apr_name_${id}`] || (def ? def.name : id),
                    group,
                    weight: coerceFloat(config[`apr_weight_${id}`], def ? def.weight : 1),
                    enabled: coerceBool(config[`apr_enabled_${id}`], def ? def.enabled : true),
                    description: typeof config[`apr_desc_${id}`] === "string"
                        ? config[`apr_desc_${id}`]
                        : (DESCRIPTIONS[id] || ""),
                };
            });
        }
        // Legacy fallback: honor old disable_X booleans on defaults
        return DEFAULT_CRITERIA.map(d => ({
            id: d.id,
            name: d.name,
            group: validGroupIds.has(d.group) ? d.group : fallbackGroup,
            weight: d.weight,
            enabled: d.enabled && !coerceBool(config[LEGACY_DISABLE_KEYS[d.id]], false),
            description: DESCRIPTIONS[d.id] || "",
        }));
    }

    function configFromState(groups, criteria) {
        const input = {
            apr_group_ids: groups.map(g => g.id).join(","),
            apr_criteria_ids: criteria.map(c => c.id).join(","),
        };
        groups.forEach(g => {
            input[`apr_group_name_${g.id}`] = g.name;
            input[`apr_group_weight_${g.id}`] = String(g.weight);
        });
        criteria.forEach(c => {
            input[`apr_name_${c.id}`] = c.name;
            input[`apr_group_${c.id}`] = c.group;
            input[`apr_weight_${c.id}`] = String(c.weight);
            input[`apr_enabled_${c.id}`] = !!c.enabled;
            input[`apr_desc_${c.id}`] = c.description || "";
        });
        return input;
    }

    function tagPrefix(criterion) { return `${criterion.name}${TAG_SUFFIX}`; }

    /* ─────────────────────────────────────────────────────────────────
       PERFORMER PAGE: rating modal trigger + modal (existing feature)
       ───────────────────────────────────────────────────────────────── */
    function tryInject(performerId) {
        if (document.querySelector('#perf-rating-trigger')) return true;
        const ratingStars = document.querySelector('.quality-group .rating-stars');
        if (ratingStars) {
            injectTrigger(ratingStars, performerId);
            return true;
        }
        return false;
    }

    function startPolling(performerId) {
        if (pollTimer) clearInterval(pollTimer);
        let attempts = 0;
        pollTimer = setInterval(() => {
            attempts++;
            if (tryInject(performerId) || attempts >= 40) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        }, 100);
    }

    let lastPath = null;
    function onLocationChange() {
        const urlMatch = window.location.pathname.match(/\/performers\/(\d+)/);
        if (urlMatch && !window.location.pathname.includes('edit')) {
            const performerId = urlMatch[1];
            if (window.location.pathname !== lastPath) {
                lastPath = window.location.pathname;
                const existing = document.querySelector('#perf-rating-trigger');
                if (existing) existing.remove();
                startPolling(performerId);
            }
        } else {
            lastPath = null;
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            const existing = document.querySelector('#perf-rating-trigger');
            if (existing) existing.remove();
        }
    }

    PluginApi.Event.addEventListener('stash:location', onLocationChange);
    onLocationChange();

    async function getEnabledCriteria() {
        const config = await getPluginConfig();
        const groups = groupsFromConfig(config);
        return criteriaFromConfig(config, groups).filter(c => c.enabled);
    }

    async function getPerformerTags(performerId) {
        const query = `query FindPerformer($id: ID!) { findPerformer(id: $id) { id tags { id name } } }`;
        const res = await gqlClient(query, { id: performerId });
        return res.data.findPerformer.tags;
    }

    async function getTagIdByName(name) {
        const query = `query FindTags($tag_filter: TagFilterType) {
            findTags(tag_filter: $tag_filter) { tags { id name } }
        }`;
        const res = await gqlClient(query, {
            tag_filter: { name: { value: name, modifier: "EQUALS" } }
        });
        const tags = res.data.findTags.tags;
        return tags.length > 0 ? tags[0].id : null;
    }

    async function updatePerformerTag(performerId, allTags, prefix, newScore) {
        const oldTags = allTags.filter(tag => {
            const match = tag.name.match(CATEGORY_PATTERN);
            return match && match[1].trim() === prefix.trim();
        });
        let newTagIds = allTags.map(t => t.id).filter(id => !oldTags.find(ot => ot.id === id));
        if (newScore !== null) {
            const newTagName = `${prefix}: ${newScore}`;
            const newTagId = await getTagIdByName(newTagName);
            if (newTagId) {
                newTagIds.push(newTagId);
            } else {
                alert(`Tag "${newTagName}" not found!\n\nMake sure you have run the "Create Tags" task first.`);
                return false;
            }
        }
        const mutation = `mutation PerformerUpdate($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }`;
        await gqlClient(mutation, { input: { id: performerId, tag_ids: newTagIds } });
        return true;
    }

    function injectTrigger(ratingStars, performerId) {
        const triggerBtn = document.createElement('button');
        triggerBtn.id = 'perf-rating-trigger';
        triggerBtn.innerHTML = '<span style="color:#ffc107;">★</span>+';
        triggerBtn.title = "Open Performer Ratings";
        triggerBtn.className = 'adv-rating-btn';
        ratingStars.insertAdjacentElement('afterend', triggerBtn);
        triggerBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation(); openModal(performerId);
        });
    }

    async function openModal(performerId) {
        if (document.querySelector('#perf-rating-modal')) return;
        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'perf-rating-modal';
        modalOverlay.className = 'adv-rating-modal-overlay';
        const modalContent = document.createElement('div');
        modalContent.className = 'adv-rating-modal-content';
        modalContent.innerHTML = `
            <div class="adv-rating-header"><h3>Performer Ratings</h3><span class="perf-rating-close">&times;</span></div>
            <div class="ratings-list">Loading...</div>
        `;
        modalOverlay.appendChild(modalContent);
        document.body.appendChild(modalOverlay);
        const handleClose = () => { modalOverlay.remove(); window.location.reload(); };
        modalContent.querySelector('.perf-rating-close').addEventListener('click', handleClose);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) handleClose(); });
        const criteria = await getEnabledCriteria();
        let performerTags = await getPerformerTags(performerId);
        function render() {
            const listContainer = modalContent.querySelector('.ratings-list');
            listContainer.innerHTML = '';
            const currentScores = {};
            performerTags.forEach(tag => {
                const match = tag.name.match(CATEGORY_PATTERN);
                if (match) currentScores[match[1].trim()] = parseInt(match[2], 10);
            });
            criteria.forEach(c => {
                const prefix = tagPrefix(c);
                const row = document.createElement('div'); row.className = 'rating-row';
                const label = document.createElement('span'); label.className = 'rating-label';
                const labelText = document.createElement('span'); labelText.innerText = prefix; label.appendChild(labelText);
                // c.description is the authoritative value from config (already
                // defaulted to DESCRIPTIONS[id] on first load). Empty string =
                // user explicitly cleared it; show no tooltip.
                const desc = c.description;
                if (desc) {
                    const infoIcon = document.createElement('span'); infoIcon.className = 'rating-info-icon'; infoIcon.innerHTML = 'ⓘ';
                    const tooltip = document.createElement('div'); tooltip.className = 'rating-tooltip'; tooltip.innerText = desc;
                    infoIcon.appendChild(tooltip); label.appendChild(infoIcon);
                }
                const starsDiv = document.createElement('div'); starsDiv.className = 'rating-stars-modal';
                const score = currentScores[prefix.trim()] !== undefined ? currentScores[prefix.trim()] : null;
                for (let i = 1; i <= 5; i++) {
                    const star = document.createElement('span'); star.className = 'rating-star';
                    star.innerHTML = (score !== null && i <= score) ? '★' : '☆';
                    star.addEventListener('mouseenter', () => {
                        starsDiv.querySelectorAll('.rating-star').forEach((s, idx) => {
                            s.classList.toggle('hovered', idx < i);
                        });
                    });
                    star.addEventListener('mouseleave', () => {
                        starsDiv.querySelectorAll('.rating-star').forEach(s => s.classList.remove('hovered'));
                    });
                    star.addEventListener('click', async () => {
                        listContainer.style.opacity = '0.5';
                        if (await updatePerformerTag(performerId, performerTags, prefix, i)) {
                            performerTags = await getPerformerTags(performerId); render();
                        }
                        listContainer.style.opacity = '1';
                    });
                    starsDiv.appendChild(star);
                }
                const clearBtn = document.createElement('span'); clearBtn.className = 'rating-clear'; clearBtn.innerHTML = '×';
                clearBtn.title = 'Remove Category Rating';
                clearBtn.addEventListener('click', async () => {
                    listContainer.style.opacity = '0.5';
                    if (await updatePerformerTag(performerId, performerTags, prefix, null)) {
                        performerTags = await getPerformerTags(performerId); render();
                    }
                    listContainer.style.opacity = '1';
                });
                starsDiv.appendChild(clearBtn);
                row.appendChild(label); row.appendChild(starsDiv); listContainer.appendChild(row);
            });
        }
        render();
    }

    /* ─────────────────────────────────────────────────────────────────
       SETTINGS PANEL: replace Stash's broken native settings UI via
       PluginApi.patch.instead("PluginSettings"). Same pattern Refract
       Theme uses to work around the inability to render dropdowns or
       reliably round-trip string inputs.
       ───────────────────────────────────────────────────────────────── */
    function buildSettingsPanel() {
        const R = PluginApi.React;
        return function AdvPerformerRatingSettings() {
            const [groups, setGroups] = R.useState(null);
            const [criteria, setCriteria] = R.useState(null);
            const [general, setGeneral] = R.useState(null);
            const [loadError, setLoadError] = R.useState(null);
            const [savingState, setSavingState] = R.useState({ saving: false, message: null, kind: null });
            const [editingDescId, setEditingDescId] = R.useState(null);

            R.useEffect(function () {
                let cancelled = false;
                Promise.all([getPluginConfig(), getStashRatingInfo()])
                    .then(function (results) {
                        if (cancelled) return;
                        const cfg = results[0];
                        const info = results[1];
                        const gs = groupsFromConfig(cfg);
                        setGroups(gs);
                        setCriteria(criteriaFromConfig(cfg, gs));
                        setGeneral({
                            allow_destructive_actions: coerceBool(cfg.allow_destructive_actions, false),
                            rating_precision: info.precision,
                            rating_precision_label: info.label,
                        });
                    })
                    .catch(function (e) {
                        if (cancelled) return;
                        setLoadError(String(e));
                    });
                return function () { cancelled = true; };
            }, []);
            function updateGeneral(patch) {
                setGeneral(function (cur) { return Object.assign({}, cur, patch); });
            }

            /* Stash exposes no event for ratingSystemOptions changes, so poll
               while the panel is mounted. Cheap (one tiny GraphQL hit every
               3 s) and only runs while this settings tab is open. */
            R.useEffect(function () {
                const interval = setInterval(async function () {
                    try {
                        const info = await getStashRatingInfo();
                        setGeneral(function (cur) {
                            if (!cur) return cur;
                            if (cur.rating_precision === info.precision && cur.rating_precision_label === info.label) return cur;
                            return Object.assign({}, cur, {
                                rating_precision: info.precision,
                                rating_precision_label: info.label,
                            });
                        });
                    } catch (e) { /* ignore */ }
                }, 3000);
                return function () { clearInterval(interval); };
            }, []);

            function updateCriterion(idx, patch) {
                setCriteria(function (cur) {
                    const next = cur.slice();
                    next[idx] = Object.assign({}, next[idx], patch);
                    return next;
                });
            }
            function removeCriterion(idx) {
                setCriteria(function (cur) { return cur.filter(function (_, i) { return i !== idx; }); });
            }
            function moveCriterion(idx, dir) {
                setCriteria(function (cur) {
                    const j = idx + dir;
                    if (j < 0 || j >= cur.length) return cur;
                    const next = cur.slice();
                    const tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
                    return next;
                });
            }
            function addCriterion() {
                setCriteria(function (cur) {
                    const id = "custom_" + Date.now().toString(36);
                    const fallbackGroup = groups[0] ? groups[0].id : "physical";
                    return cur.concat([{ id, name: "New criterion", group: fallbackGroup, weight: 1, enabled: true, description: "" }]);
                });
            }
            function updateGroup(idx, patch) {
                setGroups(function (cur) {
                    const next = cur.slice();
                    next[idx] = Object.assign({}, next[idx], patch);
                    return next;
                });
            }
            function moveGroup(idx, dir) {
                setGroups(function (cur) {
                    const j = idx + dir;
                    if (j < 0 || j >= cur.length) return cur;
                    const next = cur.slice();
                    const tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
                    return next;
                });
            }
            function addGroup() {
                setGroups(function (cur) {
                    const id = "group_" + Date.now().toString(36);
                    return cur.concat([{ id, name: "New group", weight: 1 }]);
                });
            }
            function removeGroup(idx) {
                const g = groups[idx];
                if (!g) return;
                if (groups.length <= 1) {
                    alert("At least one group is required.");
                    return;
                }
                const using = criteria.filter(function (c) { return c.group === g.id; });
                const reassignTo = (groups.find(function (other, i) { return i !== idx; }) || {}).id;
                const msg = using.length
                    ? "Remove group \"" + g.name + "\"?\n" + using.length + " criterion/criteria will be reassigned to \"" + reassignTo + "\"."
                    : "Remove group \"" + g.name + "\"?";
                if (!confirm(msg)) return;
                setGroups(function (cur) { return cur.filter(function (_, i) { return i !== idx; }); });
                if (using.length) {
                    setCriteria(function (cur) {
                        return cur.map(function (c) {
                            return c.group === g.id ? Object.assign({}, c, { group: reassignTo }) : c;
                        });
                    });
                }
            }
            function resetDefaults() {
                if (!confirm("Reset all groups and criteria to defaults?\nUnsaved edits will be lost.")) return;
                setGroups(DEFAULT_GROUPS.map(function (d) { return Object.assign({}, d); }));
                setCriteria(DEFAULT_CRITERIA.map(function (d) { return Object.assign({}, d); }));
            }

            async function recalcAll() {
                if (!confirm("Recalculate ratings for all performers? This walks every performer and updates their rating100 based on the current configuration.")) return;
                setSavingState({ saving: true, message: "Loading performers…", kind: "info" });
                try {
                    const cfg = await getPluginConfig();
                    const res = await recalculateAllPerformers(groups, criteria, cfg, function (done, total, updated) {
                        setSavingState({ saving: true, message: "Processed " + done + " / " + total + " (" + updated + " updated)", kind: "info" });
                    });
                    setSavingState({ saving: false, message: "Recalc complete: " + res.updated + " updated, " + res.skipped + " unchanged of " + res.total + ".", kind: "success" });
                } catch (e) {
                    setSavingState({ saving: false, message: "Recalc failed: " + (e && e.message ? e.message : e), kind: "error" });
                }
            }

            async function removeOrphans() {
                if (!general || !general.allow_destructive_actions) {
                    alert("Enable \"Allow Destructive Actions\" in the General section above first.");
                    return;
                }
                setSavingState({ saving: true, message: "Scanning for orphaned tags…", kind: "info" });
                try {
                    const { parentMissing, orphans } = await findOrphanCriterionTags(criteria);
                    if (parentMissing) {
                        setSavingState({ saving: false, message: "No rating tags found — nothing to scan.", kind: "info" });
                        return;
                    }
                    if (!orphans.length) {
                        setSavingState({ saving: false, message: "No orphaned tags found.", kind: "success" });
                        return;
                    }
                    const lines = orphans.map(o => "  • " + o.name + " (+ " + o.childCount + " child tag(s))");
                    const msg = "Found " + orphans.length + " orphaned criterion tag(s):\n\n" + lines.join("\n") + "\n\nDelete these and their 0–5 children from Stash?";
                    if (!confirm(msg)) {
                        setSavingState({ saving: false, message: "Cancelled.", kind: "info" });
                        return;
                    }
                    const destroyed = await destroyOrphanSubtrees(orphans);
                    setSavingState({ saving: false, message: "Deleted " + destroyed + " orphaned tag(s).", kind: "success" });
                } catch (e) {
                    setSavingState({ saving: false, message: "Scan failed: " + (e && e.message ? e.message : e), kind: "error" });
                }
            }

            async function deleteAllTags() {
                if (!general || !general.allow_destructive_actions) {
                    alert("Enable \"Allow Destructive Actions\" in the General section above first.");
                    return;
                }
                if (!confirm("Delete ALL Advanced Performer Rating tags from the database?\nThis destroys the parent + every criterion's level tags. Performers lose their per-criterion ratings (their overall rating100 stays).\nThis cannot be undone.")) return;
                if (!confirm("Really delete? Last chance.")) return;
                setSavingState({ saving: true, message: "Deleting tags…", kind: "info" });
                try {
                    const destroyed = await destroyAllRatingTags(criteria);
                    setSavingState({ saving: false, message: "Deleted " + destroyed + " tag(s). Run Save to recreate.", kind: "success" });
                } catch (e) {
                    setSavingState({ saving: false, message: "Delete failed: " + (e && e.message ? e.message : e), kind: "error" });
                }
            }

            async function save() {
                setSavingState({ saving: true, message: "Saving…", kind: "info" });
                try {
                    // Validate groups
                    if (!groups.length) throw new Error("At least one group is required");
                    const gids = groups.map(function (g) { return g.id; });
                    const gdupes = gids.filter(function (id, i) { return gids.indexOf(id) !== i; });
                    if (gdupes.length) throw new Error("Duplicate group ids: " + gdupes.join(", "));
                    const validGroupIds = new Set(gids);
                    for (const g of groups) {
                        if (!g.name || !g.name.trim()) throw new Error("Every group needs a name");
                        if (!Number.isFinite(g.weight) || g.weight < 0) throw new Error("Group weight must be a non-negative number");
                    }

                    // Validate criteria
                    const ids = criteria.map(function (c) { return c.id; });
                    const dupes = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
                    if (dupes.length) throw new Error("Duplicate criterion ids: " + dupes.join(", "));
                    for (const c of criteria) {
                        if (!c.name || !c.name.trim()) throw new Error("Every criterion needs a name");
                        if (!Number.isFinite(c.weight) || c.weight < 0) throw new Error("Weight must be a non-negative number");
                        if (!validGroupIds.has(c.group)) throw new Error("Criterion \"" + c.name + "\" references unknown group \"" + c.group + "\"");
                    }

                    // Diff vs. saved config for tag-rename detection
                    const beforeCfg = await getPluginConfig();
                    const beforeGroups = groupsFromConfig(beforeCfg);
                    const before = criteriaFromConfig(beforeCfg, beforeGroups);
                    const renames = [];
                    for (const next of criteria) {
                        const prev = before.find(function (p) { return p.id === next.id; });
                        if (prev && prev.name.trim() !== next.name.trim()) {
                            renames.push({ from: tagPrefix(prev), to: tagPrefix(next) });
                        }
                    }

                    // Persist (rating_precision is auto-derived from Stash, not stored)
                    const configInput = configFromState(groups, criteria);
                    if (general) {
                        configInput.allow_destructive_actions = !!general.allow_destructive_actions;
                    }
                    await configurePlugin(configInput);

                    // Auto-rename any tags whose criterion was renamed
                    let renameSummary = "";
                    if (renames.length) {
                        let renamedCount = 0;
                        for (const rn of renames) {
                            const result = await renameRatingTags(rn.from, rn.to);
                            if (result.renamedAny) renamedCount++;
                        }
                        if (renamedCount) renameSummary = " Renamed " + renamedCount + " tag group(s).";
                    }

                    // Auto-create any missing tags for enabled criteria
                    const created = await createMissingTags(criteria);
                    const createPieces = [];
                    if (created.createdParent) createPieces.push("parent tag");
                    if (created.createdCategories) createPieces.push(created.createdCategories + " criterion tag(s)");
                    if (created.createdLevels) createPieces.push(created.createdLevels + " level tag(s)");
                    const createSummary = createPieces.length ? " Created " + createPieces.join(", ") + "." : "";

                    setSavingState({ saving: false, message: "Saved." + renameSummary + createSummary, kind: "success" });
                } catch (e) {
                    setSavingState({ saving: false, message: "Save failed: " + (e && e.message ? e.message : e), kind: "error" });
                }
            }

            if (loadError) {
                return R.createElement("div", { className: "plugin-settings" },
                    R.createElement("div", { className: "setting" },
                        R.createElement("div", null,
                            R.createElement("h3", null, "Advanced Performer Rating"),
                            R.createElement("div", { className: "sub-heading" }, "Failed to load config: " + loadError))));
            }
            if (criteria === null || groups === null || general === null) {
                return R.createElement("div", { className: "plugin-settings" },
                    R.createElement("div", { className: "setting" },
                        R.createElement("div", null, R.createElement("h3", null, "Loading…"))));
            }

            const rows = criteria.map(function (c, idx) {
                const isEditingDesc = editingDescId === c.id;
                // Empty string means "user cleared it" — render nothing rather
                // than substituting the bundled default. Reset-to-default in the
                // editor is the way back.
                const previewDesc = c.description || "";
                return R.createElement("div", {
                    key: c.id,
                    className: "setting apr-criterion-row" + (c.enabled ? "" : " apr-disabled"),
                },
                    R.createElement("div", { className: "apr-criterion-main" },
                        R.createElement("div", { className: "apr-criterion-toggle" },
                            R.createElement("div", { className: "custom-control custom-switch" },
                                R.createElement("input", {
                                    type: "checkbox",
                                    className: "custom-control-input",
                                    id: "apr-enabled-" + c.id,
                                    checked: !!c.enabled,
                                    onChange: function (e) { updateCriterion(idx, { enabled: e.target.checked }); },
                                }),
                                R.createElement("label", {
                                    className: "custom-control-label",
                                    htmlFor: "apr-enabled-" + c.id,
                                }))),
                        R.createElement("input", {
                            type: "text",
                            className: "form-control apr-name-input",
                            value: c.name,
                            placeholder: "Display name",
                            onChange: function (e) { updateCriterion(idx, { name: e.target.value }); },
                        }),
                        R.createElement("select", {
                            className: "form-control apr-group-select",
                            value: c.group,
                            onChange: function (e) { updateCriterion(idx, { group: e.target.value }); },
                        }, groups.map(function (g) {
                            return R.createElement("option", { key: g.id, value: g.id }, g.name);
                        })),
                        R.createElement("input", {
                            type: "number",
                            className: "form-control apr-weight-input",
                            value: c.weight,
                            min: 0,
                            step: 0.5,
                            onChange: function (e) { updateCriterion(idx, { weight: coerceFloat(e.target.value, 1) }); },
                        }),
                        R.createElement("div", { className: "apr-row-actions" },
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-secondary btn-sm" + (isEditingDesc ? " active" : ""),
                                title: "Edit description",
                                onClick: function () { setEditingDescId(isEditingDesc ? null : c.id); },
                            }, "✎"),
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-secondary btn-sm",
                                title: "Move up",
                                disabled: idx === 0,
                                onClick: function () { moveCriterion(idx, -1); },
                            }, "↑"),
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-secondary btn-sm",
                                title: "Move down",
                                disabled: idx === criteria.length - 1,
                                onClick: function () { moveCriterion(idx, 1); },
                            }, "↓"),
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-danger btn-sm",
                                title: "Remove criterion. Tags stay on disk — clean up with \"Remove orphaned tags\".",
                                onClick: function () {
                                    if (confirm("Remove criterion \"" + c.name + "\" from this configuration?\nIts tags stay on disk; use \"Remove orphaned tags\" later to clean them up.")) {
                                        removeCriterion(idx);
                                    }
                                },
                            }, "×"))),
                    isEditingDesc
                        ? R.createElement("div", { className: "apr-desc-editor" },
                            R.createElement("textarea", {
                                className: "form-control apr-desc-textarea",
                                rows: 4,
                                placeholder: "Tooltip shown in the performer rating modal.",
                                value: c.description || "",
                                onChange: function (e) { updateCriterion(idx, { description: e.target.value }); },
                            }),
                            R.createElement("div", { className: "apr-desc-editor-actions" },
                                DESCRIPTIONS[c.id] ? R.createElement("button", {
                                    type: "button",
                                    className: "btn btn-link btn-sm",
                                    title: "Reset to the bundled default for this criterion",
                                    onClick: function () { updateCriterion(idx, { description: DESCRIPTIONS[c.id] }); },
                                }, "Reset to default") : null,
                                R.createElement("button", {
                                    type: "button",
                                    className: "btn btn-secondary btn-sm",
                                    onClick: function () { setEditingDescId(null); },
                                }, "Close")))
                        : (previewDesc ? R.createElement("div", { className: "apr-criterion-desc sub-heading" }, previewDesc) : null),
                );
            });

            const msgClass = savingState.kind === "error" ? "apr-msg apr-msg-error"
                : savingState.kind === "success" ? "apr-msg apr-msg-success"
                : "apr-msg";

            const groupRows = groups.map(function (g, idx) {
                const usingCount = criteria.filter(function (c) { return c.group === g.id; }).length;
                return R.createElement("div", {
                    key: g.id,
                    className: "setting apr-group-row",
                },
                    R.createElement("div", { className: "apr-group-main" },
                        R.createElement("input", {
                            type: "text",
                            className: "form-control apr-group-name-input",
                            value: g.name,
                            placeholder: "Group name",
                            onChange: function (e) { updateGroup(idx, { name: e.target.value }); },
                        }),
                        R.createElement("input", {
                            type: "number",
                            className: "form-control apr-group-weight-input",
                            value: g.weight,
                            min: 0,
                            step: 0.5,
                            title: "Group weight in the final score",
                            onChange: function (e) { updateGroup(idx, { weight: coerceFloat(e.target.value, 1) }); },
                        }),
                        R.createElement("span", { className: "apr-group-usage" },
                            usingCount + " criterion" + (usingCount === 1 ? "" : "ia")),
                        R.createElement("div", { className: "apr-row-actions" },
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-secondary btn-sm",
                                title: "Move up",
                                disabled: idx === 0,
                                onClick: function () { moveGroup(idx, -1); },
                            }, "↑"),
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-secondary btn-sm",
                                title: "Move down",
                                disabled: idx === groups.length - 1,
                                onClick: function () { moveGroup(idx, 1); },
                            }, "↓"),
                            R.createElement("button", {
                                type: "button",
                                className: "btn btn-danger btn-sm",
                                title: "Delete group",
                                disabled: groups.length <= 1,
                                onClick: function () { removeGroup(idx); },
                            }, "×"))));
            });

            const generalSection = [
                R.createElement("div", { key: "g-prec", className: "setting" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Rating Star Precision"),
                        R.createElement("div", { className: "sub-heading" },
                            "Auto-matched to Stash's rating system setting (Settings → Interface → Editing → Rating System). Change it there and reopen this panel.")),
                    R.createElement("div", { className: "apr-general-control" },
                        R.createElement("span", { className: "apr-readonly" },
                            general.rating_precision_label + " (" + general.rating_precision + ")"))),
                R.createElement("div", { key: "g-destr", className: "setting" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Allow Destructive Actions"),
                        R.createElement("div", { className: "sub-heading" },
                            "Required to use \"Remove orphaned tags\" and \"Delete all rating tags\". Use with caution.")),
                    R.createElement("div", { className: "apr-general-control" },
                        R.createElement("div", { className: "custom-control custom-switch" },
                            R.createElement("input", {
                                type: "checkbox",
                                className: "custom-control-input",
                                id: "apr-allow-destr",
                                checked: !!general.allow_destructive_actions,
                                onChange: function (e) { updateGeneral({ allow_destructive_actions: e.target.checked }); },
                            }),
                            R.createElement("label", {
                                className: "custom-control-label",
                                htmlFor: "apr-allow-destr",
                            })))),
            ];

            return R.createElement("div", { className: "plugin-settings apr-settings" },
                generalSection,
                R.createElement("div", { className: "setting" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Groups"),
                        R.createElement("div", { className: "sub-heading" },
                            "Criteria are bucketed into groups; each group has its own weight. The final score is the weighted mean of each group's weighted-criterion average. With one group it's a flat weighted average; with several, group weights balance them. Groups with no enabled criteria for a given performer are skipped."))),
                groupRows,
                R.createElement("div", { className: "setting apr-add-row" },
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-primary",
                        onClick: addGroup,
                    }, "+ Add group")),
                R.createElement("div", { className: "setting" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Criteria"),
                        R.createElement("div", { className: "sub-heading" },
                            "Tags are stored on disk as \"", R.createElement("code", null, "Name ★: 0–5"),
                            "\". Rename or reorder freely; weights drive the weighted average within each group, then groups combine using their own weights. Disabled criteria are ignored. ",
                            R.createElement("strong", null, "Save"),
                            " persists changes and automatically creates any missing tags and renames tags for renamed criteria."))),
                rows,
                R.createElement("div", { className: "setting apr-add-row" },
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-primary",
                        onClick: addCriterion,
                    }, "+ Add criterion")),
                R.createElement("div", { className: "setting apr-actions" },
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-primary",
                        disabled: savingState.saving,
                        title: "Persist config; create missing tags; rename tags for renamed criteria",
                        onClick: save,
                    }, "Save"),
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-secondary",
                        disabled: savingState.saving,
                        title: "Walk every performer and update their rating from their existing tags",
                        onClick: recalcAll,
                    }, "Recalculate all performers"),
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-secondary",
                        disabled: savingState.saving,
                        onClick: resetDefaults,
                    }, "Reset to defaults"),
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-warning",
                        disabled: savingState.saving,
                        title: "Find and delete rating tags whose criterion was renamed or removed from this config",
                        onClick: removeOrphans,
                    }, "Remove orphaned tags"),
                    R.createElement("button", {
                        type: "button",
                        className: "btn btn-danger apr-danger-btn",
                        disabled: savingState.saving,
                        title: "Destroy parent + all criterion + level tags. Requires Allow Destructive Actions.",
                        onClick: deleteAllTags,
                    }, "Delete all rating tags"),
                    savingState.message ? R.createElement("span", { className: msgClass }, savingState.message) : null,
                ));
        };
    }

    /* ── Tag CRUD (replaces the old plugin tasks) ────────────────────── */
    const RATING_ROOT_TAG = "Advanced Performer Rating";

    async function findOrCreateTag(name, parentId) {
        // Returns the tag id, creating + parenting if missing.
        let id = await getTagIdByName(name);
        if (id) return { id, created: false };
        const createRes = await gqlClient(`mutation TagCreate($input: TagCreateInput!) {
            tagCreate(input: $input) { id }
        }`, { input: { name, ignore_auto_tag: true, parent_ids: parentId ? [parentId] : [] } });
        id = createRes.data && createRes.data.tagCreate && createRes.data.tagCreate.id;
        if (!id) throw new Error("Failed to create tag: " + name);
        return { id, created: true };
    }

    async function destroyTagByName(name) {
        const id = await getTagIdByName(name);
        if (!id) return false;
        await gqlClient(`mutation TagDestroy($input: TagDestroyInput!) {
            tagDestroy(input: $input)
        }`, { input: { id } });
        return true;
    }

    async function createMissingTags(criteria) {
        // Create parent + each enabled criterion's "Name ★" + ": 0..5".
        // Idempotent; returns counts.
        const enabled = criteria.filter(c => c.enabled);
        if (!enabled.length) return { createdParent: false, createdCategories: 0, createdLevels: 0 };
        const root = await findOrCreateTag(RATING_ROOT_TAG, null);
        let createdCategories = 0, createdLevels = 0;
        for (const c of enabled) {
            const prefix = tagPrefix(c);
            const cat = await findOrCreateTag(prefix, root.id);
            if (cat.created) createdCategories++;
            for (let i = 0; i <= 5; i++) {
                const lvl = await findOrCreateTag(`${prefix}: ${i}`, cat.id);
                if (lvl.created) createdLevels++;
            }
        }
        return { createdParent: root.created, createdCategories, createdLevels };
    }

    async function destroyCriterionTags(criterion) {
        const prefix = tagPrefix(criterion);
        let destroyed = 0;
        for (let i = 0; i <= 5; i++) {
            if (await destroyTagByName(`${prefix}: ${i}`)) destroyed++;
        }
        if (await destroyTagByName(prefix)) destroyed++;
        return destroyed;
    }

    async function findOrphanCriterionTags(criteria) {
        // Returns the criterion-level tags (immediate children of the root
        // "Advanced Performer Rating" tag) whose name doesn't match any
        // currently-configured criterion's tag_prefix. Includes their child
        // count so we can report what would be deleted.
        const parentId = await getTagIdByName(RATING_ROOT_TAG);
        if (!parentId) return { parentMissing: true, orphans: [] };
        const res = await gqlClient(`query($filter: TagFilterType) {
            findTags(tag_filter: $filter, filter: {per_page: -1}) {
                tags { id name children { id name } }
            }
        }`, {
            filter: { parents: { value: [parentId], modifier: "INCLUDES" } }
        });
        const tags = (res.data && res.data.findTags && res.data.findTags.tags) || [];
        const currentPrefixes = new Set(criteria.map(c => tagPrefix(c)));
        const orphans = tags
            .filter(t => !currentPrefixes.has(t.name))
            .map(t => ({ id: t.id, name: t.name, childCount: (t.children || []).length }));
        return { parentMissing: false, orphans };
    }

    async function destroyOrphanSubtrees(orphans) {
        // For each orphan criterion-level tag, destroy its level children
        // (0..5) by name pattern, then destroy the criterion tag itself.
        let destroyed = 0;
        for (const t of orphans) {
            for (let i = 0; i <= 5; i++) {
                if (await destroyTagByName(`${t.name}: ${i}`)) destroyed++;
            }
            // Destroy the criterion tag itself by id (faster than name lookup)
            try {
                await gqlClient(`mutation TagDestroy($input: TagDestroyInput!) {
                    tagDestroy(input: $input)
                }`, { input: { id: t.id } });
                destroyed++;
            } catch (e) {
                console.warn("[advancedPerformerRating] failed to destroy orphan", t.name, e);
            }
        }
        return destroyed;
    }

    async function destroyAllRatingTags(criteria) {
        // Destroys the parent + every "<criterion> ★" tag + its 0..5 children.
        // Walks the configured criteria list, so renamed/removed criteria
        // whose tags still exist on disk won't be touched. For a true full
        // cleanup, users should restore criteria first (or hit Reset to defaults).
        let destroyed = 0;
        for (const c of criteria) {
            const prefix = tagPrefix(c);
            for (let i = 0; i <= 5; i++) {
                if (await destroyTagByName(`${prefix}: ${i}`)) destroyed++;
            }
            if (await destroyTagByName(prefix)) destroyed++;
        }
        if (await destroyTagByName(RATING_ROOT_TAG)) destroyed++;
        return destroyed;
    }

    async function renameRatingTags(oldPrefix, newPrefix) {
        // Renames the parent category tag + its six "<prefix>: 0..5" children
        // via tagUpdate GraphQL mutations. Returns { renamedAny: bool }.
        const targets = [oldPrefix];
        for (let i = 0; i <= 5; i++) targets.push(oldPrefix + ": " + i);
        let renamedAny = false;
        for (const oldName of targets) {
            const id = await getTagIdByName(oldName);
            if (!id) continue;
            const suffix = oldName.slice(oldPrefix.length); // "" or ": N"
            const newName = newPrefix + suffix;
            const mutation = `mutation TagUpdate($input: TagUpdateInput!) {
                tagUpdate(input: $input) { id name }
            }`;
            try {
                await gqlClient(mutation, { input: { id, name: newName } });
                renamedAny = true;
            } catch (e) {
                console.warn("[advancedPerformerRating] rename failed for", oldName, "→", newName, e);
            }
        }
        return { renamedAny };
    }

    /* ── Rating math (mirrors advancedPerformerRating.py) ────────────── */
    function computeRating100(performerTags, groups, criteria, ratingPrecision, minimumRequired) {
        const enabled = criteria.filter(c => c.enabled);
        if (!enabled.length) return null;
        const byPrefix = {};
        enabled.forEach(c => { byPrefix[tagPrefix(c)] = c; });
        const hitsByGroup = {};
        groups.forEach(g => { hitsByGroup[g.id] = []; });

        for (const tag of performerTags) {
            const m = (tag.name || "").match(CATEGORY_PATTERN);
            if (!m) continue;
            const cat = m[1].trim();
            const c = byPrefix[cat];
            if (!c) continue;
            const bucket = hitsByGroup[c.group];
            if (!bucket) continue;
            bucket.push({ score: parseInt(m[2], 10), w: parseFloat(c.weight) || 0 });
        }

        const totalHits = Object.values(hitsByGroup).reduce((n, arr) => n + arr.length, 0);
        if (totalHits < minimumRequired) return null;

        const contributions = [];
        for (const g of groups) {
            const hits = hitsByGroup[g.id] || [];
            const wsum = hits.reduce((n, h) => n + h.w, 0);
            if (wsum <= 0) continue;
            const gavg = hits.reduce((n, h) => n + h.score * h.w, 0) / wsum;
            const gw = parseFloat(g.weight) || 0;
            if (gw <= 0) continue;
            contributions.push({ avg: gavg, w: gw });
        }
        if (!contributions.length) return null;
        const totalW = contributions.reduce((n, c) => n + c.w, 0);
        const finalAvg = contributions.reduce((n, c) => n + c.avg * c.w, 0) / totalW;

        const precision = Math.max(1, parseInt(ratingPrecision, 10) || 10);
        let r100 = Math.round(Math.round(finalAvg * 20 / precision) * precision);
        r100 = Math.max(precision, Math.min(100, r100));
        return r100;
    }

    async function recalculateAllPerformers(groups, criteria, config, onProgress) {
        const ratingPrecision = await getStashRatingPrecision();
        const minimumRequired = 1;
        const res = await gqlClient(`{
            findPerformers(filter: {per_page: -1}) {
                count
                performers { id name rating100 tags { id name } }
            }
        }`);
        const performers = (res.data && res.data.findPerformers && res.data.findPerformers.performers) || [];
        let updated = 0, skipped = 0;
        for (let i = 0; i < performers.length; i++) {
            const p = performers[i];
            const newRating = computeRating100(p.tags || [], groups, criteria, ratingPrecision, minimumRequired);
            if (newRating === null || newRating === p.rating100) { skipped++; }
            else {
                await gqlClient(`mutation($input: PerformerUpdateInput!) {
                    performerUpdate(input: $input) { id }
                }`, { input: { id: p.id, rating100: newRating } });
                updated++;
            }
            if (onProgress) onProgress(i + 1, performers.length, updated, skipped);
        }
        return { total: performers.length, updated, skipped };
    }

    function registerSettingsPatch() {
        if (typeof PluginApi === "undefined" || !PluginApi.patch || !PluginApi.React) {
            setTimeout(registerSettingsPatch, 100);
            return;
        }
        const Panel = buildSettingsPanel();
        console.log("[advancedPerformerRating] registering PluginSettings patch");
        PluginApi.patch.instead("PluginSettings", function () {
            const args = Array.prototype.slice.call(arguments);
            const next = args.pop();
            const props = args[0];
            // Diagnostic — log props so we can confirm the field name Stash uses
            if (!window.__aprLoggedProps) {
                console.log("[advancedPerformerRating] PluginSettings props:", props);
                window.__aprLoggedProps = true;
            }
            const incomingId = props && (props.pluginID || props.pluginId || props.id);
            if (incomingId !== PLUGIN_ID) {
                return next.apply(null, args);
            }
            return PluginApi.React.createElement(Panel);
        });
    }
    registerSettingsPatch();
})();
