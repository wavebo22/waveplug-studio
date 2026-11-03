# WavePlug 图层面板 — 交接文档

最后整理：2026-11-02。给接手图层面板的 AI。先读 [`docs/README.md`](README.md) 和本文，再动代码。

---

## 0. 现在停在哪里（先看这一节）

2026-11-03：用户在 PS 里测了第 3.3、3.4 节，按反馈做了第 3.5、3.6 节（已打包，等用户再测）。代码停在下面这个状态：

| 状态 | 内容 |
|---|---|
| 源码 | `npx tsc --noEmit -p .` 无报错，`npm test` 89 个全过 |
| 打包产物 `dist/` | 11-03 重新打包，包含第 3.3–3.6 节，3.6 等用户在 PS 里测 |
| git | 分支 `local-test`。图层面板 11-03 已提交（第 3.6 节为止）；只在用户要求时提交 |

**接手后的第一件事：** 等用户测第 3.5 节的结果；先看日志 `vector mask`、`target part`、`color picker`。悬停定位已按用户要求改成默认关闭（第 5 节）。

---

## 1. 基本约定

- 项目路径：Mac 上是 `/Volumes/wavebobo/waveplug/studio`，Windows 上是 `F:\waveplug\studio`。
- 开发流程：改代码 → `npm run build` → 用户在 PS 开发版面板「WavePlug 图层 Dev」里点 ⟳。
- **PS 里的问题先看日志**：`reports/uxp_runtime.log`（开发版的日志会镜像到这里）。没有证据先加日志，不要盲试。用户额度很紧张。
- 浏览器预览：`dist/preview`，用 `MockLayerTree` 模拟一个有 3000 个图层的文档。预览服务器读不到网络盘，要先复制到本地再起服务：
  ```
  cp -R dist/preview <本地目录>
  python3 -m http.server 8791 --directory <本地目录>
  ```
  **浏览器里能用，不代表 UXP 里能用**（box-shadow 就是一例，见第 6 节）。
- 只要改了 manifest 里的面板或 `dev/` 目录：把 `scripts/build.mjs` 里的 `DEV_LOADER_VERSION`（现在是 1.4.0）调高，运行 `python3 scripts/package_ccx.py dev`，再让用户重新运行 `install_dev.cmd`。否则 UPIA 会报 -418。
- 用户偏好：
  - 回复用中文；
  - 界面要「无感」，不跳动、不闪；
  - 文字高对比、别太小；PS 用中灰主题；
  - 说明一律做成鼠标悬停提示（`src/ui/tooltip.ts`），用户明确拒绝过「?」弹窗。
- 改文件时**不要**写 `open(p,'w').write(open(p).read())`：它会先清空文件，曾经把 `layerTree.ts` 清空过一次。安全的做法是写到 `.new` 文件，再 `mv` 过去；或者用编辑工具。
- 其他会话也可能在改同一批文件。动手前看一下文件的修改时间，避免互相覆盖。

---

## 2. 文件地图

