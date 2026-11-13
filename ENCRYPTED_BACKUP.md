# 任务 13-2：数据库加密备份和隔离恢复

本任务提供 **AES-256-GCM 认证加密备份**。相较于 13-1 的 Base64 明文备份，新格式对整个数据库字节进行加密，包含客户、财务、审计、事务版本和幂等回执。已有明文恢复工具保留以兼容历史文件，但正式新备份应优先使用本工具。

**边界**：只针对单个 Node.js 进程维护的本地 JSON 数据库；不启动服务器、不初始化数据库、不修改业务数据、不覆盖现有备份、不配置定时任务。使用 Node.js 22。

## 1. 单独保管密钥

在 Git 仓库外准备三个目录：
- 真实数据库文件，例如 /private-data/edu/db.json，确认实际 DB_FILE 路径。
- 私有密钥目录，例如 /private-secrets/。
- 加密备份目录，例如 /encrypted-backups/。

首次生成 32 字节随机二进制密钥：

~~~sh
node scripts/db-encrypted-backup.js generate-key --out /private-secrets/edu-recovery.key
~~~

生成的密钥文件是随机二进制数据，并非口令；不通过命令行参数或环境变量直接传递密钥字节。工具要求密钥为普通文件、长度恰好 32 字节、没有硬链接或符号链接，POSIX 系统只允许当前用户访问（0600）。密钥需要另存一份有权限隔离的安全离线副本；**密钥丢失意味着旧备份无法解密**。不要把密钥放入 GitHub、聊天或第三方 CI，也不要把唯一的密钥副本和备份放在同一故障域。

## 2. 备份、校验和只恢复到新文件

以下是示例路径，操作前应替换为真实、绝对的路径，目标文件必须尚未存在：

~~~sh
node scripts/db-encrypted-backup.js backup-encrypted \
  --db /private-data/edu/db.json \
  --key-file /private-secrets/edu-recovery.key \
  --out /encrypted-backups/edu-20261113-001.enc

node scripts/db-encrypted-backup.js verify-encrypted \
  --file /encrypted-backups/edu-20261113-001.enc \
  --key-file /private-secrets/edu-recovery.key

node scripts/db-encrypted-backup.js restore-encrypted-isolated \
  --file /encrypted-backups/edu-20261113-001.enc \
  --key-file /private-secrets/edu-recovery.key \
  --out /isolated-test/recovered-db.json
~~~

每次备份使用新的 12 字节随机 nonce，生成 AES-256-GCM 的认证标签和密文；密文中的数据库版本与业务内容不会以明文暴露。验证时必须通过认证标签并核对数据库 JSON 结构与版本，否则拒绝恢复。错误密钥、篡改、缺失源文件、非法写入状态以及已有输出路径都会报错。输出限制为 Git 仓库外的独占新文件。

该数据库快照不包含另存的登录凭证文件（例如 data/auth-credentials.json），凭证文件应单独安全备份。恢复会保留原始数据库字节、版本和幂等回执，**不得删除回执来释放容量**。

## 3. 自动调度的上线准备

本工具可以由操作系统的定时任务重复调用，但**没有在任何机器上安装或启用计划任务**。每次执行需要未占用的输出路径（可由外部调度器生成时间戳与随机后缀）。定时任务应当：生成独立文件、运行 verify-encrypted、记录成功/失败状态、失败时发出告警，并将备份移交到另一个加密的故障隔离存储位置。

启用前需明确备份频率、留存策略、备份盘容量、权限隔离、独立密钥副本、恢复演练责任人和告警机制。正式服务仍采用单机 JSON 文件，不适合让两台计算机同时写同一数据库。

## 4. 恢复演练

建议每月在隔离机器上：
1. 对备份执行认证验证，确保正确密钥可读取、错误密钥与篡改会失败。
2. 恢复到全新文件，不修改生产 DB_FILE。
3. 验证学员、课时包、审批、审计、事务版本及幂等回执完整。
4. 通过隔离的测试后端检查可读性，使用测试凭证和测试网络，避免连接任何生产系统。
5. 记录恢复时长、备份版本与数据新旧程度，以后才能确定实际 RPO/RTO。

本 CLI 不提供生产文件覆盖入口；正式切换必须经过停机、额外备份、凭证恢复、数据验证及回滚评审。

## 5. 仍需处理

外部调度、异地副本、备份留存轮换、生产演练及告警尚未落地。幂等回执 10,000 条上限、付款渠道核验、旧业务操作、HTTPS 和权限验收也仍需按任务拆分。自动化测试使用操作系统临时目录与模拟数据，没有接触真实客户数据或真实密钥。
