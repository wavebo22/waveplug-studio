import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DROP_FILES, fileBaseName, fileDropHint, fileDropMode, pageImage, webDrop, webDropResultText, webImageExt, webImageName, fileDropResultText, fileExt, fileLayerName, pathsFromDropText, planFileDrop } from "../src/core/layers/fileDrop.ts";

test("拖拽文件置入：PSD / PSB 默认链接，其他嵌入，Alt 互换", () => {
  assert.equal(fileDropMode("海报.psd"), "linked");
  assert.equal(fileDropMode("BIG.PSB"), "linked");
  assert.equal(fileDropMode("photo.JPG"), "embedded");
  assert.equal(fileDropMode("logo.ai"), "embedded");
  assert.equal(fileDropMode("海报.psd", true), "embedded");
  assert.equal(fileDropMode("photo.png", true), "linked");
});

test("拖拽文件置入：不能置入的文件和文件夹", () => {
  assert.equal(fileDropMode("notes.txt"), null);
  assert.equal(fileDropMode("素材文件夹"), null);
  assert.equal(fileDropMode(".psd"), null);
  assert.equal(fileDropMode("a.psd.bak"), null);
});

test("拖拽文件置入：扩展名、文件名、图层名", () => {
  assert.equal(fileExt("C:\\work\\v1.2\\图.PSD"), "psd");
  assert.equal(fileExt("/Users/a/b.c/noext"), "");
  assert.equal(fileBaseName("C:\\work\\图.psd"), "图.psd");
  assert.equal(fileBaseName("/tmp/a/b.png"), "b.png");
  assert.equal(fileLayerName("C:\\work\\主视觉.v2.psd"), "主视觉.v2");
});

test("拖拽文件置入：按拖入顺序，分出不支持的，超过上限的不置入", () => {
  const plan = planFileDrop([{ file: 1, name: "a.psd" }, { file: 2, name: "b.txt" }, { file: 3, name: "c.png" }]);
  assert.deepEqual(plan.items, [{ file: 1, name: "a.psd", mode: "linked" }, { file: 3, name: "c.png", mode: "embedded" }]);
  assert.deepEqual(plan.unsupported, ["b.txt"]);
  assert.equal(plan.leftOut, 0);
  const many = planFileDrop(Array.from({ length: MAX_DROP_FILES + 3 }, (_, i) => ({ file: i, name: `f${i}.png` })));
  assert.equal(many.items.length, MAX_DROP_FILES);
  assert.equal(many.leftOut, 3);
});

test("拖拽文件置入：提示和结果文字", () => {
  assert.match(fileDropHint(), /PSD 链接/);
  assert.match(fileDropHint(true), /PSD 嵌入/);
  const none = { unsupported: [], leftOut: 0 };
  assert.deepEqual(fileDropResultText({ linked: 1, embedded: 2, opened: 0, failed: [] }, none), { text: "已链接置入 1 个，嵌入置入 2 个", kind: "ok" });
  assert.deepEqual(fileDropResultText({ linked: 0, embedded: 0, opened: 2, failed: [] }, none), { text: "已打开 2 个", kind: "ok" });
  const part = fileDropResultText({ linked: 1, embedded: 0, opened: 0, failed: ["x.psd"] }, { unsupported: ["a.txt", "b.doc", "c.zip"], leftOut: 0 });
  assert.equal(part.kind, "error");
  assert.equal(part.text, "已链接置入 1 个；1 个失败（x.psd），3 个不支持（a.txt、b.doc 等）");
  assert.deepEqual(fileDropResultText({ linked: 0, embedded: 0, opened: 0, failed: [] }, { unsupported: ["a.txt"], leftOut: 0 }), { text: "没有置入：1 个不支持（a.txt）", kind: "error" });
});

test("拖拽文件置入：从拖拽文字里取文件路径", () => {
  assert.deepEqual(pathsFromDropText("file:///C:/work/%E4%B8%BB%E8%A7%86%E8%A7%89.psd\r\n# comment\r\nfile:///D:/a%20b.png"), ["C:\\work\\主视觉.psd", "D:\\a b.png"]);
  assert.deepEqual(pathsFromDropText("file:///Users/me/a.psd"), ["/Users/me/a.psd"]);
  assert.deepEqual(pathsFromDropText('"C:\\work\\a.psd"\nhello\n\\\\nas\\b.png'), ["C:\\work\\a.psd", "\\\\nas\\b.png"]);
  assert.deepEqual(pathsFromDropText(""), []);
});

test("拖入文件：Alt 决定嵌入或链接，全部文件同一种方式", () => {
  const plan = planFileDrop([{ file: 1, name: "a.psd" }, { file: 2, name: "b.png" }, { file: 3, name: "c.txt" }], false, "embedded");
  assert.deepEqual(plan.items.map(i => i.mode), ["embedded", "embedded"]);
  assert.deepEqual(planFileDrop([{ file: 1, name: "b.png" }], false, "linked").items.map(i => i.mode), ["linked"]);
  assert.deepEqual(plan.unsupported, ["c.txt"]);
});

test("从网页拖入: image addresses, data images, words", () => {
  assert.deepEqual(webDrop([{ type: "text/plain", text: "https://a.com/x/cat.png?w=200" }]), { kind: "images", urls: ["https://a.com/x/cat.png?w=200"] });
  assert.deepEqual(webDrop([{ type: "text/html", text: '<a href="/p"><img alt="" src="https://cdn.com/i/1.webp?a=1&amp;b=2"></a>' }, { type: "text/plain", text: "https://site.com/page" }]), { kind: "images", urls: ["https://cdn.com/i/1.webp?a=1&b=2"] });
  assert.equal(webDrop([{ type: "text/plain", text: "data:image/png;base64,AAAA" }])?.kind, "images");
  assert.deepEqual(webDrop([{ type: "text/plain", text: "  你好\r\n世界 " }]), { kind: "text", text: "你好\n世界" });
  assert.equal(webDrop([{ type: "text/plain", text: "看这个 https://a.com/x.png" }])?.kind, "text");
  assert.equal(webDrop([{ type: "text/plain", text: "   " }]), null);
  assert.equal(webImageExt("image/jpeg; charset=x", "https://a/b"), "jpg");
  assert.equal(webImageExt("text/html", "https://a/b.png"), null);
  assert.equal(webImageExt("application/octet-stream", "https://a/b.JPEG"), "jpg");
  assert.equal(webImageName("https://a.com/img/%E7%8C%AB.png?x=1"), "猫");
  assert.equal(webImageName("data:image/png;base64,AA"), "网页图片");
  assert.equal(webDropResultText({ placed: 2, failed: [] }).text, "已置入 2 张网页图片");
});

test("从网页拖入: a link's page gives its own picture", () => {
  assert.deepEqual(pageImage('<head><title>x</title><meta data-vue-meta="true" property="og:image" content="//i0.hdslb.com/bfs/archive/a.jpg@100w.webp"><meta property="og:title" content="视频标题_哔哩哔哩"></head>', "https://www.bilibili.com/video/BV1"), { url: "https://i0.hdslb.com/bfs/archive/a.jpg@100w.webp", title: "视频标题_哔哩哔哩" });
  assert.equal(pageImage("<meta content='/img/p.png?a=1&amp;b=2' name='twitter:image'>", "https://a.com/pins/1")?.url, "https://a.com/img/p.png?a=1&b=2");
  assert.equal(pageImage('<link rel="image_src" href="https://c.com/z.jpg"><title> 页 </title>', "https://c.com/")?.title, "页");
  assert.equal(pageImage("<html><body>no meta</body></html>", "https://a.com/"), null);
});
