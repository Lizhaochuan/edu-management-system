'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const business=require('../web-admin/js/business-display');

function loginPage(fetch) {
  const elements={
    '#login-form':{addEventListener:(_event,handler)=>{elements.submit=handler;}},
    '#user-id':{value:'u_tch2'}, '#password':{value:'test-only-password'},
    button:{disabled:false}, '#error':{textContent:''}
  };
  const navigation=[];
  vm.runInNewContext(read('web-admin/login.html').match(/<script>([\s\S]*?)<\/script>/)[1],{
    document:{querySelector:key=>elements[key]},fetch,
    window:{location:{replace:url=>navigation.push(url)}}
  });
  return {elements,navigation,submit:()=>elements.submit({preventDefault(){}})};
}

test('BUG-13-12-01: valid teacher/parent login stays on the form with Chinese denial and no session',async()=>{
  for(const [role,label] of [['teacher','教师'],['parent','家长'],['unexpected','当前角色']]) {
    const requests=[];
    const page=loginPage(async(url,options)=>{
      requests.push({url,options});
      return {ok:true,json:async()=>({data:{user:{id:'u_tch2',role}}})};
    });
    await page.submit();
    assert.deepEqual(page.navigation,[]);
    assert.match(page.elements['#error'].textContent,/无 Web 管理端访问权限.*管理员账号/);
    assert.ok(page.elements['#error'].textContent.includes(label));
    assert.doesNotMatch(page.elements['#error'].textContent,/unexpected|teacher|parent/);
    assert.equal(page.elements['#user-id'].value,'u_tch2');
    assert.equal(page.elements['#password'].value,'');
    assert.equal(page.elements.button.disabled,false);
    assert.deepEqual(requests.map(x=>x.url),['/api/auth/login','/api/auth/logout']);
    assert.equal(requests[1].options.method,'POST');
    assert.equal(requests[1].options.credentials,'same-origin');
  }
});

test('BUG-13-12-01: both Web administrator roles still reach the dashboard',async()=>{
  for(const role of ['admin','super_admin']) {
    const requests=[];
    const page=loginPage(async url=>{
      requests.push(url);return {ok:true,json:async()=>({data:{user:{role}}})};
    });
    await page.submit();
    assert.deepEqual(page.navigation,['/']);
    assert.deepEqual(requests,['/api/auth/login']);
    assert.equal(page.elements['#password'].value,'');
    assert.equal(page.elements['#error'].textContent,'');
  }
});

test('BUG-13-12-01: credential and network errors remain visible and allow retry',async()=>{
  for(const fetch of [async()=>({ok:false,json:async()=>({message:'账号或密码错误'})}),
    async()=>{throw new Error('网络连接失败');}]) {
    const page=loginPage(fetch);
    await page.submit();
    assert.match(page.elements['#error'].textContent,/账号或密码错误|网络连接失败/);
    assert.deepEqual(page.navigation,[]);
    assert.equal(page.elements.button.disabled,false);
  }
});

test('BUG-13-12-02: approval summaries translate all configuration tables including historical records',()=>{
  const tables={teacher_tiers:'教师课酬档位',users:'员工与账号',terms:'学期',
    courses_and_class_types:'课程与班型',partner_teacher_rate_config:'合伙人教师课酬'};
  for(const [table,label] of Object.entries(tables)) {
    const original=`超管[张校长(创始人)]审批通过单据 #app_1，参数生效覆盖至 [${table}]`;
    assert.equal(business.readableAuditDescription(original),
      `超管[张校长(创始人)]审批通过单据 #app_1，参数生效覆盖至 [${label}]`);
  }
  for(const table of ['unknown_private_table','constructor','__proto__']) {
    assert.equal(business.readableAuditDescription(`参数生效覆盖至 [${table}]`),
      '参数生效覆盖至 [其他业务记录]');
  }
  for(const text of ['正常中文说明','参数生效覆盖至 [教师课酬档位]',
    '超管[teacher_tiers]审批通过单据 #app_1']) {
    assert.equal(business.readableAuditDescription(text),text,'preserve business names and IDs');
  }
  assert.equal(business.readableAuditDescription(null),'');
});

test('BUG-13-12-02: actual Web component uses translated description in list and detail without mutating logs',async()=>{
  const original={id:'log_1',action:'UPDATE',target_table:'teacher_tiers',
    description:'超管[张校长]审批通过单据 #app_1，参数生效覆盖至 [teacher_tiers]',
    before_snapshot_json:{headcount_rates_json:{1:100}},
    after_snapshot_json:{headcount_rates_json:{1:110}}};
  const before=JSON.stringify(original);
  const window={BusinessDisplay:business,api:{getLogs:async()=>({data:{list:[original],total:1,totalPages:1}})}};
  vm.runInNewContext(read('web-admin/js/components/audit-logs.js'),{window,console});
  const component=window.AuditLogsComponent;
  const instance=Object.assign(component.data(),component.methods);
  await instance.fetchLogs();
  assert.equal(instance.logs[0].displayDescription,
    '超管[张校长]审批通过单据 #app_1，参数生效覆盖至 [教师课酬档位]');
  assert.equal(instance.logs[0].readable.rows[0].afterText,'¥110 元/课时');
  assert.match(component.template,/\{\{ item\.displayDescription \}\}/);
  assert.match(component.template,/diffModal\.item\.displayDescription/);
  assert.doesNotMatch(component.template,/\{\{ (?:item|diffModal\.item)\.description/);
  assert.equal(JSON.stringify(original),before,'immutable stored audit text must stay unchanged');
});
