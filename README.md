<h1 align="center">无名杀 · 服务端联机版</h1>

<p align="center">
  基于 <a href="https://github.com/libnoname/noname">libnoname/noname</a> 的 Fork：房间和对局运行在服务端，断线自动续上，再来一局不用刷新，一条命令部署。
</p>

<p align="center">
  <a href="https://github.com/wangtao94/noname/actions/workflows/docker.yml"><img alt="镜像构建" src="https://img.shields.io/github/actions/workflow/status/wangtao94/noname/docker.yml?branch=main&style=flat-square&label=docker"></a>
  <a href="https://github.com/wangtao94/noname/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/wangtao94/noname?display_name=tag&style=flat-square"></a>
  <a href="https://github.com/wangtao94/noname/pkgs/container/noname"><img alt="镜像" src="https://img.shields.io/badge/ghcr.io-wangtao94%2Fnoname-blue?style=flat-square"></a>
  <a href="./LICENSE"><img alt="许可证" src="https://img.shields.io/github/license/wangtao94/noname?style=flat-square"></a>
</p>

## 和上游有什么不同

上游的联机由**房主的浏览器**计算整局游戏，服务器只负责转发消息。本 Fork 把整局游戏搬到了服务端：

| | 上游 | 本 Fork |
|---|---|---|
| 谁在计算对局 | 房主的浏览器 | 服务器（每局一个独立 Worker） |
| 房主掉线 | 整局结束 | 不受影响，房主只是持有管理权限的普通座位 |
| 网络波动 | 断开后需要重进房间 | 自动续传，60 秒内恢复无感知；超时由 AI 托管，回来后接管 |
| 再来一局 | 所有人刷新页面、重新进房 | 约 1 秒切到新局，重新分配身份和洗牌，页面不刷新 |
| 房间 | 房主客户端创建 | 服务端资源：房间号、邀请链接、房主可转让、离线自动移交 |
| 扩展 | 各玩家本地各自开启 | 服务器统一指定，所有人加载同一份 |
| 部署 | 需单独托管网页和中继服务 | 一个镜像、一个端口，`docker compose up -d` |

武将、卡牌、模式等游戏内容与上游一致，并定期同步。单机游戏照常可玩（服务器首页的"进入单机游戏"）。

另外内置了一个插件：**开局手牌 N 组选 1**。各身份可分别设置组数，默认自动计算（基础 2 组、内奸 3 组，总量不超过牌堆的 60%）。

## 快速部署

需要 Docker 与 Docker Compose 插件：

```sh
mkdir noname && cd noname
curl -fLO https://raw.githubusercontent.com/wangtao94/noname/main/compose.yaml
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d
```

打开 `http://服务器IP:8080`，创建房间，把邀请链接发给朋友即可。

- 镜像：`ghcr.io/wangtao94/noname`，x86_64（amd64），基于 Debian 12 + Node 24
- 所有配置都有默认值，按需在 `compose.yaml` 中取消注释即可修改，完整列表见 [部署文档](./docs/deploy.md)
- 公网部署建议放在 HTTPS 反向代理后面（文档里有 nginx 示例），浏览器才能启用离线资源缓存

**资源缓存**：约 1.2 GB 的图片和音频按内容 hash 缓存在浏览器里。第二次访问几乎不消耗服务器流量；发新版时只重新下载有变化的文件。

## 架构一览

```
┌──────── 浏览器 ────────┐            ┌──────────────── 服务器（Node） ────────────────┐
│ 大厅页面               │  /ws       │ 网关：静态资源 + WebSocket（同一端口）          │
│  ├ 建房/加入/设置       │◄─────────►│  ├ 房间管理：座位、房主、开局、再来一局          │
│  └ 对局 iframe         │  /ws/game  │  ├ 会话：断线续传、宽限期、托管                  │
│     原版游戏客户端      │◄─────────►│  └ 每局一个 Worker：原版引擎无头运行 + 插件       │
└────────────────────────┘            └────────────────────────────────────────────────┘
```

设计细节、取舍和实测数据见 [docs/architecture/server-authoritative.md](./docs/architecture/server-authoritative.md)。

## 本地开发

环境：Node.js 24、pnpm 10（`corepack enable`）。

```sh
pnpm install

# 单机开发（Vite 开发服务器）
pnpm dev

# 服务端联机
pnpm build                          # 构建网页客户端到 dist/
pnpm -F @noname/game-server start   # http://localhost:8080
```

测试：

```sh
pnpm -F @noname/game-server test    # 服务端单元测试
pnpm -F @noname/engine-host test    # 引擎/插件单元测试

# 无头整局（不需要浏览器）
cd packages/engine-host && node --import ./src/runtime/register.js ./src/testing/plugin-game.js

# 浏览器端到端（需先 pnpm build；会自动启动服务器和 Chromium）
cd packages/game-server && E2E_DROP=1 E2E_KILL_OWNER=1 E2E_RESTART=1 E2E_SPEED=vvfast node test/e2e/browser-game.mjs
```

目录：

| 路径 | 内容 |
|---|---|
| `apps/core` | 游戏本体（与上游同步） |
| `packages/engine-host` | 在 Node 中无头运行引擎、对局 Worker、服务端插件 |
| `packages/game-server` | 服务端：房间、网关、静态资源、大厅页面（`web/`） |
| `docs/` | 架构设计、部署说明 |

贡献代码和使用 AI 编码助手前，请先阅读 [AGENTS.md](./AGENTS.md)。

## 与上游同步

本 Fork 对游戏本体（`apps/core`）的改动很少，集中在 `noname/init/server-room.js` 和几处接入点，合并上游更新一般不会冲突：

```sh
git remote add upstream https://github.com/libnoname/noname.git
git fetch upstream
git merge upstream/main
```

## 使用约定

本项目与上游一样基于 **GPL-3.0** 协议开源，使用时请遵守开源协议，并请：

1. 打包、二次分发时**保留代码出处**：本 Fork <https://github.com/wangtao94/noname>，以及原项目 <https://github.com/libnoname/noname>；
2. 不要用于商业用途。

游戏内容归功于无名杀社区的所有贡献者，见上游的[贡献者列表](https://github.com/libnoname/noname/graphs/contributors)。上游的桌面版和安卓客户端请到上游项目获取。