| 文件 | 内容 |
|---|---|
| `src/core/layers/tree.ts` | 纯逻辑（有测试）：`buildTree`、`visibleRows`、`layerTags`、`dropPlan`/`dropZone`、`layerMenu`、`lockPlan`/`lockedByGroup`、`sharedColors`、`linkPeers`、`effectsOf`、`packChips`、`rawProblem`、`LayerAction` 类型、`BLEND_MODES`/`EFFECTS` |
| `src/core/layers/thumbs.ts` | `ThumbCache`；`thumbArea`（图层范围补成 ≤4:1）；`frameThumb`（画进 ≤`size` 的正方形） |
| `src/ps/uxpLayers.ts` | PS 端：multiGet 读取（`PROPS`、`rawOf`，读错时换起始编号，或退回逐层读）；`thumbnails`；`select`/`setVisible`/`move`；`run()` 和 `actionDescs()` 里的全部命令；`onEdited`/`onChange`；`styleMenu`（按菜单标题查找图层样式各页的命令 ID） |
| `src/ps/host.ts` | `LayerTree` 接口 |
| `src/ps/uxpHost.ts` | `play`/`modal`/`step`；`onModalDone`（PS 不会把插件自己的操作通知给插件，靠它补上） |
| `src/ui/layerTree.ts` | 整个列表界面（约 1400 行）：行池、绘制、滚动、拖动、菜单、缩略图队列、尺寸、画板框 |
| `src/ui/layersPanel.ts` | 面板外壳和状态栏 |
| `src/ui/dom.ts` | `h()`、`icon()`（新增 `ps*` 图标和实心部分 `FILLS`）、`setShown`/`isShown` |
| `src/ui/popupMenu.ts` / `tooltip.ts` / `slider.ts` | 弹出菜单、悬停提示、拉杆 |
| `plugin/styles.css` | 所有 `.lt-*` 样式；尺寸变量 `--lt-row`、`--lt-short`、`--lt-thumb`、`--lt-mark` 定义在 `.lt-list.sz-*` 上 |
| `src/preview/main.preview.ts` | `MockLayerTree`：徽章组、碎片组被设成了画板 |
| `tests/layer_tree.test.ts` | 纯逻辑测试 |

---

## 3. 功能清单（按确认程度分）

### 3.1 用户已在 PS 里确认

- **图层树**：层级竖线（Blender 风格）；眼睛（Alt+单击：只显示这个图层）。普通图层有「可移动 / 可编辑」两个开关，对应锁定位置和锁定图像像素；组的同一位置是「锁定全部」开关，组只能整体锁定。
- **剪贴蒙版**：显示箭头，基底图层的名字带下划线。蒙版缩略图：单击选中蒙版，Shift+单击停用。
- **状态列**：智能对象类型（独立 / 共用×N / 外部链接）或 AI 结果组、内容类型、智能滤镜、fx、链接、锁定。整个文档都用不到的列不显示。
- **子行**：效果标签（单击切换显示，快速双击打开图层样式）、智能滤镜（有眼睛）。默认收起，点 ▸ 展开。
- **双击**：缩略图 → 图层样式；名字 → 重命名；智能对象那一列的图标 → 打开内容。
- **右键菜单、底部工具栏、拖动排序**（多选、插入线、悬停自动展开、边缘自动滚动）。
- **顶部**：搜索、类型筛选、共用 / 不可编辑 / AI 筛选、混合模式、4 个锁定、不透明度和填充。
- **缩略图**（第 4 节）：修好了「列表只画出一部分」的 bug，用户已确认显示正确。

### 3.2 已打包（`dist` 13:27），还没在 PS 里确认

- **选中时闪一下**：`clickRow` 记录 `selecting`/`selectGen`。`refresh` 如果发现读取期间列表自己发出过选择，就保留列表的选中并重读一次。
- **共用副本、链接图层的底色**：统一用浅一档的选中绿（`.lt-row.peer`）。副本在折叠的组里时，组那一行颜色更淡（`.peer.inside`）。
- **缩略图大小**：底部「缩略图 无 / 小 / 中 / 大」，默认中，存在 localStorage 的 `wp.layers.size`（旧的 `wp.layers.thumbs=off` 会迁移成「无」）。由 `SIZES` 控制行高、矮行高、缩略图框和图标缩放比例：

  | 档位 | 行高 | 组 / 子行 | 缩略图框 |
  |---|---|---|---|
  | 小 | 32 | 28 | 26 |
  | 中 | 44 | 32 | 38 |
  | 大 | 60 | 38 | 54 |

  读缩略图时按框的两倍大小读。
