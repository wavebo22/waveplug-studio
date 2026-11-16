// WaveLayer for Illustrator — the host side (ExtendScript, runs inside Illustrator).
//
// The panel (src/ai/, a CEP panel) calls WavePlugWL.call(op, args) through evalScript and gets
// one JSON string back: {"ok":true,"value":…} or {"ok":false,"error":"…"}.
//
// ExtendScript is ES3: no let / const / arrow functions, no JSON, no Array.prototype.indexOf /
// forEach / map, no String.prototype.trim, no trailing commas. tests/ai_host.test.ts checks this
// file for those and runs it against a model of Illustrator's object model (src/ai/fake.ts).
//
// Items are addressed by their place in the document, a key like "l0/l2/i5/i1": layers[0] →
// its sublayer layers[2] → pageItems[5] → that group's pageItems[1]. Keys come from the last
// `tree` / `search`; every change sends the name and kind it expects at that key along, and is
// refused when the document changed under it (the panel then reads the tree again).

var WavePlugWL = (function () {
    var LIMIT_CHILDREN = 400;
    /** one tree read lists at most this many nodes: past it, open containers say "N more" */
    var LIMIT_TREE = 3000;
    var budget = LIMIT_TREE;
    var LIMIT_SEARCH = 500;
    /** a search looks at this many items at most (ExtendScript is slow on huge documents) */
    var LIMIT_VISIT = 30000;
    var LINK_PREFIX = "wavelink:";

    // ── JSON out ──
    function q(s) {
        var out = "\"", i, c, code, hex;
        s = String(s);
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i);
            code = s.charCodeAt(i);
            if (c === "\"" || c === "\\") out += "\\" + c;
            else if (c === "\n") out += "\\n";
            else if (c === "\r") out += "\\r";
            else if (c === "\t") out += "\\t";
            else if (code < 32 || code === 0x2028 || code === 0x2029) {
                hex = code.toString(16);
                while (hex.length < 4) hex = "0" + hex;
                out += "\\u" + hex;
            } else out += c;
        }
        return out + "\"";
    }
    function json(v) {
        var parts = [], k, i;
        if (v === null || v === undefined) return "null";
        if (typeof v === "string") return q(v);
        if (typeof v === "number") return isFinite(v) ? String(v) : "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) parts.push(json(v[i]));
            return "[" + parts.join(",") + "]";
        }
        for (k in v) {
            if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] !== "function") parts.push(q(k) + ":" + json(v[k]));
        }
        return "{" + parts.join(",") + "}";
    }

    function has(list, x) {
        var i;
        for (i = 0; i < list.length; i++) if (list[i] === x) return true;
        return false;
    }
    function trim(s) {
        return String(s).replace(/^\s+|\s+$/g, "");
    }
    function doc() {
        if (!app.documents.length) throw new Error("没有打开的文档");
        return app.activeDocument;
    }
    function attempt(f, fallback) {
        try { return f(); } catch (e) { return fallback; }
    }

    // ── kinds and names ──
    var KINDS = {
        Layer: "layer", PathItem: "path", CompoundPathItem: "compound", GroupItem: "group", TextFrame: "text",
        PlacedItem: "placed", RasterItem: "raster", SymbolItem: "symbol", MeshItem: "mesh", PluginItem: "plugin",
        GraphItem: "graph", LegacyTextItem: "text", NonNativeItem: "other"
    };
    var DEFAULT_NAMES = {
        path: "<路径>", compound: "<复合路径>", group: "<编组>", text: "<文字>", placed: "<链接文件>", raster: "<图像>",
        symbol: "<符号>", mesh: "<网格>", plugin: "<插件对象>", graph: "<图表>", other: "<对象>", clip: "<剪切组>"
    };
    function kindOf(o) {
        var k = KINDS[o.typename];
        if (!k) return "other";
        if (k === "group" && attempt(function () { return o.clipped; }, false)) return "clip";
        return k;
    }
    function fileName(path) {
        var s = String(path), i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
        return i >= 0 ? s.substring(i + 1) : s;
    }
    /** what Illustrator's own Layers panel would call it */
    function label(o, kind) {
        var n = attempt(function () { return o.name; }, "");
        if (n) return n;
        if (kind === "text") {
            n = trim(attempt(function () { return o.contents; }, "")).replace(/[\r\n]+/g, " ");
            if (n) return n.length > 40 ? n.substring(0, 40) + "…" : n;
        }
        if (kind === "placed") {
            n = attempt(function () { return fileName(o.file.fsName); }, "");
            if (n) return n;
        }
        if (kind === "symbol") {
            n = attempt(function () { return o.symbol.name; }, "");
            if (n) return n;
        }
        return DEFAULT_NAMES[kind] || "<对象>";
    }
    function hex2(n) {
        var s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
        return s.length < 2 ? "0" + s : s;
    }
    function rgbHex(r, g, b) {
        return "#" + hex2(r) + hex2(g) + hex2(b);
    }
    function colorHex(c) {
        if (!c) return null;
        var t = c.typename;
        if (t === "RGBColor") return rgbHex(c.red, c.green, c.blue);
        if (t === "GrayColor") return rgbHex(255 - c.gray * 2.55, 255 - c.gray * 2.55, 255 - c.gray * 2.55);
        if (t === "CMYKColor") {
            var k = 1 - c.black / 100;
            return rgbHex(255 * (1 - c.cyan / 100) * k, 255 * (1 - c.magenta / 100) * k, 255 * (1 - c.yellow / 100) * k);
        }
        if (t === "SpotColor") return attempt(function () { return colorHex(c.spot.color); }, null);
        if (t === "GradientColor") return "gradient";
        if (t === "PatternColor") return "pattern";
        return null;
    }
    function fillOf(o, kind) {
        return attempt(function () {
            if (kind === "path") return o.filled ? colorHex(o.fillColor) : null;
            if (kind === "compound") return o.pathItems.length && o.pathItems[0].filled ? colorHex(o.pathItems[0].fillColor) : null;
            return null;
        }, null);
    }
    /** the artboard a link was sent with as its page ("wavelink:ID;page=2"), else null */
    function linkPage(o) {
        var note = attempt(function () { return String(o.note || ""); }, ""), m = note.match(/wavelink:[^\s;]*;page=(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }
    /** the link was sent bare (画板 → Photoshop: the Photoshop layer has its opacity / blend mode) */
    function linkBare(o) {
        var note = attempt(function () { return String(o.note || ""); }, "");
        return /wavelink:[^\s]*;bare/.test(note);
    }
    function linkOf(o) {
        var note = attempt(function () { return String(o.note || ""); }, ""), i = note.indexOf(LINK_PREFIX), rest;
        if (i < 0) return null;
        rest = note.substring(i + LINK_PREFIX.length);
        return rest.split(/[\s;]/)[0] || null;
    }

    // ── keys ──
    function resolve(key) {
        var segs = String(key).split("/"), cur = doc(), i, s, n, kind;
        for (i = 0; i < segs.length; i++) {
            s = segs[i];
            kind = s.charAt(0);
            n = parseInt(s.substring(1), 10);
            if (isNaN(n)) throw new Error("bad key " + key);
            if (kind === "l") cur = cur.layers[n];
            else if (kind === "i") cur = cur.pageItems[n];
            else if (kind === "p") cur = cur.pathItems[n];
            else throw new Error("bad key " + key);
            if (!cur) throw new Error("图层已变化，请刷新");
        }
        return cur;
    }
    /** the object at `t.key`, checked against the name and kind the panel saw there */
    function target(t) {
        var o = resolve(t.key);
        if (t.expect) {
            var kind = kindOf(o);
            if ((t.expect.kind && t.expect.kind !== kind) || (t.expect.label !== undefined && t.expect.label !== label(o, kind)))
                throw new Error("图层已变化，请刷新后再试");
        }
        return o;
    }
    function targets(list) {
        var out = [], i;
        for (i = 0; i < list.length; i++) out.push({ key: list[i].key, obj: target(list[i]) });
        return out;
    }
    function depth(key) {
        return String(key).split("/").length;
    }
    function parentKey(key) {
        var s = String(key), i = s.lastIndexOf("/");
        return i < 0 ? null : s.substring(0, i);
    }

    /** a layer's direct children in z-order (front first): sublayers and items mixed, as in
     *  Illustrator's own panel when it can be told, else sublayers first */
    function children(o, kind) {
        var out = [], i, c, z, sorted = true, seen = {};
        if (kind === "layer") {
            for (i = 0; i < o.layers.length; i++) out.push({ obj: o.layers[i], seg: "l" + i });
            for (i = 0; i < o.pageItems.length; i++) out.push({ obj: o.pageItems[i], seg: "i" + i });
            // only worth it when both kinds are there; the document-wide position first, then the
            // position among siblings, else sublayers first
            if (o.layers.length && o.pageItems.length) {
                var props = ["absoluteZOrderPosition", "zOrderPosition"], pi;
                for (pi = 0; pi < props.length; pi++) {
                    sorted = true;
                    seen = {};
                    for (i = 0; i < out.length; i++) {
                        c = out[i];
                        z = attempt(function () { return c.obj[props[pi]]; }, null);
                        if (typeof z !== "number" || seen[z]) { sorted = false; break; }
                        seen[z] = true;
                        c.z = z;
                    }
                    if (sorted) break;
                }
                if (sorted) out.sort(function (a, b) { return b.z - a.z; });
            }
        } else if (kind === "group" || kind === "clip") {
            for (i = 0; i < o.pageItems.length; i++) out.push({ obj: o.pageItems[i], seg: "i" + i });
        }
        return out;
    }
    function childCount(o, kind) {
        if (kind === "layer") return o.layers.length + o.pageItems.length;
        if (kind === "group" || kind === "clip") return o.pageItems.length;
        return 0;
    }

    function node(o, key, open) {
        var kind = kindOf(o), n, list, i, max;
        budget--;
        if (kind === "layer") {
            n = {
                key: key, kind: kind, label: o.name, name: o.name,
                hidden: !o.visible, locked: o.locked,
                sel: attempt(function () { return o.hasSelectedArtwork; }, false),
                color: attempt(function () { return colorHex(o.color); }, null),
                count: childCount(o, kind),
                printable: attempt(function () { return o.printable; }, true),
                preview: attempt(function () { return o.preview; }, true)
            };
        } else {
            n = {
                key: key, kind: kind, label: label(o, kind), name: attempt(function () { return o.name; }, ""),
                hidden: attempt(function () { return o.hidden; }, false), locked: attempt(function () { return o.locked; }, false),
                sel: attempt(function () { return o.selected; }, false),
                fill: fillOf(o, kind), count: childCount(o, kind),
                mask: attempt(function () { return o.clipping === true; }, false),
                link: linkOf(o)
            };
            // Illustrator throws on .file when the linked file is gone
            if (kind === "placed") n.missing = attempt(function () { return !o.file.exists; }, true);
        }
        if (n.count && open[key]) {
            list = children(o, kind);
            max = Math.max(0, Math.min(list.length, LIMIT_CHILDREN, budget));
            n.children = [];
            for (i = 0; i < max; i++) n.children.push(node(list[i].obj, key + "/" + list[i].seg, open));
            if (list.length > max) n.more = list.length - max;
        }
        return n;
    }

    // ── reading ──
    function sig() {
        if (!app.documents.length) return "none";
        var d = app.activeDocument, parts = [attempt(function () { return d.fullName.fsName; }, d.name), d.layers.length, d.selection.length], i, l;
        parts.push(attempt(function () { return d.activeLayer.name; }, ""));
        parts.push(attempt(function () { return d.artboards.getActiveArtboardIndex(); }, 0));
        for (i = 0; i < d.layers.length && i < 60; i++) {
            l = d.layers[i];
            parts.push(l.name + (l.visible ? "v" : "h") + (l.locked ? "l" : "u") + (l.layers.length + l.pageItems.length));
        }
        return parts.join("|");
    }

    function tree(a) {
        if (!app.documents.length) return { doc: null };
        var d = app.activeDocument, open = {}, i, out = [], active = null, boards = [];
        budget = LIMIT_TREE;
        for (i = 0; i < (a.open || []).length; i++) open[a.open[i]] = true;
        for (i = 0; i < d.layers.length; i++) {
            out.push(node(d.layers[i], "l" + i, open));
            if (attempt(function () { return d.activeLayer === d.layers[i] || d.activeLayer.name === d.layers[i].name; }, false) && active === null) active = "l" + i;
        }
        for (i = 0; i < d.artboards.length; i++) boards.push(d.artboards[i].name);
        return {
            doc: {
                name: d.name, path: attempt(function () { return d.fullName.fsName; }, ""), saved: attempt(function () { return d.saved; }, true),
                artboards: boards, artboard: attempt(function () { return d.artboards.getActiveArtboardIndex(); }, 0)
            },
            active: active, selCount: d.selection.length, layers: out
        };
    }

    /** the keys of selected items (and their containers), front to back, at most `limit` */
    function selectedKeys(limit) {
        var d = doc(), found = [], i;
        function walk(o, key, kind) {
            var list, j, c, ck;
            if (found.length >= limit) return;
            if (kind !== "layer" && attempt(function () { return o.selected; }, false)) {
                found.push(key);
                return;
            }
            if (kind === "layer" && !attempt(function () { return o.hasSelectedArtwork; }, true)) return;
            list = children(o, kind);
            for (j = 0; j < list.length; j++) {
                c = list[j].obj;
                ck = kindOf(c);
                if (ck === "layer" || ck === "group" || ck === "clip" || attempt(function () { return c.selected; }, false)) walk(c, key + "/" + list[j].seg, ck);
            }
        }
        for (i = 0; i < d.layers.length; i++) walk(d.layers[i], "l" + i, "layer");
        return found;
    }

    function reveal(a) {
        var keys = selectedKeys(a.limit || 200), open = {}, list = [], i, p;
        for (i = 0; i < keys.length; i++) {
            p = parentKey(keys[i]);
            while (p !== null) {
                if (!open[p]) { open[p] = true; list.push(p); }
                p = parentKey(p);
            }
        }
        return { keys: keys, open: list };
    }

    function search(a) {
        var d = doc(), text = String(a.text || "").toLowerCase(), kinds = a.kinds || [], flags = a.flags || [], out = [], truncated = false, visited = 0, i;
        function want(n) {
            if (text && n.label.toLowerCase().indexOf(text) < 0) return false;
            if (kinds.length && !has(kinds, n.kind)) return false;
            if (has(flags, "hidden") && !n.hidden) return false;
            if (has(flags, "locked") && !n.locked) return false;
            if (has(flags, "empty") && !((n.kind === "layer" || n.kind === "group") && n.count === 0)) return false;
            if (has(flags, "linked") && !n.link) return false;
            if (has(flags, "missing") && !n.missing) return false;
            return true;
        }
        function walk(o, key, trail) {
            var n, list, j;
            budget = LIMIT_TREE;
            if (out.length >= LIMIT_SEARCH || visited >= LIMIT_VISIT) { truncated = true; return; }
            visited++;
            n = node(o, key, {});
            if (want(n)) { n.trail = trail; out.push(n); }
            list = children(o, n.kind);
            for (j = 0; j < list.length; j++) walk(list[j].obj, key + "/" + list[j].seg, trail ? trail + " › " + n.label : n.label);
        }
        for (i = 0; i < d.layers.length; i++) walk(d.layers[i], "l" + i, "");
        return { results: out, truncated: truncated };
    }

    // ── selection ──
    function select(a) {
        var d = doc(), list = targets(a.targets || []), items = [], layers = [], i, o, failed = 0;
        for (i = 0; i < list.length; i++) (kindOf(list[i].obj) === "layer" ? layers : items).push(list[i].obj);
        if (!a.add) d.selection = null;
        if (layers.length && !items.length) {
            d.activeLayer = layers[0];
            if (a.art) for (i = 0; i < layers.length; i++) attempt(function () { layers[i].hasSelectedArtwork = true; return true; }, false);
            return { selected: 0, active: list[0].key };
        }
        for (i = 0; i < items.length; i++) {
            o = items[i];
            if (!attempt(function () { o.selected = a.toggle ? !o.selected : true; return true; }, false)) failed++;
        }
        return { selected: items.length - failed, failed: failed };
    }

    // ── changes ──
    function setProp(a) {
        var list = targets(a.targets), i, o, k;
        for (i = 0; i < list.length; i++) {
            o = list[i].obj;
            k = kindOf(o);
            if (a.prop === "hidden") { if (k === "layer") o.visible = !a.value; else o.hidden = a.value; }
            else if (a.prop === "locked") o.locked = a.value;
            else throw new Error("bad prop " + a.prop);
        }
        return { changed: list.length };
    }

    /** Alt+eye / Alt+lock: the same for every sibling of the row, the opposite for the row */
    function others(a) {
        var key = String(a.target.key), pk = parentKey(key), seg = pk === null ? key : key.substring(pk.length + 1), parent, list, i, c, k, on = 0;
        target(a.target);
        parent = pk === null ? doc() : resolve(pk);
        list = pk === null ? (function () { var r = [], j; for (j = 0; j < parent.layers.length; j++) r.push({ obj: parent.layers[j], seg: "l" + j }); return r; })() : children(parent, kindOf(parent));
        // already the only one shown / unlocked: undo it (everything back)
        for (i = 0; i < list.length; i++) {
            c = list[i].obj;
            if (list[i].seg === seg) continue;
            if (a.prop === "hidden" ? isHidden(c) : c.locked) on++;
        }
        var restore = on === list.length - 1 && list.length > 1;
        for (i = 0; i < list.length; i++) {
            c = list[i].obj;
            k = kindOf(c);
            var v = list[i].seg === seg ? false : !restore;
            attempt(function () {
                if (a.prop === "hidden") { if (k === "layer") c.visible = !v; else c.hidden = v; }
                else c.locked = v;
                return true;
            }, false);
        }
        return { restored: restore };
    }
    function isHidden(o) {
        return kindOf(o) === "layer" ? !o.visible : o.hidden;
    }

    function rename(a) {
        var list = a.items, i, o;
        for (i = 0; i < list.length; i++) {
            o = target(list[i]);
            o.name = String(list[i].name);
        }
        return { renamed: list.length };
    }

    function byDepthDesc(list) {
        list.sort(function (x, y) { return depth(y.key) - depth(x.key); });
        return list;
    }

    function remove(a) {
        var list = byDepthDesc(targets(a.targets)), i, n = 0, d = doc();
        for (i = 0; i < list.length; i++) {
            if (kindOf(list[i].obj) === "layer" && d.layers.length === 1 && depth(list[i].key) === 1) throw new Error("文档至少要保留一个图层");
            if (attempt(function () { list[i].obj.remove(); return true; }, false)) n++;
        }
        return { removed: n };
    }

    /** a copy of `layer` (with everything in it) placed `where` relative to `rel` */
    function copyLayer(layer, rel, placement) {
        var parent = rel.parent && rel.parent.typename === "Layer" && placement !== ElementPlacement.PLACEATBEGINNING ? rel.parent : null, n, i, items = [];
        n = (placement === ElementPlacement.PLACEATBEGINNING ? rel.layers : parent ? parent.layers : doc().layers).add();
        n.name = layer.name;
        attempt(function () { n.color = layer.color; return true; }, false);
        if (placement !== ElementPlacement.PLACEATBEGINNING) n.move(rel, placement);
        for (i = layer.layers.length - 1; i >= 0; i--) copyLayer(layer.layers[i], n, ElementPlacement.PLACEATBEGINNING);
        for (i = 0; i < layer.pageItems.length; i++) items.push(layer.pageItems[i]);
        for (i = items.length - 1; i >= 0; i--) items[i].duplicate(n, ElementPlacement.PLACEATBEGINNING);
        n.visible = layer.visible;
        n.locked = layer.locked;
        return n;
    }

    function duplicate(a) {
        var list = targets(a.targets), i, o;
        for (i = 0; i < list.length; i++) {
            o = list[i].obj;
            if (kindOf(o) === "layer") copyLayer(o, o, ElementPlacement.PLACEBEFORE);
            else o.duplicate(o, ElementPlacement.PLACEBEFORE);
        }
        return { copied: list.length };
    }

    /** targets (in panel order, front first) before / after / inside dest; `copy` keeps the originals */
    function move(a) {
        var list = targets(a.targets), dest = target(a.dest), where = a.where, i, o, isLayer, destKind = kindOf(dest), container, P = ElementPlacement, moved = 0;
        for (i = 0; i < list.length; i++) {
            if (list[i].key === a.dest.key || String(a.dest.key).indexOf(list[i].key + "/") === 0) throw new Error("不能移到它自己里面");
        }
        // an item dropped on a layer's edge goes inside that layer (items sit in layers, not between them)
        if (where !== "inside" && destKind === "layer") {
            var anyItem = false;
            for (i = 0; i < list.length; i++) if (kindOf(list[i].obj) !== "layer") anyItem = true;
            if (anyItem) where = where === "before" ? "inside" : "insideEnd";
        }
        container = where === "inside" || where === "insideEnd";
        if (container && !(destKind === "layer" || destKind === "group" || destKind === "clip")) throw new Error("只能放进图层或编组");
        var order = where === "before" || where === "insideEnd" ? list : list.slice(0).reverse();
        for (i = 0; i < order.length; i++) {
            o = order[i].obj;
            isLayer = kindOf(o) === "layer";
            if (isLayer && destKind !== "layer") throw new Error("图层只能放在图层旁边或图层里");
            var placement = where === "before" ? P.PLACEBEFORE : where === "after" ? P.PLACEAFTER : where === "inside" ? P.PLACEATBEGINNING : P.PLACEATEND;
            if (isLayer) {
                if (a.copy) copyLayer(o, dest, placement === P.PLACEATEND ? P.PLACEATBEGINNING : placement);
                else o.move(dest, placement);
            } else if (a.copy) o.duplicate(dest, placement);
            else o.move(dest, placement);
            moved++;
        }
        return { moved: moved };
    }

    function newLayer(a) {
        var d = doc(), ref = a.target ? target(a.target) : null, n, parent;
        if (ref && kindOf(ref) !== "layer") {
            // an item row: the new layer goes above the layer it is in
            parent = ref.parent;
            while (parent && parent.typename !== "Layer") parent = parent.parent;
            ref = parent;
        }
        if (a.sub && ref) {
            n = ref.layers.add();
            n.move(ref, ElementPlacement.PLACEATBEGINNING);
        } else if (ref && ref.parent && ref.parent.typename === "Layer") {
            n = ref.parent.layers.add();
            n.move(ref, ElementPlacement.PLACEBEFORE);
        } else {
            n = d.layers.add();
            if (ref) n.move(ref, ElementPlacement.PLACEBEFORE);
        }
        if (a.name) n.name = a.name;
        d.activeLayer = n;
        return { name: n.name };
    }

    /** the items selected (by the panel) go into a new layer above the first one's layer */
    function collect(a) {
        var list = targets(a.targets), d = doc(), first = list[0].obj, layer = first, n, i;
        while (layer && layer.typename !== "Layer") layer = layer.parent;
        n = (layer && layer.parent && layer.parent.typename === "Layer" ? layer.parent.layers : d.layers).add();
        if (layer) n.move(layer, ElementPlacement.PLACEBEFORE);
        if (a.name) n.name = a.name;
        for (i = list.length - 1; i >= 0; i--) {
            if (kindOf(list[i].obj) === "layer") list[i].obj.move(n, ElementPlacement.PLACEATBEGINNING);
            else list[i].obj.move(n, ElementPlacement.PLACEATBEGINNING);
        }
        d.activeLayer = n;
        return { name: n.name, moved: list.length };
    }

    var MENU = {
        group: "group", ungroup: "ungroup", makeMask: "makeMask", releaseMask: "releaseMask",
        compound: "compoundPath", releaseCompound: "noCompoundPath", showAll: "showAll", unlockAll: "unlockAll",
        lockSelection: "lock", hideSelection: "hide",
        sameFill: "Find Fill Color menu item", sameStroke: "Find Stroke Color menu item", sameFillStroke: "Find Fill & Stroke menu item",
        sameAppearance: "Find Appearance menu item", sameOpacity: "Find Opacity menu item", sameStrokeWeight: "Find Stroke Weight menu item",
        sameStyle: "Find Style menu item", sameSymbol: "Find Symbol Instance menu item", sameBlend: "Find Blending Mode menu item",
        inverse: "Inverse menu item", selectAll: "selectall", deselect: "deselectall",
        bringFront: "sendToFront", bringForward: "sendForward", sendBackward: "sendBackward", sendBack: "sendToBack",
        fitArtboard: "fitin", fitAll: "fitall", selectOnArtboard: "selectallinartboard"
    };
    function menu(a) {
        var id = MENU[a.cmd];
        if (!id) throw new Error("unknown command " + a.cmd);
        app.executeMenuCommand(id);
        return { selCount: attempt(function () { return doc().selection.length; }, 0) };
    }

    function artboard(a) {
        var d = doc();
        d.artboards.setActiveArtboardIndex(a.index);
        if (a.fit) app.executeMenuCommand("fitin");
        if (a.select) { d.selection = null; app.executeMenuCommand("selectallinartboard"); }
        return { index: a.index, selCount: d.selection.length };
    }

    // ── documents ──
    function documents() {
        var out = [], i, active = -1;
        for (i = 0; i < app.documents.length; i++) {
            out.push(app.documents[i].name);
            // the same document object, else the same file, else (unsaved: no file) the same name
            if (active < 0 && (attempt(function () { return app.documents[i] === app.activeDocument; }, false)
                || attempt(function () { return app.documents[i].fullName.fsName === app.activeDocument.fullName.fsName; }, false)
                || attempt(function () { return app.documents[i].name === app.activeDocument.name; }, false))) active = i;
        }
        return { docs: out, active: active };
    }
    function activateDocument(a) {
        if (a.index < 0 || a.index >= app.documents.length) throw new Error("没有这个文档");
        app.activeDocument = app.documents[a.index];
        return { name: app.activeDocument.name };
    }

    // ── artboards ──
    function artboards() {
        var d = doc(), out = [], i, r;
        for (i = 0; i < d.artboards.length; i++) {
            r = d.artboards[i].artboardRect;
            out.push({ name: d.artboards[i].name, width: Math.round(r[2] - r[0]), height: Math.round(r[1] - r[3]) });
        }
        return { boards: out, active: d.artboards.getActiveArtboardIndex() };
    }
    function boardOp(a) {
        var d = doc(), i = a.index, b, items;
        if (a.op === "add") {
            items = selectionItems();
            if (!items.length) throw new Error("先选中对象：新画板按它们的范围");
            b = d.artboards.add(boundsOf(items));
            if (a.name) b.name = a.name;
            d.artboards.setActiveArtboardIndex(d.artboards.length - 1);
            return { index: d.artboards.length - 1 };
        }
        if (a.op === "addSize") {
            // to the right of the right-most artboard, top-aligned with it
            var right = null, top = 0, j, r;
            for (j = 0; j < d.artboards.length; j++) {
                r = d.artboards[j].artboardRect;
                if (right === null || r[2] > right) { right = r[2]; top = r[1]; }
            }
            if (!(a.width > 0 && a.height > 0)) throw new Error("尺寸不对");
            b = d.artboards.add([right + 40, top, right + 40 + a.width, top - a.height]);
            if (a.name) b.name = a.name;
            d.artboards.setActiveArtboardIndex(d.artboards.length - 1);
            return { index: d.artboards.length - 1 };
        }
        if (i === undefined || i < 0 || i >= d.artboards.length) throw new Error("没有这个画板");
        if (a.op === "rename") d.artboards[i].name = String(a.name);
        else if (a.op === "remove") {
            if (d.artboards.length === 1) throw new Error("文档至少要保留一个画板");
            d.artboards[i].remove();
        } else if (a.op === "fit") {
            if (!selectionItems().length) throw new Error("先选中对象：画板会缩放到它们的范围");
            d.artboards[i].artboardRect = boundsOf(selectionItems());
        } else throw new Error("unknown artboard op " + a.op);
        return { index: i };
    }

    /** 整理: empty layers, empty groups, empty text frames */
    function cleanup(a) {
        var d = doc(), what = a.what || [], counts = { emptyLayers: 0, emptyGroups: 0, emptyText: 0 }, i;
        function sweep(o, kind) {
            var list = children(o, kind), j, c, ck;
            for (j = list.length - 1; j >= 0; j--) {
                c = list[j].obj;
                ck = kindOf(c);
                if (ck === "layer" || ck === "group") sweep(c, ck);
                if (attempt(function () { return c.locked; }, false)) continue;
                if (ck === "layer" && has(what, "emptyLayers") && childCount(c, ck) === 0) { c.remove(); counts.emptyLayers++; }
                else if (ck === "group" && has(what, "emptyGroups") && childCount(c, ck) === 0) { c.remove(); counts.emptyGroups++; }
                else if (ck === "text" && has(what, "emptyText") && !trim(attempt(function () { return c.contents; }, "x"))) { c.remove(); counts.emptyText++; }
            }
        }
        for (i = d.layers.length - 1; i >= 0; i--) {
            sweep(d.layers[i], "layer");
            if (has(what, "emptyLayers") && d.layers.length > 1 && !d.layers[i].locked && childCount(d.layers[i], "layer") === 0) { d.layers[i].remove(); counts.emptyLayers++; }
        }
        return counts;
    }

    // ── layer options, appearance ──
    function hexColor(h) {
        var c = new RGBColor(), x = String(h).replace("#", "");
        c.red = parseInt(x.substring(0, 2), 16);
        c.green = parseInt(x.substring(2, 4), 16);
        c.blue = parseInt(x.substring(4, 6), 16);
        return c;
    }
    /** colour / printable / preview (false = outline) of layers */
    function layerOptions(a) {
        var list = targets(a.targets), i, o, n = 0;
        for (i = 0; i < list.length; i++) {
            o = list[i].obj;
            if (kindOf(o) !== "layer") continue;
            if (a.color) o.color = hexColor(a.color);
            if (a.printable !== undefined) o.printable = a.printable;
            if (a.preview !== undefined) o.preview = a.preview;
            n++;
        }
        return { changed: n };
    }

    var BLENDS = ["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "SOFTLIGHT", "HARDLIGHT", "COLORDODGE", "COLORBURN", "DARKEN", "LIGHTEN",
        "DIFFERENCE", "EXCLUSION", "HUE", "SATURATIONBLEND", "COLORBLEND", "LUMINOSITY"];
    function blendName(v) {
        var i;
        for (i = 0; i < BLENDS.length; i++) if (BlendModes[BLENDS[i]] === v) return BLENDS[i];
        return String(v).replace("BlendModes.", "");
    }
    function appearance(a) {
        var o = target(a.target);
        return { opacity: attempt(function () { return Math.round(o.opacity); }, 100), blend: attempt(function () { return blendName(o.blendingMode); }, "NORMAL") };
    }
    function setAppearance(a) {
        var list = targets(a.targets), i, o, n = 0;
        for (i = 0; i < list.length; i++) {
            o = list[i].obj;
            if (a.opacity !== undefined) o.opacity = Math.max(0, Math.min(100, a.opacity));
            if (a.blend) {
                if (BlendModes[a.blend] === undefined) throw new Error("unknown blend " + a.blend);
                o.blendingMode = BlendModes[a.blend];
            }
            n++;
        }
        return { changed: n };
    }

    /** 释放到图层（顺序）: every item of the layer into a sublayer of its own, same order */
    function releaseToLayers(a) {
        var layer = target(a.target), items = [], i, n, made = 0;
        if (kindOf(layer) !== "layer") throw new Error("只能释放图层");
        for (i = 0; i < layer.pageItems.length; i++) items.push(layer.pageItems[i]);
        for (i = items.length - 1; i >= 0; i--) {
            n = layer.layers.add();
            n.name = label(items[i], kindOf(items[i]));
            items[i].move(n, ElementPlacement.PLACEATBEGINNING);
            made++;
        }
        return { made: made };
    }

    /** 合并所选图层: everything of the others into the first (in panel order), the others removed */
    function mergeLayers(a) {
        var list = targets(a.targets), dest = list[0].obj, i, j, src, kids, moved = 0;
        for (i = 0; i < list.length; i++) if (kindOf(list[i].obj) !== "layer") throw new Error("只能合并图层");
        if (list.length < 2) throw new Error("至少选两个图层");
        for (i = 1; i < list.length; i++) {
            src = list[i].obj;
            kids = children(src, "layer");
            for (j = 0; j < kids.length; j++) { kids[j].obj.move(dest, ElementPlacement.PLACEATEND); moved++; }
            src.remove();
        }
        doc().activeLayer = dest;
        return { moved: moved, removed: list.length - 1 };
    }

    /** 文档检查: what usually goes wrong before handing a file on, each with the items' keys */
    function report() {
        var d = doc(), counts = {}, issues = {}, total = 0, i, LIMIT = 300;
        var defs = [
            ["missing", "缺失的链接图像"], ["linked", "链接（未嵌入）的图像"], ["stray", "游离点（只有一个锚点的路径）"],
            ["emptyText", "空文字"], ["emptyGroup", "空编组"], ["emptyLayer", "空图层"], ["hidden", "隐藏的对象"], ["locked", "锁定的对象"],
            ["unpainted", "无填色无描边的路径"], ["noprint", "不打印的图层"]
        ];
        for (i = 0; i < defs.length; i++) issues[defs[i][0]] = { id: defs[i][0], label: defs[i][1], count: 0, keys: [] };
        function hit(id, key) {
            var x = issues[id];
            x.count++;
            if (x.keys.length < LIMIT) x.keys.push(key);
        }
        function walk(o, key, kind) {
            var list, j, c, ck;
            total++;
            counts[kind] = (counts[kind] || 0) + 1;
            if (kind === "layer") {
                if (childCount(o, kind) === 0) hit("emptyLayer", key);
                if (!attempt(function () { return o.printable; }, true)) hit("noprint", key);
            } else {
                if (attempt(function () { return o.hidden; }, false)) hit("hidden", key);
                if (attempt(function () { return o.locked; }, false)) hit("locked", key);
                if (kind === "placed") { hit("linked", key); if (attempt(function () { return !o.file.exists; }, true)) hit("missing", key); }
                if (kind === "text" && !trim(attempt(function () { return o.contents; }, "x"))) hit("emptyText", key);
                if (kind === "group" && childCount(o, kind) === 0) hit("emptyGroup", key);
                if (kind === "path") {
                    if (attempt(function () { return o.pathPoints.length; }, 2) === 1) hit("stray", key);
                    else if (!attempt(function () { return o.filled || o.stroked || o.clipping; }, true)) hit("unpainted", key);
                }
            }
            list = children(o, kind);
            for (j = 0; j < list.length; j++) {
                c = list[j].obj;
                ck = kindOf(c);
                walk(c, key + "/" + list[j].seg, ck);
            }
        }
        for (i = 0; i < d.layers.length; i++) walk(d.layers[i], "l" + i, "layer");
        var out = [];
        for (i = 0; i < defs.length; i++) out.push(issues[defs[i][0]]);
        return { total: total, counts: counts, issues: out, artboards: d.artboards.length };
    }

    // ── 牵手 Photoshop ──
    /** where files for Photoshop go: the folder Photoshop's plugin asked for (its own temporary
     *  folder, which it may read without asking), else ours */
    function bridgeFolder(path) {
        var f = new Folder(path || (Folder.temp + "/WavePlugBridge"));
        if (!f.exists) f.create();
        return f;
    }
    function stamp() {
        return String(new Date().getTime()) + "_" + Math.floor(Math.random() * 1000);
    }
    function boundsOf(items) {
        var b = null, i, v;
        for (i = 0; i < items.length; i++) {
            v = items[i].visibleBounds;
            if (!b) b = [v[0], v[1], v[2], v[3]];
            else { b[0] = Math.min(b[0], v[0]); b[1] = Math.max(b[1], v[1]); b[2] = Math.max(b[2], v[2]); b[3] = Math.min(b[3], v[3]); }
        }
        return b;
    }
    function addNote(o, id, page, bare) {
        var note = attempt(function () { return String(o.note || ""); }, ""), i = note.indexOf(LINK_PREFIX);
        if (i >= 0) note = note.substring(0, i) + note.substring(i).replace(/^wavelink:[^\s]*\s*/, "");
        note = note.replace(/\s+$/, "");
        attempt(function () { o.note = (note ? note + "\n" : "") + LINK_PREFIX + id + (page !== null && page !== undefined ? ";page=" + page : "") + (bare ? ";bare" : ""); return true; }, false);
    }
    function selectionItems() {
        var d = doc(), sel = d.selection, out = [], i;
        if (!sel || typeof sel.length !== "number") return out;
        for (i = 0; i < sel.length; i++) if (sel[i] && sel[i].typename !== "TextRange") out.push(sel[i]);
        return out;
    }
    function itemsWithLink(id) {
        var d = doc(), out = [], i;
        for (i = 0; i < d.pageItems.length; i++) if (linkOf(d.pageItems[i]) === id) out.push(d.pageItems[i]);
        return out;
    }

    /** The selection (or the items linked to `link`) into a file for Photoshop: an .ai (vector,
     *  opens in Photoshop as a vector smart object) or a PNG at `scale` %. Items are copied into a
     *  new document, so the open one is left as it was. */
    function exportItems(a) {
        var src = doc(), items, i, out, b, file, id, opts, name, board = null;
        if (a.artboard !== undefined) {
            // everything on the artboard, and the artboard itself as the page
            src.artboards.setActiveArtboardIndex(a.artboard);
            src.selection = null;
            app.executeMenuCommand("selectallinartboard");
            board = src.artboards[a.artboard];
        }
        if (a.targets) { items = []; var tl = targets(a.targets); for (i = 0; i < tl.length; i++) items.push(tl[i].obj); }
        else items = a.link ? itemsWithLink(a.link) : selectionItems();
        // bare: without its own opacity, blend mode and hiding (the Photoshop layer carries them)
        var bare = !!a.bare || (!!a.link && items.length > 0 && linkBare(items[0]));
        // an update keeps the page the link was first sent with
        if (a.link && items.length && (a.pageArtboard === undefined || a.pageArtboard === null)) {
            var lp = linkPage(items[0]);
            if (lp !== null && lp < src.artboards.length) a.pageArtboard = lp;
        }
        // the page is an artboard (its place kept) but only the selection goes
        var page = board ? board.artboardRect : (a.pageArtboard !== undefined && a.pageArtboard !== null ? src.artboards[a.pageArtboard].artboardRect : null);
        if (!items.length) throw new Error(a.link ? "找不到和 Photoshop 关联的对象" : board ? "这个画板上没有对象" : "先在 Illustrator 里选中要发送的对象");
        id = a.link || ("L" + stamp());
        name = a.name || (board ? board.name : label(items[0], kindOf(items[0])));
        b = boundsOf(items);
        out = app.documents.add(src.documentColorSpace, Math.max(1, b[2] - b[0]), Math.max(1, b[1] - b[3]));
        try {
            var copies = [];
            for (i = items.length - 1; i >= 0; i--) copies.push(items[i].duplicate(out.layers[0], ElementPlacement.PLACEATBEGINNING));
            if (bare) for (i = 0; i < copies.length; i++) {
                var cp = copies[i];
                attempt(function () { cp.hidden = false; return true; }, false);
                attempt(function () { cp.opacity = 100; return true; }, false);
                attempt(function () { cp.blendingMode = BlendModes.NORMAL; return true; }, false);
            }
            // the copies' place in the new document's own coordinates
            var src0 = b;
            b = boundsOf(copies);
            if (page) {
                // the artboard, moved the way the copies moved
                var r = page, dx = b[0] - src0[0], dy = b[1] - src0[1];
                b = [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
            }
            out.artboards[0].artboardRect = b;
            file = new File(bridgeFolder(a.folder).fsName + "/" + id + "_" + stamp() + (a.format === "png" ? ".png" : ".ai"));
            if (a.format === "png") {
                opts = new ExportOptionsPNG24();
                opts.transparency = true;
                opts.artBoardClipping = true;
                opts.antiAliasing = true;
                opts.horizontalScale = opts.verticalScale = Math.max(10, Math.min(776, a.scale || 100));
                out.exportFile(file, ExportType.PNG24, opts);
            } else {
                opts = new IllustratorSaveOptions();
                opts.pdfCompatible = true;
                opts.embedLinkedFiles = true;
                out.saveAs(file, opts);
            }
        } finally {
            out.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = src;
        }
        if (!a.link && !board) for (i = 0; i < items.length; i++) addNote(items[i], id, a.pageArtboard, bare);
        if (board) src.selection = null;
        return { file: file.fsName, fileName: fileName(file.fsName), link: id, name: name, count: items.length, widthPt: b[2] - b[0], heightPt: b[1] - b[3] };
    }

    /** a file name from a layer name: no characters Windows refuses */
    function safeName(s) {
        var n = String(s).replace(/[\\\/:*?"<>|\r\n\t]+/g, "_").replace(/^\s+|[\s.]+$/g, "");
        return n || "图层";
    }

    /** 导出图层: each layer's artwork into its own file (PNG at `scale` %, or SVG) in a folder the
     *  user picks (or `folder`). Copies go through a new document, the open one is left as it was. */
    function exportLayers(a) {
        var src = doc(), list = targets(a.targets), dir, i, j, layer, items, out, copies, b, file, opts, done = [], skipped = [], used = {};
        for (i = 0; i < list.length; i++) if (kindOf(list[i].obj) !== "layer") throw new Error("只能导出图层");
        dir = a.folder ? new Folder(a.folder) : Folder.selectDialog("选择导出文件夹");
        if (!dir) return { cancelled: true };
        if (!dir.exists) dir.create();
        for (i = 0; i < list.length; i++) {
            layer = list[i].obj;
            src.selection = null;
            attempt(function () { layer.hasSelectedArtwork = true; return true; }, false);
            items = selectionItems();
            if (!items.length) { skipped.push(layer.name); continue; }
            out = app.documents.add(src.documentColorSpace, 100, 100);
            try {
                copies = [];
                for (j = items.length - 1; j >= 0; j--) copies.push(items[j].duplicate(out.layers[0], ElementPlacement.PLACEATBEGINNING));
                b = boundsOf(copies);
                out.artboards[0].artboardRect = b;
                var base = safeName(layer.name), name = base, k = 2;
                while (used[name.toLowerCase()]) name = base + " (" + (k++) + ")";
                used[name.toLowerCase()] = true;
                if (a.format === "svg") {
                    file = new File(dir.fsName + "/" + name + ".svg");
                    opts = new ExportOptionsSVG();
                    opts.embedRasterImages = true;
                    out.exportFile(file, ExportType.SVG, opts);
                } else {
                    file = new File(dir.fsName + "/" + name + ".png");
                    opts = new ExportOptionsPNG24();
                    opts.transparency = true;
                    opts.artBoardClipping = true;
                    opts.antiAliasing = true;
                    opts.horizontalScale = opts.verticalScale = Math.max(10, Math.min(776, a.scale || 100));
                    out.exportFile(file, ExportType.PNG24, opts);
                }
                done.push(file.fsName);
            } finally {
                out.close(SaveOptions.DONOTSAVECHANGES);
                app.activeDocument = src;
            }
        }
        src.selection = null;
        return { folder: dir.fsName, files: done, skipped: skipped };
    }

    /** the links (sent to Photoshop before) among the selection */
    function linksInSelection() {
        var items = selectionItems(), seen = {}, out = [], i, id;
        for (i = 0; i < items.length; i++) {
            id = linkOf(items[i]);
            if (id && !seen[id]) { seen[id] = true; out.push(id); }
        }
        return { links: out, count: items.length };
    }

    /** every link in the document, with the first item's label */
    function allLinks() {
        var d = doc(), seen = {}, out = [], i, id, o;
        for (i = 0; i < d.pageItems.length; i++) {
            o = d.pageItems[i];
            id = linkOf(o);
            if (id && !seen[id]) { seen[id] = true; out.push({ link: id, label: label(o, kindOf(o)) }); }
        }
        return { links: out };
    }

    /** a fingerprint of each linked item set: what it looks like (kinds, bounds, fills, text,
     *  opacity, hidden), for 自动同步 to notice a change */
    var linkedCache = null, linkedDoc = null;
    function linkSignatures(a) {
        var d = doc(), sigs = {}, i, o, id, path = attempt(function () { return d.fullName.fsName; }, d.name);
        // the linked items, found by a full scan only when asked (the panel does it when the
        // document changed, and now and then): a scan reads every item's note
        if (!linkedCache || linkedDoc !== path || a.rescan) {
            linkedCache = [];
            linkedDoc = path;
            for (i = 0; i < d.pageItems.length; i++) if (linkOf(d.pageItems[i])) linkedCache.push(d.pageItems[i]);
        }
        function r1(v) { return Math.round(v * 10) / 10; }
        function print(x, depth) {
            var k = kindOf(x), b = attempt(function () { return x.visibleBounds; }, [0, 0, 0, 0]), s, j, list;
            s = k + ":" + r1(b[0]) + "," + r1(b[1]) + "," + r1(b[2]) + "," + r1(b[3]) + ":" + fillOf(x, k) + ":" + attempt(function () { return x.opacity; }, 100)
                + ":" + attempt(function () { return x.hidden; }, false) + ":" + (k === "text" ? attempt(function () { return x.contents; }, "") : "")
                + ":" + attempt(function () { return x.pathPoints ? x.pathPoints.length : ""; }, "");
            if (depth < 6 && (k === "group" || k === "clip")) {
                list = x.pageItems;
                for (j = 0; j < list.length; j++) s += "[" + print(list[j], depth + 1) + "]";
            }
            return s;
        }
        var list = linkedCache, stale = false;
        for (i = 0; i < list.length; i++) {
            o = list[i];
            // removed (reading it throws) or unlinked since the scan: scan again next time
            id = attempt(function () { return linkOf(o); }, null);
            if (!id) { stale = true; continue; }
            sigs[id] = (sigs[id] || "") + "|" + print(o, 0);
        }
        if (stale) linkedCache = null;
        return { sigs: sigs };
    }

    function selectLink(a) {
        var items = itemsWithLink(a.link), d = doc(), i;
        d.selection = null;
        for (i = 0; i < items.length; i++) attempt(function () { items[i].selected = true; return true; }, false);
        return { selected: items.length };
    }

    /** 画板 → Photoshop: what is on artboard `artboard` (else the active one), as the layers /
     *  sublayers / groups it is in, each item with its place (points from the artboard's corner),
     *  opacity, blend mode and visibility. Groups are opened up unless that makes more than `limit`
     *  items; then each group goes whole. */
    function boardPlan(a) {
        var d = doc(), idx = a.artboard !== undefined && a.artboard !== null ? a.artboard : d.artboards.getActiveArtboardIndex(),
            board = d.artboards[idx], r = board.artboardRect, limit = a.limit || 300, deep = a.deep !== false, count = 0, nodes, i, n;
        function hit(b) { return b[0] < r[2] && b[2] > r[0] && b[3] < r[1] && b[1] > r[3]; }
        function looks(o, n) {
            n.opacity = attempt(function () { return Math.round(o.opacity); }, 100);
            n.blend = attempt(function () { return blendName(o.blendingMode); }, "NORMAL");
            return n;
        }
        function walk(o, key, kind) {
            var n, list, j, c, b;
            if (kind === "layer" || (deep && kind === "group")) {
                n = looks(o, { name: kind === "layer" ? o.name : label(o, kind), hidden: kind === "layer" ? !o.visible : attempt(function () { return o.hidden; }, false), children: [] });
                list = children(o, kind);
                for (j = 0; j < list.length; j++) {
                    c = walk(list[j].obj, key + "/" + list[j].seg, kindOf(list[j].obj));
                    if (c) n.children.push(c);
                }
                return n.children.length ? n : null;
            }
            b = attempt(function () { return o.visibleBounds; }, null);
            if (!b || !hit(b)) return null;
            count++;
            return looks(o, { key: key, kind: kind, label: label(o, kind), name: label(o, kind), hidden: attempt(function () { return o.hidden; }, false),
                left: b[0] - r[0], top: r[1] - b[1], width: b[2] - b[0], height: b[1] - b[3] });
        }
        function run() {
            count = 0;
            nodes = [];
            for (i = 0; i < d.layers.length; i++) { n = walk(d.layers[i], "l" + i, "layer"); if (n) nodes.push(n); }
        }
        run();
        if (count > limit && deep) { deep = false; run(); }
        return { name: board.name, index: idx, width: r[2] - r[0], height: r[1] - r[3], nodes: nodes, count: count, deep: deep };
    }

    /** Photoshop layers into Illustrator, at their place: `left` / `top` / `width` / `height` are
     *  document pixels of a Photoshop document of `ppi` (1 px = 72 / ppi pt). SVG files (text and
     *  shape layers) come in as editable groups, vector files out of smart objects (.ai / .pdf /
     *  .eps) are embedded (they become vectors), PNGs are embedded images. With `board` the files
     *  go on a new artboard that size (a new document when none is open), in the groups `group`
     *  names (`groups`), with their opacity, blend mode and visibility; else on the active artboard. */
    function placeFiles(a) {
        var k = 72 / (a.ppi || 72), d, ab, layer, i, f, p, c, placed = 0, missing = 0, fresh = false, made = {}, styled = [], boardName = null;
        if (a.board) {
            var w = Math.max(1, a.board.width * k), h = Math.max(1, a.board.height * k), right = null, top = null, rect, nb;
            if (!app.documents.length) {
                d = app.documents.add(DocumentColorSpace.RGB, w, h);
                fresh = true;
                ab = d.artboards[0].artboardRect;
                attempt(function () { d.artboards[0].name = a.board.name; return true; }, false);
            } else {
                d = doc();
                for (i = 0; i < d.artboards.length; i++) {
                    rect = d.artboards[i].artboardRect;
                    if (right === null || rect[2] > right) right = rect[2];
                    if (top === null || rect[1] > top) top = rect[1];
                }
                ab = [right + 40, top, right + 40 + w, top - h];
                nb = d.artboards.add(ab);
                attempt(function () { nb.name = a.board.name; return true; }, false);
                d.artboards.setActiveArtboardIndex(d.artboards.length - 1);
            }
            boardName = a.board.name;
        } else {
            d = doc();
            ab = d.artboards[d.artboards.getActiveArtboardIndex()].artboardRect;
        }
        layer = fresh ? d.layers[0] : d.layers.add();
        layer.name = a.layerName || "来自 Photoshop";
        function style(o, s, opacity) {
            if (opacity && s.opacity !== undefined && s.opacity < 100) attempt(function () { o.opacity = s.opacity; return true; }, false);
            if (s.blend && s.blend !== "NORMAL" && BlendModes[s.blend] !== undefined) attempt(function () { o.blendingMode = BlendModes[s.blend]; return true; }, false);
            // hidden last: nothing goes into a hidden container
            if (s.hidden) styled.push(o);
        }
        function container(path) {
            if (!path || !path.length) return layer;
            var key = path.join("/"), g, parent, info;
            if (made[key]) return made[key];
            parent = container(path.slice(0, path.length - 1));
            g = parent.groupItems.add();
            info = (a.groups || {})[path[path.length - 1]] || {};
            attempt(function () { g.name = info.name || "组"; return true; }, false);
            style(g, info, true);
            made[key] = g;
            return g;
        }
        for (i = a.files.length - 1; i >= 0; i--) {
            f = a.files[i];
            if (!new File(f.path).exists) { missing++; continue; }
            c = container(f.group);
            if (/\.svg$/i.test(f.path)) {
                // a text / shape layer (or an SVG smart object): editable vectors, sized by the SVG (points)
                p = c.groupItems.createFromFile(new File(f.path));
                if (f.left !== undefined && f.top !== undefined) p.position = [ab[0] + f.left * k, ab[1] - f.top * k];
                attempt(function () { p.name = f.name; return true; }, false);
                // the SVG of a text / shape layer carries its own opacity
                style(p, f, f.how === "vector");
                placed++;
                continue;
            }
            p = c.placedItems.add();
            p.file = new File(f.path);
            if (f.width && f.height) {
                p.width = f.width * k;
                p.height = f.height * k;
            }
            if (f.left !== undefined && f.top !== undefined) p.position = [ab[0] + f.left * k, ab[1] - f.top * k];
            attempt(function () { p.embed(); return true; }, false);
            // embedding replaces the placed item with what was in the file (an image, or vectors)
            p = c.pageItems[0];
            attempt(function () { p.name = f.name; return true; }, false);
            style(p, f, true);
            placed++;
        }
        for (i = 0; i < styled.length; i++) attempt(function () { styled[i].hidden = true; return true; }, false);
        d.activeLayer = layer;
        return { placed: placed, missing: missing, artboard: boardName };
    }

    /** a colour (#rrggbb) as a new swatch of the document */
    function addSwatch(a) {
        var d = doc(), s = d.swatches.add();
        s.color = hexColor(a.hex);
        s.name = a.name || String(a.hex).toUpperCase();
        return { name: s.name };
    }

    function fillHex() {
        var items = selectionItems(), k;
        if (!items.length) return { hex: null };
        k = kindOf(items[0]);
        return { hex: fillOf(items[0], k) };
    }
    function setFill(a) {
        var items = selectionItems(), c = new RGBColor(), i, n = 0, h = String(a.hex).replace("#", "");
        c.red = parseInt(h.substring(0, 2), 16);
        c.green = parseInt(h.substring(2, 4), 16);
        c.blue = parseInt(h.substring(4, 6), 16);
        for (i = 0; i < items.length; i++) {
            if (attempt(function () {
                var k = kindOf(items[i]);
                if (k === "compound") { items[i].pathItems[0].filled = true; items[i].pathItems[0].fillColor = c; }
                else if (k === "text") items[i].textRange.characterAttributes.fillColor = c;
                else { items[i].filled = true; items[i].fillColor = c; }
                return true;
            }, false)) n++;
        }
        return { changed: n };
    }

    var OPS = {
        sig: sig, tree: tree, reveal: reveal, search: search, select: select, setProp: setProp, others: others,
        rename: rename, remove: remove, duplicate: duplicate, move: move, newLayer: newLayer, collect: collect,
        menu: menu, artboard: artboard, cleanup: cleanup, exportItems: exportItems, linksInSelection: linksInSelection,
        undo: function () { app.undo(); return { done: true }; },
        redo: function () { app.redo(); return { done: true }; },
        artboards: artboards, boardOp: boardOp, documents: documents, activateDocument: activateDocument,
        addSwatch: addSwatch, exportLayers: exportLayers,
        selectLink: selectLink, allLinks: allLinks, linkSignatures: linkSignatures, placeFiles: placeFiles, boardPlan: boardPlan, fillHex: fillHex, setFill: setFill,
        layerOptions: layerOptions, appearance: appearance, setAppearance: setAppearance, releaseToLayers: releaseToLayers,
        mergeLayers: mergeLayers, report: report, selectKeys: function (a) { return select({ targets: a.targets, add: false }); },
        ping: function () { return { version: "0.1.0", app: attempt(function () { return app.version; }, "") }; }
    };

    return {
        json: json,
        call: function (op, args) {
            try {
                if (!OPS[op]) throw new Error("unknown op " + op);
                var v = OPS[op](args || {});
                if (op !== "sig" && op !== "tree" && op !== "search" && op !== "reveal" && op !== "ping" && op !== "fillHex" && op !== "linksInSelection" && op !== "report" && op !== "appearance" && op !== "allLinks" && op !== "linkSignatures" && op !== "artboards" && op !== "documents")
                    attempt(function () { app.redraw(); return true; }, false);
                return json({ ok: true, value: v });
            } catch (e) {
                return json({ ok: false, error: String(e && e.message ? e.message : e) });
            }
        }
    };
})();
