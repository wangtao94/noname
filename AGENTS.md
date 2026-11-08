# AGENTS.md

写给在本仓库工作的 AI 编码助手（Codex、Claude Code 等）和新贡献者。先读这一页，再动代码。

## 这是什么

[libnoname/noname](https://github.com/libnoname/noname)（无名杀）的 Fork。本 Fork 把联机改成**服务端权威**：每局游戏在服务端的一个 Worker 线程里，用原版引擎无头运行；浏览器只负责显示和操作。设计与实测数据见 `docs/architecture/server-authoritative.md`，部署见 `docs/deploy.md`。

## 目录与职责

| 路径 | 职责 | 改动原则 |
|---|---|---|
| `apps/core` | 游戏本体：引擎（`noname/`）、武将（`character/`）、卡牌（`card/`）、模式（`mode/`）、配置（`game/config.json`） | **与上游同步，尽量不改**。本 Fork 的改动只有 `noname/init/server-room.js`、`noname/init/index.ts` 和 `mode/connect.js` 中几行接入点，以及 `game/config.json` 的一处数据修正。服务端需要的行为差异放到 `packages/engine-host` 里覆盖，不要改引擎 |
| `packages/engine-host` | `runtime/`：在 Node 中加载引擎（loader hooks、happy-dom 浏览器接口补丁、服务端 preload）。`host/`：对局 Worker 与主机覆盖。`plugins/`：服务端插件。`testing/`：无头整局脚本 | 引擎在服务端的所有适配都放在这里 |
| `packages/game-server` | Fastify 服务端：`rooms/`（房间、对局、Worker 池、续传 `Link`）、`gateway/`（`/ws` 控制面、`/ws/game` 游戏面）、`static/`（缓存）、`fs-api.ts`、`web/`（大厅页面，原生 JS，无构建） | |
| `packages/jit` | 根作用域 Service Worker：开发期 TS 即时编译 + 资源缓存 | 全站只能有这一个 SW，缓存逻辑也加在这里 |
| `scripts/` | 根构建：合并产物、资源清单（`build-asset-manifest.ts`）、预压缩（`precompress.ts`） | |

## 常用命令

环境：Node 24、pnpm 10（`corepack enable`）。各 workspace 包有**各自的** `pnpm-lock.yaml`（`sharedWorkspaceLockfile: false`）。

```sh
pnpm install
pnpm dev                                   # 单机开发服务器
pnpm build                                 # 构建网页客户端到 /dist（约 1 分钟）
pnpm -F @noname/game-server start          # 启动服务端 :8080（需要先 build）
pnpm -F @noname/game-server test           # 服务端单测
pnpm -F @noname/engine-host test           # 引擎/插件单测
pnpm --filter "...[main]" --filter "!./" run --if-present lint            # 与 CI 相同的 ESLint
pnpm --filter "...[main]" --filter "!./" run --if-present lint:prettier   # 与 CI 相同的 Prettier
```

无头整局与浏览器端到端测试：

```sh
cd packages/engine-host
node --import ./src/runtime/register.js ./src/p0.js                  # 8 人 AI 局（单机模式）
node --import ./src/runtime/register.js ./src/testing/plugin-game.js # 服务端主机 + 插件，校验牌数守恒
node --import ./src/runtime/register.js ./src/testing/extension-game.js

cd packages/game-server                                               # 先在根目录 pnpm build
E2E_DROP=1 E2E_KILL_OWNER=1 E2E_RESTART=1 E2E_SPEED=vvfast node test/e2e/browser-game.mjs
```

浏览器测试用 `playwright-core`，需要先安装 Chromium：`npx playwright-core install chromium-headless-shell`。一局真实对局要 1–3 分钟；判定通过的标准是**每个浏览器客户端自己的引擎**都进入结束状态，不只是服务端结束。

## 改动时必须知道的事

**引擎在服务端怎么跑**

- 引擎依赖 DOM：`Player`/`Card` 继承 `HTMLDivElement`，牌堆存在 DOM 里。服务端用 happy-dom 补齐。新增的浏览器 API 缺口在 `runtime/shims.js` 补，不要改引擎。
- happy-dom 的 `Symbol.toStringTag` 与浏览器不同，已在 shims 里修正。引擎用 `get.objtype()` 判断元素类型，这个修正不能去掉。
- 一个线程只能跑一个引擎实例（全局单例：`lib/game/ui/get/ai/_status`）。并发靠 `worker_threads`；"再来一局"就是换一个新 Worker，不要尝试在同一个实例里重置状态。

**联机协议**

- 服务端走引擎原有的"中继主机"路径，主线程扮演中继服务器（见 `host/worker.js` 顶部的消息约定）。
- 引擎的 `game.me` 在服务端也是普通座位：绑定一个远程客户端，并设置 `game.notMe = true`、`_status.auto = true`，使 `isMine()` 恒为假。写新的联机流程时，先判断 `player.isOnline()`，绝不能走本机 UI 分支。
- 主机通过 `game.broadcast` / `player.send(fn, ...args)` 把**函数源码**发给客户端执行。这些函数不能引用外层作用域的变量，所需数据必须作为参数传入。
- 房间配置 `lib.configOL` 来自各模式 `lib.mode[mode].connect` 的选项（去掉 `connect_` 前缀）。大厅设置界面由引擎上报的目录自动生成，插件选项也走这条路（`connect_plugin_<id>_<key>`）。
- 游戏面帧格式 `"<seq>\n<payload>"`，控制帧以 `\u0006` 开头。改协议时客户端 `server-room.js` 的 `ResumableSocket` 和服务端 `rooms/link.ts` 要一起改。

**客户端**

- 对局页是 `/index.html?sa-room=…&sa-uid=…&sa-token=…&sa-game=…`，嵌在大厅的 iframe 里。`sa-defer=1` 表示预加载、等待对局 ID。这种模式下只在内存里覆盖本地配置，**不能保存**到玩家的单机设置。
- 首次使用的阻塞弹窗（如 GPL 确认）会卡住嵌入的对局页，类似确认要放到大厅里做。

**服务端插件**

- 在 `packages/engine-host/src/plugins/` 用 `definePlugin` 定义，只在服务端引擎实例上包装或覆盖，不修改 `apps/core`。必须有单元测试，并补一个无头整局校验（参考 `testing/plugin-game.js`）。

## 约定

- **提交信息**：中文，Conventional Commits 风格，如 `feat(game-server): 新增房间转让`、`fix(engine-host): …`。与上游风格一致。
- **格式**：仓库根目录的 Prettier 配置（tab 缩进），提交前跑上面的 lint 命令。
- **测试**：改服务端或引擎适配，至少跑对应包的单测和一个无头整局；改联机流程、大厅或客户端接入，跑一次浏览器端到端测试。
- **不要**：
  - 为服务端需求修改 `apps/core` 的武将、卡牌或模式代码；
  - 在仓库根目录以外的地方写构建产物；
  - 提交 `dist/`、`.data/`、堆快照；
  - 在测试里调大超时来掩盖卡住的对局。

## 与上游同步

```sh
git remote add upstream https://github.com/libnoname/noname.git   # 一次性
git fetch upstream && git merge upstream/main
```

合并后，跑一次浏览器端到端测试和 `plugin-game.js`。上游如果新增了"只在构建开始菜单时才写入"的配置或联机选项，服务端可能缺默认值。参考 `host/overrides.js` 中 `ensureCommonConnectOptions` 的处理方式补齐。