- **行高不统一**：组和所有子行用矮行高（`isShort`/`heightOf`，CSS `.lt-row.short`）。列表几何改成逐行累加：`yOf`/`rowAt`/`fitsFrom`/`maxFirst`。**不要再用「行号 × ROW」计算位置。**
- **PS 风格图标**：`dom.ts` 里的 `ps*` 图标（线条加实心部分），由 `layerTree.ts` 的 `ic()` 和 `PS_ICON` 映射，并按尺寸档位缩放。眼睛列宽 30、开关列宽 24（`LEAD` 已同步）。
- **画板**：multiGet 多读 `artboardEnabled` 和 `color`（PS 的图层颜色标签）。
  - 每个画板在列表上叠一个 3 px 的圆角框（`drawBoards()`，`.lt-board`，`pointer-events: none`）；框里的行左右缩进（`.ab`），框内没有颜色线条；画板那一行整行填满画板颜色，文字是深色（`.ab-head`）。
  - 双击画板行（名字以外的地方）弹出颜色菜单，执行 `setColor`，也就是设置 PS 的图层颜色，所以颜色会存进 PSD。没设颜色的画板按顺序自动配色。设置后会读回并记日志 `layer color`。
  - 用户之前反馈过一次「选了颜色没效果」，当时用的是 box-shadow，UXP 不画。现在的版本还没确认。
- **Ctrl+单击缩略图或类型图标**：载入图层像素为选区；Ctrl+单击蒙版缩略图：载入蒙版为选区。+Shift 添加，+Alt 减去，+Shift+Alt 交叉。不改变图层的选中（`loadSelection`，`prepare` 时跳过选中图层）。

### 3.3 只改了源码，**没打包、没在 PS 里试过**（「常用操作」这一批）

11-03 已打包（`dist/`），还没在 PS 里试过；`tsc` 和测试都通过。浏览器预览只看过链接图标（`MockLayerTree` 里「形状 1」带矢量蒙版，「阴影」的蒙版未链接）：显示、单击切换都正常。

| 功能 | 做法 | 把握 |
|---|---|---|
| 图层颜色标签 | 眼睛列按 PS 图层颜色着色（`labelTint`）；右键菜单末尾加「图层颜色…」，打开颜色菜单（`openColorMenu(id, ids)`，可多选） | 高（`setColor` 和画板用的是同一条命令） |
| 拖过眼睛列批量显示 / 隐藏 | 在眼睛上按下就切换这一个，按住拖过其他眼睛按同样方式切换，界面立即更新；松开鼠标时一次性发给 PS（`eyeDrag`/`eyePaint`）。**`LayerTree.setVisible` 的签名改成了 `ids: number[]`** | 高 |
| 蒙版和图层之间的链接图标 | `maskChain`，单击切换 `userMaskLinked` / `vectorMaskLinked`（`toggleMaskLink`） | 中 |
| Alt+单击蒙版只看蒙版（Alt+Shift：红色叠加），再按一次恢复 | `viewMask`：`select mask channel makeVisible`；`show mask channel`；恢复时选回复合通道（按文档模式取 RGB / CMYK / lab / black） | **低**：命令写法凭记忆，没录制核对。日志 `mask view off` |
| 矢量蒙版 | 多读 `hasVectorMask`、`vectorMaskEnabled`；缩略图走 `getLayerMask({kind:"vector"})`，缓存键是 `vmaskKey`。`vmaskCell`：单击选中，Shift 停用，Ctrl 载入路径为选区。菜单：添加 / 删除 / 停用矢量蒙版 | 中（`make path at vectorMask` 和载入选区的写法没录制核对） |
| 双击智能滤镜重新打开设置 | `editFilter`：读 `smartObject.filterFX[pos].filter`，以 `set filterFX` 加显示对话框执行。编号沿用 `filtersReversed` | 中，日志 `smart filter edit` |

改动涉及的文件：`src/core/layers/tree.ts`（类型、菜单）、`src/ps/uxpLayers.ts`（PROPS、rawOf、actionDescs、run 里的特殊分支、setVisible、thumbnails）、`src/ps/host.ts`、`src/ui/layerTree.ts`、`src/preview/main.preview.ts`。

