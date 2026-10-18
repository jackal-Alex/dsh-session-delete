# dsh-session-delete

在 DSH 侧边栏删除会话 —— 先移入可恢复的回收站，或彻底清除。

> Delete DSH sessions from the Session row's "…" menu: move to a restorable
> trash can, or purge. DSH itself ships no delete action, and its session
> storage seam has no delete API by design, so this plugin moves the session
> directory out of `$DSH_HOME/sessions` and keeps a `meta.json` so it can be
> put back.

## 为什么需要它

DSH 的会话行菜单里有 **置顶、重命名、分叉、归档**，没有删除；会话日志在 `$DSH_HOME/sessions/` 下一直累积，只能手工清。协议里虽然有 `session/delete`，但它只对外部 ACP agent 生效，宿主自己的存储层明确写着「不删除会话文件 —— 直到外部移除」。

所以删除只能落在文件系统上。本插件只做这一件事，并且把它做成**可逆**的。

## 功能

| 菜单项 | 行为 |
|---|---|
| **删除会话** | 把 `sessions/<工作区>/session-<id>/` 整体移进 `$DSH_HOME/session-trash/<时间戳>/`，附 `meta.json` 记录原工作区与目录名 |
| **彻底删除会话** | 同上移入，然后立刻从回收站清除。红色危险样式，二次确认 |

- **正在使用的会话删不掉**：Windows 上目录里有被占用的日志文件时 `rename` 会失败，插件把它报成「该会话正在被使用，先切到别的会话再删除」——不会半删一半
- **删完自动刷新**页面，侧边栏不再显示该行
- 菜单项的字号、行高、内边距、悬停与危险色**对齐 DSH 自带的菜单单元格**（13px / 20px / 34px / 6px 8px）

## 安装

```sh
# 从 npm（发布后）
dsh plugin --profile desktop add dsh-session-delete

# 从 GitHub（需要本机有 git）
dsh plugin --profile desktop add github:jackal-Alex/dsh-session-delete

# 本地开发（软链，改完硬刷新即可）
dsh plugin --profile desktop add link:/path/to/dsh-session-delete
```

装完**重启 DSH**（bundle 层在启动时装配），再按 **Ctrl+Shift+R** 硬刷新页面加载客户端半边。

## 用法

1. 鼠标移到任意会话行，点右侧的「…」
2. 选 **删除会话**，确认
3. 会话从列表消失；文件在 `~/.dsh/session-trash/` 里

恢复（接口已就绪，暂无 UI）：

```sh
curl -X POST http://127.0.0.1:19387/api/session-delete/restore \
  -H "content-type: application/json" -H "x-dsh-session-delete: 1" \
  -d '{"trashId":"<回收站目录名>"}'
```

## 宿主接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/session-delete/list` | 列出磁盘上的会话（工作区、id、大小、时间） |
| GET | `/api/session-delete/trash` | 列出回收站条目 |
| POST | `/api/session-delete/delete` | `{sessionId, mode?}` —— `mode: "purge"` 移入后立刻清除 |
| POST | `/api/session-delete/restore` | `{trashId}` —— 放回原位置 |
| POST | `/api/session-delete/purge` | `{trashId}` —— 彻底删除，不可恢复 |

所有写请求必须带 `x-dsh-session-delete: 1`：跨站页面无法在不触发 CORS 预检的情况下带自定义头，而这些路由不发放 CORS。

## 兼容性

**不声明任何 `@deepseek-ai/*` 的 `peerDependencies`。** DSH 0.2+ 的版本闸门会把 peer 对不上的插件**整包跳过**（现象是「装上了，重启后什么也没发生」，且不报错）；客户端半边只用 `ctx.slots`，宿主半边只用 `ctx.webServer`，都不静态依赖某个宿主包的具体版本。

在 **DSH 0.2.0-rc.2**（Windows 桌面版）上实测可用。

## 测试

不需要构建、不需要 DSH 运行时，纯 Node 即可：

```sh
npm run check   # node --check 三个入口
npm test        # 三个测试文件
```

- `tests/host.test.mjs` —— 文件层：list → trash → restore → trash → purge，含路径穿越拒绝
- `tests/routes.test.mjs` —— 用假 cordis context 驱动五条路由，覆盖 405 / 403 / 404 / 400
- `tests/client.test.mjs` —— 替身 `__ModuleLoader__` + 假 `require` + 假 DOM，验证装配、两个菜单项的 order 与注入面、以及**菜单单元格的度量**（防字体回退）

## 已知限制

- 删除后靠 `location.reload()` 刷新列表
- 没有批量删除、没有回收站的 UI 列表（接口 `trash` / `restore` / `purge` 已就绪）
- 只处理 `sessions/<工作区>/session-<id>/` 这种目录布局；平铺或压缩的单文件布局不在本版范围
- 彻底删除不做 shred（不是安全擦除）

## 开发

插件是**手写、无构建**的：宿主半边是普通 ESM，客户端半边是 `window.__ModuleLoader__.load({ id, factory })` 的 self-contained bundle。改 `lib/*.js` 后重跑 `npm test`，硬刷新页面即可看到客户端改动。

## 许可

MIT
