// Calibration sheet: role-by-role binding of the inpaint contract, pre-filled from recognition.

import { type ApiGraph, isLink, title } from "../core/workflow/api.ts";
import { type Binding, type Profile, ROLE_LABEL, type Role, checkBinding } from "../core/workflow/profile.ts";
import type { Recognition, Suggestion } from "../core/workflow/recognize.ts";
import { h, icon } from "./dom.ts";

export interface CalibrationResult { name: string; bindings: Binding[]; options: Profile["options"] }

const key = (b: Binding) => `${b.nodeId}.${b.input}`;
const fieldLabel = (g: ApiGraph, b: Binding) => `#${b.nodeId} ${title(g, b.nodeId)} · ${b.input}`;
const CONF: Record<string, string> = { certain: "明确", likely: "建议", ambiguous: "需确认" };

/** Literal fields of the graph, for manual parameter binding. */
function literalFields(g: ApiGraph, kinds: string[]): Binding[] {
  const out: Binding[] = [];
  for (const [id, n] of Object.entries(g)) for (const [input, v] of Object.entries(n.inputs)) {
    if (!isLink(v) && kinds.includes(typeof v)) out.push({ role: "param", nodeId: id, input, classType: n.class_type, title: title(g, id), label: input });
  }
  return out;
}

