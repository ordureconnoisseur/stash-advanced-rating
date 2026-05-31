// Based on stashapp-plugin-advanced-scene-ratings by shackofnoreturn
// Original: https://github.com/shackofnoreturn/stashapp-plugin-advanced-scene-ratings
// License: AGPL v3 - https://www.gnu.org/licenses/agpl-3.0.html
//
// Merged advanced rating UI: handles BOTH scenes and performers under a single
// plugin id (advancedRating). Domain-specific bits (URL patterns, defaults,
// GraphQL fragments, settings keys) live in two `domain` config objects; the
// rest is shared. Scene-only favourite buttons remain gated to the scene
// domain.

(function () {
    const PLUGIN_ID = "advancedRating";
    const TAG_SUFFIX = " ★";
    const CATEGORY_PATTERN = /^(.+?)\s*:\s*([0-5])$/;
    const MIGRATION_TASK_NAME = "Migrate Settings From Old Plugins";

    /* ─── GraphQL ────────────────────────────────────────────────────── */
    async function gqlClient(query, variables) {
        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables })
        });
        return res.json();
    }

    async function getPluginConfig() {
        const res = await gqlClient(`query Configuration { configuration { plugins } }`);
        try { return res.data.configuration.plugins[PLUGIN_ID] || {}; }
        catch (e) { return {}; }
    }

    async function configurePlugin(input) {
        return gqlClient(`mutation ConfigurePlugin($plugin_id: ID!, $input: Map!) {
            configurePlugin(plugin_id: $plugin_id, input: $input)
        }`, { plugin_id: PLUGIN_ID, input });
    }

    const STAR_PRECISION_MAP = { FULL: 20, HALF: 10, QUARTER: 5, TENTH: 1 };
    const STAR_PRECISION_LABEL = { 20: "Full star", 10: "Half star", 5: "Quarter star", 1: "Tenth star" };

    async function getStashRatingInfo() {
        try {
            const res = await gqlClient(`{ configuration { ui } }`);
            const ui = (res.data && res.data.configuration && res.data.configuration.ui) || {};
            const rso = ui.ratingSystemOptions || {};
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

    /* ─── Coercion helpers ───────────────────────────────────────────── */
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

    function tagPrefix(criterion) { return `${criterion.name}${TAG_SUFFIX}`; }

    /* ─── Migration trigger ──────────────────────────────────────────── */
    async function runMigrationTask() {
        try {
            await gqlClient(`mutation { runPluginTask(plugin_id: "${PLUGIN_ID}", task_name: "${MIGRATION_TASK_NAME}") }`);
            return true;
        } catch (e) {
            console.warn("[advancedRating] migration task launch failed", e);
            return false;
        }
    }

    async function pollUntilMigrationDone(maxMs) {
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            const cfg = await getPluginConfig();
            if (coerceBool(cfg.migration_done, false)) return cfg;
            await new Promise(r => setTimeout(r, 400));
        }
        return null;
    }

    /* ─── Domain definitions ─────────────────────────────────────────── */
    const sceneDomain = {
        prefix: "scene_",
        entityType: "scene",
        label: "Scene",
        labelPlural: "Scenes",
        urlPattern: /\/scenes\/(\d+)/,
        triggerId: "adv-rating-trigger",
        anchorSelector: '.scene-toolbar .rating-stars, .scene-toolbar .rating-number',
        rootTagName: "Advanced Rating System",
        modalId: "adv-rating-modal",
        modalTitle: "Advanced Ratings",
        triggerTitle: "Open Advanced Scene Ratings",
        breakdownStorageKey: "asrBreakdownOpen",
        descIdPrefix: "scene-",
        defaultGroups: [
            { id: "overall", name: "Overall", weight: 1 },
        ],
        defaultCriteria: [
            { id: "production_quality", name: "Production Quality", group: "overall", weight: 1, enabled: true },
            { id: "chemistry",          name: "Chemistry",          group: "overall", weight: 1, enabled: true },
            { id: "performance",        name: "Performance",        group: "overall", weight: 1, enabled: true },
            { id: "aesthetics",         name: "Aesthetics",         group: "overall", weight: 1, enabled: true },
            { id: "creativity",         name: "Creativity",         group: "overall", weight: 1, enabled: true },
        ],
        legacyDisableKeys: {
            production_quality: "scene_disable_production_quality",
            chemistry: "scene_disable_chemistry",
            performance: "scene_disable_performance",
            aesthetics: "scene_disable_aesthetics",
            creativity: "scene_disable_creativity",
        },
        descriptions: {
            production_quality: "Evaluates technical execution: video resolution (4K/8K), lighting illuminating bodies and genital details, camera angles/movement capturing penetration, oral, and close-ups, audio clarity of moans, breathing, and dialogue, smooth editing, and overall polish.",
            chemistry: "Measures visible attraction and interaction: focuses on eye contact, authentic kissing, responsive touching, and the sense that performers are genuinely engaged during oral, penetration, and foreplay.",
            performance: "Assesses performers' energy and engagement: intensity and realism of moans and expressions, stamina during extended penetration, visible physical reactions (muscle contractions, wetness, erection quality), and commitment to sexual acts.",
            aesthetics: "Covers physical attractiveness (body shape, grooming of genitals/pubic areas), visual presentation of breasts, buttocks, penises, and vulvas, variety of positions, and framing of penetration and bodily fluids.",
            creativity: "Evaluates originality of concept and storyline, variety and combination of sexual acts and kinks, innovative use of positions, toys, locations, or camera work, pacing and progression of the sexual sequence, and the scene's raw physical intensity, memorability, rewatch value, and erotic impact.",
        },
        hasFavourite: true,
        modalShowsSingleGroupHeader: false,
        // Entity-specific GraphQL
        async fetchEntityTags(id) {
            const res = await gqlClient(
                `query FindScene($id: ID!) { findScene(id: $id) { id tags { id name } } }`,
                { id });
            return res.data.findScene.tags;
        },
        async updateEntityTags(id, tagIds) {
            await gqlClient(
                `mutation SceneUpdate($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
                { input: { id, tag_ids: tagIds } });
        },
        async updateEntityRating(id, rating100) {
            await gqlClient(
                `mutation($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`,
                { input: { id, rating100 } });
        },
        async findAllForRecalc() {
            const res = await gqlClient(`{
                findScenes(filter: {per_page: -1}) {
                    count
                    scenes { id title rating100 tags { id name } }
                }
            }`);
            return (res.data && res.data.findScenes && res.data.findScenes.scenes) || [];
        },
        triggerHelpStrings: {
            allRated: "Open Advanced Scene Ratings — all criteria rated",
            partial: (u, t) => `Open Advanced Scene Ratings — ${u} of ${t} criteria still unrated`,
            unrated: (t) => `Open Advanced Scene Ratings — ${t} criteria to rate`,
            recalcConfirm: "Recalculate ratings for all scenes? This walks every scene and updates rating100 based on the current configuration.",
            recalcLoadingMsg: "Loading scenes…",
            deleteAllConfirm: "Delete ALL Advanced Scene Rating tags from the database?\nThis destroys the parent + every criterion's level tags. Scenes lose their per-criterion ratings (their overall rating100 stays).\nThis cannot be undone.",
            modalSubject: "scene",
        },
    };

    const performerDomain = {
        prefix: "performer_",
        entityType: "performer",
        label: "Performer",
        labelPlural: "Performers",
        urlPattern: /\/performers\/(\d+)/,
        triggerId: "perf-rating-trigger",
        // .rating-stars / .rating-number live in .quality-group on the
        // performer detail page (verbatim from the performer source).
        anchorSelector: '.quality-group .rating-stars, .quality-group .rating-number',
        rootTagName: "Advanced Performer Rating",
        modalId: "perf-rating-modal",
        modalTitle: "Performer Ratings",
        triggerTitle: "Open Performer Ratings",
        breakdownStorageKey: "aprBreakdownOpen",
        descIdPrefix: "performer-",
        defaultGroups: [
            { id: "physical",    name: "Physical",    weight: 1 },
            { id: "performance", name: "Performance", weight: 1 },
        ],
        defaultCriteria: [
            { id: "face",       name: "Face",              group: "physical",    weight: 1, enabled: true },
            { id: "breasts",    name: "Breasts",           group: "physical",    weight: 1, enabled: true },
            { id: "ass",        name: "Ass",               group: "physical",    weight: 1, enabled: true },
            { id: "body",       name: "Body Overall",      group: "physical",    weight: 1, enabled: true },
            { id: "genitals",   name: "Genitals",          group: "physical",    weight: 1, enabled: true },
            { id: "technique",  name: "Technique",         group: "performance", weight: 1, enabled: true },
            { id: "energy",     name: "Energy & Presence", group: "performance", weight: 1, enabled: true },
            { id: "sluttiness", name: "Sluttiness",        group: "performance", weight: 1, enabled: true },
        ],
        legacyDisableKeys: {
            face: "performer_disable_face", breasts: "performer_disable_breasts", ass: "performer_disable_ass",
            body: "performer_disable_body_overall", genitals: "performer_disable_genitals",
            technique: "performer_disable_technique", energy: "performer_disable_energy_presence",
            sluttiness: "performer_disable_sluttiness",
        },
        descriptions: {
            face: "Facial attractiveness, eye appeal, lip shape, skin quality, and how good the face looks in close-ups, during oral, and while moaning or orgasming.",
            breasts: "Shape, size, firmness, symmetry, nipple appearance, and natural movement/jiggle during sex.",
            ass: "Shape, roundness, firmness, tightness, bounce, and visual appeal in doggy, cowgirl, and spanking shots.",
            body: "Proportions, waist-to-hip ratio, muscle tone, skin condition, legs, posture, and overall physical presence on camera.",
            genitals: "Visual appeal and presentation of the performer's sexual organs when aroused and groomed.",
            technique: "Technical ability and proficiency in sex: quality of oral, handjobs, riding rhythm, hip movement, depth control, muscle contractions, kissing, and overall sexual technique.",
            energy: "Visible enthusiasm, stamina, vocalization, authenticity and intensity of pleasure expressions, eye contact, orgasm quality, and how strongly the performer commands attention.",
            sluttiness: "Degree of uninhibitedness and sexual eagerness: willingness to embrace rough sex, anal, deepthroat, degradation, and extreme kinks, visible hunger and greed for cock/pussy, active begging or initiating sex, intensity of dirty talk, and overall attitude of shameless sexual availability.",
        },
        hasFavourite: false,
        // performer original always emitted the group header
        modalShowsSingleGroupHeader: true,
        async fetchEntityTags(id) {
            const res = await gqlClient(
                `query FindPerformer($id: ID!) { findPerformer(id: $id) { id tags { id name } } }`,
                { id });
            return res.data.findPerformer.tags;
        },
        async updateEntityTags(id, tagIds) {
            await gqlClient(
                `mutation PerformerUpdate($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }`,
                { input: { id, tag_ids: tagIds } });
        },
        async updateEntityRating(id, rating100) {
            await gqlClient(
                `mutation($input: PerformerUpdateInput!) { performerUpdate(input: $input) { id } }`,
                { input: { id, rating100 } });
        },
        async findAllForRecalc() {
            const res = await gqlClient(`{
                findPerformers(filter: {per_page: -1}) {
                    count
                    performers { id name rating100 tags { id name } }
                }
            }`);
            return (res.data && res.data.findPerformers && res.data.findPerformers.performers) || [];
        },
        triggerHelpStrings: {
            allRated: "Open Performer Ratings — all criteria rated",
            partial: (u, t) => `Open Performer Ratings — ${u} of ${t} criteria still unrated`,
            unrated: (t) => `Open Performer Ratings — ${t} criteria to rate`,
            recalcConfirm: "Recalculate ratings for all performers? This walks every performer and updates their rating100 based on the current configuration.",
            recalcLoadingMsg: "Loading performers…",
            deleteAllConfirm: "Delete ALL Advanced Performer Rating tags from the database?\nThis destroys the parent + every criterion's level tags. Performers lose their per-criterion ratings (their overall rating100 stays).\nThis cannot be undone.",
            modalSubject: "performer",
        },
    };

    const DOMAINS = [sceneDomain, performerDomain];

    /* ─── Domain-aware config helpers ────────────────────────────────── */
    function groupsFromConfig(config, domain) {
        const raw = config[domain.prefix + "group_ids"];
        if (typeof raw === "string" && raw.trim()) {
            const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
            const result = ids.map(id => {
                const def = domain.defaultGroups.find(d => d.id === id);
                return {
                    id,
                    name: config[domain.prefix + "group_name_" + id] || (def ? def.name : id),
                    weight: coerceFloat(config[domain.prefix + "group_weight_" + id], def ? def.weight : 1),
                };
            });
            if (result.length) return result;
        }
        return domain.defaultGroups.map(d => Object.assign({}, d));
    }

    function criteriaFromConfig(config, domain, groups) {
        const validGroupIds = new Set(groups.map(g => g.id));
        const fallbackGroup = groups[0] ? groups[0].id : domain.defaultGroups[0].id;

        const raw = config[domain.prefix + "criteria_ids"];
        if (typeof raw === "string" && raw.trim()) {
            const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
            return ids.map(id => {
                const def = domain.defaultCriteria.find(d => d.id === id);
                const cfgGroup = config[domain.prefix + "group_" + id];
                const group = validGroupIds.has(cfgGroup)
                    ? cfgGroup
                    : (def && validGroupIds.has(def.group) ? def.group : fallbackGroup);
                return {
                    id,
                    name: config[domain.prefix + "name_" + id] || (def ? def.name : id),
                    group,
                    weight: coerceFloat(config[domain.prefix + "weight_" + id], def ? def.weight : 1),
                    enabled: coerceBool(config[domain.prefix + "enabled_" + id], def ? def.enabled : true),
                    description: typeof config[domain.prefix + "desc_" + id] === "string"
                        ? config[domain.prefix + "desc_" + id]
                        : (domain.descriptions[id] || ""),
                };
            });
        }
        // Legacy fallback — honor old disable_X booleans on defaults
        return domain.defaultCriteria.map(d => ({
            id: d.id,
            name: d.name,
            group: validGroupIds.has(d.group) ? d.group : fallbackGroup,
            weight: d.weight,
            enabled: d.enabled && !coerceBool(config[domain.legacyDisableKeys[d.id]], false),
            description: domain.descriptions[d.id] || "",
        }));
    }

    function configFromState(domain, groups, criteria) {
        const input = {};
        input[domain.prefix + "group_ids"] = groups.map(g => g.id).join(",");
        input[domain.prefix + "criteria_ids"] = criteria.map(c => c.id).join(",");
        groups.forEach(g => {
            input[domain.prefix + "group_name_" + g.id] = g.name;
            input[domain.prefix + "group_weight_" + g.id] = String(g.weight);
        });
        criteria.forEach(c => {
            input[domain.prefix + "name_" + c.id] = c.name;
            input[domain.prefix + "group_" + c.id] = c.group;
            input[domain.prefix + "weight_" + c.id] = String(c.weight);
            input[domain.prefix + "enabled_" + c.id] = !!c.enabled;
            input[domain.prefix + "desc_" + c.id] = c.description || "";
        });
        return input;
    }

    async function getRatingModel(domain) {
        const config = await getPluginConfig();
        const groups = groupsFromConfig(config, domain);
        const criteria = criteriaFromConfig(config, domain, groups).filter(c => c.enabled);
        return { groups, criteria };
    }

    /* ─── Shared math: breakdown + computeRating100 ──────────────────── */
    function computeBreakdown(entityTags, groups, criteria, ratingPrecision) {
        const byPrefix = {};
        criteria.forEach(c => { byPrefix[tagPrefix(c)] = c; });
        const scoresByCriterion = {};
        for (const tag of entityTags) {
            const m = (tag.name || "").match(CATEGORY_PATTERN);
            if (!m) continue;
            const c = byPrefix[m[1].trim()];
            if (!c) continue;
            scoresByCriterion[c.id] = parseInt(m[2], 10);
        }
        const groupRows = groups.map(g => {
            const groupCriteria = criteria.filter(c => c.group === g.id);
            const ratedCriteria = groupCriteria.filter(c => scoresByCriterion[c.id] !== undefined);
            const totalWeight = ratedCriteria.reduce((n, c) => n + (parseFloat(c.weight) || 0), 0);
            const weightedSum = ratedCriteria.reduce((n, c) => n + (scoresByCriterion[c.id] || 0) * (parseFloat(c.weight) || 0), 0);
            const avg = totalWeight > 0 ? weightedSum / totalWeight : null;
            return {
                group: g,
                criteriaInGroup: groupCriteria,
                rated: ratedCriteria,
                unrated: groupCriteria.filter(c => scoresByCriterion[c.id] === undefined),
                totalWeight, weightedSum, avg, scoresByCriterion,
            };
        });
        const contributingGroups = groupRows.filter(r => r.avg !== null && (parseFloat(r.group.weight) || 0) > 0);
        const totalGroupWeight = contributingGroups.reduce((n, r) => n + (parseFloat(r.group.weight) || 0), 0);
        const finalAvg = totalGroupWeight > 0
            ? contributingGroups.reduce((n, r) => n + r.avg * (parseFloat(r.group.weight) || 0), 0) / totalGroupWeight
            : null;
        let rating100 = null;
        if (finalAvg !== null) {
            const precision = Math.max(1, parseInt(ratingPrecision, 10) || 10);
            rating100 = Math.round(Math.round(finalAvg * 20 / precision) * precision);
            rating100 = Math.max(precision, Math.min(100, rating100));
        }
        const totalCriteria = criteria.length;
        const totalRated = Object.keys(scoresByCriterion).length;
        return {
            groupRows, contributingGroups, totalGroupWeight, finalAvg, rating100,
            totalCriteria, totalRated, totalUnrated: totalCriteria - totalRated,
            scoresByCriterion,
        };
    }

    function computeRating100(entityTags, groups, criteria, ratingPrecision, minimumRequired) {
        const enabled = criteria.filter(c => c.enabled);
        if (!enabled.length) return null;
        const byPrefix = {};
        enabled.forEach(c => { byPrefix[tagPrefix(c)] = c; });
        const hitsByGroup = {};
        groups.forEach(g => { hitsByGroup[g.id] = []; });
        for (const tag of entityTags) {
            const m = (tag.name || "").match(CATEGORY_PATTERN);
            if (!m) continue;
            const c = byPrefix[m[1].trim()];
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

    /* ─── Tag CRUD ───────────────────────────────────────────────────── */
    async function getTagIdByName(name) {
        const res = await gqlClient(`query FindTags($tag_filter: TagFilterType) {
            findTags(tag_filter: $tag_filter) { tags { id name } }
        }`, { tag_filter: { name: { value: name, modifier: "EQUALS" } } });
        const tags = res.data.findTags.tags;
        return tags.length > 0 ? tags[0].id : null;
    }

    async function findOrCreateTag(name, parentId) {
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

    async function createMissingTags(domain, criteria) {
        const enabled = criteria.filter(c => c.enabled);
        if (!enabled.length) return { createdParent: false, createdCategories: 0, createdLevels: 0 };
        const root = await findOrCreateTag(domain.rootTagName, null);
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

    async function findOrphanCriterionTags(domain, criteria) {
        const parentId = await getTagIdByName(domain.rootTagName);
        if (!parentId) return { parentMissing: true, orphans: [] };
        const res = await gqlClient(`query($filter: TagFilterType) {
            findTags(tag_filter: $filter, filter: {per_page: -1}) {
                tags { id name children { id name } }
            }
        }`, { filter: { parents: { value: [parentId], modifier: "INCLUDES" } } });
        const tags = (res.data && res.data.findTags && res.data.findTags.tags) || [];
        const currentPrefixes = new Set(criteria.map(c => tagPrefix(c)));
        const orphans = tags
            .filter(t => !currentPrefixes.has(t.name))
            .map(t => ({ id: t.id, name: t.name, childCount: (t.children || []).length }));
        return { parentMissing: false, orphans };
    }

    async function destroyOrphanSubtrees(orphans) {
        let destroyed = 0;
        for (const t of orphans) {
            for (let i = 0; i <= 5; i++) {
                if (await destroyTagByName(`${t.name}: ${i}`)) destroyed++;
            }
            try {
                await gqlClient(`mutation TagDestroy($input: TagDestroyInput!) {
                    tagDestroy(input: $input)
                }`, { input: { id: t.id } });
                destroyed++;
            } catch (e) { console.warn("[advancedRating] destroy failed", t.name, e); }
        }
        return destroyed;
    }

    async function destroyAllRatingTags(domain, criteria) {
        let destroyed = 0;
        for (const c of criteria) {
            const prefix = tagPrefix(c);
            for (let i = 0; i <= 5; i++) {
                if (await destroyTagByName(`${prefix}: ${i}`)) destroyed++;
            }
            if (await destroyTagByName(prefix)) destroyed++;
        }
        if (await destroyTagByName(domain.rootTagName)) destroyed++;
        return destroyed;
    }

    async function renameRatingTags(oldPrefix, newPrefix, rootTagId) {
        const targets = [oldPrefix];
        for (let i = 0; i <= 5; i++) targets.push(oldPrefix + ": " + i);
        let renamedAny = false;
        for (const oldName of targets) {
            const res = await gqlClient(`query FindTags($tag_filter: TagFilterType) {
                findTags(tag_filter: $tag_filter) { tags { id name parents { id } } }
            }`, { tag_filter: { name: { value: oldName, modifier: "EQUALS" } } });
            const tag = (res.data && res.data.findTags && res.data.findTags.tags || [])[0];
            if (!tag) continue;
            const parentIds = (tag.parents || []).map(p => p.id);
            // Only rename tags that belong to this domain's rating tree. The
            // criterion root has the user-visible rating-system parent; level
            // tags (Foo ★: 3) have the criterion root as a parent. So a tag is
            // in-tree iff its parents include rootTagId OR any of its parents
            // is itself a child of rootTagId.
            let inTree = parentIds.includes(rootTagId);
            if (!inTree && parentIds.length) {
                const parentLookup = await gqlClient(`query($filter: TagFilterType) {
                    findTags(tag_filter: $filter, filter: {per_page: -1}) {
                        tags { id parents { id } }
                    }
                }`, { filter: { parents: { value: [rootTagId], modifier: "INCLUDES" } } });
                const rootChildren = new Set(((parentLookup.data && parentLookup.data.findTags && parentLookup.data.findTags.tags) || []).map(t => t.id));
                inTree = parentIds.some(pid => rootChildren.has(pid));
            }
            if (!inTree) {
                console.warn("[advancedRating] skipping rename of '" + oldName + "' — not under rating root");
                continue;
            }
            const suffix = oldName.slice(oldPrefix.length);
            const newName = newPrefix + suffix;
            try {
                await gqlClient(`mutation TagUpdate($input: TagUpdateInput!) {
                    tagUpdate(input: $input) { id name }
                }`, { input: { id: tag.id, name: newName } });
                renamedAny = true;
            } catch (e) { console.warn("[advancedRating] rename failed", oldName, "→", newName, e); }
        }
        return { renamedAny };
    }

    async function updateEntityCriterionTag(domain, entityId, allTags, prefix, newScore) {
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
                alert(`Tag "${newTagName}" not found!\n\nClick Save in the plugin settings panel to create the missing tags.`);
                return false;
            }
        }
        await domain.updateEntityTags(entityId, newTagIds);
        return true;
    }

    async function recalculateAll(domain, groups, criteria, onProgress) {
        const ratingPrecision = await getStashRatingPrecision();
        const minimumRequired = 1;
        const items = await domain.findAllForRecalc();
        let updated = 0, skipped = 0;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const newRating = computeRating100(it.tags || [], groups, criteria, ratingPrecision, minimumRequired);
            if (newRating === null || newRating === it.rating100) { skipped++; }
            else {
                await domain.updateEntityRating(it.id, newRating);
                updated++;
            }
            if (onProgress) onProgress(i + 1, items.length, updated, skipped);
        }
        return { total: items.length, updated, skipped };
    }

    /* ─────────────────────────────────────────────────────────────────
       PAGE INJECTION (per-domain): trigger button + modal
       ───────────────────────────────────────────────────────────────── */
    const pollTimers = { scene: null, performer: null };
    const lastPaths = { scene: null, performer: null };

    function tryInject(domain, entityId) {
        if (document.querySelector('#' + domain.triggerId)) return true;
        const anchor = document.querySelector(domain.anchorSelector);
        if (anchor) {
            injectTrigger(domain, anchor, entityId);
            return true;
        }
        return false;
    }

    function startPolling(domain, entityId) {
        const key = domain.entityType;
        if (pollTimers[key]) clearInterval(pollTimers[key]);
        let attempts = 0;
        pollTimers[key] = setInterval(() => {
            attempts++;
            if (tryInject(domain, entityId) || attempts >= 40) {
                clearInterval(pollTimers[key]);
                pollTimers[key] = null;
            }
        }, 100);
    }

    function onLocationChange() {
        const path = window.location.pathname;
        for (const domain of DOMAINS) {
            const key = domain.entityType;
            const m = path.match(domain.urlPattern);
            if (m && !path.includes('edit')) {
                const entityId = m[1];
                if (path !== lastPaths[key]) {
                    lastPaths[key] = path;
                    const existing = document.querySelector('#' + domain.triggerId);
                    if (existing) existing.remove();
                    startPolling(domain, entityId);
                }
                // Clear other domain state since URL doesn't match it
                for (const other of DOMAINS) {
                    if (other !== domain) {
                        lastPaths[other.entityType] = null;
                        if (pollTimers[other.entityType]) {
                            clearInterval(pollTimers[other.entityType]);
                            pollTimers[other.entityType] = null;
                        }
                        const oex = document.querySelector('#' + other.triggerId);
                        if (oex) oex.remove();
                    }
                }
                return;
            }
        }
        // No domain matched — clear everything.
        for (const domain of DOMAINS) {
            const key = domain.entityType;
            lastPaths[key] = null;
            if (pollTimers[key]) { clearInterval(pollTimers[key]); pollTimers[key] = null; }
            const existing = document.querySelector('#' + domain.triggerId);
            if (existing) existing.remove();
        }
    }

    PluginApi.Event.addEventListener('stash:location', onLocationChange);
    onLocationChange();

    function injectTrigger(domain, anchor, entityId) {
        const triggerBtn = document.createElement('button');
        triggerBtn.id = domain.triggerId;
        // Wrap both glyphs in spans so themes (e.g. Refract) can target ★ and
        // + individually. SVG plus keeps the icon centred in the pill.
        triggerBtn.innerHTML =
            '<span class="adv-rating-btn-star" style="color:#ffc107;">★</span>' +
            '<span class="adv-rating-btn-plus">' +
                "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true'>" +
                "<path d='M6 12H18M12 6V18' stroke='currentColor' " +
                    "stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/>" +
                "</svg>" +
            '</span>';
        triggerBtn.title = domain.triggerTitle;
        triggerBtn.className = 'adv-rating-btn';
        anchor.insertAdjacentElement('afterend', triggerBtn);
        triggerBtn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation(); openModal(domain, entityId);
        });
        annotateUnratedCount(domain, triggerBtn, entityId);
        if (domain.hasFavourite) {
            injectFavouriteBtn(triggerBtn, entityId);
        }
    }

    async function annotateUnratedCount(domain, triggerBtn, entityId) {
        try {
            const [{ groups, criteria }, entityTags] = await Promise.all([
                getRatingModel(domain),
                domain.fetchEntityTags(entityId),
            ]);
            if (!triggerBtn.isConnected) return;
            const breakdown = computeBreakdown(entityTags, groups, criteria, 10);
            if (breakdown.totalUnrated === 0) {
                triggerBtn.title = domain.triggerHelpStrings.allRated;
                return;
            }
            triggerBtn.classList.add('adv-rating-btn--incomplete');
            if (breakdown.totalRated > 0) {
                triggerBtn.classList.add('adv-rating-btn--partial');
                triggerBtn.title = domain.triggerHelpStrings.partial(breakdown.totalUnrated, breakdown.totalCriteria);
            } else {
                triggerBtn.title = domain.triggerHelpStrings.unrated(breakdown.totalCriteria);
            }
            const badge = document.createElement('span');
            badge.className = 'adv-rating-btn-badge';
            badge.innerText = breakdown.totalUnrated;
            triggerBtn.appendChild(badge);
        } catch (e) {
            console.warn("[advancedRating] annotate failed (" + domain.entityType + ")", e);
        }
    }

    async function openModal(domain, entityId) {
        if (document.querySelector('#' + domain.modalId)) return;
        const modalOverlay = document.createElement('div');
        modalOverlay.id = domain.modalId;
        modalOverlay.className = 'adv-rating-modal-overlay';
        const modalContent = document.createElement('div');
        modalContent.className = 'adv-rating-modal-content';
        // Use a domain-scoped close class so both modals don't share one selector.
        const closeClass = domain.entityType === "scene" ? "adv-rating-close" : "perf-rating-close";
        modalContent.innerHTML = `
            <div class="adv-rating-header">
                <div>
                    <h3>${domain.modalTitle}</h3>
                    <div class="adv-rating-subhead"></div>
                </div>
                <span class="${closeClass}">&times;</span>
            </div>
            <div class="ratings-list">Loading…</div>
            <div class="adv-rating-breakdown"></div>
        `;
        modalOverlay.appendChild(modalContent);
        document.body.appendChild(modalOverlay);
        const handleClose = () => { modalOverlay.remove(); window.location.reload(); };
        modalContent.querySelector('.' + closeClass).addEventListener('click', handleClose);
        modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) handleClose(); });

        const { groups, criteria } = await getRatingModel(domain);
        const precision = (await getStashRatingInfo()).precision;
        let entityTags = await domain.fetchEntityTags(entityId);

        function render() {
            const listContainer = modalContent.querySelector('.ratings-list');
            const subhead = modalContent.querySelector('.adv-rating-subhead');
            const breakdownEl = modalContent.querySelector('.adv-rating-breakdown');
            listContainer.innerHTML = '';

            const breakdown = computeBreakdown(entityTags, groups, criteria, precision);
            const currentScores = breakdown.scoresByCriterion;

            subhead.innerHTML = '';
            const summary = document.createElement('span');
            summary.className = 'adv-rating-summary';
            summary.innerText = `${breakdown.totalCriteria} criteria · ${breakdown.totalRated} rated`;
            if (breakdown.totalUnrated > 0) {
                summary.innerHTML += ` · <span class="adv-rating-unrated-pill">${breakdown.totalUnrated} unrated</span>`;
            }
            subhead.appendChild(summary);

            groups.forEach(g => {
                const groupCriteria = criteria.filter(c => c.group === g.id);
                if (!groupCriteria.length) return;
                // Scene: skip header when a single group is present so the
                // default modal is clean. Performer: always show.
                if (domain.modalShowsSingleGroupHeader || groups.length > 1) {
                    const groupHeader = document.createElement('div');
                    groupHeader.className = 'adv-rating-group-header';
                    groupHeader.innerText = g.name;
                    listContainer.appendChild(groupHeader);
                }
                groupCriteria.forEach(c => {
                    const prefix = tagPrefix(c);
                    const score = currentScores[c.id] !== undefined ? currentScores[c.id] : null;
                    const row = document.createElement('div');
                    row.className = 'rating-row' + (score === null ? ' rating-unrated' : '');
                    const label = document.createElement('span'); label.className = 'rating-label';
                    const labelText = document.createElement('span'); labelText.innerText = c.name; label.appendChild(labelText);
                    if (score === null) {
                        const pill = document.createElement('span'); pill.className = 'adv-rating-unrated-pill'; pill.innerText = 'unrated';
                        label.appendChild(pill);
                    }
                    const desc = c.description;
                    if (desc) {
                        const infoIcon = document.createElement('span'); infoIcon.className = 'rating-info-icon'; infoIcon.innerHTML = 'ⓘ';
                        const tooltip = document.createElement('div'); tooltip.className = 'rating-tooltip'; tooltip.innerText = desc;
                        infoIcon.appendChild(tooltip); label.appendChild(infoIcon);
                    }
                    const starsDiv = document.createElement('div'); starsDiv.className = 'rating-stars-modal';
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
                            if (await updateEntityCriterionTag(domain, entityId, entityTags, prefix, i)) {
                                entityTags = await domain.fetchEntityTags(entityId); render();
                            }
                            listContainer.style.opacity = '1';
                        });
                        starsDiv.appendChild(star);
                    }
                    const clearBtn = document.createElement('span'); clearBtn.className = 'rating-clear'; clearBtn.innerHTML = '×';
                    clearBtn.title = 'Remove Category Rating';
                    clearBtn.addEventListener('click', async () => {
                        listContainer.style.opacity = '0.5';
                        if (await updateEntityCriterionTag(domain, entityId, entityTags, prefix, null)) {
                            entityTags = await domain.fetchEntityTags(entityId); render();
                        }
                        listContainer.style.opacity = '1';
                    });
                    starsDiv.appendChild(clearBtn);
                    row.appendChild(label); row.appendChild(starsDiv); listContainer.appendChild(row);
                });
            });

            renderBreakdown(breakdownEl, breakdown);
        }

        function renderBreakdown(container, b) {
            container.innerHTML = '';
            const open = localStorage.getItem(domain.breakdownStorageKey) === '1';
            const heading = document.createElement('button');
            heading.type = 'button';
            heading.className = 'adv-rating-breakdown-heading' + (open ? ' open' : '');
            heading.innerHTML = `<span class="adv-rating-breakdown-caret">▶</span>Score breakdown`;
            container.appendChild(heading);

            const body = document.createElement('div');
            body.className = 'adv-rating-breakdown-body' + (open ? ' open' : '');
            container.appendChild(body);

            heading.addEventListener('click', () => {
                const nowOpen = !heading.classList.contains('open');
                heading.classList.toggle('open', nowOpen);
                body.classList.toggle('open', nowOpen);
                localStorage.setItem(domain.breakdownStorageKey, nowOpen ? '1' : '0');
            });

            if (b.totalRated === 0) {
                const empty = document.createElement('div');
                empty.className = 'adv-rating-breakdown-empty';
                empty.innerText = 'Rate at least one criterion to see the calculation.';
                body.appendChild(empty);
                return;
            }
            b.groupRows.forEach(row => {
                if (!row.criteriaInGroup.length) return;
                const groupBlock = document.createElement('div');
                groupBlock.className = 'adv-rating-breakdown-group';
                const head = document.createElement('div');
                head.className = 'adv-rating-breakdown-group-head';
                const name = document.createElement('span');
                name.className = 'adv-rating-breakdown-name';
                name.innerText = row.group.name;
                head.appendChild(name);
                const weightBadge = document.createElement('span');
                weightBadge.className = 'adv-rating-breakdown-weight';
                weightBadge.innerText = 'group weight: ' + row.group.weight;
                head.appendChild(weightBadge);
                groupBlock.appendChild(head);
                if (row.rated.length === 0) {
                    const noScore = document.createElement('div');
                    noScore.className = 'adv-rating-breakdown-empty';
                    noScore.innerText = 'No rated criteria in this group — skipped.';
                    groupBlock.appendChild(noScore);
                } else {
                    const terms = row.rated.map(c => `${row.scoresByCriterion[c.id]}×${c.weight}`);
                    const formula = document.createElement('div');
                    formula.className = 'adv-rating-breakdown-formula';
                    formula.innerHTML = `(${terms.join(' + ')}) ÷ ${row.totalWeight} = <b>${row.avg.toFixed(2)}</b>`;
                    groupBlock.appendChild(formula);
                    if (row.unrated.length) {
                        const note = document.createElement('div');
                        note.className = 'adv-rating-breakdown-note';
                        note.innerText = `${row.unrated.length} unrated: ${row.unrated.map(c => c.name).join(', ')}`;
                        groupBlock.appendChild(note);
                    }
                }
                body.appendChild(groupBlock);
            });
            const finalBlock = document.createElement('div');
            finalBlock.className = 'adv-rating-breakdown-final';
            if (b.contributingGroups.length && b.finalAvg !== null) {
                const finalTerms = b.contributingGroups.map(r => `${r.avg.toFixed(2)}×${r.group.weight}`);
                finalBlock.innerHTML = `<b>Final:</b> (${finalTerms.join(' + ')}) ÷ ${b.totalGroupWeight} = <b>${b.finalAvg.toFixed(2)}</b>/5 → <b>${b.rating100}</b>/100`;
            } else {
                finalBlock.innerText = 'No contributing groups — rating not updated.';
            }
            body.appendChild(finalBlock);
        }

        render();
    }

    /* ─────────────────────────────────────────────────────────────────
       SCENE-ONLY: favourite button system
       (heart on the scene-detail page + scene-card thumbnails)
       ───────────────────────────────────────────────────────────────── */
    const FAVOURITE_TAG_NAME = "Favourite ★";

    function injectFavouriteBtn(anchorBtn, sceneId) {
        const btn = document.createElement('button');
        btn.id = 'adv-favourite-trigger';
        btn.className = 'adv-favourite-btn';
        btn.type = 'button';
        btn.innerHTML = "<svg viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'>" +
            "<path d='M12 21s-7.5-4.5-10-9.5C.5 7 3.5 3 7.5 3c2 0 3.4 1 4.5 2.5C13.1 4 14.5 3 16.5 3 20.5 3 23.5 7 22 11.5 19.5 16.5 12 21 12 21z'/>" +
            "</svg>";
        btn.title = "Loading…";
        anchorBtn.insertAdjacentElement('afterend', btn);

        sceneDomain.fetchEntityTags(sceneId).then(function (tags) {
            if (!btn.isConnected) return;
            applyFavouriteState(btn, isSceneFavourite(tags));
        }).catch(function (e) {
            console.warn("[advancedRating] favourite init failed", e);
        });

        btn.addEventListener('click', async function (e) {
            e.preventDefault(); e.stopPropagation();
            if (btn.dataset.busy === "1") return;
            btn.dataset.busy = "1";
            try {
                const tags = await sceneDomain.fetchEntityTags(sceneId);
                const currentlyOn = isSceneFavourite(tags);
                await setSceneFavourite(sceneId, tags, !currentlyOn);
                applyFavouriteState(btn, !currentlyOn);
            } catch (err) {
                console.error("[advancedRating] favourite toggle failed", err);
                alert("Failed to toggle favourite: " + err.message);
            } finally {
                btn.dataset.busy = "0";
            }
        });
    }

    function isSceneFavourite(sceneTags) {
        return (sceneTags || []).some(function (t) { return t.name === FAVOURITE_TAG_NAME; });
    }

    function applyFavouriteState(btn, on) {
        btn.classList.toggle('adv-favourite-btn--on', on);
        btn.title = on ? "Remove favourite" : "Mark as favourite";
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    async function setSceneFavourite(sceneId, sceneTags, on) {
        const existingIds = (sceneTags || []).map(function (t) { return t.id; });
        if (on) {
            const { id: favId } = await findOrCreateTag(FAVOURITE_TAG_NAME, null);
            if (existingIds.indexOf(favId) !== -1) return;
            const newTagIds = existingIds.concat([favId]);
            await sceneDomain.updateEntityTags(sceneId, newTagIds);
        } else {
            const favTag = (sceneTags || []).find(function (t) { return t.name === FAVOURITE_TAG_NAME; });
            if (!favTag) return;
            const newTagIds = existingIds.filter(function (id) { return id !== favTag.id; });
            await sceneDomain.updateEntityTags(sceneId, newTagIds);
        }
    }

    /* ── Scene-card favourite buttons ──────────────────────────────── */
    let favouriteIdsCache = null;
    let cardSyncTimer = null;
    let cardObserver = null;

    async function refreshFavouriteSet() {
        try {
            const tagId = await getTagIdByName(FAVOURITE_TAG_NAME);
            if (!tagId) {
                favouriteIdsCache = new Set();
                return favouriteIdsCache;
            }
            const res = await gqlClient(
                `query FindFavouriteScenes($filter: SceneFilterType) {
                    findScenes(scene_filter: $filter, filter: {per_page: -1}) {
                        scenes { id }
                    }
                }`,
                { filter: { tags: { value: [tagId], modifier: "INCLUDES_ALL" } } }
            );
            const scenes = (res.data && res.data.findScenes && res.data.findScenes.scenes) || [];
            favouriteIdsCache = new Set(scenes.map(function (s) { return s.id; }));
        } catch (e) {
            console.warn("[advancedRating] could not load favourite list", e);
            if (!favouriteIdsCache) favouriteIdsCache = new Set();
        }
        return favouriteIdsCache;
    }

    function extractSceneIdFromCard(card) {
        const link = card.querySelector("a[href*='/scenes/']");
        if (!link) return null;
        const m = (link.getAttribute("href") || "").match(/\/scenes\/(\d+)/);
        return m ? m[1] : null;
    }

    function injectCardFavouriteBtn(card) {
        if (card.querySelector(":scope > .adv-favourite-card-btn")) return;
        const sceneId = extractSceneIdFromCard(card);
        if (!sceneId) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'adv-favourite-btn adv-favourite-card-btn';
        btn.dataset.sceneId = sceneId;
        btn.innerHTML = "<svg viewBox='0 0 24 24' fill='currentColor' aria-hidden='true'>" +
            "<path d='M12 21s-7.5-4.5-10-9.5C.5 7 3.5 3 7.5 3c2 0 3.4 1 4.5 2.5C13.1 4 14.5 3 16.5 3 20.5 3 23.5 7 22 11.5 19.5 16.5 12 21 12 21z'/>" +
            "</svg>";
        btn.title = "Mark as favourite";
        btn.setAttribute('aria-pressed', 'false');
        const isOn = favouriteIdsCache && favouriteIdsCache.has(sceneId);
        if (isOn) applyFavouriteState(btn, true);
        card.appendChild(btn);
        btn.addEventListener('click', async function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (btn.dataset.busy === "1") return;
            btn.dataset.busy = "1";
            try {
                const tags = await sceneDomain.fetchEntityTags(sceneId);
                const currentlyOn = isSceneFavourite(tags);
                await setSceneFavourite(sceneId, tags, !currentlyOn);
                applyFavouriteState(btn, !currentlyOn);
                if (favouriteIdsCache) {
                    if (!currentlyOn) favouriteIdsCache.add(sceneId);
                    else favouriteIdsCache.delete(sceneId);
                }
            } catch (err) {
                console.error("[advancedRating] card favourite toggle failed", err);
                alert("Failed to toggle favourite: " + err.message);
            } finally {
                btn.dataset.busy = "0";
            }
        });
    }

    function syncCardFavouriteButtons() {
        document.querySelectorAll('.scene-card').forEach(injectCardFavouriteBtn);
    }

    function scheduleCardSync() {
        if (cardSyncTimer) return;
        cardSyncTimer = setTimeout(function () {
            cardSyncTimer = null;
            syncCardFavouriteButtons();
        }, 80);
    }

    function initCardFavouriteButtons() {
        if (cardObserver) return;
        refreshFavouriteSet().finally(syncCardFavouriteButtons);
        cardObserver = new MutationObserver(scheduleCardSync);
        cardObserver.observe(document.body, { childList: true, subtree: true });
        PluginApi.Event.addEventListener('stash:location', function () {
            refreshFavouriteSet().finally(syncCardFavouriteButtons);
        });
    }
    initCardFavouriteButtons();

    /* ─────────────────────────────────────────────────────────────────
       SETTINGS PANEL: ONE component renders both domains, gated by
       PluginApi.patch.instead("PluginSettings") on plugin_id "advancedRating".
       ───────────────────────────────────────────────────────────────── */
    function buildSettingsPanel() {
        const R = PluginApi.React;
        return function AdvRatingSettings() {
            const [config, setConfig] = R.useState(null);
            const [sceneGroups, setSceneGroups] = R.useState(null);
            const [sceneCriteria, setSceneCriteria] = R.useState(null);
            const [performerGroups, setPerformerGroups] = R.useState(null);
            const [performerCriteria, setPerformerCriteria] = R.useState(null);
            const [general, setGeneral] = R.useState(null);
            const [loadError, setLoadError] = R.useState(null);
            const [savingState, setSavingState] = R.useState({ saving: false, message: null, kind: null, scope: null });
            const [editingDesc, setEditingDesc] = R.useState({ scene: null, performer: null });
            const [migrationStatus, setMigrationStatus] = R.useState(null); // null | "running" | "done" | "failed"

            function loadConfigInto(cfg, info) {
                const sg = groupsFromConfig(cfg, sceneDomain);
                const sc = criteriaFromConfig(cfg, sceneDomain, sg);
                const pg = groupsFromConfig(cfg, performerDomain);
                const pc = criteriaFromConfig(cfg, performerDomain, pg);
                setConfig(cfg);
                setSceneGroups(sg);
                setSceneCriteria(sc);
                setPerformerGroups(pg);
                setPerformerCriteria(pc);
                setGeneral({
                    allow_destructive_actions: coerceBool(cfg.allow_destructive_actions, false),
                    rating_precision: info.precision,
                    rating_precision_label: info.label,
                });
            }

            R.useEffect(function () {
                let cancelled = false;
                (async function () {
                    try {
                        const [cfg, info] = await Promise.all([getPluginConfig(), getStashRatingInfo()]);
                        if (cancelled) return;
                        if (!coerceBool(cfg.migration_done, false)) {
                            // Kick off the migration task; render banner while
                            // we wait for the Python side to flip migration_done.
                            setMigrationStatus("running");
                            const launched = await runMigrationTask();
                            if (!launched) {
                                if (!cancelled) {
                                    setMigrationStatus("failed");
                                    loadConfigInto(cfg, info);
                                }
                                return;
                            }
                            const migratedCfg = await pollUntilMigrationDone(5000);
                            if (cancelled) return;
                            if (migratedCfg) {
                                setMigrationStatus("done");
                                loadConfigInto(migratedCfg, info);
                            } else {
                                // Timed out — show config as-is with a warning.
                                setMigrationStatus("failed");
                                const refreshed = await getPluginConfig();
                                if (cancelled) return;
                                loadConfigInto(refreshed, info);
                            }
                        } else {
                            loadConfigInto(cfg, info);
                        }
                    } catch (e) {
                        if (cancelled) return;
                        setLoadError(String(e));
                    }
                })();
                return function () { cancelled = true; };
            }, []);

            function updateGeneral(patch) {
                setGeneral(function (cur) { return Object.assign({}, cur, patch); });
            }

            /* Poll Stash's rating-system setting while panel is mounted. */
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

            /* ── Domain-scoped state mutators ─────────────────────────── */
            function getDomainState(domain) {
                if (domain === sceneDomain) {
                    return {
                        groups: sceneGroups, setGroups: setSceneGroups,
                        criteria: sceneCriteria, setCriteria: setSceneCriteria,
                    };
                }
                return {
                    groups: performerGroups, setGroups: setPerformerGroups,
                    criteria: performerCriteria, setCriteria: setPerformerCriteria,
                };
            }

            function updateCriterion(domain, idx, patch) {
                const { setCriteria } = getDomainState(domain);
                setCriteria(function (cur) {
                    const next = cur.slice();
                    next[idx] = Object.assign({}, next[idx], patch);
                    return next;
                });
            }
            function removeCriterion(domain, idx) {
                const { setCriteria } = getDomainState(domain);
                setCriteria(function (cur) { return cur.filter(function (_, i) { return i !== idx; }); });
            }
            function moveCriterion(domain, idx, dir) {
                const { setCriteria } = getDomainState(domain);
                setCriteria(function (cur) {
                    const j = idx + dir;
                    if (j < 0 || j >= cur.length) return cur;
                    const next = cur.slice();
                    const tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
                    return next;
                });
            }
            function addCriterion(domain) {
                const { groups, setCriteria } = getDomainState(domain);
                setCriteria(function (cur) {
                    const id = "custom_" + Date.now().toString(36);
                    const fallbackGroup = groups[0] ? groups[0].id : domain.defaultGroups[0].id;
                    return cur.concat([{ id, name: "New criterion", group: fallbackGroup, weight: 1, enabled: true, description: "" }]);
                });
            }
            function updateGroup(domain, idx, patch) {
                const { setGroups } = getDomainState(domain);
                setGroups(function (cur) {
                    const next = cur.slice();
                    next[idx] = Object.assign({}, next[idx], patch);
                    return next;
                });
            }
            function moveGroup(domain, idx, dir) {
                const { setGroups } = getDomainState(domain);
                setGroups(function (cur) {
                    const j = idx + dir;
                    if (j < 0 || j >= cur.length) return cur;
                    const next = cur.slice();
                    const tmp = next[idx]; next[idx] = next[j]; next[j] = tmp;
                    return next;
                });
            }
            function addGroup(domain) {
                const { setGroups } = getDomainState(domain);
                setGroups(function (cur) {
                    const id = "group_" + Date.now().toString(36);
                    return cur.concat([{ id, name: "New group", weight: 1 }]);
                });
            }
            function removeGroup(domain, idx) {
                const { groups, setGroups, criteria, setCriteria } = getDomainState(domain);
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
            function resetDefaults(domain) {
                const { setGroups, setCriteria } = getDomainState(domain);
                if (!confirm("Reset all " + domain.labelPlural.toLowerCase() + " groups and criteria to defaults?\nUnsaved edits will be lost.")) return;
                setGroups(domain.defaultGroups.map(function (d) { return Object.assign({}, d); }));
                setCriteria(domain.defaultCriteria.map(function (d) { return Object.assign({}, d, { description: domain.descriptions[d.id] || "" }); }));
            }

            function setEditingDescFor(domain, id) {
                setEditingDesc(function (cur) {
                    const next = Object.assign({}, cur);
                    next[domain.entityType] = id;
                    return next;
                });
            }

            async function recalcAll(domain) {
                const { groups, criteria } = getDomainState(domain);
                if (!confirm(domain.triggerHelpStrings.recalcConfirm)) return;
                setSavingState({ saving: true, message: domain.triggerHelpStrings.recalcLoadingMsg, kind: "info", scope: domain.entityType });
                try {
                    const res = await recalculateAll(domain, groups, criteria, function (done, total, updated) {
                        setSavingState({ saving: true, message: "Processed " + done + " / " + total + " (" + updated + " updated)", kind: "info", scope: domain.entityType });
                    });
                    setSavingState({ saving: false, message: "Recalc complete: " + res.updated + " updated, " + res.skipped + " unchanged of " + res.total + ".", kind: "success", scope: domain.entityType });
                } catch (e) {
                    setSavingState({ saving: false, message: "Recalc failed: " + (e && e.message ? e.message : e), kind: "error", scope: domain.entityType });
                }
            }

            async function removeOrphans(domain) {
                const { criteria } = getDomainState(domain);
                if (!general || !general.allow_destructive_actions) {
                    alert("Enable \"Allow Destructive Actions\" first.");
                    return;
                }
                setSavingState({ saving: true, message: "Scanning for orphaned tags…", kind: "info", scope: domain.entityType });
                try {
                    const { parentMissing, orphans } = await findOrphanCriterionTags(domain, criteria);
                    if (parentMissing) {
                        setSavingState({ saving: false, message: "No rating tags found — nothing to scan.", kind: "info", scope: domain.entityType });
                        return;
                    }
                    if (!orphans.length) {
                        setSavingState({ saving: false, message: "No orphaned tags found.", kind: "success", scope: domain.entityType });
                        return;
                    }
                    const lines = orphans.map(o => "  • " + o.name + " (+ " + o.childCount + " child tag(s))");
                    const msg = "Found " + orphans.length + " orphaned criterion tag(s):\n\n" + lines.join("\n") + "\n\nDelete these and their 0–5 children from Stash?";
                    if (!confirm(msg)) {
                        setSavingState({ saving: false, message: "Cancelled.", kind: "info", scope: domain.entityType });
                        return;
                    }
                    const destroyed = await destroyOrphanSubtrees(orphans);
                    setSavingState({ saving: false, message: "Deleted " + destroyed + " orphaned tag(s).", kind: "success", scope: domain.entityType });
                } catch (e) {
                    setSavingState({ saving: false, message: "Scan failed: " + (e && e.message ? e.message : e), kind: "error", scope: domain.entityType });
                }
            }

            async function deleteAllTags(domain) {
                const { criteria } = getDomainState(domain);
                if (!general || !general.allow_destructive_actions) {
                    alert("Enable \"Allow Destructive Actions\" first.");
                    return;
                }
                if (!confirm(domain.triggerHelpStrings.deleteAllConfirm)) return;
                if (!confirm("Really delete? Last chance.")) return;
                setSavingState({ saving: true, message: "Deleting tags…", kind: "info", scope: domain.entityType });
                try {
                    const destroyed = await destroyAllRatingTags(domain, criteria);
                    setSavingState({ saving: false, message: "Deleted " + destroyed + " tag(s). Run Save to recreate.", kind: "success", scope: domain.entityType });
                } catch (e) {
                    setSavingState({ saving: false, message: "Delete failed: " + (e && e.message ? e.message : e), kind: "error", scope: domain.entityType });
                }
            }

            async function save(domain) {
                const { groups, criteria } = getDomainState(domain);
                setSavingState({ saving: true, message: "Saving…", kind: "info", scope: domain.entityType });
                try {
                    if (!groups.length) throw new Error("At least one group is required");
                    const gids = groups.map(function (g) { return g.id; });
                    const gdupes = gids.filter(function (id, i) { return gids.indexOf(id) !== i; });
                    if (gdupes.length) throw new Error("Duplicate group ids: " + gdupes.join(", "));
                    const validGroupIds = new Set(gids);
                    for (const g of groups) {
                        if (!g.name || !g.name.trim()) throw new Error("Every group needs a name");
                        if (!Number.isFinite(g.weight) || g.weight < 0) throw new Error("Group weight must be a non-negative number");
                    }
                    const ids = criteria.map(function (c) { return c.id; });
                    const dupes = ids.filter(function (id, i) { return ids.indexOf(id) !== i; });
                    if (dupes.length) throw new Error("Duplicate criterion ids: " + dupes.join(", "));
                    for (const c of criteria) {
                        if (!c.name || !c.name.trim()) throw new Error("Every criterion needs a name");
                        if (!Number.isFinite(c.weight) || c.weight < 0) throw new Error("Weight must be a non-negative number");
                        if (!validGroupIds.has(c.group)) throw new Error("Criterion \"" + c.name + "\" references unknown group \"" + c.group + "\"");
                    }

                    // Diff vs. saved config for tag-rename detection (per-domain)
                    const beforeCfg = await getPluginConfig();
                    const beforeGroups = groupsFromConfig(beforeCfg, domain);
                    const before = criteriaFromConfig(beforeCfg, domain, beforeGroups);
                    const renames = [];
                    for (const next of criteria) {
                        const prev = before.find(function (p) { return p.id === next.id; });
                        if (prev && prev.name.trim() !== next.name.trim()) {
                            renames.push({ from: tagPrefix(prev), to: tagPrefix(next) });
                        }
                    }

                    const configInput = configFromState(domain, groups, criteria);
                    if (general) {
                        configInput.allow_destructive_actions = !!general.allow_destructive_actions;
                    }
                    // Stash's configurePlugin REPLACES the whole plugin config map rather
                    // than merging into it, so saving one domain would otherwise wipe the
                    // other domain's keys (and any unrelated settings), reverting them to
                    // defaults. Start from the existing saved config, drop only this
                    // domain's keys (clears stale entries for deleted criteria/groups),
                    // then overlay the new ones.
                    const merged = {};
                    for (const k in beforeCfg) {
                        if (!k.startsWith(domain.prefix)) merged[k] = beforeCfg[k];
                    }
                    Object.assign(merged, configInput);
                    await configurePlugin(merged);

                    let renameSummary = "";
                    if (renames.length) {
                        const rootTagId = await getTagIdByName(domain.rootTagName);
                        if (rootTagId) {
                            let renamedCount = 0;
                            for (const rn of renames) {
                                const result = await renameRatingTags(rn.from, rn.to, rootTagId);
                                if (result.renamedAny) renamedCount++;
                            }
                            if (renamedCount) renameSummary = " Renamed " + renamedCount + " tag group(s).";
                        }
                    }

                    const created = await createMissingTags(domain, criteria);
                    const createPieces = [];
                    if (created.createdParent) createPieces.push("parent tag");
                    if (created.createdCategories) createPieces.push(created.createdCategories + " criterion tag(s)");
                    if (created.createdLevels) createPieces.push(created.createdLevels + " level tag(s)");
                    const createSummary = createPieces.length ? " Created " + createPieces.join(", ") + "." : "";

                    setSavingState({ saving: false, message: "Saved." + renameSummary + createSummary, kind: "success", scope: domain.entityType });
                } catch (e) {
                    setSavingState({ saving: false, message: "Save failed: " + (e && e.message ? e.message : e), kind: "error", scope: domain.entityType });
                }
            }

            /* ─── Render helpers (per-domain blocks) ─────────────────── */
            function renderDomainSection(domain) {
                const { groups, criteria } = getDomainState(domain);
                if (!groups || !criteria) return null;
                const idPrefix = domain.descIdPrefix; // "scene-" or "performer-"
                const editingDescId = editingDesc[domain.entityType];

                const groupRows = groups.map(function (g, idx) {
                    const usingCount = criteria.filter(function (c) { return c.group === g.id; }).length;
                    return R.createElement("div", {
                        key: idPrefix + "g-" + g.id,
                        className: "setting apr-group-row",
                    },
                        R.createElement("div", { className: "apr-group-main" },
                            R.createElement("input", {
                                type: "text",
                                className: "form-control apr-group-name-input",
                                value: g.name,
                                placeholder: "Group name",
                                onChange: function (e) { updateGroup(domain, idx, { name: e.target.value }); },
                            }),
                            R.createElement("input", {
                                type: "number",
                                className: "form-control apr-group-weight-input",
                                value: g.weight,
                                min: 0,
                                step: 0.5,
                                title: "Group weight in the final score",
                                onChange: function (e) { updateGroup(domain, idx, { weight: coerceFloat(e.target.value, 1) }); },
                            }),
                            R.createElement("span", { className: "apr-group-usage" },
                                usingCount + " criterion" + (usingCount === 1 ? "" : "ia")),
                            R.createElement("div", { className: "apr-row-actions" },
                                R.createElement("button", { type: "button", className: "btn btn-secondary btn-sm", title: "Move up", disabled: idx === 0, onClick: function () { moveGroup(domain, idx, -1); } }, "↑"),
                                R.createElement("button", { type: "button", className: "btn btn-secondary btn-sm", title: "Move down", disabled: idx === groups.length - 1, onClick: function () { moveGroup(domain, idx, 1); } }, "↓"),
                                R.createElement("button", { type: "button", className: "btn btn-danger btn-sm", title: "Delete group", disabled: groups.length <= 1, onClick: function () { removeGroup(domain, idx); } }, "×"))));
                });

                const rows = criteria.map(function (c, idx) {
                    const isEditingDesc = editingDescId === c.id;
                    const previewDesc = c.description || "";
                    return R.createElement("div", {
                        key: idPrefix + "c-" + c.id,
                        className: "setting apr-criterion-row" + (c.enabled ? "" : " apr-disabled"),
                    },
                        R.createElement("div", { className: "apr-criterion-main" },
                            R.createElement("div", { className: "apr-criterion-toggle" },
                                R.createElement("div", { className: "custom-control custom-switch" },
                                    R.createElement("input", {
                                        type: "checkbox",
                                        className: "custom-control-input",
                                        id: idPrefix + "apr-enabled-" + c.id,
                                        checked: !!c.enabled,
                                        onChange: function (e) { updateCriterion(domain, idx, { enabled: e.target.checked }); },
                                    }),
                                    R.createElement("label", {
                                        className: "custom-control-label",
                                        htmlFor: idPrefix + "apr-enabled-" + c.id,
                                    }))),
                            R.createElement("input", {
                                type: "text",
                                className: "form-control apr-name-input",
                                value: c.name,
                                placeholder: "Display name",
                                onChange: function (e) { updateCriterion(domain, idx, { name: e.target.value }); },
                            }),
                            R.createElement("select", {
                                className: "form-control apr-group-select",
                                value: c.group,
                                onChange: function (e) { updateCriterion(domain, idx, { group: e.target.value }); },
                            }, groups.map(function (g) {
                                return R.createElement("option", { key: g.id, value: g.id }, g.name);
                            })),
                            R.createElement("input", {
                                type: "number",
                                className: "form-control apr-weight-input",
                                value: c.weight,
                                min: 0,
                                step: 0.5,
                                onChange: function (e) { updateCriterion(domain, idx, { weight: coerceFloat(e.target.value, 1) }); },
                            }),
                            R.createElement("div", { className: "apr-row-actions" },
                                R.createElement("button", {
                                    type: "button",
                                    className: "btn btn-secondary btn-sm" + (isEditingDesc ? " active" : ""),
                                    title: "Edit description",
                                    onClick: function () { setEditingDescFor(domain, isEditingDesc ? null : c.id); },
                                }, "✎"),
                                R.createElement("button", { type: "button", className: "btn btn-secondary btn-sm", title: "Move up", disabled: idx === 0, onClick: function () { moveCriterion(domain, idx, -1); } }, "↑"),
                                R.createElement("button", { type: "button", className: "btn btn-secondary btn-sm", title: "Move down", disabled: idx === criteria.length - 1, onClick: function () { moveCriterion(domain, idx, 1); } }, "↓"),
                                R.createElement("button", {
                                    type: "button",
                                    className: "btn btn-danger btn-sm",
                                    title: "Remove criterion. Tags stay on disk — clean up with \"Remove orphaned tags\".",
                                    onClick: function () {
                                        if (confirm("Remove criterion \"" + c.name + "\" from this configuration?\nIts tags stay on disk; use \"Remove orphaned tags\" later to clean them up.")) {
                                            removeCriterion(domain, idx);
                                        }
                                    },
                                }, "×"))),
                        isEditingDesc
                            ? R.createElement("div", { className: "apr-desc-editor" },
                                R.createElement("textarea", {
                                    className: "form-control apr-desc-textarea",
                                    rows: 4,
                                    placeholder: "Tooltip shown in the " + domain.triggerHelpStrings.modalSubject + " rating modal.",
                                    value: c.description || "",
                                    onChange: function (e) { updateCriterion(domain, idx, { description: e.target.value }); },
                                }),
                                R.createElement("div", { className: "apr-desc-editor-actions" },
                                    domain.descriptions[c.id] ? R.createElement("button", {
                                        type: "button",
                                        className: "btn btn-link btn-sm",
                                        title: "Reset to the bundled default for this criterion",
                                        onClick: function () { updateCriterion(domain, idx, { description: domain.descriptions[c.id] }); },
                                    }, "Reset to default") : null,
                                    R.createElement("button", {
                                        type: "button",
                                        className: "btn btn-secondary btn-sm",
                                        onClick: function () { setEditingDescFor(domain, null); },
                                    }, "Close")))
                            : (previewDesc ? R.createElement("div", { className: "apr-criterion-desc sub-heading" }, previewDesc) : null),
                    );
                });

                const showMsg = savingState.message && savingState.scope === domain.entityType;
                const msgClass = savingState.kind === "error" ? "apr-msg apr-msg-error"
                    : savingState.kind === "success" ? "apr-msg apr-msg-success"
                    : "apr-msg";

                return R.createElement(R.Fragment, { key: domain.entityType },
                    R.createElement("h2", { className: "apr-domain-heading", style: { marginTop: "1.5rem" } }, domain.labelPlural),
                    R.createElement("div", { className: "setting" },
                        R.createElement("div", null,
                            R.createElement("h3", null, "Groups"),
                            R.createElement("div", { className: "sub-heading" },
                                "Criteria are bucketed into groups; each group has its own weight. The final score is the weighted mean of each group's weighted-criterion average. With one group it's a flat weighted average; with several, group weights balance them. Groups with no enabled criteria for a given " + domain.triggerHelpStrings.modalSubject + " are skipped."))),
                    groupRows,
                    R.createElement("div", { className: "setting apr-add-row" },
                        R.createElement("button", { type: "button", className: "btn btn-primary", onClick: function () { addGroup(domain); } }, "+ Add group")),
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
                        R.createElement("button", { type: "button", className: "btn btn-primary", onClick: function () { addCriterion(domain); } }, "+ Add criterion")),
                    R.createElement("div", { className: "setting apr-actions" },
                        R.createElement("button", {
                            type: "button",
                            className: "btn btn-primary",
                            disabled: savingState.saving,
                            title: "Persist config; create missing tags; rename tags for renamed criteria",
                            onClick: function () { save(domain); },
                        }, "Save"),
                        R.createElement("button", {
                            type: "button",
                            className: "btn btn-secondary",
                            disabled: savingState.saving,
                            title: "Walk every " + domain.triggerHelpStrings.modalSubject + " and update its rating from existing tags",
                            onClick: function () { recalcAll(domain); },
                        }, "Recalculate all " + domain.labelPlural.toLowerCase()),
                        R.createElement("button", {
                            type: "button",
                            className: "btn btn-secondary",
                            disabled: savingState.saving,
                            onClick: function () { resetDefaults(domain); },
                        }, "Reset to defaults"),
                        R.createElement("button", {
                            type: "button",
                            className: "btn btn-warning",
                            disabled: savingState.saving,
                            title: "Find and delete rating tags whose criterion was renamed or removed from this config",
                            onClick: function () { removeOrphans(domain); },
                        }, "Remove orphaned tags"),
                        R.createElement("button", {
                            type: "button",
                            className: "btn btn-danger apr-danger-btn",
                            disabled: savingState.saving,
                            title: "Destroy parent + all criterion + level tags. Requires Allow Destructive Actions.",
                            onClick: function () { deleteAllTags(domain); },
                        }, "Delete all rating tags"),
                        showMsg ? R.createElement("span", { className: msgClass }, savingState.message) : null,
                    ));
            }

            /* ─── Top-level render ─────────────────────────────────── */
            if (loadError) {
                return R.createElement("div", { className: "plugin-settings" },
                    R.createElement("div", { className: "setting" },
                        R.createElement("div", null,
                            R.createElement("h3", null, "Advanced Rating"),
                            R.createElement("div", { className: "sub-heading" }, "Failed to load config: " + loadError))));
            }

            // Render migration banner if running
            const migrationBanner = migrationStatus === "running"
                ? R.createElement("div", { className: "setting apr-migration-banner" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Migrating settings from old plugins…"),
                        R.createElement("div", { className: "sub-heading" },
                            "Importing config from advancedSceneRating and advancedPerformerRating. This usually takes a few seconds.")))
                : migrationStatus === "failed"
                    ? R.createElement("div", { className: "setting apr-migration-banner apr-msg-error" },
                        R.createElement("div", null,
                            R.createElement("h3", null, "Migration didn't complete"),
                            R.createElement("div", { className: "sub-heading" },
                                "The one-shot import task didn't finish. You can still configure both sections below; re-open this panel to retry the import.")))
                    : null;

            // While loading or mid-migration, show banner + placeholder
            if (general === null || sceneCriteria === null || performerCriteria === null) {
                return R.createElement("div", { className: "plugin-settings apr-settings" },
                    migrationBanner,
                    R.createElement("div", { className: "setting" },
                        R.createElement("div", null, R.createElement("h3", null, "Loading…"))));
            }

            const generalSection = [
                R.createElement("div", { key: "g-prec", className: "setting" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Rating Star Precision"),
                        R.createElement("div", { className: "sub-heading" },
                            "Auto-matched to Stash's rating system setting (Settings → Interface → Editing → Rating System). Change it there and the value here updates within a few seconds.")),
                    R.createElement("div", { className: "apr-general-control" },
                        R.createElement("span", { className: "apr-readonly" },
                            general.rating_precision_label + " (" + general.rating_precision + ")"))),
                R.createElement("div", { key: "g-destr", className: "setting" },
                    R.createElement("div", null,
                        R.createElement("h3", null, "Allow Destructive Actions"),
                        R.createElement("div", { className: "sub-heading" },
                            "Required to use \"Remove orphaned tags\" and \"Delete all rating tags\" in either section. Use with caution.")),
                    R.createElement("div", { className: "apr-general-control" },
                        R.createElement("div", { className: "custom-control custom-switch" },
                            R.createElement("input", {
                                type: "checkbox",
                                className: "custom-control-input",
                                id: "adv-rating-allow-destr",
                                checked: !!general.allow_destructive_actions,
                                onChange: function (e) { updateGeneral({ allow_destructive_actions: e.target.checked }); },
                            }),
                            R.createElement("label", {
                                className: "custom-control-label",
                                htmlFor: "adv-rating-allow-destr",
                            })))),
            ];

            return R.createElement("div", { className: "plugin-settings apr-settings" },
                migrationBanner,
                generalSection,
                renderDomainSection(sceneDomain),
                renderDomainSection(performerDomain),
            );
        };
    }

    function registerSettingsPatch() {
        if (typeof PluginApi === "undefined" || !PluginApi.patch || !PluginApi.React) {
            setTimeout(registerSettingsPatch, 100);
            return;
        }
        const Panel = buildSettingsPanel();
        console.log("[advancedRating] registering PluginSettings patch");
        PluginApi.patch.instead("PluginSettings", function () {
            const args = Array.prototype.slice.call(arguments);
            const next = args.pop();
            const props = args[0];
            const incomingId = props && (props.pluginID || props.pluginId || props.id);
            if (incomingId !== PLUGIN_ID) {
                return next.apply(null, args);
            }
            return PluginApi.React.createElement(Panel);
        });
    }
    registerSettingsPatch();
})();
