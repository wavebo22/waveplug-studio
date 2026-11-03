/** Workbench format notices and actionable error descriptions.
 *  A difference in colour mode/profile/depth is only a RISK, not proof of incompatibility.
 *  A failure cause must be grounded in an observed Photoshop result. */
export interface WorkbenchCompatibilityNotice {
  code: "COLOR_MODE" | "BIT_DEPTH" | "COLOR_PROFILE";
  sourceDoc: string;
  sourceValue: string;
  targetValue: string;
  detail: string;
}
export interface WorkbenchDiagnostic {
  level: "error" | "warning";
  title: string;
  reason: string;
  advice: string;
  details?: string;
}

export class WorkbenchPlaceError extends Error {
  readonly code: string;
  readonly reason: string;
  readonly advice: string;
  readonly details: string;
  constructor(code: string, reason: string, advice: string, details = "") {
    super(reason);
    this.name = "WorkbenchPlaceError";
    this.code = code;
    this.reason = reason;
    this.advice = advice;
    this.details = details;
  }
}

const known = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  const str = String(value).trim();
  return !str || str === "undefined" || str === "null" || str === "未知模式" ? "" : str;
};
const bits = (value: unknown): string => {
  const s = known(value);
  const digits = s.match(/(?:^|\D)(8|16|32)(?:\D|$)/);
  return digits ? digits[1] + " 位" : s;
};
function safeProperty(obj: unknown, key: string): unknown {
  try { return obj && typeof obj === "object" ? (obj as any)[key] : undefined; }
  catch { return undefined; }
}
export function collectWorkbenchCompatibility(source: unknown, target: unknown, sourceDoc: string): WorkbenchCompatibilityNotice[] {
  if (source === target || !source || !target) return [];
  const pairs = [
    {
      code: "COLOR_MODE" as const, from: known(safeProperty(source, "mode")), to: known(safeProperty(target, "mode")),
      prefix: "颜色模式", detail: "复制已成功，但颜色外观和部分调整参数可能变化",
    },
    {
      code: "BIT_DEPTH" as const, from: bits(safeProperty(source, "bitsPerChannel")),
      to: bits(safeProperty(target, "bitsPerChannel")),
      prefix: "位深", detail: "复制已成功，但部分滤镜、像素精度或编辑功能可能不同",
    },
    {
      code: "COLOR_PROFILE" as const, from: known(safeProperty(source, "colorProfileName")),
      to: known(safeProperty(target, "colorProfileName")),
      prefix: "颜色配置文件", detail: "复制已成功，但色彩显示或转换结果可能存在差异",
    },
  ];
  return pairs.filter(p => !!p.from && !!p.to && p.from !== p.to).map(p => ({
    code: p.code, sourceDoc, sourceValue: p.from, targetValue: p.to,
    detail: `${sourceDoc}：${p.prefix} ${p.from} → ${p.to}。${p.detail}。`,
  }));
}

export function explainWorkbenchError(error: unknown): WorkbenchDiagnostic {
  if (error instanceof WorkbenchPlaceError) {
    const titles: Record<string, string> = {
      NO_TARGET: "没有目标文档",
      TARGET_CLOSED: "目标文档已关闭",
      TARGET_SWITCHED: "活动文档已经改变",
      EMPTY_PLAN: "没有可置入的图层",
      INVALID_REF: "暂存记录无效",
      SOURCE_CLOSED: "来源 PSD 已关闭",
      SOURCE_LAYER_MISSING: "来源图层已不存在",
      COPY_NO_OUTPUT: "Photoshop 未生成目标图层",
      COPY_PARTIAL: "复制过程中只完成部分内容",
      COPY_COUNT_MISMATCH: "复制图层数量不一致",
      GROUP_CREATE_FAILED: "创建文件夹失败",
      TARGET_LAYER_MISSING: "无法定位复制的图层",
      MOVE_FAILED: "无法移入文件夹",
      VERIFY_FAILED: "文件夹内容不完整",
    };
    return {
      level: "error",
      title: "置入失败 · " + (titles[error.code] ?? error.code),
      reason: error.reason,
      advice: error.advice,
      details: error.details || undefined,
    };
  }
  const raw = String((error as Error | undefined)?.message ?? error ?? "未知异常");
  // The host may produce an unexpected exception without any reliable diagnosis. NEVER turn
  // a possible format mismatch into a made-up confirmed cause.
  return {
    level: "error",
    title: "置入失败 · 原因待确认",
    reason: "Photoshop 或插件执行时出现未分类异常，尚不能确定是否由颜色模式或其他格式不兼容导致。",
    advice: "请确认来源 PSD 仍打开且图层存在，检查目标图层锁定状态；可先用单个图层测试。需要进一步排查时提供下方原始错误。",
    details: raw,
  };
}

export function explainCompatibilityWarnings(notices: readonly WorkbenchCompatibilityNotice[]): WorkbenchDiagnostic | null {
  if (!notices.length) return null;
  return {
    level: "warning",
    title: "置入成功 · 请核对兼容性",
    reason: notices.map(item => item.detail).join("\n"),
    advice: "请检查颜色、调整图层参数、图层效果和蒙版；这是格式差异提醒，不代表复制失败。",
  };
}
