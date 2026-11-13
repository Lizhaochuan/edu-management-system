# 任务 13-3：备份调度、失败告警和恢复演练

本任务新增 scheduler-ready 命令：scripts/backup-operations.js。它复用任务 13-2 的 AES-256-GCM 加密备份工具，不修改服务器和数据库写入逻辑，不自动安装 cron、launchd 或 systemd，不访问真实数据，除非管理员明确在数据库主机上执行。

## 1. 真实环境部署前检查

- Node.js 22 和项目副本可用；必须核实真实数据库的绝对路径，**禁止把示例路径当成真实路径**。
- 创建位于 Git 仓库外的备份目录、状态目录和演练目录，并设置为仅本机账户可访问（POSIX：chmod 700）；应位于受控的加密存储或加密磁盘。
- 事先用 scripts/db-encrypted-backup.js generate-key 生成 32 字节私钥，保存在独立目录；密钥、登录凭证与备份分别保存，密钥必须有独立离线副本。
- 备份脚本从单个原子更新的 JSON 数据库文件读取，适合当前单 Node 进程架构；不解决多进程、网络共享盘、支付对账或完整生产灾难恢复。
- 使用一个操作系统服务账户，避免多台机器同时写入正式数据库。脚本不上传客户数据，不调用外部 webhook。

## 2. 一次性执行已加密备份

以下目录与时间仅是操作示例：

~~~sh
node scripts/backup-operations.js run \
  --db /private-data/edu/db.json \
  --key-file /private-secrets/edu-recovery.key \
  --backup-dir /encrypted-backups \
  --status-dir /private-backup-status
~~~

每次 run 都生成不可重复的 .enc 文件名。先写入随机名称的 .enc.pending 文件，调用 AES-256-GCM 加密和认证验证；**只有验证通过才将文件发布为 .enc**。失败的临时文件不计为有效备份，执行器退出码非零，不会覆盖已经成功的备份，也不会修改源数据库。不同 run 之间用状态目录里的 backup-ops.lock 防止重叠；进程异常崩溃留下的锁不能自动忽略，必须人工确认没有后台进程仍在执行后再处理。

成功后在状态目录原子写入 last-backup.json，包含时间戳、操作类型、备份文件名和数据库提交版本，不包含用户记录或密钥。失败时写入 attention-required.json，同时返回非零退出码；这是**可供监控系统消费的本地告警信号，不等于已经向人员发送短信或邮件**。即使后一次备份成功，告警标记仍保留，必须由管理员确认处理原因后手动清除。

## 3. 备份健康检查

~~~sh
node scripts/backup-operations.js check \
  --status-dir /private-backup-status \
  --max-age-hours 26 \
  --max-drill-age-hours 840
~~~

- last-backup.json 缺失、超过 26 小时、内容无效，或 attention-required.json 仍存在，检查返回非零。
- 如提供 --max-drill-age-hours，还要求最近一次成功恢复演练没有超过相应小时数（示例为 35 天）。
- 可以让外部监控系统每小时调用 check，根据退出码发出真正的邮件、短信或 IT 告警。配置接收人、发送渠道和凭证由运维人员负责，**本仓库没有部署任何外部通知连接**。
- 首次启用前需要执行一次成功的备份与演练，否则健康检查按设计失败。

## 4. 手动或定期隔离恢复演练

~~~sh
node scripts/backup-operations.js drill \
  --file /encrypted-backups/edu-example.enc \
  --key-file /private-secrets/edu-recovery.key \
  --drill-dir /private-isolated-drills \
  --status-dir /private-backup-status
~~~

drill 首先验证 AES-GCM 认证标签，再临时恢复到一个全新的数据库文件，检查用户、课时包、审计表以及写入回执结构，最后删除临时恢复文件并写入 last-drill.json。**演练期间会短暂在磁盘上生成明文数据库**，因此演练目录必须位于经过磁盘加密、仅授权账户可访问的存储卷；删除文件不代表物理安全擦除。最好在专用隔离设备上完成，不应将演练文件暴露给生产服务或其它同步进程。

这属于自动化数据完整性演练，不替代业务人员在独立测试服务器上验证真实恢复流程，包括登录凭证、审计、余额和订单状态。

## 5. 调度模板（不会被此 PR 自动安装）

Mac 上可使用 launchd，Linux 上可使用 systemd timer 或受控 cron。下面给出一份**未安装的 launchd 配置示例**，需要先替换所有占位绝对路径，再保存在负责备份的账户对应的 LaunchAgents 目录中。示例每天 03:00 运行一次，实际时间必须由管理员按业务需求确认。

~~~xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>example.edu.encrypted-backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/node</string>
    <string>/absolute/path/to/checkout/scripts/backup-operations.js</string>
    <string>run</string>
    <string>--db</string><string>/private-data/edu/db.json</string>
    <string>--key-file</string><string>/private-secrets/edu-recovery.key</string>
    <string>--backup-dir</string><string>/encrypted-backups</string>
    <string>--status-dir</string><string>/private-backup-status</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
</dict>
</plist>
~~~

这是**示例，不是当前机器的已生效配置**。还需要独立配置健康检查及可靠的对外告警传递，确认机器睡眠、断电、服务账户失效时有补检措施。不要将私钥字节放进 plist，避免把备份作业配置放进项目的私有客户资料目录。

## 6. 运行后检查和剩余风险

建议每日检查：最近一次备份时间、健康检查退出码、是否存在未确认的告警、磁盘容量和备份是否在独立存储中；每月进行独立设备的受控真实恢复演练，记录开始和结束时间、备份与恢复数据库版本、是否需要单独恢复凭证及最终验收签字。

**当前仍未完成**：实际生产机定时任务安装、自动发送告警、备份异地复制与保留轮换、真实故障恢复演练、RPO/RTO 测定、幂等回执容量、付款渠道对账、旧业务接口迁移、生产 HTTPS。测试仅使用随机生成的测试密钥与操作系统临时目录，绝不触碰正式业务数据。
