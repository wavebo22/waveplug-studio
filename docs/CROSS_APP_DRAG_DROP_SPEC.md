# WavePlug 跨软件拖拽系统：技术方案与验证记录

- 文档版本：V1.0
- 整理日期：2026-11-09
- 项目：WavePlug Studio / WaveLayer
- 状态：**OLE 数据对象与 Windows Shell 接收已验证；生产接入尚未开始**
- 目标平台：Windows / Photoshop UXP

> 本文把“已验证的原型能力”“WavePlug 当前已有的内部接口”和“建议新增的生产接口”分开标记。方案或代码片段不代表生产代码已经实现。

---

## 1. 项目目标与用户已确认决策

让用户从 WaveLayer 拖出图层后，可以直接投放到 Windows 桌面、文件夹、微信、QQ、Illustrator、Figma、Office、浏览器上传区域及其他支持标准拖放的软件。

目标不是简单导出 PNG，而是通过 Windows 原生 OLE 多格式数据对象，让目标应用自行选择最适合的格式。

### 1.1 已确认的用户决策

| 项目 | 决策 |
|---|---|
| 多选图层 | **separate**：每个选中图层独立传输，不合并成一张图 |
| 文字图层 | **editable**：优先保留文字可编辑属性 |
| 外部拖拽触发 | **auto**：普通拖动，离开 Photoshop 后自动切换为外部拖拽 |
| 对原 PSD 的影响 | 只复制传输，不移动、不删除、不修改原图层 |
| 格式选择 | 自动选择；能保留编辑能力时不主动栅格化 |
| 不支持的格式 | 保证视觉回退，优先 PNG |
| 未知目标软件 | 提供通用标准格式，不要求每个软件都单独安装适配器 |

### 1.2 设计目标

1. 在 WaveLayer 内部拖拽时，原有图层排序、Alt 复制、删除轨道、编辑工作台逻辑保持不变。
2. 拖到 WavePlug 自己的外置生成面板时，继续使用原有参考图投放逻辑。
3. 只有拖到 Photoshop 以外的第三方目标时，才启动 Windows OLE。
4. 多选图层按独立文件传输，保留 Photoshop 图层顺序。
5. 文字、矢量优先可编辑；复杂效果无法表达时才做视觉回退。
6. 导出和 OLE 调用不能阻塞 WebSocket、egui 面板或 Photoshop 的正常交互。

---

## 2. 当前成果与状态边界

### 2.1 已验证的独立 OLE POC

**状态：已验证**

独立原型位于当前用户临时目录：

    C:\Users\WAVE\.agentdock\tmp\WavePlugOleHeadless

该目录不属于 WavePlug Git 仓库，不会被 Photoshop 加载。

已完成的验证：

| 能力 | 结果 |
|---|---|
| 自定义 IDataObject | 通过 |
| QueryInterface / AddRef / Release | 通过 |
| QueryGetData | 通过 |
| GetData + HGLOBAL 数据交付 | 通过 |
| GetCanonicalFormatEtc | 通过 |
| EnumFormatEtc / IEnumFORMATETC | 通过 |
| CF_HDROP 双文件路径 | 通过 |
| UTF-16 中文文件名 | 通过 |
| CF_UNICODETEXT | 通过 |
| HTML Clipboard 格式 | 通过 |
| RTF 格式 | 通过 |
| SVG 注册格式 | 通过 |
| OleInitialize / OleUninitialize 同线程 | 通过 |
| Windows Shell 文件夹真实接收 | 通过 |
| Debug / Release | 各 10/10 |
| Shell 接收重复测试 | 3/3 |
| cargo fmt --check | 通过 |
| cargo clippy --all-targets -- -D warnings | 通过 |

Shell 接收测试不是自制假窗口：测试通过 Windows Shell API 获取临时目标文件夹的真实 IDropTarget，把自定义 IDataObject 交给 Shell 的 DragEnter、DragOver、Drop。两个文件实际出现在目标目录，文件名和文件内容均校验通过，其中一个文件名包含中文。

### 2.2 尚未通过的真实全局拖拽测试

**状态：待验证**

另一个临时交互式 POC 已成功编译，并尝试在左键仍按下时调用 DoDragDrop。测试记录确认：

- GetAsyncKeyState(VK_LBUTTON) 检测到左键仍按下。
- Rust 辅助进程进入 DoDragDrop。
- 但当时鼠标实际命中的是 Chrome，而不是预期的 Explorer 文件夹。
- OLE 最终返回 DROPEFFECT_NONE，没有文件落地。

因此，**Shell 能接收 CF_HDROP 已通过；真实鼠标跨进程接管、Explorer 物理拖放、ESC 取消仍未通过验收**。

### 2.3 WavePlug 生产代码当前状态

**状态：尚未接入**

当前生产代码已有：

- UXP 与 Rust helper 的 WebSocket 通信。
- WaveLayer 内部拖拽生命周期。
- Rust 全局鼠标与 Photoshop 窗口识别基础。
- 原生拖拽预览。
- WavePlug 外置生成面板的参考图拖放。

当前生产源码中尚无真正的：

- DoDragDrop
- IDataObject
- IDropSource
- CF_HDROP 文件传输
- Windows OLE STA 拖拽线程

目前从 WaveLayer 拖到 Photoshop 外部，能看到拖拽预览，但没有向目标软件提交 Windows 数据对象，因此目标应用不会收到文件。

---

## 3. 总体架构

### 3.1 职责划分

| 模块 | 主要职责 |
|---|---|
| WaveLayer / UXP | 识别选择的图层、建立拖拽会话、从 Photoshop 读取像素、生成文件、管理源临时文件 |
| src/core/overlay/protocol.ts | TypeScript 侧 WebSocket 消息定义 |
| src/app/overlay.ts | WebSocket 连接、命令发送、事件接收 |
| native/overlay/src/protocol.rs | Rust 侧消息定义与 JSON 解析 |
| native/overlay/src/server.rs | 127.0.0.1:47821 WebSocket 服务；接收 UXP 命令、发送 Rust 事件 |
| native/overlay/src/win.rs | Windows 光标、窗口、Photoshop 进程识别 |
| 新增 Rust OLE 模块 | 专用 STA 线程、IDataObject、IDropSource、DoDragDrop、缓存文件管理 |
| Windows 目标软件 | 从 IDataObject 中选择自己支持的格式并接收 |

### 3.2 推荐数据流

    WaveLayer 图层开始拖动
        ↓
    UXP 建立 sessionId 和图层快照
        ↓
    后台预导出各图层文件
        ↓
    Rust 监控全局光标与左键
        ↓
    光标离开 Photoshop / WavePlug 自有投放区？
        ↓
    文件准备完成且左键仍按下？
        ↓
    Rust OLE STA 线程启动 DoDragDrop
        ↓
    目标软件选择格式并接收
        ↓
    完成 / 取消 / 拒绝 / 错误事件
        ↓
    缓存延迟清理或取消后立即清理