export function openCalibration(host: HTMLElement, g: ApiGraph, rec: Recognition, init: CalibrationResult, isNew: boolean): Promise<CalibrationResult | null> {
  return new Promise(resolve => {
    const chosen = new Map<string, Binding | null>(); // slot key → binding
    const params: Binding[] = init.bindings.filter(b => b.role === "param");
    const options = { ...init.options };
    const existing = (role: Role, slot?: number) => init.bindings.find(b => b.role === role && (slot === undefined || b.slot === slot));

    // ── single-choice roles ──
    type Row = { slot: string; role: Role; label: string; required: boolean; options: Binding[]; suggestion?: Suggestion };
    const rows: Row[] = [];
    const sugg = (role: Role) => rec.suggestions.filter(s => s.binding.role === role);
    const addRow = (slot: string, role: Role, label: string, required: boolean, s: Suggestion | undefined, extra: Binding[] = []) => {
      const opts: Binding[] = [];
      const push = (b?: Binding) => { if (b && !opts.some(o => key(o) === key(b))) opts.push(b); };
      push(existing(role, s?.binding.slot)); push(s?.binding); s?.alternatives?.forEach(push); extra.forEach(push);
      rows.push({ slot, role, label, required, options: opts, suggestion: s });
      const pre = existing(role, s?.binding.slot) ?? (s && (isNew ? s.confidence === "certain" : false) ? s.binding : undefined);
      chosen.set(slot, pre ?? null);
    };
    const imageS = sugg("image")[0];
    addRow("image", "image", ROLE_LABEL.image, true, imageS);
    const maskS = sugg("mask")[0];
    if (maskS || existing("mask")) addRow("mask", "mask", ROLE_LABEL.mask, true, maskS);
    addRow("prompt", "prompt", ROLE_LABEL.prompt, false, sugg("prompt")[0], literalFields(g, ["string"]).map(b => ({ ...b, role: "prompt" as Role })));
    const negS = sugg("negative")[0];
    if (negS || existing("negative")) addRow("negative", "negative", ROLE_LABEL.negative, false, negS);
    addRow("output", "output", ROLE_LABEL.output, true, sugg("output")[0]);
    sugg("reference").forEach(s => addRow("ref" + s.binding.slot, "reference", `参考图 ${s.binding.slot}`, false, s));
    sugg("seed").forEach((s, i) => addRow("seed" + i, "seed", ROLE_LABEL.seed + (sugg("seed").length > 1 ? ` ${i + 1}` : ""), false, s));
    if (isNew) for (const s of sugg("param")) if (s.confidence === "certain" && !params.some(p => key(p) === key(s.binding))) params.push(s.binding);

    const nameInput = h("input", { class: "field", value: init.name, placeholder: "工作流名称" });
    const paramBox = h("div", { class: "param-list" });
    const msg = h("div", { class: "sheet-msg" });

    function renderParams() {
      paramBox.textContent = "";
      const offered = rec.suggestions.filter(s => s.binding.role === "param");
      const all = [...offered.map(s => s.binding), ...params.filter(p => !offered.some(o => key(o.binding) === key(p)))];
      if (!all.length) paramBox.append(h("div", { class: "muted small" }, "没有识别到可调参数，可在下方手动添加"));
      for (const b of all) {
        const on = params.some(p => key(p) === key(b));
        const s = offered.find(o => key(o.binding) === key(b));
        paramBox.append(h("label", { class: "check-row" },
          h("input", { type: "checkbox", checked: on, onChange: (e: Event) => {
            const i = params.findIndex(p => key(p) === key(b));
            if ((e.target as HTMLInputElement).checked) { if (i < 0) params.push(b); } else if (i >= 0) params.splice(i, 1);
          } }),
          h("span", { class: "grow" }, b.label ?? b.input, h("span", { class: "muted small" }, `  #${b.nodeId}.${b.input}`)),
          s ? h("span", { class: "badge " + s.confidence, title: s.reason }, CONF[s.confidence]) : null));
      }
    }

    // manual param add: any literal number/bool field
    const fieldSel = h("select", { class: "field" },
      h("option", { value: "" }, "手动添加参数…"),
      ...literalFields(g, ["number", "boolean"]).map(b => h("option", { value: key(b) }, fieldLabel(g, b))));
    fieldSel.addEventListener("change", () => {
      const b = literalFields(g, ["number", "boolean"]).find(x => key(x) === fieldSel.value);
      if (b && !params.some(p => key(p) === key(b))) params.push({ ...b, label: `${title(g, b.nodeId)} · ${b.input}` });
      fieldSel.value = "";
      renderParams();
    });

    const roleRow = (r: Row) => {
      const sel = h("select", { class: "field" },
        h("option", { value: "" }, r.required ? "— 请选择 —" : "不绑定"),
        ...r.options.map(b => h("option", { value: key(b) }, fieldLabel(g, b))));
      sel.value = chosen.get(r.slot) ? key(chosen.get(r.slot)!) : "";
      sel.addEventListener("change", () => chosen.set(r.slot, r.options.find(b => key(b) === sel.value) ?? null));
      const s = r.suggestion;
      return h("div", { class: "role-row" },
        h("div", { class: "role-head" },
          h("span", { class: "role-name" }, r.label, r.required ? h("span", { class: "req" }, " *") : null),
          s ? h("span", { class: "badge " + s.confidence, title: s.reason }, CONF[s.confidence]) : null),
        sel,
        s ? h("div", { class: "muted small reason" }, s.reason) : null);
    };

    const emptyPrompt = h("input", { type: "checkbox", checked: options.allowEmptyPrompt, onChange: (e: Event) => { options.allowEmptyPrompt = (e.target as HTMLInputElement).checked; } });
    const scope = h("select", { class: "field" }, h("option", { value: "canvas" }, "整张画布（工作流自己裁剪）"), h("option", { value: "crop" }, "选区周围（推荐，文件小、更快）"));
    scope.value = options.sendScope;
    scope.addEventListener("change", () => { options.sendScope = scope.value as "canvas" | "crop"; });

    const close = (v: CalibrationResult | null) => { sheet.remove(); resolve(v); };
    const save = () => {
      const bindings: Binding[] = [];
      for (const r of rows) {
        const b = chosen.get(r.slot);
        if (!b && r.required) { msg.textContent = `请先为「${r.label}」选择节点`; return; }
        if (b) bindings.push({ ...b, role: r.role });
      }
      bindings.push(...params);
      // 扩图: the four extension amounts are always the canvas node's own sources
      const pads = init.bindings.filter(b => b.role === "pad");
      bindings.push(...(pads.length ? pads : rec.suggestions.filter(x => x.binding.role === "pad").map(x => x.binding)));
      const bad = bindings.map(b => checkBinding(g, b)).find(s => !s.ok);
      if (bad && !bad.ok) { msg.textContent = bad.message; return; }
      close({ name: nameInput.value.trim() || init.name, bindings, options });
    };

    renderParams();
    const sheet = h("div", { class: "sheet" },
      h("div", { class: "sheet-head" },
        h("span", { class: "sheet-title" }, "接口校准"),
        h("button", { class: "icon-btn", title: "关闭", onClick: () => close(null) }, icon("close"))),
      h("div", { class: "sheet-body" },
        rec.blockers.length ? h("div", { class: "alert" }, icon("warn"), h("span", null, rec.blockers.join("；"))) : null,
        h("div", { class: "muted small" }, "插件只写入下面选定的字段，不会修改 ComfyUI 中的节点和连线。"),
        h("div", { class: "group-label" }, "名称"), nameInput,
        h("div", { class: "group-label" }, "数据绑定"),
        ...rows.map(roleRow),
        h("div", { class: "group-label" }, "高级参数"),
        paramBox, fieldSel,
        h("div", { class: "group-label" }, "选项"),
        h("label", { class: "check-row" }, emptyPrompt, h("span", null, "允许提示词为空（例如留空 = 移除选区内容）")),
        h("div", { class: "muted small" }, "发送给 ComfyUI 的范围"), scope,
        rec.notes.length ? h("div", { class: "muted small" }, rec.notes.join("；")) : null),
      h("div", { class: "sheet-foot" }, msg,
        h("button", { class: "btn", onClick: () => close(null) }, "取消"),
        h("button", { class: "btn primary", onClick: save }, "保存")));
    host.append(sheet);
  });
}