**这一批没做的：**
- 双击调整图层或蒙版打开「属性」面板：PS 没有公开命令，只能靠菜单 ID，而这个菜单项是开关，面板已经开着时会把它关掉。没做，要先和用户确认。
- 11-03 补上了：智能滤镜子行的悬停提示加了「双击：重新打开设置」；链接图标 `.lt-mlink` 的 CSS（宽 12 px，嵌进缩略图的右边距，取消链接时留空但仍可单击）；Alt+单击看蒙版时，那个蒙版缩略图加 `.viewing` 高亮框。矢量蒙版缩略图同时带 `.lt-mask` 类，样式沿用图层蒙版的。

---

### 3.4 11-03 按用户测试反馈做的（已打包，**没在 PS 里试过**；浏览器预览已逐项点过）

用户对 3.3 的测试结果：Alt 看蒙版正常；智能滤镜双击正常（日志里 -128 是在对话框里点了取消）；矢量蒙版添加失败（`make` 报「建立 当前不可用」，没测到后面）；其余见下表。

| 反馈 | 做法 |
|---|---|
| 图层颜色、画板颜色改成色板，加自定义颜色 | `popupMenu` 新增 `{ swatches }` 项（`.pm-swatch`）。第一排：无颜色 + PS 的 7 个标签（`setColor`，存进 PSD）；第二排：最近用过的自定义颜色（最多 8 个）；再下面「自定义颜色…」打开 PS 拾色器（`LayerTree.pickColor` → batchPlay `showColorPicker`，第一次记日志 `color picker`）。**自定义颜色只存在插件里**：localStorage `wp.layers.custom`，按文档（`read()` 新增的 `docKey` = 文件路径，未保存时是标题）和图层 id；最近颜色 `wp.layers.recent`。选 PS 标签会清掉这个图层的自定义颜色。眼睛底色和画板框都优先用自定义颜色 |
| 拖得快时漏掉几个；锁定也要能拖 | `eyeDrag` 换成 `paint`（`col`: eye / position / pixels）。鼠标经过任何一行（不再只是眼睛）就把上次那行到这行之间的所有行补上（`paintTo`/`paintRow`）。可移动、可编辑改成按下即切换并可拖动，松开后一次 `setLock`。从组开始拖只切换组（组的开关是锁定全部），从普通图层开始拖只切换普通图层 |
| 空图层也要有缩略图 | `hasPicture`（显示）和 `hasThumb`（要读像素，尺寸 > 0）分开：空图层画空白棋盘格 |
| 单击切换编辑蒙版 / 回到图层，蒙版要能删 | `focus`（`TargetPart`: layer / mask / vmask / filterMask）。单击蒙版 → `targetMask`；单击图层缩略图 → `targetLayer`（选复合通道，`compositeOf`）。选中一个带蒙版的图层时，当前编辑的那个缩略图加白框（`.lt-thumb.target`）。底部垃圾桶在蒙版被选中时删蒙版（`deleteSelected`）；右键菜单「删除图层」仍删图层。PS 自己面板里的切换通过 `onTarget`（`select` 通知里的 channel / path）同步 |
| 智能滤镜蒙版不能选 | 多读 `hasFilterMask`（PROPS）。「智能滤镜」那一行的白色缩略图单击 → `targetFilterMask`（`select channel filterMask`），有白框；选中时垃圾桶删它（`deleteFilterMask`）。没有缩略图，只是白块 |
| 矢量蒙版建不出来 | `addVectorMask` 改成特殊分支：依次试 3 种引用写法，成功时记 `vector mask made with form N`；全失败记 `vector mask make failed`，带图层类型、锁定、是否已有蒙版。**每次失败 PS 可能各弹一次错误框** |

没做：Delete 键删除（面板里没有可靠的焦点，两个面板共用一个 document，按键可能误删）；智能滤镜蒙版的真实缩略图（`getLayerMask` 只有 user / vector）。

### 3.5 11-03 第二轮反馈（已打包，**没在 PS 里试过**；浏览器预览已点过）