### 3.3 关键原则

- 不通过 WebSocket 传输整张图片的 Base64。WebSocket 只传会话信息、图层元数据和文件路径。
- UXP 负责 Photoshop 数据提取；Rust 不直接解析 PSD 内部结构。
- OLE 的 DoDragDrop 不得运行在 WebSocket 或 egui UI 线程。
- OLE 数据对象必须在 OLE STA 线程中创建、使用和释放。
- 对外拖拽始终是 Copy，不向目标应用提供 Move 语义。

---

## 4. Windows OLE / COM 接口

### 4.1 核心调用链

    OleInitialize(NULL)
        ↓
    创建 IDataObject
        ↓
    创建 IDropSource
        ↓
    DoDragDrop(pDataObject, pDropSource, DROPEFFECT_COPY, &effect)
        ↓
    目标应用查询 IDataObject 支持的格式
        ↓
    目标应用调用 GetData
        ↓
    目标应用接收数据并释放 STGMEDIUM
        ↓
    DoDragDrop 返回
        ↓
    释放 COM 对象
    OleUninitialize()

### 4.2 OleInitialize / OleUninitialize

用途：初始化当前线程的 OLE 单线程单元（STA）。

规则：

- OleInitialize(NULL) 和 OleUninitialize() 必须在同一线程配对调用。
- DoDragDrop 必须在已经初始化 OLE 的线程中调用。
- 推荐新增独立 OLE STA 线程。
- 不要在 Tokio/WebSocket 线程或 egui 更新循环中直接运行 DoDragDrop。
- OLE 线程应串行处理拖拽会话，避免多个会话同时抢占鼠标。
- OLE STA 线程必须处理 Windows 消息。空闲等待应使用 MsgWaitForMultipleObjects / PeekMessage / DispatchMessage 或隐藏窗口加消息循环；不能长期阻塞等待任务而完全不泵送 STA 消息。DoDragDrop 活跃期间会进入 OLE 自己的模态拖拽消息循环。

### 4.3 DoDragDrop

关键接口：

    HRESULT DoDragDrop(
        IDataObject *pDataObject,
        IDropSource *pDropSource,
        DWORD dwOKEffects,
        DWORD *pdwEffect
    );

本项目的目标参数：

- pDataObject：本次拖拽提供的多格式数据对象。
- pDropSource：管理 ESC、鼠标松开和拖拽反馈。
- dwOKEffects：第一版固定为 DROPEFFECT_COPY。
- pdwEffect：返回最终效果；不能只看 HRESULT，必须同时检查效果位。

### 4.4 IDataObject

这是整个跨软件传输的核心。目标软件通过它查询和读取数据。

| 方法 | 作用 | POC 状态 |
|---|---|---|
| QueryInterface | 查询 COM 接口 | 已实现 |
| AddRef | 增加引用计数 | 已实现 |
| Release | 减少引用计数并释放对象 | 已实现 |
| GetData | 按 FORMATETC 返回 STGMEDIUM | 已实现 |
| GetDataHere | 将数据写入调用方提供的介质 | 返回 E_NOTIMPL |
| QueryGetData | 判断指定格式是否可用 | 已实现 |
| GetCanonicalFormatEtc | 返回规范化格式描述 | 已实现 |
| SetData | 允许目标向数据源回写数据 | 返回 E_NOTIMPL |
| EnumFormatEtc | 枚举可用格式 | 已实现 |
| DAdvise / DUnadvise | 数据变化通知 | 返回不支持 |
| EnumDAdvise | 枚举通知连接 | 返回不支持 |

生产第一版不需要实现回写和数据变化通知，但必须保证 COM ABI、引用计数和内存所有权正确。

### 4.5 FORMATETC

用于描述目标应用请求的数据格式。

关键字段：

| 字段 | 第一版规则 |
|---|---|
| cfFormat | CF_HDROP、CF_UNICODETEXT 或注册格式 ID |
| ptd | NULL |
| dwAspect | DVASPECT_CONTENT |
| lindex | 普通全局格式使用 -1 |
| tymed | 第一版使用 TYMED_HGLOBAL |

QueryGetData 必须验证格式 ID、dwAspect、lindex 和 tymed，不能只判断格式 ID。

### 4.6 STGMEDIUM 与 HGLOBAL

POC 使用的交付方式：

1. GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size) 分配内存。
2. GlobalLock 获取可写地址。
3. 复制数据。
4. GlobalUnlock。
5. 填写 STGMEDIUM.tymed = TYMED_HGLOBAL。
6. 将 HGLOBAL 放入 STGMEDIUM。
7. pUnkForRelease = NULL。

接收方使用 ReleaseStgMedium 释放介质。POC 已对 HGLOBAL 字节内容和释放流程做了测试。

### 4.7 IEnumFORMATETC

目标应用可能通过它枚举所有可用格式。

需要实现：

- QueryInterface
- AddRef
- Release
- Next
- Skip
- Reset
- Clone

POC 曾发现 Skip 恰好跳到末尾时 HRESULT 不正确，已修复并加入测试。Next 没有取到数据时也必须正确返回 S_FALSE 和实际读取数量。

### 4.8 IDropSource

负责拖拽源端的继续、取消和鼠标反馈。

| 方法 | 作用 |
|---|---|
| QueryInterface / AddRef / Release | COM 生命周期 |
| QueryContinueDrag | 判断继续、放下或取消 |
| GiveFeedback | 指定系统默认或自定义拖拽光标 |

建议的 QueryContinueDrag 规则：

    Escape 按下       → DRAGDROP_S_CANCEL
    左键已经松开      → DRAGDROP_S_DROP
    其他情况          → S_OK

GiveFeedback 第一版可返回 DRAGDROP_S_USEDEFAULTCURSORS，先使用 Windows 默认反馈。

### 4.9 CF_HDROP

用途：向资源管理器、桌面、文件夹及支持文件拖放的应用提供真实文件路径。

数据结构：

    typedef struct _DROPFILES {
        DWORD pFiles;
        POINT pt;
        BOOL  fNC;
        BOOL  fWide;
    } DROPFILES;

关键要求：

- pFiles 指向文件路径列表的起始偏移。
- fWide = TRUE，路径使用 UTF-16。
- 每条路径以 NUL 结束。
- 整个路径列表以双 NUL 结束。
- 多选图层可以一次放入同一个 CF_HDROP 列表，目标应用看到的是多个独立文件。

POC 已验证两个文件、中文文件名和双 NUL 终止符。

### 4.10 其他数据格式

POC 已通过 RegisterClipboardFormatW 注册并提供以下格式：

| 格式 | 注册方式 | 用途 |
|---|---|---|
| CF_UNICODETEXT | Windows 预定义格式 | Unicode 纯文本 |
| HTML Format | RegisterClipboardFormatW | HTML 富文本 |
| Rich Text Format | RegisterClipboardFormatW | RTF 富文本 |
| image/svg+xml | RegisterClipboardFormatW | SVG 矢量数据 |

