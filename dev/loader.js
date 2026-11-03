// WavePlug Studio — development loader.
// Installed once (as a separate plugin, com.waveplug.studio.dev). Every time the panel opens or
// ⟳ is clicked, it reads the latest build from F:\waveplug\studio\dist\plugin and runs it, so code
// changes take effect without closing Photoshop or reinstalling.
(function () {
  "use strict";
  var ROOT = "F:/waveplug/studio/dist/plugin/";
  var storage = require("uxp").storage;
  var fs = storage.localFileSystem;

  // Two panels (WavePlug Studio, WavePlug 图层) must be registered right away, before the build is
  // read; each gets a root element that survives ⟳. The build finds them in __waveplugPanels.
  var panels = { studio: { root: null, shown: false }, layers: { root: null, shown: false } };
  var listeners = [];
  function rootOf(name) {
    var p = panels[name];
    if (!p.root) { p.root = document.createElement("div"); p.root.style.height = "100%"; }
    return p.root;
  }
  function shown(name, on, arg) {
    var node = arg && arg.node || arg, r = rootOf(name);
    if (on && node && node.appendChild && r.parentNode !== node) node.appendChild(r);
    panels[name].shown = on;
    listeners.forEach(function (cb) { try { cb(name, on); } catch (e) { /* build gone */ } });
  }
  function panel(name) {
    return { show: function (a) { shown(name, true, a); }, hide: function (a) { shown(name, false, a); } };
  }
  try { require("uxp").entrypoints.setup({ panels: { "studio-dev": panel("studio"), "layers-dev": panel("layers") } }); }
  catch (e) { console.warn("entrypoints.setup", e); }
  globalThis.__waveplugPanels = {
    root: rootOf,
    isShown: function (name) { return panels[name].shown; },
    onShow: function (cb) { listeners.push(cb); },
  };

  async function readText(name) {
    var urls = ["file:" + ROOT + name, "file:///" + ROOT + name];
    var last;
    for (var i = 0; i < urls.length; i++) {
      try { var f = await fs.getEntryWithUrl(urls[i]); return await f.read({ format: storage.formats.utf8 }); }
      catch (e) { last = e; }
    }
    throw new Error("无法读取 " + ROOT + name + "：" + (last && last.message));
  }

  function showError(e) {
    var body = rootOf("studio");
    body.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "padding:12px;color:#e0705f;font:11px sans-serif;white-space:pre-wrap";
    box.textContent = "开发版加载失败：\n" + (e && e.stack || e);
    var retry = document.createElement("div");
    retry.textContent = "重试";
    retry.style.cssText = "margin-top:10px;color:#63c2b1;cursor:pointer;text-decoration:underline";
    retry.addEventListener("click", load);
    box.appendChild(retry);
    body.appendChild(box);
  }

  async function load() {
    try {
      if (typeof globalThis.__waveplugDispose === "function") { try { globalThis.__waveplugDispose(); } catch (e) { /* old build */ } }
      var css = await readText("styles.css");
      var js = await readText("index.js");
      document.head.querySelectorAll("style[data-waveplug]").forEach(function (s) { s.remove(); });
      var style = document.createElement("style");
      style.setAttribute("data-waveplug", "");
      style.textContent = css;
      document.head.appendChild(style);
      listeners = [];
      rootOf("studio").innerHTML = '<div id="app"></div>';
      rootOf("layers").innerHTML = '<div id="layers-app"></div>';
      globalThis.__waveplugDevReload = load;
      (0, eval)(js);
    } catch (e) { showError(e); }
  }

  load();
})();
