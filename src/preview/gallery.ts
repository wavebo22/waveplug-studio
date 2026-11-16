// Component gallery: the panels' shared pieces in each state, drawn with the plugin's real styles.css
// and class names, so it shows what the panels look like now. For checking the UI spec
// (docs/UI_DESIGN_SYSTEM.md) at a glance; built to dist/preview/gallery.html. Browser only —
// UXP draws some things differently (no box-shadow, native inputs), so confirm in Photoshop too.

import { h, icon, ICON_NAMES } from "../ui/dom.ts";
import { createSlider } from "../ui/slider.ts";

// Photoshop's panel backgrounds per interface theme (approximate)
const THEMES: [string, string][] = [["最深", "#262626"], ["深色", "#323232"], ["中灰", "#535353"]];

const COLORS = ["--c-bg", "--c-text", "--c-text-2", "--c-text-3", "--c-surface", "--c-field", "--c-line", "--c-line-soft",
  "--c-hover", "--c-accent", "--c-accent-hi", "--c-accent-ink", "--c-accent-wash", "--c-accent-wash-strong",
  "--c-ok", "--c-warn", "--c-err", "--c-info", "--tag-shared", "--tag-link", "--tag-edit", "--tag-content", "--tag-ai"];

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const sec = (title: string, note: string | null, ...body: Node[]) =>
  h("section", { class: "g-sec" }, h("h2", null, title), note ? h("p", null, note) : null, ...body);
const row = (caption: string | null, ...items: Node[]) =>
  h("div", { class: "g-row" }, caption ? h("div", { class: "g-cap" }, caption) : null, ...items);

function disabled<T extends HTMLElement>(el: T): T { (el as any).disabled = true; return el; }

function themeBar() {
  const btns = THEMES.map(([label, bg], i) => {
    const b = h("button", { class: "seg-btn" + (i === 1 ? " on" : ""), onClick: () => {
      document.documentElement.style.setProperty("--uxp-host-background-color", bg);
      for (const o of btns) o.classList.toggle("on", o === b);
      renderSwatches();
    } }, label);
    return b;
  });
  return h("div", { class: "g-bar" }, h("h1", null, "WavePlug 组件预览"), h("div", { class: "seg" }, ...btns),
    h("span", { class: "small" }, "PS 面板背景（近似值）。悬停状态请用鼠标查看。"));
}

const swatches = h("div", { class: "g-row" });
function renderSwatches() {
  swatches.textContent = "";
  for (const n of COLORS) swatches.append(h("div", { class: "g-sw" }, h("i", { style: `background: var(${n})` }), n, h("br"), token(n)));
}

function tokens() {
  renderSwatches();
  const ruler = (name: string, prop: "width" | "height") =>
    h("div", { class: "g-ruler" }, h("code", null, name), h("i", { style: prop === "width" ? `width: var(${name}); height: 10px` : `height: var(${name}); width: 40px` }), token(name));
  return [
    sec("颜色", null, swatches),
    sec("字号", "最小 11px", ...["--fs-s", "--fs", "--fs-l"].map(n =>
      h("div", { class: "g-ruler", style: `font-size: var(${n})` }, h("code", { style: "font-size: 11px" }, n), "图层 1 · AI 结果 v2 · " + token(n)))),
    sec("间距", null, ...["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6"].map(n => ruler(n, "width"))),
    sec("控件高度", null, ...["--h-xs", "--h-s", "--h-m", "--h-l"].map(n => ruler(n, "height"))),
    sec("圆角", null, row(null, ...["--r-s", "--r", "--r-pill"].map(n =>
      h("div", { class: "g-sw" }, h("i", { style: `border-radius: var(${n}); background: var(--c-field); border-color: var(--c-line)` }), n, " ", token(n))))),
  ];
}

