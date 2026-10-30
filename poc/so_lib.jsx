// WavePlug Studio · Smart Object version-chain POC (ExtendScript / Action Manager).
// The descriptors used here are the same ones UXP batchPlay will send.
// Only ever operates on documents created by WP.makeTestDoc(); never on user files.
$.global.WP = (function () {
  var NO = DialogModes.NO;
  function c(s) { return charIDToTypeID(s); }
  function s(x) { return stringIDToTypeID(x); }
  function pad(n) { n = String(n); while (n.length < 3) n = "0" + n; return n; }

  function docById(id) {
    for (var i = 0; i < app.documents.length; i++) if (app.documents[i].id == id) return app.documents[i];
    throw Error("document " + id + " not open");
  }
  function activate(id) { var d = docById(id); app.activeDocument = d; return d; }
  function guardTest(d) { if (!/^WavePlug_POC_/.test(d.name)) throw Error("refusing to touch non-POC document: " + d.name); }

  function selectLayer(id) {
    var r = new ActionReference(); r.putIdentifier(c("Lyr "), id);
    var d = new ActionDescriptor(); d.putReference(c("null"), r); d.putBoolean(c("MkVs"), false);
    executeAction(c("slct"), d, NO);
  }
  function activeLayerId() {
    var r = new ActionReference(); r.putProperty(c("Prpr"), s("layerID")); r.putEnumerated(c("Lyr "), c("Ordn"), c("Trgt"));
    return executeActionGet(r).getInteger(s("layerID"));
  }
  function layerDesc(id) { var r = new ActionReference(); r.putIdentifier(c("Lyr "), id); return executeActionGet(r); }

  function fillSelection(rgb) {
    var col = new SolidColor(); col.rgb.red = rgb[0]; col.rgb.green = rgb[1]; col.rgb.blue = rgb[2];
    app.activeDocument.selection.fill(col);
  }
  function rect(l, t, r, b) { return [[l, t], [r, t], [r, b], [l, b]]; }

  function makeTestDoc(w, h) {
    var name = "WavePlug_POC_" + new Date().getTime();
    var d = app.documents.add(UnitValue(w, "px"), UnitValue(h, "px"), 72, name, NewDocumentMode.RGB, DocumentFill.WHITE);
    d.selection.selectAll(); fillSelection([214, 220, 214]);
    d.selection.select(rect(80, 80, 520, 720)); fillSelection([46, 52, 60]);
    d.selection.select(rect(640, 180, 1100, 620)); fillSelection([125, 175, 166]);
    d.selection.select(rect(760, 300, 980, 500)); fillSelection([235, 228, 210]);
    d.selection.deselect();
    return { id: d.id, name: d.name };
  }

  // Solid test "generation result" PNG with a stripe so alignment/scaling is visible.
  function makePng(path, w, h, rgb) {
    var prev = app.activeDocument;
    var d = app.documents.add(UnitValue(w, "px"), UnitValue(h, "px"), 72, "WavePlug_POC_png", NewDocumentMode.RGB, DocumentFill.WHITE);
    d.selection.selectAll(); fillSelection(rgb);
    d.selection.select(rect(0, Math.round(h * 0.45), w, Math.round(h * 0.55))); fillSelection([255, 255, 255]);
    d.selection.select(rect(Math.round(w * 0.45), 0, Math.round(w * 0.55), h)); fillSelection([20, 20, 20]);
    d.selection.deselect();
    var f = new File(path); f.parent.create();
    d.saveAs(f, new PNGSaveOptions(), true);
    d.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = prev;
    return f.fsName;
  }

  // New task group: region pixels (no clipboard) -> embedded SO named WavePlug_<task>.psb,
  // feathered selection becomes the SO layer mask in the main document.
  function createTaskGroup(docId, b, feather, taskId) {
    var d = activate(docId); guardTest(d);
    var t0 = $.hiresTimer;
    // "stamp visible" needs 2+ visible layers; a single-layer doc is copied directly.
    var stampId = null;
    if (d.layers.length > 1) {
      d.activeLayer = d.layers[0];
      var stampDesc = new ActionDescriptor(); stampDesc.putBoolean(c("Dplc"), true);
      executeAction(s("mergeVisible"), stampDesc, NO);
      stampId = activeLayerId();
    } else d.activeLayer = d.layers[0];
    d.selection.select(rect(b[0], b[1], b[2], b[3]));
    executeAction(s("copyToLayer"), undefined, NO);
    var baseId = activeLayerId();
    if (stampId !== null) { selectLayer(stampId); d.activeLayer.remove(); }
    selectLayer(baseId);
    d.activeLayer.name = "WavePlug_" + taskId;
    executeAction(s("newPlacedLayer"), undefined, NO);
    var soId = activeLayerId();
    d.activeLayer.name = "AI 结果 · " + taskId;
    d.selection.select(rect(b[0], b[1], b[2], b[3]));
    if (feather > 0) d.selection.feather(feather);
    var m = new ActionDescriptor(); m.putClass(c("Nw  "), c("Chnl"));
    var r = new ActionReference(); r.putEnumerated(c("Chnl"), c("Chnl"), c("Msk "));
    m.putReference(c("At  "), r); m.putEnumerated(c("Usng"), c("UsrM"), c("RvlS"));
    executeAction(c("Mk  "), m, NO);
    d.selection.deselect();
    return { soId: soId, ms: Math.round(($.hiresTimer) / 1000), file: soInfo(docId, soId).file };
  }

  function soInfo(docId, soId) {
    activate(docId);
    var ld = layerDesc(soId);
    var so = ld.getObjectValue(s("smartObject"));
    var out = { file: so.getString(s("fileReference")), current: null, comps: [] };
    if (ld.hasKey(s("smartObjectMore"))) {
      var more = ld.getObjectValue(s("smartObjectMore"));
      if (more.hasKey(s("comp"))) out.current = more.getInteger(s("comp"));
      if (more.hasKey(s("compInfo"))) {
        var ci = more.getObjectValue(s("compInfo"));
        if (ci.hasKey(s("compList"))) {
          var list = ci.getList(s("compList"));
          for (var i = 0; i < list.count; i++) {
            var e = list.getObjectValue(i);
            out.comps.push({ id: e.getInteger(s("ID")), name: e.getString(s("name")),
              comment: e.hasKey(s("comment")) ? e.getString(s("comment")) : "" });
          }
        }
      }
    }
    return out;
  }

  function switchComp(docId, soId, compId) {
    activate(docId); selectLayer(soId);
    var r = new ActionReference(); r.putEnumerated(c("Lyr "), c("Ordn"), c("Trgt"));
    var d = new ActionDescriptor(); d.putReference(c("null"), r); d.putInteger(s("compID"), compId);
    executeAction(s("setPlacedLayerComp"), d, NO);
    return soInfo(docId, soId).current;
  }

  function openContents(docId, soId) {
    var d = activate(docId); guardTest(d); selectLayer(soId);
    var expected = soInfo(docId, soId).file;
    executeAction(s("placedLayerEditContents"), new ActionDescriptor(), NO);
    var psb = app.activeDocument;
    if (psb.name !== expected) throw Error("opened " + psb.name + " but expected " + expected);
    return psb;
  }

  function readCounter(psb) {
    var m = /waveplug:last=(\d+)/.exec(psb.info.instructions || "");
    return m ? Number(m[1]) : 0;
  }
  function writeCounter(psb, n) {
    var rest = String(psb.info.instructions || "").replace(/\s*waveplug:last=\d+/, "");
    psb.info.instructions = (rest ? rest + " " : "") + "waveplug:last=" + n;
  }
  function versionLayers(psb) {
    var out = [];
    for (var i = 0; i < psb.layers.length; i++) if (/^\d{3,}$/.test(psb.layers[i].name)) out.push(psb.layers[i]);
    return out;
  }

  // Re-record one comp per surviving version layer (solo), drop comps whose layer is gone.
  function rebuildComps(psb, comments) {
    var versions = versionLayers(psb), byName = {};
    for (var i = 0; i < versions.length; i++) byName[versions[i].name] = versions[i];
    for (var k = psb.layerComps.length - 1; k >= 0; k--) {
      var lc = psb.layerComps[k];
      if (/^\d{3,}$/.test(lc.name) && !byName[lc.name]) lc.remove();
    }
    for (var j = 0; j < versions.length; j++) {
      for (var q = 0; q < versions.length; q++) versions[q].visible = (q === j);
      var name = versions[j].name, comp = null;
      for (var k2 = 0; k2 < psb.layerComps.length; k2++) if (psb.layerComps[k2].name === name) comp = psb.layerComps[k2];
      if (comp) comp.recapture();
      else psb.layerComps.add(name, (comments && comments[name]) || "", false, false, true);
    }
  }

  function appendVersion(docId, soId, pngPath, comment) {
    var t0 = $.hiresTimer, timing = {};
    var psb = openContents(docId, soId);
    timing.open = Math.round($.hiresTimer / 1000);
    // first append: rename the original pixels layer
    for (var i = 0; i < psb.layers.length; i++) if (/^WavePlug_/.test(psb.layers[i].name)) psb.layers[i].name = "原图";
    var numeric = 0, vs = versionLayers(psb);
    for (var j = 0; j < vs.length; j++) numeric = Math.max(numeric, Number(vs[j].name));
    var next = Math.max(readCounter(psb), numeric) + 1;

    var p = new ActionDescriptor(); p.putPath(c("null"), new File(pngPath));
    p.putEnumerated(c("FTcs"), c("QCSt"), c("Qcsa"));
    var o = new ActionDescriptor(); o.putUnitDouble(c("Hrzn"), c("#Pxl"), 0); o.putUnitDouble(c("Vrtc"), c("#Pxl"), 0);
    p.putObject(c("Ofst"), c("Ofst"), o);
    executeAction(c("Plc "), p, NO);
    var L = psb.activeLayer;
    var bw = L.bounds[2].as("px") - L.bounds[0].as("px"), bh = L.bounds[3].as("px") - L.bounds[1].as("px");
    var W = psb.width.as("px"), H = psb.height.as("px");
    L.resize(W / bw * 100, H / bh * 100, AnchorPosition.MIDDLECENTER);
    L.translate(-L.bounds[0].as("px"), -L.bounds[1].as("px"));
    L.rasterize(RasterizeType.ENTIRELAYER);
    L.name = pad(next);
    L.move(psb.layers[0], ElementPlacement.PLACEBEFORE);
    timing.place = Math.round($.hiresTimer / 1000);

    var comments = {}; comments[pad(next)] = comment || "";
    rebuildComps(psb, comments);
    var all = versionLayers(psb);
    for (var q = 0; q < all.length; q++) all[q].visible = (all[q].name === pad(next));
    writeCounter(psb, next);
    psb.save(); psb.close(SaveOptions.DONOTSAVECHANGES);
    timing.save = Math.round($.hiresTimer / 1000);

    var info = soInfo(docId, soId), target = null;
    for (var z = 0; z < info.comps.length; z++) if (info.comps[z].name === pad(next)) target = info.comps[z];
    if (!target) throw Error("comp " + pad(next) + " not visible from main document");
    var cur = switchComp(docId, soId, target.id);
    timing.switch = Math.round($.hiresTimer / 1000);
    return { version: pad(next), compId: target.id, current: cur, ok: cur === target.id, timing: timing, comps: info.comps };
  }

  // Simulates the user deleting a version layer by hand inside the PSB.
  function manualDelete(docId, soId, name) {
    var psb = openContents(docId, soId);
    psb.layers.getByName(name).remove();
    psb.save(); psb.close(SaveOptions.DONOTSAVECHANGES);
    return soInfo(docId, soId);
  }

  // Reconcile after manual edits: drop orphan comps (requires opening the PSB).
  function reconcile(docId, soId) {
    var psb = openContents(docId, soId);
    rebuildComps(psb, null);
    var vs = versionLayers(psb), top = vs.length ? vs[0].name : null;
    for (var q = 0; q < vs.length; q++) vs[q].visible = (vs[q].name === top);
    var last = readCounter(psb);
    psb.save(); psb.close(SaveOptions.DONOTSAVECHANGES);
    return { counter: last, info: soInfo(docId, soId) };
  }

  return { makeTestDoc: makeTestDoc, makePng: makePng, createTaskGroup: createTaskGroup, soInfo: soInfo,
    switchComp: switchComp, appendVersion: appendVersion, manualDelete: manualDelete, reconcile: reconcile,
    docById: docById };
})();
"loaded";
