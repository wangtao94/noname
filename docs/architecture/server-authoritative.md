# 服务端权威联机架构（server-authoritative）

状态：P0–P5 已实现并通过验证（见第 8 节）；D5 服务端扩展进行中 · 分支 `feat/server-authoritative`

## 1. 背景与问题

| 现状 | 位置 | 影响 |
|---|---|---|
| 游戏计算在房主客户端，服务端只转发 | `packages/server`、`lib.message` | 房主掉线整局结束；重连差 |
| 武将技能约 49 万行，直接依赖引擎 API | `apps/core/character` | 不能重写引擎，否则丢失全部内容 |
| `Player`/`Card` 继承 `HTMLDivElement`，牌堆存在 DOM（`ui.cardPile.children`） | `library/element/*.js` | 引擎离不开 DOM |
| 主机通过 `game.broadcast` 把函数源码发给客户端执行 | `game/index.js` `broadcast` | 任意房主可在他人浏览器执行代码 |
| 全局可变状态（`lib/game/_status/ui`） | 全局 | 再来一局必须刷新 |

## 2. 已定决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 引擎策略 | 复用现有引擎，在服务端 Worker 中无头运行，作为不占座位的虚拟主机 |
| D2 | 客户端形态 | Shell（常驻，持有 WebSocket）+ iframe 对局（现有 UI，客户端模式）；换局换 iframe，结算期间预加载 |
| D3 | 内置插件 | 开局**手牌** N 组选 1，各身份可配 N |
| D4 | 身份 | 匿名设备 token（localStorage），无需注册 |
| D5 | 扩展 | 管理员放在服务端 `/data/extensions`，开房勾选；客户端联机仅保留 UI 类扩展 |
| D6 | 再来一局 | 房主点击直接开始；未离开者继续；掉线者托管 |
| D7 | 离场 | 结算时任何人可离开；空位房主等人补位或开局时由 AI 补 |
| D8 | 交付范围 | P0–P5；P6 交付时附评估，另行立项 |

## 3. 总体架构

```
┌──────────── 浏览器 ────────────┐          ┌──────────────── 服务端 (Node) ───────────────┐
│ Shell (常驻，不刷新)            │   WS     │  Gateway: HTTP静态 + /ws + /healthz           │
│  ├ 大厅 / 房间 / 设置 UI        │◄────────►│  ├ Session: token→用户, 断线宽限, 消息重放     │
│  ├ 唯一的 WebSocket + 重连      │  /ws     │  ├ RoomManager: 房间/座位/房主/权限/生命周期   │
│  └ GameFrame <iframe>           │          │  └ 每局一个 Worker ─────────────────────┐     │
│      现有 noname 引擎(客户端模式)│ postMsg  │      noname 引擎(无头, DOM shim)         │     │
│      只负责渲染+操作            │          │      虚拟主机 + 内置插件 + 服务端扩展    │     │
└────────────────────────────────┘          └──────────────────────────────────────────┘
```

### 3.1 服务端
- 主线程：Gateway / Session / RoomManager。状态仅在内存。
- Game Worker：每局一个 `worker_threads`，加载引擎 + DOM shim，`lib.node.clients` 替换为虚拟客户端，经主线程转发到座位。
- 再来一局 = 销毁 Worker 并启用预热 Worker（彻底清除全局状态）。
- Worker 设 `resourceLimits`；预热池大小按内存自动计算。

### 3.2 房间
- 6 位短码；座位绑定用户 token（不绑 socket）。
- 房主权限：改配置、踢人、开始、再来一局、换座、转让。大厅阶段房主离线超过宽限则自动迁移；对局中不影响。
- 空房 TTL 后销毁。

### 3.3 重连
- 每连接下行消息带 `seq`，服务端保留环形缓冲。重连带 `lastSeq`：在缓冲内补发；否则全量快照（复用 `reinit`：`get.arenaState()` + `game.getState()`）并重发当前待处理请求。
- 断线期间托管，重连自动解除。版本不一致时 Shell 提示并刷新。

### 3.4 协议
- `packages/protocol`：共享类型 + 运行时校验。
- 控制面：`hello{token,lastSeq}`、`room.*`、`seat.*`、`chat`。
- 游戏面：现有引擎消息透传 `{t:"g", seq, data}`；按座位过滤隐藏信息（视 P0 结果）。

