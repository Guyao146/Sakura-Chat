# NOTICE — Sakura-Chat 许可证采用声明

本文件按《[Sakura-License 采用与授权指引](https://wiki.mcylyr.cn/#/../docs/sakura-license-adoption)》记录本项目的许可证采用信息，与 `LICENSE` 配套使用，本身不是许可正文。

## 项目身份

- 项目名称：Sakura Chat
- 官方仓库：https://github.com/Guyao146/Sakura-Chat
- 原始来源：本仓库自创建，无外部上游源码

## 权利主体

版权归属以 Git 提交记录为准；提交均由 Guyao146（guxuan.mojang@outlook.com）作出。商业许可与法律通知入口：[GitHub Issues](https://github.com/Guyao146/Sakura-Chat/issues)。

## 适用范围

- 适用：`server/`、`public/`、`tools/`、`test/`、`Dockerfile`、`docker-compose.yml`、`docker-compose.ghcr.yml`、`.env.example`、`.github/`、`README.md`、`NOTICE.md`、`LICENSE`、`package.json` 等本仓库原创文件。
- 不适用：`node_modules/` 中的第三方依赖，各自保持原许可；与本仓库原创文件一同存放或分发的第三方内容不因分发而改用本许可；`public/uploads/` 等目录中由用户上传的内容。

## 固定许可版本

- 许可正文：`LICENSE`，当前为 **Sakura-License v1.2 审阅稿**（文本标识 `Sakura-License-1.2-draft`，审阅修订 3，修订日期 2026-10-02）。
- 该许可限制特定商业利用，属于源码可用（source-available）许可证，不是 OSI 批准的开源许可证，也没有 SPDX 短标识；在物料清单中引用写作 `LicenseRef-Sakura-License-1.2-draft`。
- v1.2 正文自身声明其为拟议文本。权利主体在此作出明确采用声明：自本仓库首次同时包含本声明与该 `LICENSE` 的提交起，对本作品适用 Sakura-License v1.2 审阅稿；正式固定版本发布后将按采用指引整体替换 `LICENSE`，不影响已授予的权利。
- npm 元数据：`package.json` 与 `package-lock.json` 的 `license` 字段写作 `SEE LICENSE IN LICENSE`。

## 生效边界

- 首次适用：包含本声明与当前 `LICENSE` 的 `master` 分支提交，及此后发布的全部版本。
- 本仓库此前没有 LICENSE 文件与许可声明，不存在依本许可或其他许可授予的历史权利。

## 历史权利

- 本仓库历史内容未在任何许可证下分发；按 GitHub 默认规则，无许可证声明时保留所有权利。本次采用不追溯改变既有状态。

## 第三方内容

- 运行依赖 `express` 与 `ws` 保持各自许可（MIT），以各依赖包自带的许可证声明为准。
- 本项目不对外部依赖的许可合规性作担保；分发或再分发时应自行核对依赖清单。