function mainPanel() {
  const seg = h("div", { class: "seg" }, h("button", { class: "seg-btn on" }, "局部重绘"), h("button", { class: "seg-btn" }, "扩图"), h("button", { class: "seg-btn" }, "融图"));
  const slider = createSlider({ onInput: () => {}, onChange: () => {} }); slider.value = 60;
  const sliderOff = createSlider({ onInput: () => {}, onChange: () => {} }); sliderOff.value = 30; sliderOff.disabled = true;
  const running = h("button", { class: "generate running" }, icon("stop", 14), "停止");
  const notice = (err: boolean) => h("div", { class: "wb-notice" + (err ? " is-error" : "") },
    h("div", { class: "wb-notice-head" }, icon("warn", 14), h("span", { class: "wb-notice-title" }, err ? "放置失败" : "有 1 项被跳过")),
    h("div", { class: "wb-notice-reason" }, err ? "目标图层已锁定。" : "引用的图层已被删除。"),
    h("div", { class: "wb-notice-advice" }, "解锁后重试。"));
  return [
    sec("按钮", null,
      row("btn / primary / 禁用", h("button", { class: "btn" }, "关闭"), h("button", { class: "btn primary" }, "确定"), disabled(h("button", { class: "btn" }, "禁用"))),
      row("generate：默认 / 禁用 / 运行中", h("button", { class: "generate" }, icon("spark", 14), "生成")),
      row(null, disabled(h("button", { class: "generate" }, icon("spark", 14), "生成"))),
      row(null, running)),
    sec("图标按钮", "不同组件现在各有一套尺寸，统一时归到 22 / 26 两档",
      row("icon-btn 28 / icon-btn.sm 26 / wb-icon-btn 24", h("button", { class: "icon-btn" }, icon("dice")), h("button", { class: "icon-btn sm" }, icon("eye")),
        h("button", { class: "wb-icon-btn" }, icon("wbPlace", 16)), disabled(h("button", { class: "wb-icon-btn is-disabled" }, icon("wbExport", 16))))),
    sec("输入", null,
      row("field（input / select）", h("input", { class: "field", type: "text", placeholder: "输入文字" })),
      row(null, h("select", { class: "field" }, h("option", null, "每次随机"), h("option", null, "固定"))),
      row("prompt", h("textarea", { class: "prompt", rows: 3, placeholder: "描述想要的内容" }))),
    sec("分段选择", null, seg),
    sec("勾选", null, row(null, h("label", { class: "check-row" }, h("input", { type: "checkbox", checked: true }), h("span", null, "只在选区内生成")),
      h("label", { class: "check-row" }, h("input", { type: "checkbox" }), h("span", null, "未勾选")))),
    sec("胶囊 / 状态", null,
      row("flow-btn / warn", h("button", { class: "flow-btn" }, icon("flow", 14), h("span", { class: "flow-name" }, "局部重绘 PS"), icon("chevron", 12)),
        h("button", { class: "flow-btn warn" }, icon("warn", 14), h("span", { class: "flow-name" }, "缺少节点"))),
      row("conn：已连接 / 断开 / 检查中", ...[["ok", "已连接"], ["down", "未连接"], ["checking", "检查中"]].map(([c, t]) =>
        h("button", { class: "conn " + c }, h("span", { class: "dot" }), t))),
      row("badge", h("span", { class: "badge certain" }, "确定"), h("span", { class: "badge likely" }, "可能"), h("span", { class: "badge ambiguous" }, "不确定"), h("span", { class: "badge" }, "默认"))),
    sec("卡片 / 提示", null,
      h("section", { class: "card" }, h("div", { class: "card-head" }, h("span", { class: "label" }, "智能对象"), h("span", { class: "muted small" }, "3 个")), h("div", { class: "hint" }, "卡片正文与 hint 文字。")),
      h("div", { class: "alert" }, icon("warn", 14), h("span", null, "无法连接 ComfyUI。")),
      notice(false), notice(true)),
    sec("滑块：默认 / 禁用", null, row(null, slider.el), row(null, sliderOff.el)),
  ];
}

function layerRow(name: string, state: string, tags: [string, string][], color = "") {
  const eye = h("div", { class: "lt-eye" + (state === "off" ? " hidden" : "") }, state === "off" ? null : icon("psEye", 14));
  const body = h("div", { class: "lt-body" }, h("span", { class: "lt-name" }, name),
    h("span", { class: "lt-tags" }, ...tags.map(([c, t]) => h("span", { class: "lt-tag " + c }, t))));
  return h("div", { class: "lt-row" + (state ? " " + state : "") }, h("div", { class: "lt-stripe" + (color ? " " + color : "") }), eye, body);
}

