<div align="center">
    <img src="https://github.com/Mehver/FlightArchive/raw/main/docs/icon/256.png" width="20%" alt="FlightArchive"/>
    <h1>FlightArchive <code>v1.0.1</code></h1>
    <p><a href="https://github.com/Mehver/FlightArchive/blob/main/README.md">English</a> | 简体中文</p>
    <a href="https://github.com/Mehver/FlightArchive"><img src="https://img.shields.io/badge/-GitHub-3A3A3A?style=flat&amp;logo=GitHub&amp;logoColor=white" referrerpolicy="no-referrer" alt="FlightArchive GitHub 仓库"></a>
	<a href='https://github.com/Mehver/FlightArchive/pkgs/container/flightarchive'><img src="https://img.shields.io/badge/-GHCR-8957E5?style=flat&amp;logo=GitHub&amp;logoColor=white" alt="GHCR"></a>
	<a href='https://hub.docker.com/r/mehver/flightarchive'><img src="https://img.shields.io/badge/-DockerHub-1c90ed?style=flat&amp;logo=Docker&amp;logoColor=white" alt="DockerHub"></a>
</div>

## 1 简介

FlightArchive 是一个自托管、单用户的个人飞行档案，运行在本机或受信任的家庭 / 局域网环境中。它把你的飞行记录、登机牌扫描件和相关文件集中保存在一个由你掌控的私有位置，无需账号，也不依赖云端服务。

项目使用 Python、FastAPI、React 19、TypeScript 和 Material UI 编写，并以单个容器交付。你现有的媒体文件夹通过 [RemappableFileGateway](https://github.com/MehverLibs/remappable-file-gateway)（RFG）以只读方式接入，FlightArchive 只引用这些文件，而不会接管它们。

### 功能

- 以列表或卡片网格浏览飞行记录，并打开单个航班的详情。
- 添加和编辑航班，并维护航空公司、机场和机型参考目录。
- 裁切登机牌扫描件，并将纸质登机牌排布到模板上。
- 将登机牌扫描件、航空公司标志及其他附件关联到资源文件夹中的文件。
- 审阅资源映射、忽略不需要的文件，并在源文件缺失时重新连接已移动的文件。
- 导入和导出业务数据，并在“活动与任务”抽屉中查看操作记录。

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

各部分的实现契约见 [ARCHITECTURE.md](ARCHITECTURE.md)、[BUSINESS_DATA.md](BUSINESS_DATA.md) 和 [RESOURCE_LIFECYCLE.md](RESOURCE_LIFECYCLE.md)。

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
  -v /path/for/cache:/cache \
   flightarchive:local
```

容器启动后访问 http://localhost:8080。

| 参数 | 作用 |
| --- | --- |
| `-p 127.0.0.1:8080:8080/tcp` | HTTP Web 界面 |
| `-v /path/for/resources:/resource:ro` | 现有资源文件夹，以只读方式挂载 |
| `-v /path/for/data:/data` | FlightArchive 数据与资源映射；保留此项即可保留你的档案 |
| `-v /path/for/cache:/cache` | 可选的缩略图缓存，可安全删除并重建 |

你的档案保存在 `/data` 中；`/resource` 为只读。可选的 `/cache` 挂载用于存放可重建的缩略图；未挂载时，缓存位于容器内部。

> FlightArchive 不含身份验证，仅供单用户在本地或受信任的局域网中使用。请勿将其暴露到公网。

**已发布镜像：** 每个已发布的 GitHub Release tag 会直接用作镜像 tag（不进行版本规范化），同时更新 `latest`：

```shell
docker pull ghcr.io/mehver/flightarchive:<release-tag>
docker pull docker.io/mehver/flightarchive:<release-tag>
```

Release assets 还包含可分别加载的 `linux/amd64` 与 `linux/arm64` Docker 镜像 tarball。

---

**Docker Compose：**

```shell
cp app/.env.example app/.env
docker compose --env-file app/.env -f app/compose.yaml up --build
```

如需持久缩略图缓存，请在 `app/.env` 中取消注释 `FLIGHTARCHIVE_CACHE_HOST_PATH` 并加入可选覆盖配置，它只挂载 `/cache`：

```shell
docker compose --env-file app/.env -f app/compose.yaml -f app/compose.cache-host.yaml up --build
```

## 3 开发

开发环境搭建、本地运行命令与测试说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。

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

## 5 许可证

本项目采用 BSD 3-Clause 许可证发布。在适当署名的前提下可以复用代码。

Copyright (c) 2026 Mehver (https://github.com/Mehver). All rights reserved.

所有依赖均为开源软件，并采用宽松许可证。未包含 copyleft（例如 GPL 或 AGPL）组件。
