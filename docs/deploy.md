# 部署服务端权威版

需要 Docker Engine 和 Docker Compose 插件。将仓库根目录的 `compose.yaml` 单独复制到服务器目录即可，无需下载源码：

```sh
mkdir noname && cd noname
curl -fLO https://raw.githubusercontent.com/wangtao94/noname/main/compose.yaml
docker compose up -d
docker compose logs -f
```

访问 `http://服务器IP:8080`，健康检查为 `/healthz`。默认镜像 `ghcr.io/wangtao94/noname:latest` 在发布 `vX.Y.Z` 标签时更新；开发版本可将镜像标签改为 `edge`（main）或 `sa-edge`（feat/server-authoritative）。更新使用 `docker compose pull && docker compose up -d`。

数据挂载在当前目录 `./data`，扩展放在 `./data/extension`。镜像使用非 root 的 node 用户（UID/GID 1000），请先执行 `mkdir -p data && sudo chown -R 1000:1000 data`，确保挂载目录可写。房间与会话保存在内存，重启会结束现有对局。

## 环境变量

取消 compose 文件中 `environment:` 及所需项目的注释。下表为镜像默认值；修改容器端口后需同步修改端口映射。

| 变量                   | 默认值         | 说明                                              |
| ---------------------- | -------------- | ------------------------------------------------- |
| PORT                   | 8080           | HTTP 与 WebSocket 共用端口                        |
| NONAME_SERVE_WEB       | true           | false 时只提供游戏服务                            |
| NONAME_EXTENSIONS     | 空             | 服务端启用的扩展名，用逗号分隔                    |
| NONAME_DATA_DIR        | /data          | 扩展与持久数据目录                                |
| NONAME_WEB_ROOT        | /app/dist      | 网页构建目录                                      |
| NONAME_ASSET_ROOTS     | /app/apps/core | 静态资源回退根目录，多个用冒号分隔                |
| NONAME_RECONNECT_GRACE | 60s            | 断线重连宽限                                      |
| NONAME_ROOM_IDLE_TTL   | 10m            | 空房回收时间                                      |
| NONAME_MAX_ROOMS       | 0              | 0 按内存自动估算并发对局上限                      |
| NONAME_TRUST_PROXY     | false          | 可信反向代理后可设 true；须限制后端端口的直接访问 |
| NONAME_LOG_LEVEL       | info           | 日志级别                                          |
| NONAME_GAME_SPEED      | mid            | 默认对局速度                                      |

## 扩展

将管理员安装的扩展放在 `./data/extension/<name>/`，目录中包含 `extension.js`（或 `extension.ts`）、`info.json` 及其资源，再设置 `NONAME_EXTENSIONS: "扩展名1,扩展名2"` 并重启服务。仓库 `apps/core/extension` 中的自带扩展也可以直接按目录名启用（如 `boss`、`cardpile`、`coin`）。扩展需支持联机模式；服务端不会将单机扩展自动改为联机扩展。

服务器启动时会警告并移除找不到入口文件的扩展。所有房间使用同一份管理员名单，Worker 与浏览器游戏页按该名单加载；大厅的房间设置只读展示名单。玩家本地的扩展开关不影响联机游戏页，联机覆盖仅在内存中生效，不保存到玩家设置。默认名单为空。

## 反向代理

网页与 `/ws` 使用同一个端口。公网部署应由反向代理提供 HTTPS，浏览器才能在非 localhost 环境启用 Service Worker。以下 nginx 配置放在对应的 `http` 上下文中，证书路径按实际修改：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}
server {
    listen 443 ssl;
    server_name game.example.com;
    ssl_certificate /etc/letsencrypt/live/game.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/game.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
    }
}
```

反代与容器在同机时，可将 compose 端口改成 `127.0.0.1:8080:8080`。容器化反代可通过同一 Docker 网络访问 `noname:8080`。

## 缓存与构建

代码和文档（`.html`、`.js`、`.mjs`、`.css`、`.json`、`.ts`、`.wasm`、`.map`、`.txt`，含目录首页、Service Worker 和资源清单）使用 `Cache-Control: no-cache`，每次使用前验证，避免未启用 Service Worker 的客户端在发版后继续使用旧引擎代码。媒体、字体及其他文件使用 `public, max-age=3600, stale-while-revalidate=86400`；服务器提供 ETag、Last-Modified 和条件请求 304。媒体支持 Range 206。文本、JSON、WASM 等超过 1 KB 的文件在构建时生成 Brotli/gzip 副本，按 Accept-Encoding 协商。

现有根作用域 Service Worker 会在安装、激活及页面导航时检查资源清单（导航检查最多每 60 秒一次）。清单覆盖浏览器依赖以及音频、图片、扩展，按文件内容生成 hash。资源只在实际使用时缓存到 `noname-assets`，缓存键包含 hash；清单变化后删除旧版本。音频等资源的 Range 请求在缓存未命中时正常从网络返回，同时后台获取完整文件；仅缓存状态为 200、提供 Content-Length 且不超过 20 MiB 的完整响应，同一资源的并发后台下载会合并。首次访问不会下载全部约 1.2 GB 资源。更新清单失败时继续使用旧清单，浏览器缓存配额不足时仍可从网络读取。`/ws`、`/healthz`、`/api/` 和页面入口不进入资源缓存。开发环境原有的 JIT 编译优先执行。

本地运行 `pnpm build` 会生成清单和预压缩文件。Docker 设置 `NONAME_BUILD_SKIP_ASSETS=1`，清单仍从 `apps/core` 读取 audio/image/extension，但不将其重复复制到 dist；HTTP 服务从资产根目录读取原文件。镜像同时保留引擎源码及生产依赖，服务端 Worker 在运行时加载源码。

## 将 GHCR 包公开

首次推送成功后，在 GitHub 的个人或组织主页进入 **Packages → noname → Package settings → Danger Zone → Change visibility → Public**，确认公开。公开后用户可匿名拉取，单独复制 compose 文件即可部署。若属于组织，还需确认组织允许公开包，并在包的 Actions access 中授权仓库写入。CI 使用仓库的 `GITHUB_TOKEN`，权限为 `contents: read` 和 `packages: write`；PR 仅构建，推送分支和版本标签才发布镜像。
