# UXP 覆盖页与原生编辑控件叠层
Photoshop 27.10.0 / Studio 0.1.2：连接页诊断结果被主面板提示词 textarea 遮挡。用户截图 reports/shots/A4_012_user_20261031_5.png 为实机证据。

复现：打开连接设置 → 诊断；原生提示词输入框绘制在 z-index:10 的 sheet 上面。HTML 浏览器不复现此宿主合成限制，因此不添加仅在浏览器证明 z-index 有效的伪回归测试。

最小处理：mountSheet 在覆盖页存在时给根元素加 sheet-open；CSS visibility:hidden 隐藏被覆盖的工作区但保留其布局空间。关闭最后一个 sheet 时恢复。设置、导入菜单、工作流选择、校准页共用同样处理；正常主界面布局和数据不变。

实机复测：设置/诊断内容不再被提示词遮挡；关闭或成功连接自动关闭后提示词恢复，内容保留；导入菜单和校准页也无底层编辑框穿透；取消后恢复主面板。

官方依据：https://developer.adobe.com/photoshop/uxp/2021/uxp/known-issues/ （User Interface：编辑控件不遵守普通叠层，可通过隐藏被覆盖控件避免）。
状态：修复已实现，等待重装实测，不把截图前的观察当作修复后通过。
