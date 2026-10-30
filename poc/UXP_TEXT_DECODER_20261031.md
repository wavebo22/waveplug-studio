# UXP XHR 解码最小复现

Photoshop 27.10.0、Studio 0.1.2：连接设置点诊断，两次均为 fetch HTTP 200 / XHR ReferenceError: TextDecoder is not defined / WebSocket 已连接。见 reports/uxp_012_20261031_5.log。

UXP 控制台等价最小探针（新写法尚待重装实测）：

```js
console.log(typeof TextDecoder, typeof Response);
const bytes = new Uint8Array([0xE4, 0xB8, 0xAD]);
// 0.1.2 实际依赖的调用：new TextDecoder().decode(bytes)
console.log(await new Response(bytes.buffer).text()); // 预期：中
```

修复只将 XHR 响应的 text/json 解析交给 UXP Response；arrayBuffer 仍返回原字节。无服务端改动。

回归：`node --test tests/uxp_net.test.ts`，模拟缺失 TextDecoder，通过真实 diagnose、uxpFetch、ComfyClient 路径；修复前 XHR 诊断断言失败。覆盖中文及 emoji JSON、fetch 失败后的 XHR 读取和 PNG 非 UTF-8 原始字节。

官方依据：[Network Operations](https://developer.adobe.com/uxp/guides/how-to/recipes/network/) 明确 TextDecoder 不可用；[Response](https://developer.adobe.com/photoshop/uxp/2022/uxp-api/reference-js/global-members/data-transfers/response) 支持 ArrayBuffer 构造及 text/json。