HTML 使用 CF_HTML 头部，必须计算 UTF-8 字节偏移：

- StartHTML
- EndHTML
- StartFragment
- EndFragment

POC 已修复 HTML 偏移量错误并通过测试。

### 4.11 尚未实现的 OLE 格式

| 格式 / 接口 | 作用 | 状态 |
|---|---|---|
| CF_DIBV5 | 直接向支持位图的应用提供 DIBV5 | 待实现 |
| PNG 注册剪贴板格式 | 直接提供 PNG 图像数据 | 待评估 |
| FILEGROUPDESCRIPTORW | 虚拟文件组描述 | 未实现 |
| FILECONTENTS | 虚拟文件内容 | 未实现 |
| TYMED_ISTREAM | 通过 IStream 交付数据 | 未实现 |

第一版优先使用 CF_HDROP 真实文件路径，兼容性更直观。虚拟文件和 IStream 留作后续扩展，不应误写为 POC 已通过的能力。

---

## 5. Windows Shell 接口与已验证路径

### 5.1 已测试的 Shell API 调用链

    SHParseDisplayName(folderPath)
        ↓
    SHBindToParent(pidl, IID_IShellFolder)
        ↓
    IShellFolder::GetUIObjectOf(IID_IDropTarget)
        ↓
    IDropTarget::DragEnter(dataObject)
        ↓
    IDropTarget::DragOver(...)
        ↓
    IDropTarget::Drop(dataObject)

接口作用：

| 接口 | 作用 |
|---|---|
| SHParseDisplayName | 将文件夹路径解析成 Shell PIDL |
| SHBindToParent | 获取父级 IShellFolder 与子 PIDL |
| IShellFolder::GetUIObjectOf | 获取目标文件夹的 IDropTarget |
| IDropTarget::DragEnter | 目标收到拖拽数据 |
| IDropTarget::DragOver | 更新拖拽位置与效果 |
| IDropTarget::DragLeave | 离开目标时结束悬停 |
| IDropTarget::Drop | 目标实际接收数据 |

### 5.2 这项测试证明了什么

已证明：

- Windows Shell 文件夹能够识别自定义 IDataObject。
- Shell 能读取 CF_HDROP。
- Shell 能复制两个独立文件。
- UTF-16 中文文件名正常。
- 文件内容与源文件逐字节一致。

**这不是完整的全局鼠标 OLE 测试。** 它直接调用了 Shell 的 IDropTarget，没有经过真实 DoDragDrop 鼠标命中循环。

---

## 6. UXP / Photoshop 图层导出接口

### 6.1 项目中已经存在的接口

| 接口 | 位置 | 当前用途 |
|---|---|---|
| require("photoshop").imaging.getPixels() | src/ps/uxpHost.ts、src/ps/uxpLayers.ts | 读取指定文档或图层的像素 |
| imageData.getData({ chunky: true }) | src/ps/uxpHost.ts | 获取连续排列的像素数据 |
| imageData.dispose() | 同上 | 释放 Photoshop 图像数据 |
| encodePng(Pixels) | src/core/image/png.ts | 编码 8-bit 灰度 / RGB / RGBA PNG |
| localFileSystem.getTemporaryFolder() | src/ps/uxpHost.ts | 获取 UXP 临时目录 |
| folder.createFile() | src/ps/uxpHost.ts | 创建临时文件 |
| file.write(bytes, { format: formats.binary }) | src/ps/uxpHost.ts | 写入二进制文件 |
| fs.createSessionToken(file) | src/ps/uxpHost.ts | 为 Photoshop 文件操作创建会话令牌 |

现有 uxpHost.ts 已经有 tempPng()，可以作为临时 PNG 写入和删除的实现参考。

### 6.2 普通像素图层导出建议

推荐使用项目已有的 Imaging API 与 PNG 编码器，不要重新实现一套像素读取逻辑。

    const imaging = require("photoshop").imaging;

    const result = await imaging.getPixels({
      documentID: docId,
      layerID: layerId,
      componentSize: 8,
      colorSpace: "RGB",
      colorProfile: "sRGB IEC61966-2.1"
      // 不要设置 applyAlpha: true，否则 RGBA 会被白色合成并移除 Alpha
    });

    try {
      const d = result.imageData;
      const data = new Uint8Array(await d.getData({ chunky: true }));

      const png = encodePng({
        width: d.width,
        height: d.height,
        channels: d.components,
        data
      });

      // 将 png 写入 UXP 临时文件，再把文件路径交给 Rust。
    } finally {
      result.imageData.dispose();
    }

注意：

- getPixels 的 sourceBounds 可能是裁切后的实际像素范围，必须保存其位置。
- 像素图层原点不一定是 (0, 0)。
- encodePng 当前只支持 8-bit 灰度、RGB、RGBA；16/32-bit 需要转换或走其他导出管线。
- imageData.dispose() 必须放在 finally，避免大图拖拽后内存持续增长。
- Adobe Imaging API 的 encodeImageData 当前文档说明是给 UXP 图像元素使用的 JPEG/base64 编码接口，不应误用它作为 PNG 文件编码器。

### 6.3 临时文件路径交给 Rust

推荐使用以下流程：

1. UXP 使用 getTemporaryFolder() 创建独立 session 目录。
2. 每个选中图层生成独立 PNG。
3. file.write(png, { format: formats.binary }) 写入文件。
4. 使用 UXP Storage 的 getNativePath(file) 获取原生路径（该调用尚未接入 WavePlug，需要在 Photoshop 2026 实机验证）。
5. 将路径和元数据通过 WebSocket 发送给 Rust。
6. Rust 将文件复制到自己的传输缓存目录。
7. Rust 确认复制完成后，UXP 删除原始临时文件。

不要把 createSessionToken(file) 当作 Windows 原生路径。Session Token 是 Photoshop 文件操作使用的授权令牌，OLE 的 CF_HDROP 需要真实文件系统路径。

### 6.4 不同图层类型的导出策略

| Photoshop 图层类型 | 优先格式 | 回退 |
|---|---|---|
| 普通像素图层 | PNG | PNG |
| 文字图层 | SVG 文字 / RTF / HTML | PNG |
| 形状图层 | SVG | PDF / PNG |
| 钢笔路径 / 矢量 | SVG | PDF / PNG |
| 智能对象 | 可提取的原始素材格式 | PNG |
| 图层组 | 尽可能保留内部结构 | 合成 PNG |
| 调整图层 | 当前视觉效果 | PNG |
| 复杂混合模式 / 图层样式 | 保证最终视觉效果 | 必要时合成 PNG |

说明：

- 文字的默认策略是保留可编辑属性，不能默认转轮廓。
- 字体缺失时应提示或回退，不能悄悄改变字体。
- 形状与路径需要从 Photoshop 矢量描述转换为 SVG，当前尚无完整导出实现。
- 调整图层、蒙版和混合模式可能依赖其他图层，不能保证独立导出后仍然等同于原 PSD；需要按实际效果渲染。
- 智能对象原始素材提取能力需要按嵌入 / 链接类型分别验证。

