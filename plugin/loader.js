// WavePlug Studio — loader (one plugin, com.waveplug.studio, for users and for development).
// It registers the two panels, then runs a build:
//   • 开发文件夹 (G:\waveplug\studio\dist\plugin, or localStorage "wp.devRoot"): when that folder is
//     reachable and "wp.loadFrom" isn't "bundled". Every ⟳ / new build-stamp.txt reads it again,
//     so code changes take effect without closing Photoshop or reinstalling.
//   • the build inside the plugin (index.js / styles.css next to this file) otherwise, and whenever
//     the development folder can't be read.
// The build learns which one through __waveplugSource ("dev" | "bundled").
(function () {
  "use strict";
  var DEFAULT_DEV_ROOT = "G:/waveplug/studio/dist/plugin/";
  var storage = require("uxp").storage;
  var fs = storage.localFileSystem;

  function setting(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function devRoot() {
    var r = (setting("wp.devRoot") || DEFAULT_DEV_ROOT).replace(/\\/g, "/");
    return /\/$/.test(r) ? r : r + "/";
  }

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
  try { require("uxp").entrypoints.setup({ panels: { studio: panel("studio"), layers: panel("layers") } }); }
  catch (e) { console.warn("entrypoints.setup", e); }
  globalThis.__waveplugPanels = {
    root: rootOf,
    isShown: function (name) { return panels[name].shown; },
    onShow: function (cb) { listeners.push(cb); },
  };

  async function readDev(name) {
    var root = devRoot(), urls = ["file:" + root + name, "file:///" + root + name];
    var last;
    for (var i = 0; i < urls.length; i++) {
      try { var f = await fs.getEntryWithUrl(urls[i]); return await f.read({ format: storage.formats.utf8 }); }
      catch (e) { last = e; }
    }
    throw new Error("无法读取 " + root + name + "：" + (last && last.message));
  }
  async function readBundled(name) {
    var dir = await fs.getPluginFolder();
    var f = await dir.getEntry(name);
    return await f.read({ format: storage.formats.utf8 });
  }

  function showError(e) {
    var body = rootOf("studio");
    body.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "padding:12px;color:#e0705f;font:11px sans-serif;white-space:pre-wrap";
    box.textContent = "WavePlug 加载失败：\n" + (e && e.stack || e);
    var retry = document.createElement("div");
    retry.textContent = "重试";
    retry.style.cssText = "margin-top:10px;color:#63c2b1;cursor:pointer;text-decoration:underline";
    retry.addEventListener("click", load);
    box.appendChild(retry);
    body.appendChild(box);
  }

  /** css + js from the development folder, or null (not wanted / not reachable) */
  async function fromDev() {
    if (setting("wp.loadFrom") === "bundled") return null;
    try {
      var css = await readDev("styles.css");
      var js = await readDev("index.js");
      return { css: css, js: js };
    } catch (e) {
      return { error: e };
    }
  }

  async function load() {
    try {
      if (typeof globalThis.__waveplugDispose === "function") { try { globalThis.__waveplugDispose(); } catch (e) { /* old build */ } }
      var dev = await fromDev(), source = "dev", css, js;
      if (dev && dev.js) { css = dev.css; js = dev.js; }
      else {
        source = "bundled";
        // wanted the development folder but it isn't there (another computer, drive not mounted)
        globalThis.__waveplugDevMissing = dev && dev.error ? String(dev.error.message || dev.error) : "";
        css = await readBundled("styles.css");
        js = await readBundled("index.js");
      }
      document.head.querySelectorAll("style[data-waveplug]").forEach(function (s) { s.remove(); });
      var style = document.createElement("style");
      style.setAttribute("data-waveplug", "");
      style.textContent = css;
      document.head.appendChild(style);
      listeners = [];
      rootOf("studio").innerHTML = '<div id="app"></div>';
      rootOf("layers").innerHTML = '<div id="layers-app"></div>';
      globalThis.__waveplugSource = source;
      globalThis.__waveplugDevRoot = devRoot();
      globalThis.__waveplugDevReload = load;
      (0, eval)(js);
    } catch (e) { showError(e); }
  }

  load();
})();
