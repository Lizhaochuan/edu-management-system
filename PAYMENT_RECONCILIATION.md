# 任务 13-4：人工收款对账与防重复购课

本阶段补充付款凭据的双人核对和精确匹配。**系统目前没有连接银行、微信支付、支付宝等可信账单 API，也没有支付渠道签名或可信回调，因此不能宣称已经自动核实真实到账。** 新增的 confirmed 状态仅代表授权人员对官方外部账单进行了人工核对。

## 一、兼容模式与严格模式

- 现有微信客户端直接发送 package.purchase。为了不在前端改造之前破坏现有购课流程，默认仍允许未核对登记，但新购课流水明确标记 verification_status = unverified_legacy，绝不可报告为已真实到账。
- 在新前端及对账流程上线后，可以在服务器启动前设置环境变量 REQUIRE_RECONCILED_PAYMENTS=1。严格模式下，没有已确认付款凭据的 package.purchase 返回 409 PAYMENT_UNVERIFIED，不发放课时。
- 对已经通过 payment.submit 登记的参考号，**无论开关设置如何**，只有已经确认、金额/课程/学员/收款账户全部匹配的收款才能被使用；不能绕过待核对记录直接购课。
- 严格模式**尚未开启**，这是一个部署前功能开关，不能把它视作财务安全全面完成。

## 二、新增服务端命令

所有命令均使用现有服务器认证、命令白名单、幂等键、版本号和单事务提交；不能由客户端指定用户身份。

| 命令 | 可用角色 | 说明 |
| --- | --- | --- |
| payment.submit | admin、super_admin | 输入 payment_reference、student_id、course_id、amount 和 account_destination；生成 pending 收款记录，不生成课时包。 |
| payment.confirm | super_admin，必须与原登记人不同 | 在官方渠道账单中**人工核对**后提交 payment_reference 及 statement_reference；状态变为 confirmed。重复账单流水号拒绝。 |
| payment.reject | super_admin，必须与原登记人不同 | 对没有核实到账或信息不一致的 pending 收款记录输入 reason；状态变为 rejected。 |
| package.purchase | admin、super_admin | 若存在收款记录，精确匹配学员、课程、金额（以整数分对比）和账户；成功后将记录变为 consumed 并绑定 package_id。严格模式下缺少 confirmed 付款则拒绝。 |

输入示例，先由教务管理员发送：

~~~json
{
  "command": "payment.submit",
  "params": {
    "payment_reference": "edu-2026-001",
    "student_id": "stu_1",
    "course_id": "crs_1",
    "amount": 1800,
    "account_destination": "进入公账"
  },
  "idempotencyKey": "original-unique-idempotency-key",
  "expectedVersion": 123
}
~~~

再由另一位具有核对权限的超级管理员确认实际银行账单中的对应记录：

~~~json
{
  "command": "payment.confirm",
  "params": {
    "payment_reference": "edu-2026-001",
    "statement_reference": "bank-statement-line-001"
  },
  "idempotencyKey": "second-unique-idempotency-key",
  "expectedVersion": 124
}
~~~

示例 ID 和版本都是虚构值。statement_reference 只是人工输入的核对凭证，并不意味着系统自动验证了付款渠道；两个账号参与也不能代替真实账单。

## 三、数据一致性与审计

- 一次购课的课时包、旧欠费抵扣、收款消耗状态、购课流水、审计、版本及幂等回执同时提交；失败整体回滚。
- pending、rejected 和 consumed 收款不能再次用于购课；同一 payment_reference 或已被使用的 statement_reference 拒绝重复确认。
- 旧购课在兼容模式下留下 unverified_legacy 标签，不应被自动批量改为 confirmed。
- 网络超时与结果不确定时应按现有命令协议保留并重试原始幂等信封，不能换键重复入账。

## 四、后续工作

1. 由负责小程序与 Web 的前端开发者增加收款登记、待核对、确认与拒绝页面。完成流程验收后才能考虑在后端启用严格模式，否则旧客户端可能无法正常购课。
2. 确定实际收款渠道、官方对账字段和银行交易唯一标识。具备可信渠道 API 后，应接入服务端签名核验或官方账单查询，不能永远依赖人工填写。
3. 历史未核验购课需单独对账与异常处理，不得当作已经确认到账。
4. 单进程数据库、凭据上限、部署 HTTPS、剩余旧业务接口仍需要各自的上线评审。

本任务仅使用模拟数据执行测试，不读取客户资料、银行数据或正式数据库。