| 反馈 | 原因 / 做法 |
|---|---|
| 自定义颜色没效果 | 日志：拾色器的 `color` 是 **HSBColorClass**，RGB 在 `RGBFloatColor`（0–255 浮点）。改为优先读 `RGBFloatColor`，`value: false` 视为取消 |
| 拖过去再拖回来要能还原；拖完底色错乱 | 拖动改成「范围」：从按下的那行到鼠标所在的那行全部切换，范围外碰过的行恢复原状（`paint.orig`，`paintTo`）。松开时只发真正变了的。底色错乱是 UXP 拖动后 `:hover` 卡在行上：行的悬停改成 JS 加的 `.hover` 类（`hoverEl`），CSS 里 `.lt-row:hover` 全部换成 `.hover` |
| 选中图层时缩略图变样；要绿框不要变尺寸 | **类名冲突**：主面板已有全局 `.target`（padding、圆角、`max-width: 66%`），改名 `lt-target`。所有缩略图改成 `box-sizing: border-box` + 2 px 边框，选中只换边框颜色（`--accent-hi`），尺寸不变。每个选中的图层都标出当前编辑的部分（图层 / 蒙版 / 矢量蒙版 / 智能滤镜蒙版） |
| 选中 AI 图层时新建图层会进到它的组里 | `LayerTree.run` 加 `opts.above`：UI 在选中变体图层（`isVariantLayer`）时传入；PS 端建好后在同一步里 `move(group, PLACEBEFORE)` 移到组上方。用于新建图层、新建组、调整图层 |
| Delete 删除 | 面板最后一次被点击时（`panelActive`，捕获阶段的 mousedown 判断是否在本面板内）按 Delete / Backspace = 垃圾桶（蒙版选中时删蒙版）。输入框和重命名时不触发。**UXP 面板能否收到按键没验证** |
| 矢量蒙版仍建不出 | 日志：普通像素图层、无锁定，3 种 `make` 写法都失败。改为先按标题找菜单「图层 › 矢量蒙版 › 显示全部」（`vectorMaskMenu`：「显示全部」里离「当前路径」最近的那个，日志 `vector mask menu ids`），用 `performMenuCommand` 执行并读回 `hasVectorMask`；不行再试 `make` |
| 原版逻辑：蒙版按钮第一次加图层蒙版，再点加矢量蒙版 | 底部蒙版按钮：单个图层已有图层蒙版 → `addVectorMask`；两个都有 → 提示 |
| 每个蒙版都有链接按钮，链接没居中 | 缩略图 ⛓ 图层蒙版 ⛓ 矢量蒙版，各自的链（`userMaskLinked` / `vectorMaskLinked`）。`.lt-mlink` 宽 18、左边距 -6，正好填满两个缩略图之间的空隙 |
| 智能滤镜蒙版有时选不中 | 没找到原因。每次 target* 后读回 PS 当前的目标通道，日志 `target part`，下次看证据 |
| 缩略图按画板 / 画布比例 | multiGet 多读 `artboard`（取 `artboardRect`，`TreeLayer.board`）。缩略图（含蒙版）读的范围改成图层所在画板，不在画板里就是整个画布（`areaOf`）；`frameThumb(..., shaped=true)` 输出该范围的形状；框的宽度 = 行高 × 比例，限制在 0.5–2 倍（`thumbW`）。**注意**：以前的缩略图是按图层自身范围读的（内容填满）；现在小图层会显得小，和 PS 一样 |

### 3.6 11-03 第三轮反馈（已打包，没在 PS 里试过）

