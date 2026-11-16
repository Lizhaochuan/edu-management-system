'use strict';
(() => {
  const $=selector=>document.querySelector(selector);
  let rows=[],history=false,busy=false,authenticated=false;
  function tell(text,error=false){$('#message').textContent=text;$('#message').className=error?'error':'';}
  async function request(url,options={}) {
    let res;
    try{res=await fetch(url,{...options,credentials:'same-origin'});}
    catch(_error){throw new Error('网络连接失败，请检查网络后刷新页面或重试');}
    if(res.status===401){authenticated=false;rows=[];$('#schedule-rows').replaceChildren();$('#count').textContent='';window.location.replace('/login.html');throw new Error('登录已失效，请重新登录');}
    if(!res.ok)throw new Error(res.status===403?'当前账号无权查看个人课表，请重新登录':'读取失败，请检查网络后点击“刷新记录”重试');
    return res.json();
  }
  function render(){
    const body=$('#schedule-rows');body.replaceChildren();
    if(!authenticated)return;
    const from=$('#from-date').value,to=$('#to-date').value;
    if(from&&to&&from>to){$('#count').textContent='';tell('开始日期不能晚于结束日期，请调整后重新筛选',true);return;}
    const visible=rows.filter(row=>(!history||row.completed)&&(!from||row.date>=from)&&(!to||row.date<=to));
    const shown=history?visible.slice().reverse():visible;
    $('#count').textContent='共 '+shown.length+' 个课次';
    tell(shown.length?'':history?'当前条件下暂无授课记录，可清除筛选后重试':'当前条件下暂无课次安排，可清除筛选或联系教务管理员');
    for(const row of shown){
      const tr=document.createElement('tr');
      const cell=(main,detail)=>{const td=document.createElement('td');const text=document.createElement('strong');text.textContent=main;td.appendChild(text);if(detail){const small=document.createElement('small');small.textContent=detail;td.appendChild(small);}tr.appendChild(td);return td;};
      cell(row.date||'日期待确认',(row.startTime||'待确认')+' – '+(row.endTime||'待确认'));
      cell(row.courseName,row.className);
      cell(row.hours===null?'课时待确认':row.hours+' 课时');
      cell(row.assignmentText);
      const status=cell(row.statusText);status.firstChild.className='badge';
      body.appendChild(tr);
    }
  }
  async function load(){
    if(busy||!authenticated)return;busy=true;$('#refresh').disabled=true;
    rows=[];$('#schedule-rows').replaceChildren();$('#count').textContent='';tell('正在加载个人课表…');
    try{const result=await request('/api/teacher/schedules');rows=result.data.schedules;render();}
    catch(error){tell(error.message||'网络连接失败，请点击“刷新记录”重试',true);}
    finally{busy=false;$('#refresh').disabled=false;}
  }
  function view(record){history=record;$('#schedule-tab').className=record?'':'active';$('#history-tab').className=record?'active':'';$('#schedule-tab').setAttribute('aria-pressed',String(!record));$('#history-tab').setAttribute('aria-pressed',String(record));$('#list-title').textContent=record?'授课记录':'我的课表';render();}
  $('#filters').addEventListener('submit',event=>{event.preventDefault();render();});
  $('#reset').addEventListener('click',()=>{$('#from-date').value='';$('#to-date').value='';render();});
  $('#schedule-tab').addEventListener('click',()=>view(false));
  $('#history-tab').addEventListener('click',()=>view(true));
  $('#refresh').addEventListener('click',load);
  $('#logout').addEventListener('click',async()=>{
    $('#logout').disabled=true;
    try{await request('/api/auth/logout',{method:'POST'});authenticated=false;rows=[];$('#schedule-rows').replaceChildren();window.location.replace('/login.html');}
    catch(error){tell('退出失败，请检查网络后重试',true);}
    finally{$('#logout').disabled=false;}
  });
  (async()=>{
    try{
      const result=await request('/api/auth/me');const user=result.data.user;
      if(['admin','super_admin'].includes(user.role)){window.location.replace('/');return;}
      if(user.role!=='teacher'){tell('当前账号无教师工作台访问权限，请退出后使用教师账号登录',true);return;}
      $('#teacher-name').textContent=user.name+' · 教师';authenticated=true;await load();
    }catch(error){tell(error.message||'登录验证失败，请刷新页面重试',true);}
  })();
})();