### 3.5 插件
运行于 Game Worker：`definePlugin({ id, configSchema, defaults(ctx), setup(engine, config) })`，房间设置界面按 schema 生成。

**开局手牌 N 组选 1**：每组张数 = 正常起手数；未选中的牌洗回牌堆。默认 N：基础 2，内奸 +1；约束 `Σ N×起手数 ≤ 牌堆 60%`，超出时从 N 最大的身份起递减。选择超时 15 秒默认第 1 组；AI 选评估值最高的一组。

## 4. 部署

单镜像、单端口。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP + WS |
| `NONAME_SERVE_WEB` | `true` | `false` 时只跑游戏服务 |
| `NONAME_DATA_DIR` | `/data` | 扩展、日志 |
| `NONAME_RECONNECT_GRACE` | `60s` | 断线宽限 |
| `NONAME_ROOM_IDLE_TTL` | `10m` | 空房回收 |
| `NONAME_MAX_ROOMS` | `0`（自动） | 并发对局上限 |
| `NONAME_TRUST_PROXY` | `false` | 反代后取真实 IP |
| `NONAME_LOG_LEVEL` | `info` | |

缓存：`index.html`/`sw.js`/清单 `no-cache`；带 hash 的打包产物 `immutable` 1 年；音频图片由 Service Worker + 资源清单（路径→hash）按 hash 缓存，无 SW 回退 `ETag + no-cache`；文本预压缩 br/gzip。

CI：PR/推送跑 lint、测试、镜像构建；main 出 `:edge`；tag 出版本号与 `:latest`；amd64 + arm64；GHCR。

## 5. 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | Node Worker 无头跑 8 人 AI 身份局 | 打完一局；内存/CPU/加载耗时；DOM 兼容问题清单；隐藏信息泄露核查 |
| P1 | 新服务端 + 协议 + Shell + 虚拟主机 | 3 个浏览器打完一局，房主不占座位 |
| P2 | 重连 + 房主迁移 | 杀掉任意浏览器（含房主）后重开可接续 |
| P3 | 换局不刷新 | 连续 3 局无刷新 |
| P4 | 插件框架 + 开局手牌 N 选 1 | 配置界面自动生成；默认值算法有单测 |
| P5 | 镜像、compose、CI、缓存 | 二次访问近零流量；发版后可更新 |
| P6 | 具名消息替换函数广播；状态脱离 DOM | 另行立项 |

## 6. P0 结果（2026-11-08，结论：通过）

原型代码：`packages/engine-host/src`（`p0.js` 单局、`p0-multi.js` 多 Worker 并发）。运行：`node --import ./src/register.js ./src/p0.js`。

### 6.1 数据（WSL2，16 核，Node 24，开发态 tsx 加载源码，全部武将包）

| 指标 | 结果 |
|---|---|
| 引擎导入 | ~0.5 s |
| 启动到开局 | ~1.3 s（预热池成本很低） |
| 单局（8 人 AI，vvfast） | 18–70 s 打完，2–12 轮 |
| 单局 CPU | 12–24 s 用户态（正常速度对局中分摊在 20–40 分钟里） |
| 堆内存（GC 后） | 250–510 MB，长局在 ~650 MB 附近趋于平稳，不随时间无界增长 |
| 4 Worker 并发 | 全部正常结束，进程峰值 RSS 2.4 GB（≈600 MB/局，含 tsx 开销） |

容量估算：16 GB 主机约 20–25 个并发对局。可优化项（P1 之后）：生产态预构建去掉 tsx 与 sourcemap 字符串（约 60 MB/局）；只加载房间启用的武将包。

### 6.2 无头运行需要的适配（全部在 engine-host 内，未改引擎）