function layersPanel() {
  const list = h("div", { class: "lt-list sz-s" },
    layerRow("普通图层", "", []),
    layerRow("悬停", "hover", []),
    layerRow("选中", "on", [["own", "PSB"]]),
    layerRow("选中 + 悬停", "on hover", []),
    layerRow("隐藏的图层", "off", []),
    layerRow("同源高亮（peer）", "peer", [["shared", "共享×2"]], "c0"),
    layerRow("很长很长很长很长的图层名称会被截断显示", "", [["ai", "AI"]], "c3"));
  const tool = (name: string) => h("button", { class: "lt-tool" }, icon(name, 16));
  const menu = h("div", { class: "pm" }, h("div", { class: "pm-item" }, "复制图层"), h("div", { class: "pm-item" }, "转换为智能对象"),
    h("div", { class: "pm-sep" }), h("div", { class: "pm-item off" }, "不可用的项"));
  return [
    sec("图层面板顶部", "现在混用 22 / 26 / 27 高", h("div", { class: "lt" },
      row(null, h("button", { class: "lt-head-btn" }, "正常"), h("button", { class: "lt-top-icon" }, icon("image", 15)), h("button", { class: "lt-top-icon" }, icon("psFilters", 16))),
      row(null, h("input", { class: "field lt-search", type: "text", placeholder: "搜索图层名称" })))),
    sec("图层行：普通 / 悬停 / 选中 / 隐藏 / 同源 / 截断", null, h("div", { class: "lt" }, list)),
    sec("图层标签", null, h("div", { class: "lt" }, row(null,
      ...[["own", "PSB"], ["edit", "可编辑"], ["content", "PNG"], ["shared", "共享×3"], ["link", "外链"], ["ai", "AI"], ["mask", "蒙版"]].map(([c, t]) => h("span", { class: "lt-tag " + c }, t))))),
    sec("底部工具栏", null, h("div", { class: "lt" }, h("div", { class: "lt-foot" }, tool("psClip"), tool("psMask"), tool("psAdjust"), tool("psFolder"), tool("psNew"), tool("psTrash"),
      disabled(h("button", { class: "lt-tool is-disabled" }, icon("psLink", 16)))))),
    sec("右键菜单 / 悬停提示", "浮层的阴影在 UXP 里不显示", h("div", { class: "g-static" }, menu, h("div", { style: "height: 8px" }), h("div", { class: "tip" }, "显示 / 隐藏（Alt+单击：只显示这个图层）"))),
    sec("工作台", "按来源分组；失效条目置灰并说明；设置行与右键「发送到」共用", h("div", { class: "wb-section" },
      h("div", { class: "wb-head" }, h("span", { class: "wb-heading" }, "编辑工作台"), h("span", { class: "wb-count" }, "3 项"), h("button", { class: "wb-action" }, "清空")),
      h("div", { class: "wb-items" },
        h("div", { class: "wb-src" }, icon("chevron", 12), h("span", { class: "wb-dot on" }), h("span", { class: "wb-src-name" }, "主文档.psd"), h("span", { class: "wb-src-count" }, "2")),
        h("div", { class: "wb-item sel" }, h("span", { class: "wb-thumb" }), h("span", { class: "wb-item-name" }, "产品图"), h("button", { class: "wb-remove" }, icon("close", 12))),
        h("div", { class: "wb-item" }, h("span", { class: "wb-thumb" }), h("span", { class: "wb-item-name" }, "标题"), h("button", { class: "wb-remove" }, icon("close", 12))),
        h("div", { class: "wb-src" }, icon("chevron", 12), h("span", { class: "wb-dot" }), h("span", { class: "wb-src-name" }, "参考.psd"), h("span", { class: "wb-src-count" }, "1")),
        h("div", { class: "wb-item stale" }, h("span", { class: "wb-thumb" }), h("span", { class: "wb-item-name" }, "背景"), h("span", { class: "wb-item-state" }, "来源未打开"), h("button", { class: "wb-remove" }, icon("close", 12)))),
      h("div", { class: "wb-actions" }, h("button", { class: "wb-icon-btn on" }, icon("chevron", 16)), h("span", { class: "grow" }),
        h("button", { class: "wb-place" }, icon("wbPlace", 16), h("span", null, "置入所选 1"))),
      h("div", { class: "wb-options" },
        h("div", { class: "wb-opt-line" }, h("span", { class: "wb-opt-label" }, "位置"), h("div", { class: "wb-seg" }, h("div", { class: "wb-seg-btn on" }, "置顶"), h("div", { class: "wb-seg-btn" }, "选中图层上方"))),
        h("div", { class: "wb-opt-line" }, h("div", { class: "wb-opt" }, h("span", { class: "wb-check on" }), h("span", null, "还原画面位置")), h("div", { class: "wb-opt" }, h("span", { class: "wb-check" }), h("span", null, "随画布缩放")))),
      h("span", { class: "wb-state" }, "已置入 2 个图层到「工作台素材」；2 个已还原画面位置"))),
  ];
}

// Photoshop's filter on/off toggle: a small upright switch, knob up and lit when filtering is on.
function filterToggle(on: boolean) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
  const body = document.createElementNS(ns, "rect");
  for (const [k, v] of Object.entries({ x: "4.5", y: "1.5", width: "7", height: "13", rx: "3.5", fill: "none", stroke: "currentColor", "stroke-width": "1.2" })) body.setAttribute(k, v);
  const knob = document.createElementNS(ns, "circle");
  for (const [k, v] of Object.entries({ cx: "8", cy: on ? "5" : "11", r: "2.2", fill: "currentColor", class: "knob" })) knob.setAttribute(k, v);
  svg.append(body, knob);
  return h("button", { class: "p-ibtn p-toggle" + (on ? " on" : ""), title: "打开 / 关闭图层过滤" }, svg);
}

