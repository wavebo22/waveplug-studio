// WavePlug Studio panel. Layout follows V1.4: versions on top → workflow row → prompt →
// references → "参考当前画面" + selection → generate → collapsed advanced → status line.

import { type Comfy, ComfyError } from "../core/comfy/client.ts";
import type { Rect } from "../core/image/region.ts";
import { asApiGraph } from "../core/workflow/api.ts";
import { MAX_SEED, randomSeed } from "../core/workflow/inject.ts";
import { type Binding, type Profile, carryOver, newProfile, validateProfile } from "../core/workflow/profile.ts";
import { recognize } from "../core/workflow/recognize.ts";
import { uiToApi } from "../core/workflow/uiToApi.ts";
import { findLocalMaskLinks } from "../core/workflow/localMask.ts";
import { type RefSource, StashedResult, runInpaint } from "../app/generate.ts";
import { type ProfileState, type Services, type Settings, store } from "../app/services.ts";
import type { DocInfo, FillGroup, Variation } from "../ps/host.ts";
import { log, withTimeout } from "../app/log.ts";
import { openCalibration } from "./calibrate.ts";
import { h, icon, replace } from "./dom.ts";

type Conn = { state: "checking" | "ok" | "down"; text: string };

const OLD_HINTS = ["描述要画进选区的内容；留空 = 移除选区内的内容", "描述要画进选区的内容"];
/** Strips hint text that older versions' placeholder may have merged into the prompt. */
export function cleanPrompt(s: string): string {
  for (const h of OLD_HINTS) s = s.split(h).join("");
  return s.trim();
}

/** Accepts "127.0.0.1", "127.0.0.1:8188", "http://host:port/" … and returns "http://host:port". */
export function normalizeUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return "http://127.0.0.1:8188";
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  if (!/^https?:\/\/[^/]+:\d+/i.test(s) && /^http:/i.test(s)) s = s.replace(/^(http:\/\/[^/]+)/i, "$1:8188");
  return s;
}
type RefSlot = RefSource & { thumb?: string };

