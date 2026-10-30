// WavePlug Studio — development loader.
// Installed once (as a separate plugin, com.waveplug.studio.dev). Every time the panel opens or
// ⟳ is clicked, it reads the latest build from F:\waveplug\studio\dist\plugin and runs it, so code
// changes take effect without closing Photoshop or reinstalling.
(function () {
  "use strict";
  var ROOT = "F:/waveplug/studio/dist/plugin/";
  var storage = require("uxp").storage;
  var fs = storage.localFileSystem;

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
    document.body.innerHTML = "";
    var box = document.createElement("div");
    box.style.cssText = "padding:12px;color:#e0705f;font:11px sans-serif;white-space:pre-wrap";
    box.textContent = "开发版加载失败：\n" + (e && e.stack || e);
    var retry = document.createElement("div");
    retry.textContent = "重试";
    retry.style.cssText = "margin-top:10px;color:#63c2b1;cursor:pointer;text-decoration:underline";
    retry.addEventListener("click", load);
    box.appendChild(retry);
    document.body.appendChild(box);
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
      document.body.innerHTML = '<div id="app"></div>';
      globalThis.__waveplugDevReload = load;
      (0, eval)(js);
    } catch (e) { showError(e); }
  }

  load();
})();