// Proposal for the WaveLayer top area (11-04), shown here before it goes into layerTree.ts.
function topProposal(narrow: boolean) {
  const pct = (v: string) => h("div", { class: "p-pct" }, h("span", null, v), h("i", null, icon("chevron", 10)));
  const lock = (name: string, on = false) => h("button", { class: "p-ibtn" + (on ? " on" : "") }, icon(name, 14));
  const xbtn = (tip: string, ...c: Node[]) => h("button", { class: "p-ibtn p-xbtn", title: tip }, ...c);
  const fx = (dir: string) => h("span", { class: "p-fx" }, "fx", icon(dir, 8));
  const expand = () => h("div", { class: "p-xbtns" },
    xbtn("展开组", icon("folderOpen", 14)), xbtn("展开效果", fx("chevron")), h("span", { class: "p-sep" }),
    xbtn("折叠组", icon("folder", 14)), xbtn("折叠效果", fx("chevronRight")), xbtn("折叠全部", icon("layers", 14)));
  return h("div", { class: "lt p-frame" + (narrow ? " narrow" : "") },
    h("div", { class: "p-row p-head" },
      h("span", { class: "p-title" }, "图层"), h("span", { class: "p-count" }, "3021 · 已选 1"),
      h("span", { class: "lt-peers", style: "flex: none" }, "共用×3"),
      h("span", { class: "p-grow" }),
      h("button", { class: "p-ibtn small", title: "缩略图大小" }, icon("image", 14))),
    h("div", { class: "p-row p-find" },
      h("input", { class: "field p-search", type: "text", placeholder: "搜索图层" }),
      expand(),
      h("span", { class: "p-grow" }),
      h("button", { class: "p-ibtn", title: "筛选" }, icon("psFilters", 15)),
      filterToggle(true)),
    h("div", { class: "p-line" }),
    h("div", { class: "p-row" },
      h("select", { class: "field p-mode" }, h("option", null, "正常"), h("option", null, "颜色减淡")),
      h("span", { class: "p-grow" }),
      h("span", { class: "p-label" }, "不透明度"), pct("100%")),
    h("div", { class: "p-row" },
      h("span", { class: "p-label p-lock-label" }, "锁定"),
      h("div", { class: "p-locks" }, lock("checker"), lock("brush"), lock("move"), lock("lock", true)),
      h("span", { class: "p-grow" }),
      h("span", { class: "p-label" }, "填充"), pct("100%")),
    h("div", { class: "p-list" }, "图层列表"));
}

function topSection() {
  return [sec("图层面板顶部方案（11-04 已接入插件）", "300px 和 240px 两种面板宽度",
    topProposal(false), topProposal(true),
    h("ul", { class: "p-notes" },
      h("li", null, "和 PS 原版同样的三行：筛选 / 混合模式 + 不透明度 / 锁定 + 填充。不透明度和填充右对齐成一列，数值框同宽 64px。"),
      h("li", null, "5 个展开 / 折叠按钮（展开组、展开效果 | 折叠组、折叠效果、折叠全部）直接放在搜索框右边，不合成菜单。面板窄到放不下时（约 285px 以下），这 5 个按钮换到搜索框下面一行。漏斗和筛选开关放到这一行最右边，开关改成 PS 原版那种竖着的小开关图标。"),
      h("li", null, "锁定行只剩锁定和填充。240px 宽时三行都不溢出，不用再隐藏文字（插件最小宽度 220px）。"),
      h("li", null, "标题行只留「图层」、数量和已选数，详细信息放进悬停提示；缩略图大小按钮移到标题行右侧。"),
      h("li", null, "筛选行和属性行之间加一条分割线，和 PS 一样把「筛选」和「属性」分开。"),
      h("li", null, "搜索框（80px）和混合模式（96px）只留四个字多一点的宽度，不再撑满。"),
      h("li", null, "所有控件 24px 高，行间距 6px；图标暂用现有的，图标重绘另做。")))];
}

function icons() {
  return [sec(`图标（${ICON_NAMES.length} 个，16px）`, "同一含义有两套的（如 eye / psEye）统一时只留一套",
    row(null, ...ICON_NAMES.map(n => h("div", { class: "g-icon" }, icon(n, 16), n))))];
}

const col = (...items: Node[]) => h("div", { class: "g-col" }, ...items);
document.getElementById("gallery")!.append(themeBar(), h("div", { class: "g-cols" },
  col(...topSection()), col(...tokens()), col(...mainPanel()), col(...layersPanel()), col(...icons())));