---

## 7. WaveLayer 当前拖拽接口与需要新增的协议

### 7.1 当前已有的 UXP 拖拽生命周期

src/core/layers/drag.ts 当前定义：

- LayerDragPhase：armed / dragging / released / cancelled
- LayerDragRegion：list / delete / tool / workbench / panel / outside
- createLayerDragLifecycle()
- activateLayerDragLifecycle()
- updateLayerDragLifecycle()
- releaseLayerDragLifecycle()
- cancelLayerDragLifecycle()
- routeLayerDragRelease()

src/ui/layerTree.ts 负责：

- 鼠标移动阈值与内部放置区域识别。
- 多选图层的顺序和内部拖放计划。
- 原有工作台、删除轨道和图层排序。
- 开始 / 结束原生拖拽预览。

当前 routeLayerDragRelease() 的 external 路由依赖 referenceDragStarted。这个字段代表 WavePlug 外置生成面板的参考图拖放，不等同于 Windows 第三方应用拖放。

因此，生产接入时必须增加独立的 externalTransferSession，不能把两个外部拖拽概念混为一谈。

### 7.2 当前已有的 Overlay 协议

通信地址：

    ws://127.0.0.1:47821

当前插件 → Rust 已有消息：

| 消息 | 作用 |
|---|---|
| hello | 建立 / 重置连接状态 |
| show / hide | 显示或隐藏外置面板 |
| state | 同步外置面板状态 |
| toast | 显示通知 |
| layer-drag-start | WaveLayer 开始向 WavePlug 自有外置面板拖图层 |
| layer-drag-cancel | 取消该参考图拖放 |
| layer-drag-preview-start | 开始独立原生拖拽预览 |
| layer-drag-preview-update | 更新预览动作和颜色 |
| layer-drag-preview-end | 结束预览 |
| hover-frame | 显示悬停边框 |
| manage-comfy / restart-helper | ComfyUI 与 helper 生命周期控制 |

当前 Rust → 插件已有事件：

- ready
- action
- view-request
- comfy-status

### 7.3 建议新增的跨应用传输协议

以下是**建议新增的接口，不是当前生产协议**。

#### UXP → Rust：external-drag-prepare

拖拽越过激活阈值时立即建立会话，并启动后台导出。

    {
      "type": "external-drag-prepare",
      "sessionId": "drag-session-001",
      "docId": 7,
      "totalCount": 2,
      "layers": [
        {
          "layerId": 42,
          "name": "标题",
          "kind": "text",
          "order": 0
        },
        {
          "layerId": 43,
          "name": "装饰图形",
          "kind": "shape",
          "order": 1
        }
      ]
    }

#### UXP → Rust：external-drag-ready

所有文件准备完成后发送文件清单。WebSocket 不传图片字节。

    {
      "type": "external-drag-ready",
      "sessionId": "drag-session-001",
      "files": [
        {
          "layerId": 42,
          "name": "标题.svg",
          "path": "C:\\Users\\WAVE\\...\\标题.svg",
          "mime": "image/svg+xml",
          "order": 0
        },
        {
          "layerId": 43,
          "name": "装饰图形.png",
          "path": "C:\\Users\\WAVE\\...\\装饰图形.png",
          "mime": "image/png",
          "order": 1
        }
      ]
    }

文件记录后续可增加：

- bounds：图层原始文档坐标。
- canvas：原始画布宽高。
- format：输出格式。
- editable：是否保留编辑结构。
- fallback：是否为视觉回退文件。

#### UXP → Rust：external-drag-cancel

    {
      "type": "external-drag-cancel",
      "sessionId": "drag-session-001",
      "reason": "internal-drop"
    }

建议原因值：

- escape
- pointer-released
- internal-drop
- document-changed
- helper-disconnected
- export-failed
- session-expired

#### Rust → UXP：external-drag-files-copied

Rust 已将 UXP 临时文件复制到自己的缓存目录后，通知 UXP 可以删除源临时文件。

    {
      "type": "external-drag-files-copied",
      "sessionId": "drag-session-001"
    }

#### Rust → UXP：external-drag-finished

    {
      "type": "external-drag-finished",
      "sessionId": "drag-session-001",
      "status": "dropped",
      "effect": "copy",
      "targetPid": 1234,
      "message": ""
    }

status 建议支持：

- dropped
- cancelled
- rejected
- error

### 7.4 为什么建议在拖拽开始时预导出

不建议等鼠标已经离开 Photoshop 后才开始读取大图层。

原因：

- Imaging API 是异步的，可能涉及磁盘 I/O。
- 大图层导出可能需要几十到数百毫秒。
- 用户可能在导出完成前已经松开鼠标。
- DoDragDrop 启动时必须仍处于有效的拖拽按键状态。

因此推荐：

1. UXP 检测到拖拽激活阈值后，立即建立会话。
2. UXP 在后台准备文件。
3. Rust 同时监控光标。
4. 文件准备好且鼠标仍按下时，如果光标已经离开 Photoshop / WavePlug 自有投放区，则启动 OLE。
5. 如果用户在文件准备好之前松开鼠标，则取消会话并清理文件。

这样既不会延迟内部拖拽，也不会等到外部目标出现后才开始导出。

---

## 8. Rust 生产模块设计

建议新增独立模块，例如：

    native/overlay/src/
      transfer/
        mod.rs
        session.rs
        ole.rs
        data_object.rs
        drop_source.rs
        formats.rs
        cache.rs

| 模块 | 责任 |
|---|---|
| session.rs | sessionId、文件清单、状态机、超时和取消 |
| ole.rs | STA 线程、OleInitialize、DoDragDrop |
| data_object.rs | IDataObject、IEnumFORMATETC、HGLOBAL |
| drop_source.rs | IDropSource、ESC、左键松开 |
| formats.rs | CF_HDROP、Unicode、HTML、RTF、SVG 等格式 |
| cache.rs | 文件复制、重名处理、缓存清理 |

### 8.1 OLE STA 线程

推荐结构：

    WebSocket server thread
            │
            ├── 解析 external-drag-prepare
            ├── 解析 external-drag-ready
            └── 发送取消 / 完成事件
                     │
                     ▼
             Transfer Session Manager
                     │
                     ▼
              OLE STA worker thread
                     │
                     ├── OleInitialize
                     ├── IDataObject
                     ├── IDropSource
                     ├── DoDragDrop
                     └── OleUninitialize

要求：

- OLE 线程独立，不阻塞 WebSocket。
- 不阻塞 egui 更新循环。
- 一次只执行一个系统拖拽会话。
- IDataObject 的引用计数和数据内存必须在正确的生命周期内释放。
- 如果用户已经松开左键，不允许启动一个新的 OLE 拖拽。

