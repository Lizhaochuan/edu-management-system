# 教务 / 课时管理系统

本仓库用于两台电脑轮流使用 Antigravity 开发同一套教育管理系统，源码包含微信小程序、Web 管理端和 Node.js 后端。

## 目录
- `pages/`、`components/`：微信小程序。
- `web-admin/`：Web 管理端。
- `server.js`、`services/`：共享后端。
- `data/db.json`：**真实运行数据，不得上传 GitHub**。

## 操作红线
- 这里只存源码，不上传正式数据库、`.env`、凭证、密钥或本地私有配置。
- 两台电脑均在 OneDrive / Google Drive 实时同步目录之外 clone 本仓库。
- 两台电脑轮流工作：开始前先获取最新提交；结束时提交、推送并填写 `HANDOFF.md`。
- 不要让两个 Agent 同时修改同一个分支或工作目录。
- 保留唯一正式后端与数据库；开发测试使用隔离的测试数据。
- 本代码是已有工程的基础版本，不代表最新 Notion 业务需求全部实现。

请先看 [HANDOFF.md](HANDOFF.md)，再开始任何开发。
