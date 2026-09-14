<div align="center">
    <img src="https://github.com/Mehver/FlightArchive/raw/main/docs/icon/256.png" width="20%" alt="FlightArchive"/>
    <h1>FlightArchive <code>v1.0.0</code></h1>
    <p><a href="https://github.com/Mehver/FlightArchive/blob/main/README.md">English</a> | 简体中文</p>
    <a href="https://github.com/Mehver/FlightArchive"><img src="https://img.shields.io/badge/-GitHub-3A3A3A?style=flat&amp;logo=GitHub&amp;logoColor=white" referrerpolicy="no-referrer" alt="FlightArchive GitHub 仓库"></a>
	<a href='https://github.com/Mehver/FlightArchive/pkgs/container/flightarchive'><img src="https://img.shields.io/badge/-GHCR-8957E5?style=flat&amp;logo=GitHub&amp;logoColor=white" alt="GHCR"></a>
	<a href='https://hub.docker.com/r/mehver/flightarchive'><img src="https://img.shields.io/badge/-DockerHub-1c90ed?style=flat&amp;logo=Docker&amp;logoColor=white" alt="DockerHub"></a>
</div>

## 1 简介

FlightArchive 是一个使用 Python、FastAPI、React 19、TypeScript 和 Material UI 构建的容器化飞行历史应用。它使用 [RemappableFileGateway](https://github.com/MehverLibs/remappable-file-gateway) （RFG）提供只读源文件发现、虚拟路径映射、资源交付与哈希功能。

它遵循以下规则：

- 航班、目录和登机牌布局数据由后端原子持久化
- 资源从 RFG 资源根目录中选择，业务记录只保留已分类的虚拟路径
- 可以检查资源映射并手动重新匹配，无需编辑虚拟路径
- 缩略图是可丢弃的派生缓存数据，绝不进入业务数据
- 指纹仅存储在直接绑定到已保存航班登机牌、附件或已保存航空公司徽标的已分类资源上

<table>
    <tr>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/1.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/2.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/3.png"/></td>
    </tr>
<tr>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/4.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/5.png"/></td>
        <td><img src="https://github.com/Mehver/FlightArchive/raw/main/docs/img/6.png"/></td>
    </tr>
</table>

### 1.1 资源模型

RFG 拥有只读资源根目录和 `<data>/rfg/mapping.json`。FlightArchive 拥有 `<data>/flightarchive/v1/business-data.json`。独立的缓存根目录存放可重建的缩略图对象，永远不属于业务数据。

### 1.2 预览配置

首次启动时，FlightArchive 会原子地创建仅在重启后生效、可由用户编辑的配置文件 `<RFG_DATA_DIR>/flightarchive/v1/preview-config.json`。它独立于 BusinessData 和可丢弃的缩略图缓存。该文件必须是有效的版本 1 配置；无效配置会阻止启动，直至修正。修改仅在后端重启后生效。

```json
{
  "schemaVersion": 1,
  "thumbnails": {
    "maxSourceBytes": 268435456,
    "maxSourcePixels": 100000000,
    "maxDimension": 512,
    "quality": 82,
    "jobConcurrency": 2
  },
  "rfg": {
    "pillowImageMaxPixels": 100000000
  }
}
```

`thumbnails.maxSourceBytes` 默认值为 256 MiB。提高它、源像素上限或任务并发数会增加内存使用；并发图像工作也会产生相应的内存成本。修改缩略图设置会使缩略图缓存失效并重新生成配置标识。

`rfg.pillowImageMaxPixels` 是唯一受支持的主机级 RFG 图像安全设置。它在 RFG 初始化前应用，并影响感知哈希。RFG ZIP 防护、哈希容量和内部阈值不能通过此文件配置。

### 1.3 当前功能

FlightArchive 提供响应式航班仪表盘、航班与航班参考目录（航空公司、机场、机型）编辑、资源选择与分类、包含忽略和重新匹配操作的映射审阅工作区、业务绑定资源的指纹功能，以及登机牌裁切和布局工具。

## 2 使用

以下容器命令均从仓库根目录运行。

**构建 Docker 镜像：**

```shell
docker build -f app/Dockerfile -t flightarchive:local app
```

**运行 Docker 镜像：**

```shell
docker run -d \
  --name=flightarchive \
  --restart=unless-stopped \
  -p 127.0.0.1:8080:8080/tcp \
  -v /path/for/resources:/resource:ro \
  -v /path/for/data:/data \
   flightarchive:local
```

**已发布镜像：** 每个已发布的 GitHub Release tag 会直接用作镜像 tag（不进行版本规范化），同时更新 `latest`：

```shell
docker pull ghcr.io/mehver/flightarchive:<release-tag>
docker pull docker.io/mehver/flightarchive:<release-tag>
```

Release assets 还包含可分别加载的 `linux/amd64` 与 `linux/arm64` Docker 镜像 tarball。

| 参数 | 作用 |
| --- | --- |
| `-p 127.0.0.1:8080:8080/tcp` | HTTP Web 界面 |
| `-v /path/for/resources:/resource:ro` | 现有 RFG 资源根目录，只读 |
| `-v /path/for/data:/data` | RFG 映射和 FlightArchive 业务数据 |
| `-v /path/for/cache:/cache` | 可选的可重建缩略图缓存 |

容器启动后访问 http://localhost:8080。未挂载可选缓存时，`/cache` 保持为普通的可丢弃容器目录。

---

**Docker Compose：**

```shell
cp app/.env.example app/.env
docker compose --env-file app/.env -f app/compose.yaml up --build
```

如需持久或高速的缩略图缓存，请设置 `FLIGHTARCHIVE_CACHE_HOST_PATH` 并运行：

```shell
docker compose --env-file app/.env -f app/compose.yaml -f app/compose.cache-host.yaml up --build
```

该覆盖配置只挂载 `/cache`；资源挂载保持只读，数据挂载保留 RFG 映射与业务状态。

## 3 开发

**要求**

- [Docker](https://www.docker.com/)
- 用于前端开发的 [Node.js](https://nodejs.org/) v22 或更高版本
- 用于后端开发和测试的 Python 3.10 或更高版本

**安装依赖**

```shell
cd app/frontend
pnpm install

cd ../backend
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements-dev.txt
```

**前端开发**

```shell
cd app/frontend
pnpm dev
```

**编译前端**

```shell
cd app/frontend
pnpm build
```

**后端服务**

```shell
cd app/backend
RFG_RESOURCE_PATH=/path/for/resources \
RFG_DATA_DIR=/path/for/data \
python -m flightarchive
```

**测试 / 类型检查**

```shell
cd app/backend
python -m pytest tests -q

cd ../frontend
pnpm exec vitest run --maxWorkers=4
pnpm typecheck
```

**构建 Docker 镜像**

```shell
docker build -f app/Dockerfile -t flightarchive:local app
```

在 Windows 上，`tools/BuildAll.bat` 构建相同的本地镜像。 `tools/BuildAndRunContainer.bat` 是 Windows 辅助脚本，可清理本地构建产物、提示输入主机映射并启动后台容器。其他平台请使用[使用](#2-使用)章节中的 `docker run` 命令。

## 4 基于以下技术构建

> 所有依赖均为开源软件，并采用宽松许可证。未包含 copyleft（例如 GPL 或 AGPL）组件。

- Python
  - [FastAPI](https://github.com/fastapi/fastapi)
  - [Uvicorn](https://github.com/encode/uvicorn)
  - [RemappableFileGateway](https://github.com/MehverLibs/remappable-file-gateway)
  - [Pillow](https://github.com/python-pillow/Pillow)
- Node.js
  - React 19 + Vite
    - [Material UI](https://github.com/mui/material-ui)
    - [Vitest](https://github.com/vitest-dev/vitest)
- Docker
  - `node:22-bookworm-slim`
  - `python:3.14-slim`

## 5 许可证

本项目采用 BSD 3-Clause 许可证发布。在适当署名的前提下可以复用代码。

Copyright (c) 2026 Mehver (https://github.com/Mehver). All rights reserved.

所有依赖均为开源软件，并采用宽松许可证。未包含 copyleft（例如 GPL 或 AGPL）组件。