### 8.2 目标窗口识别

现有 native/overlay/src/win.rs 已有部分可复用能力：

- GetCursorPos
- GetAsyncKeyState
- WindowFromPoint
- GetAncestor
- GetForegroundWindow
- GetWindowThreadProcessId
- GetWindowRect
- photoshop_at()
- is_photoshop()
- Photoshop 主窗口枚举与生命周期监控

目标分类建议：

| 光标目标 | 处理 |
|---|---|
| Photoshop | 保留内部拖拽 |
| WavePlug 外置生成面板 | 保留参考图投放 |
| WavePlug 变体窗口 | 保留现有逻辑 |
| Windows 桌面 / Explorer | 允许系统 OLE |
| 第三方软件 | 允许系统 OLE |
| 未知窗口 | 使用通用 OLE 格式 |

不能只用“光标离开 UXP 面板”作为条件，否则用户在 Photoshop 画布和 WavePlug 自有窗口之间移动时，会误触发系统拖拽。

---

## 9. 输出格式与目标软件策略

### 9.1 格式优先级

| 目标内容 | 首选 | 备用 |
|---|---|---|
| 普通图片 | PNG / DIBV5 | CF_HDROP PNG |
| 文字 | SVG 文字 / RTF / HTML | PNG |
| 矢量 | SVG | PDF / PNG |
| 富文本 | RTF / HTML | Unicode 文本 |
| 多选图层 | 多文件 CF_HDROP | 目标支持的直接数据格式 |
| 未知内容 | 通用多格式数据对象 | PNG |

### 9.2 目标应用兼容策略

| 目标 | 推荐格式 | 状态 |
|---|---|---|
| Windows 桌面 | CF_HDROP | Shell 接收接口已验证；全局鼠标拖放待测 |
| Windows 文件夹 | CF_HDROP | Shell 真实接收已验证 |
| 微信 / QQ | PNG 文件优先 | 未实测 |
| 飞书 / 钉钉 | 图片或文件 | 未实测 |
| Illustrator | SVG / PDF / PNG | 未实测 |
| Figma | SVG / PNG | 未实测 |
| Word | RTF / HTML / PNG | 未实测 |
| PowerPoint | SVG / PNG | 未实测 |
| Excel | PNG / SVG | 未实测 |
| 浏览器 AI 上传区 | CF_HDROP 文件 | 未实测 |
| 普通文本输入框 | CF_UNICODETEXT / HTML / RTF | 未实测 |
| 未知软件 | CF_HDROP + 通用格式 | 未实测 |

目标软件识别只能作为优化，不能成为兼容的前提。即使识别不到目标软件，也应尝试标准格式。

### 9.3 排版与坐标

建议提供两种输出定位模式：

1. **素材裁切模式**：只保留图层有效像素，适合聊天、上传、素材文件夹。
2. **画布坐标模式**：保留原始画布宽高和图层 X/Y 坐标，适合 Illustrator、Figma 等设计软件。

注意：多选 separate 代表多个独立文件。仅在每个 PNG 内保留原始画布透明边界，并不能保证所有软件导入后自动按原坐标对齐。需要目标软件实际测试，必要时再提供统一 SVG 画布或坐标元数据方案。

---

## 10. 文件缓存、性能与异常处理

### 10.1 文件生命周期建议

    UXP 临时目录
       │
       ├── 创建每个图层的导出文件
       │
       ▼
    Rust 收到文件路径
       │
       ├── 校验文件存在、大小和 sessionId
       ├── 复制到 %LOCALAPPDATA%\WavePlug\TransferCache\<sessionId>
       └── 回复 external-drag-files-copied
              │
              ▼
    UXP 删除源临时文件
              │
              ▼
    Rust 使用缓存文件执行 OLE
              │
              ├── dropped：延迟清理
              ├── cancelled：立即清理
              └── error：记录原因并清理

建议：

- 目标软件可能在 Drop 返回后才异步读取文件，因此不要在 DoDragDrop 返回的瞬间立即删除目标文件。
- 初步建议成功文件保留 24 小时，定期清理；这是建议值，不是已经实现的策略。
- 取消、未开始的会话可以立即清理。
- 文件名清理 Windows 非法字符。
- 同名文件自动增加编号，不覆盖用户文件。
- 所有临时文件必须带 sessionId，避免清理其他会话文件。
- 大图层按文件处理，不把所有图层长期保存在 Base64 字符串或大块 JS 内存中。

### 10.2 异常场景

| 场景 | 预期处理 |
|---|---|
| 用户按 ESC | OLE 取消，回报 UXP，清理会话 |
| 用户在导出完成前松开 | 不启动 OLE，清理临时文件 |
| 用户放回 WaveLayer | 取消外部会话，继续内部排序 |
| 用户拖入 WavePlug 参考图区域 | 继续原有参考图逻辑 |
| Photoshop 切换文档 | 取消旧 session，禁止导出到新文档 |
| Photoshop 关闭 | 取消全部会话并回收资源 |
| helper 断连 | UXP 清理未完成的源文件 |
| 目标不支持格式 | 保留通用文件回退 |
| 临时文件不存在 | 拒绝启动 OLE 并返回明确错误 |
| 多选文件重名 | 自动编号，不覆盖 |
| 超大图层 / 内存不足 | 分阶段导出、限制并发、明确提示 |
| 目标软件管理员权限高于 helper | 记录 Windows 完整性级别限制，不伪报成功 |

---

## 11. 开发顺序

### P0：生产 OLE 基础设施

- 将 POC 的 COM 数据对象移植到 native/overlay。
- 增加专用 OLE STA 线程。
- 增加 CF_HDROP 多文件数据对象。
- 增加 sessionId、完成、取消、失败状态。
- 保留现有 WebSocket / egui 线程。

### P1：UXP 图层导出

- 从 WaveLayer 获取本次拖拽的图层快照。
- 使用现有 imaging.getPixels 和 encodePng。
- 将每个图层写成独立 PNG。
- 将文件路径和元数据交给 Rust。
- 验证临时文件授权和 getNativePath。

### P2：自动接管

- UXP 激活拖拽后预导出。
- Rust 全局监控鼠标和目标窗口。
- 只在左键仍按下、光标离开 Photoshop / WavePlug 自有投放区时启动 OLE。
- ESC、松开、返回内部区域、helper 断连都能正确结束。

### P3：真实应用兼容

依次测试：

1. Windows 文件夹 / 桌面。
2. 微信 / QQ。
3. Illustrator。
4. Figma。
5. Word / PowerPoint。
6. 浏览器 AI 上传区域。

### P4：可编辑格式

- SVG 文字。
- SVG 路径。
- RTF / HTML。
- PDF。
- DIBV5。
- 目标应用配置与格式优先级。

---

## 12. 验收标准

