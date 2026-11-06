# undermind-mcp-client

Undermind.ai 的 MCP server（`https://mcp.undermind.ai/mcp`）只支持用户级 OAuth：
没有 API key、没有 service account、也不支持动态注册（DCR）。这个仓库做两件事：

1. **托管 Client ID Metadata Document**（`client-metadata.json`），让 Undermind 的授权
   服务器能把 DSH 当作一个合法 OAuth 客户端——`client_id` 就是这个文件的 HTTPS 地址。
2. 提供两个小脚本：`src/login.mjs` 做一次性授权，`src/bridge.mjs` 把 stdio 上的 MCP
   流量中继到 Undermind，并自动注入 / 刷新 bearer token。

DSH 侧不需要写新插件：`@deepseek-ai/dsh-mcp-client` 已经能跑 stdio MCP server，
把 bridge 作为 `command` 配上即可。

## 一次性授权

```powershell
node src/login.mjs
```

浏览器里登录 Undermind 并同意授权，token 会写进 `.state/tokens.json`（已 gitignore，
权限 0600）。access token 1 小时过期，refresh token 会自动轮换，正常情况下不用再登录；
90 天不刷新才会失效。

## 接到 DSH

在 desktop profile 的 `cordis.patch.yml` 里加一条（路径换成这台机器上的实际路径）：

```yaml
- id: mcp-undermind
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: undermind
    transport: stdio
    command: 'C:\小玩意\Deepseek harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    args: ['C:\Users\16672\Documents\deepseek-harness\default-workspace\undermind-dsh\src\bridge.mjs']
    toolCallTimeoutMs: 240000
```

重启 DSH 后，工具会以 `mcp__undermind__*` 出现在工具列表里。

## 测试

```powershell
node --test --test-isolation=none tests/relay.test.mjs
```

测试用本地 mock 的 MCP server 和授权服务器，覆盖 initialize / tools/list / tools/call、
401 后刷新重试、以及未登录时的报错。

## 注意

- 回调端口固定为 `53682`，因为 `client-metadata.json` 里登记的 `redirect_uris`
  必须和实际请求完全一致。改端口要同时改这个文件并重新发布（GitHub Pages 生效有延迟）。
- 这是个人用的桥，不是通用产品；token 谁拿到谁就能以你的身份用 Undermind。