- 用户确认：智能滤镜蒙版现在能选中（日志 `target part` 读回「图层 1 滤镜蒙版」）。选中矢量蒙版时读回的是 RGB，这是正常的：矢量蒙版是路径，不是通道。
- **形状图层多出一个不存在的蒙版**：形状图层（layerKind 4）的形状本身就存成矢量蒙版（`hasVectorMask` 为真），PS 的图层面板不把它显示成蒙版。`buildTree` 里形状图层的 `vmask` 一律为假（组和其他图层照旧）；右键菜单「添加矢量蒙版」对形状图层不可用；蒙版按钮在形状图层已有图层蒙版时给出提示。
- **智能滤镜蒙版的点击和图层蒙版一致**：Ctrl+单击载入选区（+Shift 添加、+Alt 减去，`loadSelection` 的 `mask: "filter"` → 通道 `filterMask`）；Alt+单击只看蒙版、Alt+Shift 红色叠加，再按恢复（`viewMask` 的参数加 `:filter`）。Shift+单击停用**没做**：没找到它的属性名（日志里只有 `hasFilterMask`、`filterMaskDensity`、`filterMaskFeather`）。
- **主面板按钮有时点不动、光标变成抓手**：代码里没找到直接原因，没有日志证据。推测是面板里选中了文字，再点到选中的文字上时 UXP 会开始拖动。已在 `body` 上关掉文字选择（输入框和诊断输出除外）。**没确认是否解决**，需要用户复现时提供的细节。
- 第四轮（11-03）：
  - 用户：Ctrl+单击载入选区不正常（没说是哪种缩略图）。日志里只有更早的 3 次「无法执行 set」，没有细节。`loadSelection` 改成特殊分支：先按图层 id 执行；失败时记 `load selection by id`（发出的描述符和错误），临时选中该图层改用 targetEnum 再试，结果记 `load selection as target`，最后恢复原来的选中。每次都记 `load selection`（参数和执行后的选区范围）。**下次先看这几条日志**。
  - 用户：按钮点不动的问题无法复现，但双击左键可以恢复正常。这和「点到选中的文字上会开始拖动」的推测吻合（双击会重新选择，状态复位）；关掉文字选择的改动保留。
- 第五轮（11-03）：
  - **不能把图层拖进 AI 图层**（进去后 AI 图层会变成普通组）：`dropZone` 对变体图层只分上 / 下两半；`dropPlan` 拒绝放进变体图层，也拒绝放到它的变体旁边（有测试）。
  - **形状图层 Ctrl+单击**：用户建议单击形状图层时选中它的矢量蒙版。没有照做：PS 选中形状图层时本来就会显示它的路径，而且「选中蒙版时垃圾桶删蒙版」会把形状删掉。改为 Ctrl+单击形状图层缩略图时载入它的形状（矢量蒙版路径），和 PS 一致。
  - **主面板提示词粘贴后修改时光标错位**：`renderFlows()` 在连接状态、工作流同步时都会运行，每次都重新给 `prompt.value` 赋值，光标就跳到末尾。现在只有内容不同时才赋值（`src/ui/app.ts`）。

## 4. 缩略图（已解决，不要破坏）

- 故障：「招聘内的招聘.psd」里有一个细长形状「形状 3」。旧方案按图层原尺寸读，生成了几千 px 长的图片，UXP 画不了，整个列表就停止绘制。
- 现在的做法：
  - 按图层自己的范围读，`thumbArea` 把短边补到长宽比最多 4:1；
  - 读取**一定**带 `targetSize`（按长边缩小）；
  - `frameThumb` 再画进 ≤`size` px 的正方形：内容等比居中，透明处和四周是棋盘格，超出范围的部分不画；
  - 蒙版按整张画布读。
- **坑**：带 `targetSize` 时，返回的 `sourceBounds` 用的是缩小后那一层（`r.level`，即 1/2^level）的坐标，而且只框住图层实际有像素的部分。必须乘以 `2 ** level` 换算回文档坐标，否则内容会跑到框外。日志 `layer thumbnail bounds` 每次加载记前 6 张。
- 两条底线：**输出图片一定很小**；**读取一定带 `targetSize`，长宽比一定有上限**。

---

## 5. 悬停定位（有严重 bug，待重做，用户要求先放一放）