| 测试 | 通过条件 |
|---|---|
| 单个普通图层拖到文件夹 | 文件真实落地，透明度正确 |
| 多选 4 个图层 | 4 个独立文件，名称和顺序正确 |
| 中文图层名 | 文件名无乱码 |
| 文字拖到支持 SVG 的软件 | 文字尽可能保持可编辑 |
| 矢量拖到 Illustrator | 保留路径，不被默认栅格化 |
| 拖入微信 | 图片或文件能够正常发送 |
| 拖入 AI 网站 | 上传区域能识别文件 |
| ESC | 取消后鼠标正常，文件清理正确 |
| 松开在无效目标 | 不报告成功、不留下永久垃圾文件 |
| 拖回 Photoshop | 内部图层排序逻辑不受影响 |
| 拖入 WavePlug 外置面板 | 原有参考图投放逻辑不受影响 |
| 切换文档 / 关闭 PS | 不会导出错误文档或残留会话 |
| 大图层 / 多选 | 不明显阻塞 Photoshop，不持续累积内存 |

---

## 13. 当前工程变更边界

截至本文整理时：

- 独立 OLE POC 在当前用户临时目录下。
- WavePlugOleHeadless 是保留的无界面测试工程。
- WavePlug 生产源码尚未接入 DoDragDrop。
- 当前 local-test 分支存在其他未提交修改。
- 本文档新增不应覆盖、重置或清理这些已有修改。
- 不提交 Git、不切换分支，除非用户明确要求。

---

## 14. 参考资料与源码入口

### Adobe 官方接口文档

