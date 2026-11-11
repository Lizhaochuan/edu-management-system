# 教务 / 课时管理系统

本仓库用于 ChatGPT 与 Antigravity（按需加入）共同开发教育管理系统。包含微信小程序、Web 管理端与 Node.js 后端。通过独立任务分支和 Pull Request 协作，允许轮流开发，但严禁同时修改相同文件。

## 项目目录
- `pages/`、`components/`：微信小程序。
- `web-admin/`：Web 管理端。
- `server.js`、`services/`：后端业务代码。
- `data/db.json`：正式业务数据，**不得上传 GitHub**。

## 分支约定
- `main`：稳定基线，不用于日常编程。
- `work`：共享集成分支；任务开发者不直接往此分支提交代码。
- `chatgpt/<task>`：ChatGPT 负责后端、安全、课时与薪酬逻辑。
- `antigravity/<task>`：Antigravity 负责前端页面与交互。
- 双方从最新 `work` 创建任务分支，通过 Pull Request 审核后合并。
- 最新规范以 [HANDOFF.md](HANDOFF.md) 为准。

## 安全规则
- 不上传 `data/db.json`、个人信息、`.env`、密码、令牌、密钥和本地私有配置。
- 不在云端 Agent 中使用正式数据库进行开发测试；应使用隔离的测试数据。
- 正式后端和数据库保持单一写入来源，不能依靠网盘同步活跃数据库。
- `.gitignore` 不能替代人工安全检查；推送前必须审核暂存文件。
- 历史代码不代表 Notion 的最新需求已全部实现。

首次开发请先读 [HANDOFF.md](HANDOFF.md)。任何 Agent 不得在没有最新交接上下文时自行继续编程。