export function mountApp(root: HTMLElement, svc: Services) {
  let settings: Settings = store.settings();
  let profiles: Profile[] = store.profiles();
  let profile: Profile | null = profiles.find(p => p.id === settings.activeProfile) ?? profiles[0] ?? null;
  let pstate: ProfileState | null = profile ? store.state(profile.id) : null;
  let comfy: Comfy = svc.comfy(settings.comfyUrl);
  let conn: Conn = { state: "checking", text: "连接中…" };
  let doc: DocInfo | null = null, sel: Rect | null = null, group: FillGroup | null = null;
  let variations: Variation[] = [];
  // thumbnails keyed "docId:layerId" — rebuilt from Photoshop when missing
  const thumbs = new Map<string, string>();
  const refs: Record<number, RefSlot | undefined> = {};
  let run: null | { stage: string; progress: number | null; detail: string; promptId?: string; signal: { aborted: boolean } } = null;
  let status: { text: string; kind: "info" | "ok" | "error" } = { text: "就绪", kind: "info" };
  let stash: Uint8Array | null = null;

  // ── skeleton ──
  const connEl = h("button", { class: "conn", title: "ComfyUI 连接设置", onClick: () => openSettings() });
  const targetEl = h("span", { class: "target" });
  const historyEl = h("div", { class: "history vars" });
  const varPromptEl = h("div", { class: "var-prompt" });
  const flowSel = h("select", { class: "field grow", title: "工作流" });
  const prompt = h("textarea", { class: "prompt", rows: 4 }) as HTMLTextAreaElement;
  const refsEl = h("div", { class: "refs" });
  const promptHint = h("div", { class: "prompt-hint" });
  const selEl = h("span", { class: "sel-state" });
  const genBtn = h("button", { class: "generate" });
  const progEl = h("div", { class: "progress" });
  const advHead = h("button", { class: "adv-head" });
  const advBody = h("div", { class: "adv-body" });
  const statusEl = h("div", { class: "status" });
  const sheetHost = h("div", { class: "sheet-host" });

  const mainEl = h("main", { class: "scroll" });
  const footEl = h("footer", { class: "foot" });
  // UXP draws native text fields above everything regardless of z-index, so while a sheet is open
  // the work area is taken out of the DOM (not hidden — a visibility toggle coincided with a host
  // crash in 0.1.4) and put back when the last sheet closes. Element state (prompt text) is kept.
  const syncSheets = () => {
    const open = !!sheetHost.querySelector(".sheet");
    if (open && mainEl.parentNode) mainEl.remove();
    else if (!open && !mainEl.parentNode) root.insertBefore(mainEl, footEl);
  };
  const appendToHost = sheetHost.append.bind(sheetHost);
  sheetHost.append = (...nodes: (Node | string)[]) => {
    for (const n of nodes) if (n instanceof HTMLElement && n.classList.contains("sheet")) {
      const detach = n.remove.bind(n);
      n.remove = () => { detach(); syncSheets(); };
    }
    appendToHost(...nodes);
    syncSheets();
  };

  root.append(
    h("header", { class: "top" },
      h("div", { class: "brand" }, h("span", { class: "mark" }, "W"), h("span", null, "WavePlug Studio")),
      connEl),
    (mainEl.append(
      h("section", { class: "block" },
        h("div", { class: "label-row" }, h("span", { class: "label" }, "变体"), targetEl),
        historyEl, varPromptEl),
      h("section", { class: "block row" },
        h("span", { class: "flow-icon", title: "工作流" }, icon("flow")),
        flowSel,
        h("button", { class: "icon-btn", title: "接口校准", onClick: () => calibrate() }, icon("sliders")),
        h("button", { class: "icon-btn", title: "导入工作流", onClick: () => importMenu() }, icon("plus"))),
      h("section", { class: "block tight" }, prompt, promptHint, refsEl,
        h("div", { class: "opt-row" },
          h("label", { class: "check-row locked", title: "局部重绘始终以当前画面为底图" },
            h("input", { type: "checkbox", checked: true, disabled: true }), h("span", null, "参考当前画面")),
          selEl)),
      h("section", { class: "block" }, genBtn, progEl),
      h("section", { class: "block adv" }, advHead, advBody)), mainEl),
    (footEl.append(statusEl, h("span", { class: "ver" }, svc.version)), footEl),
    sheetHost);

  prompt.addEventListener("input", () => { promptHint.hidden = !!prompt.value; });
  prompt.addEventListener("input", () => { if (pstate && profile) { pstate.prompt = prompt.value; store.saveState(profile.id, pstate); } });
  flowSel.addEventListener("change", () => selectProfile(flowSel.value));
  genBtn.addEventListener("click", () => (run ? cancel() : generate()));
  advHead.addEventListener("click", () => { settings.advancedOpen = !settings.advancedOpen; store.saveSettings(settings); renderAdvanced(); });

  // ── rendering ──
  function setStatus(text: string, kind: "info" | "ok" | "error" = "info") { status = { text, kind }; renderStatus(); }

  function renderStatus() {
    replace(statusEl, h("span", { class: "dot " + status.kind }), h("span", { class: "status-text", title: status.text }, status.text),
      stash ? h("button", { class: "link", onClick: saveStash }, "保存未写入的结果") : null);
  }

  function renderConn() {
    connEl.className = "conn " + conn.state;
    replace(connEl, h("span", { class: "dot" }), h("span", null, conn.text));
  }

  function renderHistory() {
    targetEl.textContent = group ? `继续 · ${group.name}` : "新建填充";
    targetEl.title = group
      ? "已选中 AI 填充图层组：新的变体基于原图生成，并加入这个图层组"
      : "未选中 AI 填充图层组：将用当前选区新建一个。选中已有的 AI 填充图层组即可继续生成变体";
    targetEl.className = "target " + (group ? "cont" : "new");
    const ratio = group ? (group.rect.bottom - group.rect.top) / Math.max(1, group.rect.right - group.rect.left) : 1;
    const h0 = Math.round(Math.max(56, Math.min(132, 96 * ratio)));
    const tiles: HTMLElement[] = variations.map(v => {
      const thumb = thumbs.get(`${group!.docId}:${v.layerId}`);
      return h("div", { class: "var" + (v.visible ? " on" : ""), title: v.prompt || "（无提示词）" },
        h("button", { class: "var-img", style: `height:${h0}px`, onClick: () => showVariation(v) },
          thumb ? h("img", { src: thumb }) : h("span", { class: "tile-ph" }, icon("image", 16))),
        h("div", { class: "var-foot" },
          h("span", { class: "var-num" }, String(v.number)),
          h("button", { class: "var-del", title: "删除这个变体", onClick: () => deleteVariation(v) }, icon("close", 10))));
    });
    if (run) tiles.push(h("div", { class: "var pending" },
      h("div", { class: "var-img", style: `height:${h0}px` }, h("span", { class: "var-fill", style: `width:${Math.round((run.progress ?? 0) * 100)}%` })),
      h("div", { class: "var-foot" }, h("span", { class: "var-num" }, "生成中"))));
    if (!tiles.length) tiles.push(h("div", { class: "history-empty" }, group ? "这个填充还没有变体" : "框选区域并生成后，变体会出现在这里，点击即可切换"));
    replace(historyEl, ...tiles);
    const active = variations.find(v => v.visible);
    replace(varPromptEl, active ? h("span", null, h("span", { class: "muted" }, `变体 ${active.number}：`), active.prompt || "（无提示词）",
      active.prompt && active.prompt !== prompt.value ? h("button", { class: "link", onClick: () => { prompt.value = active.prompt; prompt.dispatchEvent(new Event("input")); renderAction(); } }, " 使用") : null) : null);
    void loadThumbs();
  }

  let loadingThumbs = false;
  async function loadThumbs() {
    if (!group || loadingThumbs) return;
    loadingThumbs = true;
    try {
      for (const v of variations) {
        const key = `${group.docId}:${v.layerId}`;
        if (thumbs.has(key)) continue;
        try { thumbs.set(key, await svc.host.thumbnail(group, v.layerId, 128)); } catch (e) { log("warn", "thumbnail", e); thumbs.set(key, ""); }
        renderHistory();
      }
    } finally { loadingThumbs = false; }
  }

  function renderFlows() {
    replace(flowSel, ...(profiles.length
      ? profiles.map(p => h("option", { value: p.id }, p.name + (validateProfile(p).length ? "（需校准）" : "")))
      : [h("option", { value: "" }, "尚未导入工作流")]));
    flowSel.value = profile?.id ?? "";
    flowSel.disabled = !profiles.length || !!run;
    const allowEmpty = profile?.options.allowEmptyPrompt;
    // UXP's native textarea can merge its placeholder into the typed text, so the hint lives outside it
    promptHint.textContent = allowEmpty ? "描述要画进选区的内容；留空 = 移除选区内的内容" : "描述要画进选区的内容";
    prompt.title = promptHint.textContent;
    prompt.value = pstate?.prompt ?? "";
    promptHint.hidden = !!prompt.value;
  }

  function renderRefs() {
    const slots = profile?.bindings.filter(b => b.role === "reference").map(b => b.slot!) ?? [];
    refsEl.hidden = !slots.length;
    replace(refsEl, ...slots.map(slot => {
      const r = refs[slot];
      return h("button", { class: "ref" + (r ? " set" : ""), title: r ? `参考图 ${slot}：${r.name}` : `参考图 ${slot}：点击选择`, onClick: (e: Event) => refMenu(slot, e.currentTarget as HTMLElement) },
        r?.thumb ? h("img", { src: r.thumb }) : icon("image", 16),
        h("span", { class: "ref-num" }, String(slot)));
    }));
  }

  function renderSelection() {
    if (!doc) { selEl.textContent = "未打开文档"; return; }
    if (sel) selEl.textContent = `选区 ${sel.right - sel.left} × ${sel.bottom - sel.top}`;
    else selEl.textContent = group ? "无选区 · 沿用填充范围" : "无选区";
    selEl.className = "sel-state" + (!sel && !group ? " warn" : "");
  }

  function blockedReason(): string | null {
    if (!profile) return "请先导入工作流";
    const problems = validateProfile(profile);
    if (problems.length) return "工作流需要校准：" + problems[0];
    if (conn.state !== "ok") return "未连接 ComfyUI";
    if (!doc) return "请先打开 PSD";
    if (!sel && !group) return "请先建立选区";
    if (!profile.options.allowEmptyPrompt && profile.bindings.some(b => b.role === "prompt") && !prompt.value.trim()) return "请输入提示词（留空移除可在「接口校准」里开启）";
    return null;
  }

  function renderAction() {
    if (run) {
      genBtn.className = "generate running";
      replace(genBtn, icon("stop"), h("span", null, "取消"));
      genBtn.disabled = false;
      replace(progEl, h("div", { class: "bar" }, h("span", { style: `width:${Math.round((run.progress ?? 0) * 100)}%` })),
        h("div", { class: "stage" }, run.stage + (run.detail ? " · " + run.detail : "")));
      progEl.hidden = false;
      return;
    }
    const why = blockedReason();
    genBtn.className = "generate";
    genBtn.disabled = !!why;
    genBtn.title = why ?? "";
    replace(genBtn, icon("spark"), h("span", null, group ? "生成更多变体" : "生成"));
    progEl.hidden = !why;
    replace(progEl, why ? h("div", { class: "stage muted" }, why) : null);
  }

  function renderAdvanced() {
    const open = settings.advancedOpen;
    replace(advHead, icon("sliders"), h("span", { class: "grow" }, "高级参数"), h("span", { class: "chev" + (open ? " open" : "") }, icon("chevron")));
    advBody.hidden = !open;
    if (!open) return;
    if (!profile || !pstate) { replace(advBody, h("div", { class: "muted small" }, "导入工作流后显示")); return; }
    const ps = pstate, p = profile;
    const save = () => store.saveState(p.id, ps);
    const rows: HTMLElement[] = [];
    for (const b of p.bindings.filter(x => x.role === "param")) {
      const k = b.nodeId + "." + b.input;
      const base = p.api[b.nodeId]?.inputs[b.input];
      const val = k in ps.params ? ps.params[k] : (base as number | boolean);
      const label = h("span", { class: "param-label", title: `#${b.nodeId}.${b.input}` }, b.label ?? b.input);
      if (typeof base === "boolean") {
        rows.push(h("label", { class: "param check-row" }, h("input", { type: "checkbox", checked: !!val, onChange: (e: Event) => { ps.params[k] = (e.target as HTMLInputElement).checked; save(); } }), label));
        continue;
      }
      const isInt = Number.isInteger(base) && !/strength|强度|cfg|denoise/i.test(b.label ?? b.input);
      const lo = b.min ?? (isInt ? 0 : 0), hi = b.max ?? (isInt ? Math.max(Number(base) * 2, 10) : Math.max(2, Number(base) * 2));
      const num = h("input", { class: "num", type: "number", value: String(val), step: isInt ? "1" : "0.01" }) as HTMLInputElement;
      const range = h("input", { type: "range", min: String(lo), max: String(hi), step: isInt ? "1" : "0.01", value: String(val) }) as HTMLInputElement;
      const set = (v: number) => { if (!Number.isFinite(v)) return; ps.params[k] = v; num.value = String(v); range.value = String(v); save(); };
      range.addEventListener("input", () => set(Number(range.value)));
      num.addEventListener("change", () => set(Number(num.value)));
      rows.push(h("div", { class: "param" }, h("div", { class: "param-top" }, label,
        k in ps.params && ps.params[k] !== base ? h("button", { class: "link small", title: "恢复工作流中的原始值", onClick: () => { delete ps.params[k]; save(); renderAdvanced(); } }, "复原") : null),
        h("div", { class: "param-ctl" }, range, num)));
    }
    if (p.bindings.some(b => b.role === "seed")) {
      const seedNum = h("input", { class: "num wide", type: "number", value: String(ps.seed), disabled: ps.seedMode === "random" }) as HTMLInputElement;
      seedNum.addEventListener("change", () => { ps.seed = Math.max(0, Math.min(MAX_SEED, Math.floor(Number(seedNum.value) || 0))); save(); });
      const mode = h("select", { class: "field" }, h("option", { value: "random" }, "每次随机"), h("option", { value: "fixed" }, "固定")) as HTMLSelectElement;
      mode.value = ps.seedMode;
      mode.addEventListener("change", () => { ps.seedMode = mode.value as "random" | "fixed"; save(); renderAdvanced(); });
      rows.push(h("div", { class: "param" }, h("div", { class: "param-top" }, h("span", { class: "param-label" }, "随机种子")),
        h("div", { class: "param-ctl" }, mode, seedNum,
          h("button", { class: "icon-btn", title: "换一个种子", onClick: () => { ps.seed = randomSeed(); ps.seedMode = "fixed"; save(); renderAdvanced(); } }, icon("dice")))));
    }
    if (p.options.localMask?.links.length) {
      const lm = p.options.localMask;
      rows.push(h("label", { class: "param check-row", title: "把遮罩接到 " + lm.links.map(l => `#${l.nodeId}.${l.input}`).join("、") + "，让模型只在选区内生成。只改本次提交的副本，不修改 ComfyUI 中的工作流" },
        h("input", { type: "checkbox", checked: lm.enabled, onChange: (e: Event) => { lm.enabled = (e.target as HTMLInputElement).checked; store.saveProfiles(profiles); } }),
        h("span", { class: "param-label" }, "只重绘选区内")));
    }
    {
      const count = h("select", { class: "field" }, ...[1, 2, 3, 4].map(n => h("option", { value: String(n) }, `${n} 个`))) as HTMLSelectElement;
      count.value = String(ps.count ?? 1);
      count.addEventListener("change", () => { ps.count = Number(count.value); save(); });
      rows.push(h("div", { class: "param" }, h("div", { class: "param-top" }, h("span", { class: "param-label" }, "每次生成变体数")), h("div", { class: "param-ctl" }, count)));
      rows.push(h("label", { class: "param check-row", title: "生成前调用 ComfyUI 自带的「释放」接口，清空节点缓存并卸载模型，让工作流每个节点都重新执行。结果与使用缓存时相同，但每次都要重新加载模型，明显更慢" },
        h("input", { type: "checkbox", checked: !!ps.fullRun, onChange: (e: Event) => { ps.fullRun = (e.target as HTMLInputElement).checked; save(); } }),
        h("span", { class: "param-label" }, "每次完整运行（不使用 ComfyUI 缓存，较慢）")));
    }
    if (!rows.length) rows.push(h("div", { class: "muted small" }, "该工作流没有绑定可调参数。可在「接口校准」中添加已有 LoRA 强度、步数等字段。"));
    replace(advBody, ...rows);
  }

  function renderAll() { renderConn(); renderHistory(); renderFlows(); renderRefs(); renderSelection(); renderAction(); renderAdvanced(); renderStatus(); }

  // ── Photoshop state ──
  let refreshing = false, again = false;
  async function refresh() {
    if (refreshing) { again = true; return; }
    refreshing = true;
    try {
      doc = svc.host.activeDoc();
      sel = doc ? await svc.host.selectionBounds(doc.id) : null;
      group = doc ? await svc.host.activeFillGroup() : null;
      variations = group ? await svc.host.variations(group) : [];
    } catch (e) { log("warn", "refresh failed", e); }
    finally { refreshing = false; }
    renderHistory(); renderSelection(); renderAction();
    if (again) { again = false; void refresh(); }
  }

  async function showVariation(v: Variation) {
    if (!group || run) return;
    try { await svc.host.showVariation(group, v.layerId); variations = variations.map(x => ({ ...x, visible: x.layerId === v.layerId })); renderHistory(); }
    catch (e) { setStatus("切换失败：" + (e as Error).message, "error"); }
  }

  async function deleteVariation(v: Variation) {
    if (!group || run) return;
    try { await svc.host.deleteVariation(group, v.layerId); await refresh(); setStatus(`已删除变体 ${v.number}`, "ok"); }
    catch (e) { setStatus("删除失败：" + (e as Error).message, "error"); }
  }

  // ── connection ──
  /** Returns null on success, else the raw error text (also logged). */
  async function checkConn(): Promise<string | null> {
    conn = { state: "checking", text: "连接中…" }; renderConn();
    let error: string | null = null;
    try {
      const s = await withTimeout(comfy.systemStats(), 6000, "连接 ComfyUI ");
      conn = { state: "ok", text: "ComfyUI " + (s.system?.comfyui_version ?? "") };
      log("info", "connected", comfy.base, s.system?.comfyui_version);
    } catch (e) {
      const err = e as Error;
      error = `${err.name && err.name !== "Error" ? err.name + "：" : ""}${err.message}`;
      conn = { state: "down", text: "未连接" };
      log("error", "connect failed", comfy.base, err);
      setStatus(error, "error");
    }
    renderConn(); renderAction();
    return error;
  }

  function openSettings() {
    const url = h("input", { class: "field", value: settings.comfyUrl, placeholder: "127.0.0.1:8188" }) as HTMLInputElement;
    const result = h("div", { class: "conn-result" });
    const show = (kind: "ok" | "error" | "info", text: string) => replace(result, h("span", { class: "dot " + kind }), h("span", null, text));
    const connect = async () => {
      show("info", "正在保存…");
      settings.comfyUrl = normalizeUrl(url.value);
      url.value = settings.comfyUrl;
      store.saveSettings(settings);
      comfy = svc.comfy(settings.comfyUrl);
      show("info", "正在连接 " + settings.comfyUrl + " …");
      const error = await checkConn();
      if (error) show("error", error);
      else { show("ok", conn.text + " · 已连接"); setStatus("已连接 " + settings.comfyUrl, "ok"); setTimeout(() => sheet.remove(), 700); }
    };
    const sheet = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "ComfyUI 连接"),
        h("button", { class: "icon-btn", onClick: () => sheet.remove() }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("div", { class: "group-label" }, "地址"), url,
        h("div", { class: "muted small" }, "可以只填 IP 和端口，例如 127.0.0.1:8188。插件只调用 ComfyUI 自带的接口，不需要安装节点或修改启动参数。"),
        result,
        h("div", { class: "group-label" }, "排查问题"),
        h("label", { class: "check-row", title: "每次生成时把发送的图片、返回的图片和提交的工作流保存到 F:\\waveplug\\studio\\reports\\debug_*。大图一张可达几十 MB，排查完请关闭" },
          h("input", { type: "checkbox", checked: settings.debugFiles, onChange: (e: Event) => { settings.debugFiles = (e.target as HTMLInputElement).checked; store.saveSettings(settings); } }),
          h("span", null, "保存调试文件（图片较大，仅排查时打开）"))),
      h("div", { class: "sheet-foot" },
        svc.diagnose ? h("button", { class: "btn", title: "逐项测试 fetch / XHR / WebSocket，结果同时写入日志", onClick: async () => {
          settings.comfyUrl = normalizeUrl(url.value); url.value = settings.comfyUrl;
          show("info", "诊断中…");
          const lines = await svc.diagnose!(settings.comfyUrl).catch(e => ["诊断失败：" + (e as Error).message]);
          replace(result, h("pre", { class: "diag" }, lines.join("\n")));
        } }, "诊断") : null,
        h("button", { class: "btn", onClick: () => sheet.remove() }, "关闭"),
        h("button", { class: "btn primary", onClick: () => void connect() }, "保存并连接")));
    sheetHost.append(sheet);
    if (conn.state === "down" && status.kind === "error") show("error", status.text);
  }

  // ── workflows ──
  function selectProfile(id: string) {
    profile = profiles.find(p => p.id === id) ?? null;
    pstate = profile ? store.state(profile.id) : null;
    settings.activeProfile = profile?.id ?? null; store.saveSettings(settings);
    for (const k of Object.keys(refs)) delete refs[Number(k)];
    renderFlows(); renderRefs(); renderAction(); renderAdvanced();
  }

  function importMenu() {
    const menu = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "导入工作流"),
        h("button", { class: "icon-btn", onClick: () => menu.remove() }, icon("close"))),
      h("div", { class: "sheet-body" },
        h("button", { class: "menu-item", onClick: async () => { menu.remove(); await importFromFile(); } },
          icon("folder"), h("span", null, h("b", null, "API 格式 JSON 文件"), h("span", { class: "muted small block" }, "ComfyUI 菜单 → 导出 (API)"))),
        h("button", { class: "menu-item", onClick: async () => { menu.remove(); await importFromComfy(); } },
          icon("flow"), h("span", null, h("b", null, "ComfyUI 中已保存的工作流"), h("span", { class: "muted small block" }, "需要已连接 ComfyUI，自动转换为 API 格式")))));
    sheetHost.append(menu);
  }

  async function importFromFile() {
    try {
      const f = await svc.pickJson();
      if (!f) return;
      await adopt(f.name.replace(/\.json$/i, ""), asApiGraph(JSON.parse(f.text)), []);
    } catch (e) { setStatus("导入失败：" + (e as Error).message, "error"); }
  }

  async function importFromComfy() {
    try {
      setStatus("读取 ComfyUI 工作流列表…");
      const list = await comfy.listWorkflows();
      const pickSel = h("select", { class: "field" }, ...list.map(p => h("option", { value: p }, p.replace(/\.json$/, ""))));
      const sheet = h("div", { class: "sheet" },
        h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "选择 ComfyUI 工作流"),
          h("button", { class: "icon-btn", onClick: () => sheet.remove() }, icon("close"))),
        h("div", { class: "sheet-body" }, list.length ? pickSel : h("div", { class: "muted" }, "ComfyUI 中没有已保存的工作流")),
        h("div", { class: "sheet-foot" }, h("button", { class: "btn", onClick: () => sheet.remove() }, "取消"),
          h("button", { class: "btn primary", disabled: !list.length, onClick: async () => {
            sheet.remove();
            try {
              setStatus("转换为 API 格式…");
              const [ui, info] = await Promise.all([comfy.readWorkflow(pickSel.value), comfy.objectInfo()]);
              const { api, warnings } = uiToApi(ui, info);
              await adopt(pickSel.value.split("/").pop()!.replace(/\.json$/, ""), api, warnings, { kind: "comfy", path: pickSel.value });
              if (warnings.length) log("warn", "conversion", warnings);
            } catch (e) { setStatus("导入失败：" + (e as Error).message, "error"); }
          } }, "导入")));
      sheetHost.append(sheet);
      setStatus("就绪");
    } catch (e) { setStatus((e instanceof ComfyError ? "" : "读取失败：") + (e as Error).message, "error"); }
  }

  /** New import, or re-import of a workflow with the same name: carry valid bindings over. */
  /** Bindings to use without asking, when every required role was recognised unambiguously. */
  function autoBindings(rec: ReturnType<typeof recognize>): Binding[] | null {
    if (rec.blockers.length) return null;
    const one = (role: string) => rec.suggestions.filter(s => s.binding.role === role);
    const image = one("image"), output = one("output"), prompt = one("prompt"), mask = one("mask");
    if (image.length !== 1 || image[0].confidence !== "certain") return null;
    if (output.length !== 1 || output[0].confidence !== "certain") return null;
    if (prompt.length && prompt[0].confidence !== "certain") return null;
    if (mask.length && mask[0].confidence !== "certain") return null;
    return rec.suggestions.filter(s => s.confidence === "certain").map(s => s.binding);
  }

  const looksLikeRemoval = (name: string, bindings: Binding[]) =>
    /移除|清除|擦除|remove|erase/i.test(name + " " + bindings.filter(b => b.role === "prompt").map(b => b.title ?? "").join(" "));

  /** Short confirmation shown instead of the full calibration sheet when recognition is clear. */
  function openSummary(name: string, bindings: Binding[], options: Profile["options"]): Promise<"ok" | "adjust" | null> {
    return new Promise(resolve => {
      const line = (label: string, b?: Binding, note = "") => b
        ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, label), h("span", { class: "sum-v" }, `#${b.nodeId} ${b.title ?? b.classType}${note}`))
        : null;
      const params = bindings.filter(b => b.role === "param").map(b => b.label ?? b.input);
      const img = bindings.find(b => b.role === "image");
      const empty = h("input", { type: "checkbox", checked: options.allowEmptyPrompt, onChange: (e: Event) => { options.allowEmptyPrompt = (e.target as HTMLInputElement).checked; } });
      const done = (v: "ok" | "adjust" | null) => { sheet.remove(); resolve(v); };
      const sheet = h("div", { class: "sheet" },
        h("div", { class: "sheet-head" }, h("span", { class: "sheet-title" }, "已识别工作流"),
          h("button", { class: "icon-btn", title: "关闭", onClick: () => done(null) }, icon("close"))),
        h("div", { class: "sheet-body" },
          h("div", { class: "sum-name" }, icon("check", 16), h("span", null, name)),
          h("div", { class: "muted small" }, "所有必需的接口都已自动找到，可以直接使用。"),
          h("div", { class: "sum" },
            line("画面 + 选区", img, img?.encoding === "rgba-alpha-mask" ? "（选区写入透明通道）" : ""),
            line("选区遮罩", bindings.find(b => b.role === "mask")),
            line("提示词", bindings.find(b => b.role === "prompt")),
            line("输出", bindings.find(b => b.role === "output")),
            params.length ? h("div", { class: "sum-row" }, h("span", { class: "sum-k" }, "高级参数"), h("span", { class: "sum-v" }, params.join("、"))) : null),
          bindings.some(b => b.role === "prompt")
            ? h("label", { class: "check-row sum-opt" }, empty, h("span", null, "提示词留空时执行「移除选区内容」")) : null),
        h("div", { class: "sheet-foot" },
          h("button", { class: "btn", onClick: () => done("adjust") }, "手动调整"),
          h("button", { class: "btn primary", onClick: () => done("ok") }, "完成")));
      sheetHost.append(sheet);
    });
  }

  /** New import, or re-import of a workflow with the same name: carry valid bindings over. */
  async function adopt(name: string, api: ReturnType<typeof asApiGraph>, warnings: string[], source: Profile["source"] = { kind: "file" }) {
    const rec = recognize(api);
    if (warnings.length) rec.notes.push(...warnings);
    const old = profiles.find(p => p.name === name);
    if (old) {
      const c = carryOver(old, api);
      if (!c.broken.length && !validateProfile(c.profile).length) {
        Object.assign(old, { ...c.profile, source, updatedAt: Date.now() });
        saveProfiles(old.id);
        setStatus(`已更新「${old.name}」，原有绑定全部有效`, "ok");
        return;
      }
      const result = await openCalibration(sheetHost, api, rec, { name, bindings: c.profile.bindings, options: c.profile.options }, false);
      if (!result) return;
      Object.assign(old, { ...c.profile, source, name: result.name, bindings: result.bindings, options: result.options, updatedAt: Date.now() });
      saveProfiles(old.id);
      setStatus(`已更新「${old.name}」：保留 ${c.kept.length} 项，自动迁移 ${c.remapped.length} 项` + (c.broken.length ? `，${c.broken.length} 项已重新绑定` : ""), "ok");
      return;
    }
    const options = newProfile(name, api, []).options;
    const auto = autoBindings(rec);
    if (auto) {
      options.allowEmptyPrompt = looksLikeRemoval(name, auto);
      const choice = await openSummary(name, auto, options);
      if (!choice) return;
      if (choice === "ok") {
        const p = newProfile(name, api, auto);
        p.options = options;
        p.source = source;
        profiles.push(p);
        saveProfiles(p.id);
        setStatus(`已导入「${p.name}」，可以开始生成`, "ok");
        return;
      }
    }
    const result = await openCalibration(sheetHost, api, rec, { name, bindings: auto ?? [], options }, true);
    if (!result) return;
    const p = newProfile(result.name, api, result.bindings);
    p.options = result.options;
    p.source = source;
    profiles.push(p);
    saveProfiles(p.id);
    setStatus(`已导入「${p.name}」`, "ok");
  }

  async function calibrate() {
    if (!profile) return importMenu();
    const p = profile;
    const result = await openCalibration(sheetHost, p.api, recognize(p.api), { name: p.name, bindings: p.bindings, options: p.options }, false);
    if (!result) return;
    Object.assign(p, { name: result.name, bindings: result.bindings, options: result.options, updatedAt: Date.now() });
    saveProfiles(p.id);
    setStatus("校准已保存", "ok");
  }

  function saveProfiles(activeId: string) {
    store.saveProfiles(profiles);
    selectProfile(activeId);
  }

  // ── references ──
  function refMenu(slot: number, anchor: HTMLElement) {
    sheetHost.querySelector(".pop")?.remove();
    const layers = doc ? svc.host.listLayers(doc.id) : [];
    const layerSel = h("select", { class: "field" }, h("option", { value: "" }, "从 PS 图层…"),
      ...layers.map(l => h("option", { value: String(l.id) }, "  ".repeat(l.depth) + l.name)));
    layerSel.addEventListener("change", () => {
      const l = layers.find(x => String(x.id) === layerSel.value);
      if (l && doc) refs[slot] = { kind: "layer", docId: doc.id, layerId: l.id, name: l.name };
      pop.remove(); renderRefs();
    });
    const pop: HTMLElement = h("div", { class: "pop", style: `top:${anchor.getBoundingClientRect().bottom + 4}px` },
      layerSel,
      h("button", { class: "menu-item small", onClick: async () => {
        pop.remove();
        const img = await svc.pickImage();
        if (img) { refs[slot] = { kind: "file", name: img.name, bytes: img.bytes, thumb: img.url }; renderRefs(); }
      } }, icon("folder"), h("span", null, "选择图片文件…")),
      refs[slot] ? h("button", { class: "menu-item small", onClick: () => { refs[slot] = undefined; pop.remove(); renderRefs(); } }, icon("close"), h("span", null, "清空")) : null);
    sheetHost.append(pop);
    setTimeout(() => document.addEventListener("click", function off(e) { if (!pop.contains(e.target as Node)) { pop.remove(); document.removeEventListener("click", off); } }), 0);
  }

  // ── generate ──
  let objectInfo: Awaited<ReturnType<Comfy["objectInfo"]>> | null = null;

  /**
   * Re-reads a ComfyUI-saved workflow and converts it with the current converter, so edits made in
   * ComfyUI (and converter fixes) take effect without re-importing. Older profiles without a
   * recorded source are matched to a saved workflow of the same name. Returns an error or null.
   */
  async function syncProfile(p: Profile): Promise<string | null> {
    if (p.source?.kind === "file") return null;
    let path = p.source?.kind === "comfy" ? p.source.path : null;
    if (!path) {
      const list = await comfy.listWorkflows().catch(() => [] as string[]);
      path = list.find(x => x.split("/").pop()!.replace(/\.json$/, "") === p.name) ?? null;
      if (!path) return null;
    }
    try {
      setStatus("同步 ComfyUI 工作流…");
      objectInfo ??= await comfy.objectInfo();
      const { api, warnings } = uiToApi(await comfy.readWorkflow(path), objectInfo);
      // ComfyUI validates every node itself and reports misalignments precisely, so conversion
      // warnings are logged rather than blocking (display-only widgets also trigger them).
      if (warnings.length) log("warn", "conversion", warnings);
      const c = carryOver(p, api);
      if (c.broken.length) return `ComfyUI 中的工作流已修改，${c.broken.length} 项绑定失效（${c.broken[0].reason}），请点「接口校准」重新确认`;
      Object.assign(p, { api: c.profile.api, bindings: c.profile.bindings, source: { kind: "comfy", path }, updatedAt: Date.now() });
      if (!p.options.cropDefault) Object.assign(p.options, { sendScope: "crop", cropMargin: 1, cropDefault: true });
      refreshMaskLinks(p);
      store.saveProfiles(profiles);
      log("info", "workflow synced", path, c.remapped.length ? `remapped ${c.remapped.length}` : "");
      return null;
    } catch (e) {
      log("warn", "workflow sync failed", path, e);
      return "读取 ComfyUI 工作流失败：" + (e as Error).message;
    }
  }

  /** Detects the optional "repaint only inside the selection" links; on by default when found. */
  function refreshMaskLinks(p: Profile) {
    if (!objectInfo) return;
    const links = findLocalMaskLinks(p.api, objectInfo);
    const was = p.options.localMask;
    p.options.localMask = links.length ? { enabled: was ? was.enabled : true, links } : undefined;
    store.saveProfiles(profiles);
    if (links.length && !was) { log("info", "local mask links", JSON.stringify(links)); renderAdvanced(); }
  }

  async function generate() {
    if (!profile || !pstate || run) return;
    await checkConn();
    await refresh();
    const why = blockedReason();
    if (why) { setStatus(why, "error"); return; }
    const syncError = await syncProfile(profile);
    if (syncError) { setStatus(syncError, "error"); return; }
    setStatus("生成中…");
    const p = profile, ps = pstate;
    run = { stage: "准备中…", progress: null, detail: "", signal: { aborted: false } };
    const current = run;
    stash = null;
    renderAll();
    try {
      const res = await runInpaint(svc.host, comfy, {
        profile: p, prompt: cleanPrompt(prompt.value), seed: ps.seedMode === "fixed" ? ps.seed : null, params: ps.params,
        references: Object.fromEntries(Object.entries(refs).map(([k, v]) => [k, v])),
        count: ps.count ?? 1,
        fullRun: !!ps.fullRun,
      }, {
        signal: current.signal,
        stage: t => { current.stage = t; current.detail = ""; renderAction(); },
        progress: (f, t) => { current.progress = f; current.detail = t ?? ""; renderAction(); renderHistory(); },
        promptQueued: id => { current.promptId = id; },
        variationAdded: (g, v) => { group = g; variations = [...variations.map(x => ({ ...x, visible: false })), v]; renderHistory(); },
        debug: settings.debugFiles ? svc.debugSave : undefined,
      });
      if (ps.seedMode === "random") { ps.seed = res.seeds[res.seeds.length - 1]; store.saveState(p.id, ps); }
      setStatus(`${res.continued ? "已加入" : "已新建 AI 填充，"}变体 ${res.variations.map(v => v.number).join("、")} · seed ${res.seeds.join("、")}`, "ok");
    } catch (e) {
      log("error", "generate failed", e);
      if (e instanceof StashedResult) { stash = e.png; setStatus(e.message, "error"); }
      else setStatus(current.signal.aborted ? "已取消" : (e as Error).message, current.signal.aborted ? "info" : "error");
    } finally {
      run = null;
      renderAll();
      await refresh();
    }
  }

  async function cancel() {
    if (!run) return;
    run.signal.aborted = true;
    run.stage = "正在取消…"; renderAction();
    if (run.promptId) await comfy.cancel(run.promptId).catch(e => console.warn("取消失败", e));
  }

  async function saveStash() {
    if (!stash) return;
    if (await svc.saveImage(stash, `waveplug_${Date.now()}.png`)) { stash = null; setStatus("结果已另存", "ok"); }
  }

  // ── start ──
  window.addEventListener("error", e => { log("error", "uncaught", (e as ErrorEvent).error ?? (e as ErrorEvent).message); setStatus("插件内部错误：" + ((e as ErrorEvent).message ?? ""), "error"); });
  window.addEventListener("unhandledrejection", e => { log("error", "unhandled", (e as PromiseRejectionEvent).reason); setStatus("插件内部错误：" + String((e as PromiseRejectionEvent).reason?.message ?? (e as PromiseRejectionEvent).reason), "error"); });
  log("info", "start", svc.version, svc.host.kind, settings.comfyUrl);
  renderAll();
  svc.host.onChange(() => void refresh());
  void refresh();
  void checkConn();
}