| 问题 | 处理 |
|---|---|
| `@/`、`noname` 别名，`.js` 指向 `.ts`，`/mode/x.js` 绝对路径动态导入 | ESM loader hooks（`hooks.js`） |
| `import.meta.env`、`import.meta.glob`、`.vue` 导入、CJS 命名导出（crypto-js） | loader 转换 / 桩模块 / 包装模块 |
| happy-dom 的 `Symbol.toStringTag` 返回子类名，`get.objtype()` 失效，`ui.create.div(.., dialog)` 不挂载 | 按浏览器语义给接口原型固定 toStringTag（`shims.js`） |
| canvas `getContext` 为 null；Audio/AudioContext/alert/confirm | 空实现 |
| 配置走 IndexedDB + fetch/XHR + `<script>` | fake-indexeddb；`lib.init.js/json/req/css` 改为读文件（`preload.js`） |
| 模式默认配置（如 `choice_fan`）只在构建开始菜单 UI 时写入，导致 AI 座位无武将 | 启动预置 `<key>_mode_config_<mode>` |
| 新手向导、更新日志弹窗会阻塞开局；`lib.onfree` 延迟构建菜单（约占一半内存）；结束时保存录像依赖菜单 | 预置 `new_tutorial`、`video:"0"`；`showChangeLog`/`onfree` 置空 |
| 沙盒 Realms 依赖 iframe | 服务端可信，`debug:true` 关闭沙盒 |

选型对比：linkedom 更轻但缺 `getComputedStyle`/`offsetWidth`/`animate` 等，兼容风险高，放弃；无头 Chromium 不需要。

### 6.3 隐藏信息核查：存在泄露

`get.stringifiedResult` 把 Card 序列化为 `[cardid, suit, number, name, nature]`，`player.directgain` 等广播把手牌对象发给**所有**客户端，改过的客户端可以看到他人手牌。这是现有协议本身的问题，不是新架构引入的。处理计划：服务端转发层按座位对"不属于该座位且未公开"的牌做脱敏（只保留 cardid），P2 实现并做回归验证；验证不过则保持现状并在文档标注。

### 6.4 对 P1 的设计修正

- **主机接入方式**：Worker 内引擎走现有"中继主机"路径（`game.onlineroom`，`lib.wsOL` + `NodeWS`），主线程扮演中继：`onconnection/onmessage/onclose` 下发给引擎，`game.send("server", ...)` 上行。不改引擎。
- **不占座位**：引擎的 `game.me`（原房主座位）同样绑定一个远程客户端（`me.ws = client`），并设 `game.notMe = true`、`_status.auto = true`，使 `isMine()` 恒为假；各 OL 流程先判断 `isOnline()` 再判断 `game.me`（已抽查 `chooseButtonOL`、`replaceHandcardsOL`、身份局选将），远程分支生效。P1 用无头客户端做端到端验证。
- **存储抽象**：`RoomStore`（房间元数据、座位、会话、重连消息缓冲）与 `RecordSink`（整局结束后持久化，供战绩）为接口，默认内存实现，可选 Redis；进行中的引擎状态是 Worker 内对象图，不进存储层。

## 7. P1–P3 实现说明

### 7.1 组件与路径

| 组件 | 位置 | 说明 |
|---|---|---|
| 无头运行时 | `packages/engine-host/src/runtime/` | loader hooks、浏览器 shim、服务端 preload、`bootEngine()` |
| 主机 Worker | `packages/engine-host/src/host/worker.js`、`overrides.js` | 中继主机桥接；`game.me` 也绑定远程客户端；补齐联机公共选项（出牌时限等） |
| 服务端 | `packages/game-server/src/` | `main.ts` 入口；`rooms/`（房间、对局、Worker 池、续传 Link）；`gateway/`（`/ws` 控制面、`/ws/game` 游戏面）；`fs-api.ts`（只读文件接口）；`static/`（缓存） |
| 大厅 Shell | `packages/game-server/web/` | 无构建的原生 JS；`/`、`/room/<房间号>` |
| 客户端接入 | `apps/core/noname/init/server-room.js` + `mode/connect.js` 3 行分支 | `?sa-room=` 模式；`ResumableSocket` |

### 7.2 与第 3 节设计的差异

- **两条 WebSocket**：大厅 Shell 用 `/ws`，对局 iframe 自己连 `/ws/game`（原设计是 Shell 独占连接再 postMessage 转发）。这样客户端引擎代码几乎不用改；换局仍是换 iframe，体验不变。
- **身份**：令牌在浏览器本地生成，`uid = sha256(token)` 前 16 位。服务端无需持久化用户表，重启后身份不变。
- **协议包**：控制面类型暂放 `packages/game-server/src/protocol.ts`（只有一个消费者），未单独建 `packages/protocol`。

### 7.3 重连（P2）

