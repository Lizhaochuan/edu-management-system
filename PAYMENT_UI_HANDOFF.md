# 任务 13-5：双端人工收款核对交接与验收

## 范围与开发分工

本阶段基于 work / PR #20 的人工对账命令，新增一个服务端受限只读列表和独立 Web、微信小程序页面。GitHub 开始时没有开放中的开发 PR，因此本轮任务分支由 ChatGPT 负责 **以下明确范围文件**；若 Antigravity 同时承担界面工作，请先合并/交接本 PR，避免两名开发者编辑同一文件。不能把代码通过静态检查视为 UI 已验收。

修改范围：
- server.js、services/authService.js：增加 GET /api/payments/reconciliation 的鉴权与最小响应。
- 客户端既有重试规则保持不变：403 等权限异常时继续保存结果不确定的原始幂等信封，避免权限变化后的重复入账。
- app.json、pages/index/index.js、pages/course-packages/index.wxml：增加小程序入口、购课未核验提示。
- pages/payment-reconciliation/index.js/.wxml/.wxss：小程序收款登记、列表、人工确认/拒绝及绑定购课。
- web-admin/index.html、web-admin/js/api.js、web-admin/payment-reconciliation.html、web-admin/js/payment-reconciliation.js：Web 导航、命令封装和独立业务页面。
- tests/payment-ui-http.test.js、tests/payment-ui-views.test.js：隔离测试，不能触碰 data/db.json。

## 后端读取规则

GET /api/payments/reconciliation 只接受已登录 admin/super_admin：
- 超管查看最近 200 条人工收款记录，可看到人工账单流水号和审核情况。
- 普通管理员只能查看 **本人提交**的收款记录，且不会收到官方账单参考号、他人审核细节。
- 教师、家长、未登录、非法状态筛选请求被拒绝。
- 仅返回固定白名单字段，**不返回整张 business_write_events、历史财务账本或其他用户的隐私数据**。
- 响应包含 strict_mode 运行状态，来自服务端 REQUIRE_RECONCILED_PAYMENTS 环境变量。前端展示不能决定服务器权限。
- GET 只读，不递增数据库版本、不更改任何余额。

## 功能说明

1. 教务管理员或超管在“收款人工核对”中录入学员、课程、原始付款参考号、到账金额、账户。触发 payment.submit，创建 pending 收款，**不产生课时**。
2. 超管点击待核对记录，先去官方银行/支付后台查证金额和实际入账，再输入官方账单流水号、确认 payment.confirm；原登记人不能自审。
3. 对账失败可输入理由执行 payment.reject，已拒绝记录不可直接生成购课。
4. 选择 confirmed 收款，填写学期、付费课时和赠送课时，执行 package.purchase。学员、课程、金额、账户全部从已核对记录提取，**不可被前端自由修改以绕过匹配**。服务器会在同一事务消耗收款、建立课时包。
5. 新页面和原买课页均提示：付款参考号不等于到账；旧购课流程仍可能存在 unverified_legacy 记录。小程序原页面在严格模式启用后会拒绝未核对订单，用户应改走新页面。

## 人工 GUI/真机验收清单（尚未实际执行）

- 微信开发者工具编译：确认 app.json 正常注册、WXML 表达式和事件绑定无错，页面能够进入和返回，不出现空列表/无学生时崩溃。
- 小程序两位超管与教务管理员交叉登录：验证收款提交、当前用户可见范围、拒绝、另一名超管确认和课时包生成，模拟 409/403/网络失败后重试及刷新。
- iPhone 真机：检查数据输入、权限、返回导航、页面滚动、长参考号与错误提示，必须使用受控的 HTTPS 测试环境及模拟数据。
- Web 浏览器：两位用户交替登录，确认列表不泄露他人记录/对账流水，只有合法用户可确认，购课精确匹配，清理登录态不会残留他人数据。
- 付款严格模式测试：在隔离测试环境设 REQUIRE_RECONCILED_PAYMENTS=1，原页面的未核验购课应收到明确拒绝、新页面应成功完成先核对后购课；**不要在真实业务服务器上开启此开关**。
- 核对 PR 变更范围，确认无 data/db.json、用户资料、收款明细、密钥或私有配置进入 Git。

## 上线阻断项

仍没有对接真实支付渠道官方 API，人工声明未经过机器认证。真实财务对账需明确人、账、账户、金额和手续费规则，旧 unverified_legacy 记录单独审核。GUI 和真机未验收，不能宣称完整上线；正式备份演练、HTTPS、剩余旧财务接口和幂等回执容量仍须跟进。


## 任务 13-6：验收前权限边界补充

静态复核发现仅对 /api/payments/reconciliation 做角色筛选还不足够：旧的 /api/commands/context 和 /api/db/all 曾向普通管理员导出整张 business_write_events，其中包括**其他管理员登记的付款、超管人工填写的外部账单参考号**。

任务 13-6 在上述两个旧只读接口中对 admin 隐藏整张内部 business_write_events（置空数组），super_admin 仍可访问完整内部业务账本；专用 /api/payments/reconciliation 继续提供“本人登记的付款、剔除对账流水号”的最小必要列表。测试要求同时覆盖三条读路径及教师拒绝访问。这个修复不改变资金计算、付款记录原始持久化和已有业务命令，也不代表已实现真实支付渠道核验。

GUI 验收时还需要核实：以两个不同的 admin 账号直接请求这三个接口，不得拿到另一人的付款记录或对账流水号；Web/小程序显示自己的待核对记录仍应正常，super_admin 仍应正常查看与审批。
