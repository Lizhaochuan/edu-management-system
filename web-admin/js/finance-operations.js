'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const model = { user:null, students:[], teachers:[], packages:[], courses:[], terms:[], salary:[] };
  let busy = false;
  const money = amount => '¥' + Number(amount || 0).toFixed(2);
  const tell = (message, error=false) => {
    $('#message').textContent = message;
    $('#message').style.color = error ? '#ab3333' : '#236b41';
  };
  const nameFor = (rows,id,key) => {
    const found=rows.find(row=>row.id===id);
    return found ? String(found[key] || found.name || '未命名') : '记录待核对';
  };
  const addOption = (selector, value, label) => {
    const option=document.createElement('option');
    option.value=value;
    option.textContent=label;
    $(selector).appendChild(option);
  };
  function details() {
    const pkg=model.packages.find(item=>item.id===$('#package').value);
    $('#package-info').textContent=pkg ?
      '当前剩余付费课时 '+Number(pkg.paid_hours_left||0)+
      '，赠送课时 '+Number(pkg.gift_hours_left||0)+
      '；原到期日 '+(pkg.expire_date||'未设置')+
      '。本页面不记录任何补费到账。' : '请选择学员课时包';
  }
  function updateLists() {
    const ctx=model;
    for(const selector of ['#package','#target-term','#teacher']) $(selector).replaceChildren();
    for(const pkg of ctx.packages) {
      addOption('#package',pkg.id,
        nameFor(ctx.students,pkg.student_id,'name')+' · '+
        nameFor(ctx.courses,pkg.course_id,'course_name')+' · 到期 '+(pkg.expire_date||'待确认'));
    }
    for(const term of ctx.terms){
      addOption('#target-term',term.id,term.name+' · 截止 '+(term.fixed_expire_date||'未设置'));
    }
    for(const teacher of ctx.teachers)addOption('#teacher',teacher.id,teacher.name);
    $('#rollover-form button').disabled=!ctx.packages.length || !ctx.terms.length;
    $('#salary-form button').disabled=!ctx.teachers.length;
    details();
    const tbody=$('#settlements');
    tbody.replaceChildren();
    for(const row of ctx.salary.slice().sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))){
      const tr=document.createElement('tr');
      const values=[row.teacher_name||nameFor(ctx.teachers,row.teacher_id,'name'),
        row.period,money(row.total_salary),
        row.status==='settled'?'已锁定结算':row.status==='draft'?'草稿（待核对）':'其他状态'];
      for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.appendChild(td);}
      const action=document.createElement('td');
      if(row.status==='draft'){
        const button=document.createElement('button');
        button.type='button';
        button.textContent='确认并锁定工资单';
        button.addEventListener('click',()=>settle(row));
        action.appendChild(button);
      } else {action.textContent='不可重复结算';}
      tr.appendChild(action);tbody.appendChild(tr);
    }
    if(!ctx.salary.length){
      const tr=document.createElement('tr');
      const td=document.createElement('td');
      td.colSpan=5;td.textContent='当前尚无工资单，可选择教师和月份生成草稿。';
      tr.appendChild(td);tbody.appendChild(tr);
    }
  }
  async function reload() {
    const result=await window.api.commandContext();
    if(!result || !result.data || !result.data.snapshot)throw Error('服务器未提供财务数据快照');
    const d=result.data.snapshot;
    model.students=d.students||[];
    model.packages=d.course_packages||[];
    model.courses=d.courses_and_class_types||[];
    model.terms=d.terms||[];
    model.teachers=(d.users||[]).filter(u=>u.role==='teacher'&&u.status==='active');
    model.salary=d.salary_settlements||[];
    updateLists();
  }
  async function act(method, success) {
    if(busy)return;
    busy=true;
    document.querySelectorAll('button').forEach(el=>el.disabled=true);
    try{
      await method();
      tell(success);
      await reload();
    }catch(e){
      tell((e.message||'操作未确认')+'。如网络中断，请保留原请求重试，不要重复登记。',true);
    }finally{
      busy=false;
      document.querySelectorAll('button').forEach(el=>el.disabled=false);
      $('#rollover-form button').disabled=!model.packages.length||!model.terms.length;
      $('#salary-form button').disabled=!model.teachers.length;
    }
  }
  $('#package').addEventListener('change',details);
  $('#rollover-form').addEventListener('submit',event=>{
    event.preventDefault();
    const form=event.currentTarget.elements;
    const pkg=model.packages.find(item=>item.id===form.package_id.value);
    const target=model.terms.find(item=>item.id===form.target_term_id.value);
    if(!pkg||!target){tell('请选择有效课时包和目标学期',true);return;}
    if(!target.fixed_expire_date||target.fixed_expire_date<=(pkg.expire_date||'9999-12-31')){
      tell('目标学期必须晚于原到期日',true);return;
    }
    if(!window.confirm('确认把该学员剩余的付费和赠送课时转入 '+target.name+
      '？此次顺延没有补费，提交后不可重复操作。'))return;
    act(()=>window.api.rolloverTerm({package_id:pkg.id,target_term_id:target.id,
      top_up_fee:0,remark:form.remark.value.trim()}),'课时已顺延，请检查课时包的新到期日');
  });
  $('#salary-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(model.user.role!=='super_admin'){tell('仅超级管理员可生成工资单',true);return;}
    const f=event.currentTarget.elements;
    const teacher=model.teachers.find(u=>u.id===f.teacher_id.value);
    if(!teacher||!/^\d{4}-(0[1-9]|1[0-2])$/.test(f.period.value)){
      tell('请选择有效教师和月份',true);return;
    }
    if(!window.confirm('确认生成 '+teacher.name+' '+f.period.value+
      ' 的工资单草稿？同一教师本月不能重复生成。'))return;
    act(()=>window.api.generateSettlement({teacher_id:teacher.id,period:f.period.value}),
      '工资单草稿已建立，请先核对课酬明细，再确认锁定');
  });
  function settle(row) {
    if(model.user.role!=='super_admin'||row.status!=='draft')return;
    if(!window.confirm('确认将 '+row.teacher_name+' '+row.period+' 的应发课酬 '+
      money(row.total_salary)+' 锁定为已结算吗？确认后不得直接修改，只能经审批调账。'))return;
    act(()=>window.api.settleSalary(row.id),'工资单已锁定并归档，不能再次结算');
  }
  async function start() {
    model.user=await window.api.whoAmI();
    if(!model.user||!['super_admin','admin'].includes(model.user.role)){
      window.location.replace('/login.html');return;
    }
    $('#actor').textContent=model.user.name+'（'+
      (model.user.role==='super_admin'?'超级管理员':'教务管理员')+'）';
    $('#salary-section').classList.toggle('hidden',model.user.role!=='super_admin');
    $('#period').value=new Date().toISOString().slice(0,7);
    await reload();
  }
  start().catch(e=>tell(e.message||'无法读取业务数据，请重新登录',true));
})();