- 现在的实现（另一个会话写的）：鼠标在一行上停 60 ms，就在 PS 里临时选中这个图层，让画布上显示变换框；离开时再选回原来的图层。
- 用户报告：工具不是移动工具时会变成「选择各类图层」；划得快时 PS 会卡死。
- 原因：每次悬停都排进一条选择命令（`peekQueue` 链式排队），PS 跟不上时队列越积越长；恢复选中时选了几个图层就发几条命令；也不判断当前工具。
- 11-03 按用户要求改成**默认关闭**：localStorage 键 `wp.layers.peek` 为 `on` 才开。
- 给用户提过的方案，**用户还没选**：
  1. 面板里的画布小地图：用已经读到的图层范围和画布尺寸画出图层位置，**一条 PS 命令都不发**（推荐）；
  2. 按住 Alt 才触发，只在移动工具下生效，同一时间只有一条命令，PS 忙就放弃；
  3. 去掉悬停，改成「定位到画布」按钮。

---

## 6. UXP / PS 踩过的坑

- **UXP 不画 box-shadow**，要用真正的 border 或叠加层（画板框第一版就栽在这里）。
- `title` 不显示，用自绘的悬停提示；`getBoundingClientRect` 和鼠标坐标对不上（拖动时改用透明感应层的 `offsetY`）；CSS 属性选择器不可靠；`<button>` 被渲染成原生控件（`h()` 换成了 div）。
- 原生滚动区域、细长图片都可能让 UXP 停止绘制整个面板。所以列表是一个固定大小的框，只放得下的行，自绘滚动条。
- PS 不会把插件自己 batchPlay 的操作通知给插件，靠 `onModalDone` 补上。
- `applyLocking` 按 id 指定会被静默忽略，必须先选中图层；智能滤镜、效果的开关也要用当前选中图层的引用。
- `select menuItemClass blendingOptions` 不可用，图层样式对话框改用 `set layerEffects` 并显示对话框；要打开某个效果的那一页，用 `styleMenu()` 按菜单标题查命令 ID。
- 读缩略图时会临时报「不能使用移动工具」「无法更新智能对象文件」，这是 PS 正忙，重试就好。
- 选中图层、显示 / 隐藏，PS 都会发通知，进而触发列表重读；面板自己选中的时候要防止读到旧状态（见 3.2 的闪烁修复）。
- 往 PS 发命令要**限量、合并、不排长队**：悬停定位就是反例。

---

## 7. 尚未在 PS 里确认的旧功能

- 智能滤镜拖动：PS 没有公开写法，代码会逐个尝试编号，每次尝试是一步可回滚的历史记录，用 `filterID` 核对结果。日志 `smart filter move`。
- 智能滤镜显示 / 隐藏会读回来自动校准编号方向（`filtersReversed`）。「智能滤镜」那一行的总开关读不到 PS 的真实状态：只要还有显示中的滤镜，就全部隐藏，否则全部显示。
- 单个效果的显示 / 隐藏用 `show/hide [效果(_index), layerEffects, layer]`，执行后读回核对；新写法还没确认。
- 链接图层读的是 multiGet 的 `linkedLayerIDs`，执行链接时日志记 `layer link keys`。

---

## 8. 和 PS 原版图层面板相比还缺的（用户要求列出；除第 3.3 节外都还没做）

- **快捷键**：Ctrl+J、Ctrl+G、Ctrl+E、Delete、Ctrl+[ ]、Ctrl+Shift+[ ]、Alt+[ ]。现在列表里只有 Esc。
- **筛选**：按效果、混合模式、属性（可见、锁定、空图层、有蒙版、剪贴…）、颜色标签、已选中、画板筛选，以及筛选总开关。
- **锁定**：第 5 个「防止在画板内外自动嵌套」。
- **右键菜单**：
  - 智能对象：通过拷贝新建智能对象、替换内容、导出内容、重新链接、转换为链接 / 嵌入；
  - 画板 / 框架：从图层新建画板、新建框架；
  - 合并：合并可见图层、拼合图像；
  - 其他：栅格化图层样式、选择链接图层、选择相似图层、隔离图层、快速导出、复制 CSS / SVG。
- **面板菜单（☰）**：面板选项（缩略图显示图层范围还是整个文档等）、删除隐藏图层、锁定组内所有图层、新建图层对话框。
- **属性面板联动**：双击调整图层或蒙版打开「属性」（见 3.3）。
- **不打算做**：3D、视频、动画图层，图层复合。