- 游戏面帧格式 `"<seq>\n<payload>"`，双向编号；客户端每 2 秒发 `\u0006ack:<seq>`，服务端据此裁剪缓冲（上限 8 MB）。
- 断线：服务端保留该座位的流 `NONAME_RECONNECT_GRACE`（默认 60 秒），期间引擎无感知；客户端指数退避重连并带 `resume=<seq>`，服务端补发缺失帧，客户端重发未确认帧。
- 无法续传（超出缓冲、宽限期已过、页面刷新）：服务端回 `\u0006fresh`，页面重载，引擎走原有快照重连（`reinit`）。宽限期过后座位由 AI 托管，回来后解除。
- 大厅阶段房主离线 30 秒自动转让；对局中房主与普通玩家无区别。

### 7.4 换局（P3）

- 每局一个 iframe（`sa-game=<对局ID>`）。结算出现时 Shell 预加载下一局页面（`sa-defer=1`：引擎启动完毕、等待对局 ID）。
- 房主点"再来一局"：服务端从预热池取 Worker 开新局；Shell 把新对局 ID 发给预加载页，页面连上后淡入，旧局 400 ms 后销毁。旧对局 Worker 保留 60 秒后回收。

### 7.5 已知问题

- 游戏页首次加载会因现有 JIT Service Worker 的注册流程自刷新 1–2 次（原有行为）。
- 个别技能把引用了外部变量的 AI 函数发给客户端执行（如 `player is not defined`），客户端报错后由出牌超时兜底。原引擎联机就有，属于 P6 范畴。

## 8. 交付状态与验证

| 阶段 | 状态 | 验证 |
|---|---|---|
| P0 | 完成 | 第 6 节 |
| P1 | 完成 | 浏览器端到端：3 个 Chromium 经大厅建房/加入/开局，每个客户端引擎各自完整打完一局；房主是普通座位 |
| P2 | 完成 | 同一场景内注入 18 次断网（续传无感）+ 房主页面崩溃后重开（快照重连回到对局）；`test/link.test.ts` 单测 |
| P3 | 完成 | 再来一局 0.9 s 出新画面，大厅页不刷新；身份/武将重新分配 |
| P4 | 完成 | 插件单测 + 全扩展包无头整局（牌数守恒、无重复）；浏览器端到端全程开启插件 |
| P5 | 完成 | 静态缓存单测；GitHub Actions 双架构镜像构建推送成功 |
| D5 服务端扩展 | 进行中 | — |
| 隐藏信息脱敏 | 未做 | 见 8.1 |

运行端到端测试：`pnpm build` 后在 `packages/game-server` 执行
`E2E_DROP=1 E2E_KILL_OWNER=1 E2E_RESTART=1 E2E_SPEED=vvfast node test/e2e/browser-game.mjs`。

### 8.1 隐藏信息脱敏（未实现，建议并入 P6）

客户端以 `lib.cardOL[cardid]` 缓存牌对象。若在转发层把他人手牌脱敏为空信息，该牌之后被公开（打出、展示）时客户端可能沿用缓存的空对象，出现空白牌面。需要逐类核对广播（`directgain`、`$draw`、`$give`、`lose`…）并在公开时补发真实信息，属于协议改造，适合与 P6 的"函数广播 → 具名消息"一起做。

### 8.2 P6 评估

| 项 | 工作量 | 收益 |
|---|---|---|
| P6a 函数广播 → 具名消息（引擎约 600+ 处 `broadcast/broadcastAll`，武将代码另有约 600 处） | 大，可按模块渐进；适合按文件批量交给 Codex，每批用无头整局 + 浏览器端到端回归 | 客户端不再执行服务端下发的代码；协议可做隐藏信息过滤；修复"AI 函数引用外部变量"类联机报错 |
| P6b 状态脱离 DOM（Player/Card 不再继承 HTMLDivElement） | 极大（49 万行武将代码依赖） | 服务端去掉 DOM shim，单局内存预计降一半以上 |

建议先做 P6a 中"手牌相关广播 + 隐藏信息过滤"这一小块（收益最直接），P6b 暂不立项。

### 8.3 旧服务端

`packages/server`（旧中继服务）与其 Dockerfile 仍保留：旧版桌面/移动客户端的"联机大厅"仍依赖它。是否删除由维护者决定。
