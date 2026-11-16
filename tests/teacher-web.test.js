'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../web-admin/js/teacher.js'),'utf8');

function node(){return {value:'',textContent:'',className:'',disabled:false,children:[],listeners:{},
  addEventListener(event,fn){this.listeners[event]=fn;},setAttribute(){},
  appendChild(child){this.children.push(child);this.firstChild=this.children[0];},
  replaceChildren(){this.children=[];this.firstChild=null;}};}
async function page({role='teacher',schedules=[],responseStatus=200}={}) {
  const elements={};for(const id of ['message','schedule-rows','count','from-date','to-date','refresh','schedule-tab','history-tab','list-title','filters','reset','logout','teacher-name'])elements['#'+id]=node();
  const requests=[],navigation=[];
  let status=responseStatus;
  vm.runInNewContext(source,{document:{querySelector:id=>elements[id],createElement:node},
    window:{location:{replace:url=>navigation.push(url)}},
    fetch:async(url,options)=>{
      requests.push({url,options});
      const code=url==='/api/teacher/schedules'?status:200;
      if(code==='offline')throw new Error('Failed to fetch');
      return {ok:code===200,status:code,json:async()=>url==='/api/auth/me'?{data:{user:{role,name:'测试老师'}}}:{data:{schedules}}};
    }});
  await new Promise(resolve=>setImmediate(resolve));
  return{elements,requests,navigation,setStatus:value=>{status=value;},
    click:async(id,event='click')=>{await elements['#'+id].listeners[event]({preventDefault(){}});},
    text:()=>elements['#schedule-rows'].children.map(tr=>tr.children.map(td=>td.children.map(x=>x.textContent).join(' ')).join(' | ')).join('\n')};
}

const schedules=[{date:'2026-11-18',startTime:'09:00',endTime:'10:30',courseName:'自然拼读',className:'启蒙一班',hours:1.5,statusText:'待上课',completed:false,assignmentText:'任课'},
  {date:'2026-11-16',startTime:'14:00',endTime:'15:00',courseName:'阅读 <script>保留为文本</script>',className:'阅读二班',hours:null,statusText:'已完成',completed:true,assignmentText:'代课'}];

test('teacher portal renders business fields and filters dates/history, with actionable empty/invalid states',async()=>{
  const p=await page({schedules});
  assert.match(p.text(),/自然拼读.*启蒙一班.*1.5 课时/);
  assert.match(p.text(),/课时待确认/);
  await p.click('history-tab');assert.doesNotMatch(p.text(),/自然拼读/);assert.match(p.text(),/阅读/);
  await p.click('schedule-tab');p.elements['#from-date'].value='2026-11-18';await p.click('filters','submit');
  assert.match(p.text(),/自然拼读/);assert.doesNotMatch(p.text(),/阅读/);
  p.elements['#to-date'].value='2026-11-10';await p.click('filters','submit');
  assert.match(p.elements['#message'].textContent,/开始日期不能晚于结束日期/);assert.equal(p.text(),'');
  await p.click('reset');assert.equal(p.elements['#schedule-rows'].children.length,2);
  p.elements['#from-date'].value='2099-01-01';await p.click('filters','submit');
  assert.match(p.elements['#message'].textContent,/暂无课次安排.*联系教务/);
  assert.equal(p.requests.every(r=>r.options.credentials==='same-origin'),true);
  assert.doesNotMatch(source,/\.innerHTML\s*=/,'untrusted course/class names use textContent');
});

test('teacher portal redirects administrators before fetching teacher data',async()=>{
  for(const role of ['admin','super_admin']){
    const p=await page({role});assert.deepEqual(p.navigation,['/']);assert.deepEqual(p.requests.map(r=>r.url),['/api/auth/me']);
  }
  const p=await page({role:'parent'});assert.match(p.elements['#message'].textContent,/无教师工作台访问权限/);assert.equal(p.requests.length,1);
});

test('teacher portal clears stale rows on failed refresh, supports retry and redirects expired sessions',async()=>{
  const p=await page({schedules});p.setStatus(500);await p.click('refresh');
  assert.equal(p.text(),'');assert.match(p.elements['#message'].textContent,/刷新记录.*重试/);
  p.setStatus('offline');await p.click('refresh');assert.match(p.elements['#message'].textContent,/网络连接失败.*重试/);
  assert.doesNotMatch(p.elements['#message'].textContent,/Failed to fetch/);
  p.setStatus(200);await p.click('refresh');assert.equal(p.elements['#schedule-rows'].children.length,2);
  p.setStatus(401);await p.click('refresh');assert.equal(p.text(),'');assert.deepEqual(p.navigation,['/login.html']);
});

test('teacher logout clears displayed data and returns to login',async()=>{
  const p=await page({schedules});await p.click('logout');assert.equal(p.text(),'');
  assert.deepEqual(p.navigation,['/login.html']);assert.equal(p.requests.at(-1).url,'/api/auth/logout');assert.equal(p.requests.at(-1).options.method,'POST');
});