- [Photoshop UXP Imaging API](https://developer.adobe.com/photoshop/uxp/2022/ps-reference/media/imaging)
  - imaging.getPixels
  - PhotoshopImageData.getData
  - PhotoshopImageData.dispose
  - sourceBounds / targetSize / componentSize
- [Photoshop UXP API Reference](https://developer.adobe.com/photoshop/uxp/ps_reference)
- [UXP Storage API](https://developer.adobe.com/xd/uxp/develop/reference/uxp/module/storage)

### Microsoft Windows API

- [DoDragDrop](https://learn.microsoft.com/windows/win32/api/ole2/nf-ole2-dodragdrop)
- [IDataObject](https://learn.microsoft.com/windows/win32/api/objidl/nn-objidl-idataobject)
- [IDropSource](https://learn.microsoft.com/windows/win32/api/oleidl/nn-oleidl-idropsource)
- [IDropTarget](https://learn.microsoft.com/windows/win32/api/oleidl/nn-oleidl-idroptarget)
- [IShellFolder](https://learn.microsoft.com/windows/win32/api/shobjidl_core/nn-shobjidl_core-ishellfolder)
- [SHParseDisplayName](https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shparsedisplayname)

### WavePlug 当前源码入口

| 文件 | 内容 |
|---|---|
| src/core/layers/drag.ts | WaveLayer 拖拽生命周期 |
| src/ui/layerTree.ts | 图层拖拽 UI、内部放置、参考图拖拽启动 |
| src/app/overlay.ts | UXP WebSocket 客户端 |
| src/core/overlay/protocol.ts | TypeScript 消息定义 |
| src/ps/uxpLayers.ts | Photoshop 图层读取与操作 |
| src/ps/uxpHost.ts | Imaging API、临时 PNG 写入 |
| src/core/image/png.ts | PNG 编码器 |
| native/overlay/src/protocol.rs | Rust 消息定义 |
| native/overlay/src/server.rs | WebSocket 服务与事件队列 |
| native/overlay/src/host.rs | Rust 外置面板状态与绘制 |
| native/overlay/src/win.rs | Windows 窗口、光标、Photoshop 进程识别 |

---

## 15. 结论

已经证明 Windows Shell 能接收由自定义 IDataObject 提供的多文件 CF_HDROP，并且数据对象的格式枚举、HGLOBAL 交付、Unicode 路径、HTML/RTF/SVG 数据和 COM 生命周期均有独立测试。

下一步不再重复研究 OLE 基础，而是把已验证的数据对象移植到 WavePlug Rust helper，建立 UXP 文件导出与 Rust OLE 线程之间的会话协议，再完成真实的全局鼠标接管测试。

**在 Explorer 真实鼠标拖放、ESC 取消和 WaveLayer 内部拖拽回归通过之前，不应宣称跨软件拖拽已正式交付。**


## 15. 拖拽判定权与拖拽引擎（2026-11-12，helper 0.6.0）

起因：拖到外置参考图槽位上，卡片显示「不能放在这里」，松手却能放入；之后又出现卡片跟手滞后。原来的结构里，卡片是 egui viewport，每帧重画一次；槽位的悬停和松手判定，由面板每帧轮询光标和左键状态来做。判定分散在三个地方，卡片位置又绑在整帧 GPU 重画上。

**规则：谁看得见光标，谁判定；卡片和松手用同一次命中测试。**

现在的结构是拖拽引擎（`native/overlay/src/drag/`），运行在独立线程上，参照 `frame.rs`：纯 Win32，不用 egui，也不用 GPU。

| 文件 | 职责 |
|---|---|
| `drag/session.rs` | 纯逻辑状态机。输入：插件判定、移动、松手、Esc、插件结束或取消。输出：Render（只在文字变化时）、Place、Hover、Dropped、Hide、Finished。卡片文字由 `drag_target::resolve` 仲裁：光标下的原生目标优先，否则用插件的判定。原生目标只对插件标记为参考图拖拽的会话（`layer-drag-start`）生效。 |
| `drag/targets.rs` | 原生落点注册表。Surface 绘制时发布屏幕矩形，引擎在每次鼠标移动时做命中测试。 |
| `drag/card.rs` | 卡片排版和像素，可在 Mac 上测试。文字由 GDI 绘制。 |
| `drag/win.rs` | 引擎线程：分层窗口，拖拽期间安装 `WH_MOUSE_LL` 钩子（失败时退回 4ms 轮询），30ms 定时器负责 Esc、前台检查和兜底松手判定。 |

- 卡片只在文字或 DPI 变化时绘制（`UpdateLayeredWindow`）；鼠标移动时只调用 `SetWindowPos`。
- 松手由钩子收到的 `WM_LBUTTONUP` 决定。如果插件的 `layer-drag-preview-end` 先到，就看左键是否已经抬起：已抬起，按松手处理；仍按着，按取消处理。
- 落点结果以事件交给 host，由对应 Surface 的 `external_drop` 生成动作（参考图槽位就是原来的 `drop-refs`）。参考图拖拽结束时，host 向插件发送 `finish-layer-drag`。
- 日志：每次拖拽结束写一行 `drag session <dropped|released|escape|cancelled> ms=… moves=… renders=… max_handler_us=… hook=ok|fallback`。
- 版本：插件的 `EXPECTED_HELPER_VERSION`（`src/core/overlay/protocol.ts`）必须和 `native/overlay/Cargo.toml` 一起升级；版本不一致时，设置页会提示重新运行 build.cmd。

**接入新目标：**
- 其他外置面板：绘制时调用 `drag::targets::publish`，并实现 `Surface::external_drop`。
- 其他软件（P0 的 OLE）：把 `DoDragDrop` 放在这个引擎线程上（STA，已有消息循环）。目标应用在 DragOver 中返回的 DROPEFFECT 映射成会话判定（COPY → copy，NONE → invalid），松手按同一判定执行。

### 15.1 系统拖拽（OLE，helper 0.7.0，待 Photoshop 实测）

- 模块：`drag/transfer.rs`（缓存、文件名、CF_HDROP 字节、结果映射，纯逻辑）和 `drag/ole.rs`（用 windows-sys 手写的 IDataObject / IEnumFORMATETC / IDropSource 加 DoDragDrop）。引擎线程启动时调用 `OleInitialize`，作为 STA。
- 协议按 7.3 实现：插件 → helper 有 `external-drag-prepare / ready / cancel`；helper → 插件有 `external-drag-files-copied / finished`。ready 后 helper 在工作线程把文件复制到 `%LOCALAPPDATA%\WavePlug\TransferCache\<sessionId>`，按图层名命名，重名自动编号。
- 启动条件：文件已就绪、左键仍按着、光标所在的顶层窗口既不属于 Photoshop 也不属于 helper（`win::is_foreign`），并且没有命中参考图槽位。DoDragDrop 在引擎线程运行，期间不持有引擎借用，钩子照常移动卡片。
- 卡片文字：准备中「正在准备 N 个文件…」；目标接收「复制到这里」；不接收「这里不能放入」；回到 Photoshop 或 helper 窗口时「松开取消」。
- 松手：在参考图槽位上，按参考图放入，OLE 取消；在 Photoshop 或 helper 窗口上，取消；其他位置，由目标接收文件。Esc 取消。
- 缓存：dropped 的会话保留，24 小时后在 helper 启动时清理；其他结果立即删除。
- 日志：`external transfer ready files ms`、`ole drag start`、`ole drag status hr effect feedback ms`。如果 `feedback=0`，说明 OLE 没能接管鼠标（即 2.2 的未通过项），需要另想办法。

### 15.2 实测卡死与看门狗（11-12，helper 0.7.1）

- **0.7.0 实测**：拖进微信时卡死，日志两次都只有 `ole drag start`，没有结束记录。鼠标是在 Photoshop 里按下的，helper 线程的输入状态里没有这次按键，Windows 的拖拽循环收不到松手，DoDragDrop 永远不返回。结果是卡片一直粘在鼠标上，之后的拖拽也再出不来（引擎线程被占住）。这就是 2.2 那项未通过验证的实际表现。
- **0.7.1 修复**：
  - DoDragDrop 期间用 `AttachThreadInput` 接上前台（Photoshop）线程的输入状态，结束后断开。
  - 松手以物理左键（`GetAsyncKeyState`）为准，不看 OLE 传来的按键标志。
  - 新增独立看门狗线程：松手 500ms 后拖拽还没结束，就向引擎线程投递 Esc；3 秒后仍未结束（已经交给目标软件放下的放宽到 20 秒），就藏起卡片、通知插件结束拖拽，并重启 helper（ComfyUI 不受影响）。
- **新日志**：`ole drag input attached=… front_thread=… button_down=…`、`ole query_continue first …`、`ole feedback first effect=…`、`ole drag calls query_continue=… feedback=…`、`ole watchdog: …`。

### 15.3 Alt+Tab、导出复用与缓存上限（11-12，helper 0.7.2）

0.7.1 实测：已能拖进微信。剩下两类失败：
- 大图层导出要 2.2–2.5 秒，松手时还没导完。
- 好几次系统拖拽返回「取消」，原因当时没有记录。

**Alt+Tab**
- Windows 在前台切换时会取消正在进行的系统拖拽。如果这次取消不是我们的 QueryContinueDrag 决定的，并且左键仍按着，就保留会话，等光标再回到其他程序的窗口上时重新启动（每次拖拽最多 20 次）。
- 输入状态始终接 Photoshop 的 UI 线程（拖拽开始时记下），不再接当前前台窗口。
- 卡片在整个拖拽期间都显示，不再因为 Photoshop 失去前台而隐藏。
- 文件进入 helper 缓存后，只要左键还按着，插件发来的结束或取消都忽略（插件可能在切换窗口时丢掉自己的拖拽）。日志：`plugin ended its drag with the button down`。

**松手日志**：`ole release at x,y over=<程序名> target=… decision=Drop|Cancel|Native`；被 Windows 中断时记 `ole drag interrupted by Windows … resume N`。

**导出复用**
- 插件给每个图层生成一个键：插件这次加载的随机值 + 文档 id + 当前历史状态 id + 图层 id。任何编辑、撤销、重做都会改变历史状态，所以改过的图层不会被误复用；插件重新加载后也不会和旧键撞上。
- prepare 带上这些键；helper 立刻回 `external-drag-cached`，列出已经导出过的键。插件只导出没有的，有的在 ready 里不带文件路径。插件最多等这个回复 300ms。
- helper 的 `TransferCache\store\<键的哈希>.png` 每个图层版本只存一份；每次拖拽的会话目录里放的是指向它的硬链接，不再多占磁盘。

**上限**
- 一次最多 20 个图层，多出的不导出，并在状态栏提示。
- store 只保留最近 24 小时用过的文件，总量不超过 1GB，超出时先删最久没用的。
- 每次系统拖拽结束和 helper 启动时都会清理一次。

### 15.4 易用性与微信偶发失败（11-12，helper 0.7.3）

- **重复文件**：拖进文件夹时由资源管理器自己复制文件，同名时弹出 Windows 自带的「替换 / 跳过 / 比较」，所以不另做弹窗。一次拖出多个同名图层时，我们自动编号。
- **卡片写明目标程序**：「复制到 微信 / 文件夹 / 浏览器 / Word」，目标不接收时显示「微信 不接收」。程序名映射见 `transfer::app_label`。
- **放下后的提示**：`external-drag-finished` 增加 `target` 和 `count`。WaveLayer 状态栏显示「已把 N 个图层复制到 微信」或「微信 没有接收这些文件」；取消时不提示。
- **导出进度**：插件每导出完一个文件就发 `external-drag-progress`，卡片显示「正在准备 2/5 个文件…」（只有需要实际导出多个时才发）。
- **更多软件能接收**：只拖一个图层时，除了 CF_HDROP，还提供注册格式 `PNG`（带透明）和 `CF_DIBV5`（BGRA、直通 alpha、自下而上），数据在目标第一次请求时才生成。只认图片的软件（Office、网页编辑器等）也能放。多个图层只提供文件列表。
- **微信偶发失败**：
  - 证据不足，先补日志：开始位置（`ole drag start … over=`），以及松手时目标最后一次的接收状态和变化次数（`last_effect`、`effect_changes`）。
  - 同时做了一个低风险修正：系统拖拽启动后，如果光标已经停在其他程序上，就通过 `SendInput` 模拟一次 0 位移的鼠标移动，让目标立刻收到「有东西拖进来」的通知（日志：`ole nudge`）。

### 15.5 「中间有一段时间无法放置」的证据（11-12，helper 0.7.4）

- 0.7.3 日志：两次拖拽（一次从资源管理器开始，一次从微信开始）都在 7–9 秒后松手，日志判断松手位置为 `over=Photoshop.exe`（x≈268–360，y≈1160–1190），所以取消了；`last_effect=1`，说明松手处的程序表示可以接收。Photoshop 本身也接收文件拖放，所以这和「光标下是 Photoshop」一致。
- 两种可能：
  - Photoshop 在拖拽经过时把自己提到了前面，挡住了微信；
  - Photoshop 有一个看不见的透明窗口盖在微信上，`WindowFromPoint` 命中的是它。
  
  现有日志区分不了。
- 0.7.4 只加证据，不改行为：拖拽期间，光标下的顶层窗口每变一次就记一行 `drag over <exe> foreign=… ole=… class=… rect=… ex=… front=<前台程序>`。下次复现后，看「无法放置」那段时间里命中的窗口类名、范围和透明样式，以及前台程序，再决定怎么修。
- 0.7.4 实测（用户确认看到的是微信）：微信窗口为 `647,838,2194,1990`；失败的松手点 (1180,716) 在它上边缘以上，之前两次 (268–360, ~1170) 在它左边。按系统给出的数据，这些点都不在微信窗口内。拖拽过程中光标下的窗口在微信和 Photoshop 之间反复切换，但前台一直是微信，helper 也没有切换焦点。
- 0.7.5 继续补证据：松手被判为 Photoshop 时，记录该点上从上到下所有可见的顶层窗口（程序、类名、范围、透明样式、是否被系统隐藏），以及两种光标坐标和线程的 DPI 感知，用来区分「坐标对不上（DPI）」和「那里确实没有微信窗口」。
- 同时，在 Photoshop 上松手被取消时，WaveLayer 状态栏会提示「在 Photoshop 上松手：已取消」，用户能立刻知道这次没放进去。

## 16. 拖进 Illustrator：像素嵌入、矢量和文字可编辑（11-13，helper 0.10.0）

### 16.1 为什么不用普通拖放

- 文件拖进 Illustrator 默认是**链接**，按住 Shift 松手才嵌入（社区经验，非官方）。我们交出去的是缓存里的 PNG，缓存 24 小时后清理，链接就断了。
- 「SVG 代码文本」能否粘贴或拖入 Illustrator，各方说法不一，不可靠。

### 16.2 做法

1. **插件**导出时，每个图层除了 PNG，还附带三项（`external-drag-ready` 里的 `rect`、`vector`、`res`）：
   - `rect`：像素在文档中的位置。
   - `vector`：文字或形状图层的 SVG 片段（`src/core/overlay/svgFragment.ts`），坐标是文档像素。
   - `res`：文档分辨率。

   走缓存复用的图层也会带上这三项，因为它们只读图层描述，不读像素。
2. **helper** 复制完文件后，如果有任何图层带片段，就把所有图层合成一个 `waveplug_layers.svg`（`drag/compose.rs`）：
   - 文字和形状放片段；其余图层把 PNG 以 base64 写进 `<image>`。
   - 下层在前，图层之间的相对位置不变。
   - 尺寸按「文档像素 → 点（分辨率）」换算，落到 Illustrator 里是印刷尺寸。
3. 系统拖拽中，光标在 Illustrator 上时，如果它能用脚本驱动（ProgID 已注册），卡片显示当前模式：
   - 「嵌入 Illustrator · 可编辑」
   - 「作为图片嵌入 Illustrator」
   - 「链接到 Illustrator」
4. **松手**（不按 Alt）时，helper 取消系统拖放，转交 `drag/illustrator.rs` 在独立线程上导入：
   - 调用链：cscript（JScript，UTF-16 脚本）→ COM `Illustrator.Application.<版本>`（从安装路径的年份推算，例如 2025 → 29），不行再用通用名 → `DoJavaScript` → `groupItems.createFromFile`。
   - 落点：从落点所在窗口（画布）的比例和 `views[0].bounds` 换算出文档坐标，把内容的中心放在落点并选中。
   - 没有打开的文档时，新建一个文档，画板贴合导入的内容。
   - 超时 15 秒。完成后发 `external-drag-finished`（`effect: "embed"`），状态栏显示「已把 N 个图层嵌入 Illustrator（文字和形状可编辑）」；失败时提示可以按 Alt 改用普通拖放。会话文件随后删除（内容已嵌入，不依赖缓存）。
5. **Figma 桌面版**（`Figma.exe`）：有合成 SVG 时，交出这个 SVG 而不是 PNG。效果未实测。

### 16.3 组合键（以松手那一刻为准）

| 松手时 | Illustrator | 其他程序 |
|---|---|---|
| 不按键 | 嵌入：文字和形状可编辑，像素嵌入，保持相对位置 | PNG 文件（同以前） |
| Ctrl | 全部作为嵌入图片（`waveplug_images.svg`），保持相对位置 | 同以前 |
| Alt | 普通拖放，由 Illustrator 自己处理（链接 PNG；它的 Shift 嵌入照常有效） | 同以前 |

### 16.4 片段覆盖范围和已知限制

- **文字**：
  - 每行一个 `<tspan>`，按样式区间再拆分。
  - 字体用 PostScript 名，字号、颜色、字距、行距（自动行距按 1.2 倍）、对齐、变换矩阵、伪粗体 / 伪斜体、下划线 / 删除线都会带上。
  - 图层效果去掉；图层不透明度和填充不透明度保留。
  - **段落文字只保留手动换行**，自动换行会丢失。
  - 竖排、变形文字、非 RGB 颜色回退为 PNG。
- **形状**：
  - 矢量蒙版路径（锚点和控制柄）转成 SVG，有减去 / 排除时用 evenodd。
  - 支持纯色填充和纯色描边（线宽、端点、拐角、虚线）。描边的内侧 / 外侧对齐按居中近似。
  - 相交组合、渐变或图案填充回退为 PNG。
- 回退原因记录在 `uxp_runtime.log`：`external drag vector fallback <id> <kind> <原因>`。
- **待实测**：
  - 文字基线和行距的位置（`textClickPoint` / `transform` 字段的含义只能在 PS 上验证）。
  - `getPixels` 导出的 PNG 是否包含图层效果（影响 Ctrl 模式）。
  - `createFromFile` 导入的 SVG 文字是否为可编辑文字。
- **日志**（`overlay_runtime.log`）：
  - `drag over Illustrator path=… scriptable=…`
  - `ole release over Illustrator: script import mode=… at fx,fy`
  - `illustrator canvas class=… rect=…`
  - `illustrator import status=… ms=… answer=…`
