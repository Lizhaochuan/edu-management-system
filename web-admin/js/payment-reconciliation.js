'use strict';
(() => {
  const $ = selector => document.querySelector(selector);
  const pattern = /^[A-Za-z0-9_-]{1,100}$/;
  const state = { user:null, receipt:null, records:[], students:[], courses:[], terms:[] };
  let busy = false;
  function message(text, error=false) {
    $('#notice').textContent = text;
    $('#notice').style.color = error ? '#ad3333' : '#216146';
  }
  function optionList(selector, rows, label) {
    const select=$(selector);
    select.replaceChildren();
    for(const row of rows) {
      const option=document.createElement('option');
      option.value=row.id;
      option.textContent=label(row);
      select.appendChild(option);
    }
  }
  function nameOf(items, id, field) {
    const item=items.find(x=>x.id===id);
    return item && item[field] ? item[field] : id;
  }
  function cell(row, value) {
    const td=document.createElement('td');
    td.textContent=String(value ?? '');
    row.appendChild(td);
  }
  async function load() {
    const res=await window.api.getPaymentReconciliations();
    if (!res || !res.data || !Array.isArray(res.data.items)) throw new Error('服务端付款列表格式无效');
    state.records=res.data.items;
    $('#mode').textContent=res.data.strict_mode ?
      '当前为严格模式：未核对的收款不能创建课时包。' :
      '当前为兼容模式：其他旧入口仍可能产生未核对购课记录。';
    const tbody=$('#rows');
    tbody.replaceChildren();
    for(const entry of state.records) {
      const tr=document.createElement('tr');
      tr.tabIndex=0;
      tr.setAttribute('aria-selected',String(state.receipt?.receipt_id===entry.receipt_id));
      cell(tr,entry.payment_reference);
      cell(tr,nameOf(state.students,entry.student_id,'name'));
      cell(tr,nameOf(state.courses,entry.course_id,'course_name'));
      cell(tr,'¥'+(entry.amount_cents/100).toFixed(2));
      cell(tr,entry.account_destination);
      cell(tr,entry.status);
      cell(tr,entry.submitted_by);
      tr.addEventListener('click',()=>choose(entry.receipt_id));
      tr.addEventListener('keydown',event=>{if(event.key==='Enter')choose(entry.receipt_id)});
      tbody.appendChild(tr);
    }
    if(state.receipt) {
      state.receipt=state.records.find(row=>row.receipt_id===state.receipt.receipt_id)||null;
    }
    renderSelection();
  }
  function choose(id) {
    state.receipt=state.records.find(row=>row.receipt_id===id)||null;
    for(const tr of $('#rows').children)tr.setAttribute('aria-selected','false');
    renderSelection();
    // Highlight the chosen row without injecting untrusted strings into HTML.
    const index=state.records.findIndex(r=>r.receipt_id===id);
    if(index>=0)$('#rows').children[index].setAttribute('aria-selected','true');
  }
  function renderSelection() {
    const entry=state.receipt;
    const review=entry&&entry.status==='pending'&&state.user.role==='super_admin'&&entry.submitted_by!==state.user.id;
    const purchasable=entry&&entry.status==='confirmed';
    $('#review-panel').classList.toggle('hidden',!review);
    $('#purchase-form').classList.toggle('hidden',!purchasable);
    $('#selection').textContent=entry ?
      '参考号 '+entry.payment_reference+' · '+entry.status+' · ¥'+(entry.amount_cents/100).toFixed(2)+
      ' · '+nameOf(state.students,entry.student_id,'name')+' · '+nameOf(state.courses,entry.course_id,'course_name') :
      '请点击上方收款记录。超管核对其他人员登记的收款，确认后才能按对应记录购课。';
  }
  function validReference(value) {
    const normalized=String(value||'').trim();
    if (!pattern.test(normalized)) throw new Error('流水参考号须为字母、数字、下划线或短横线');
    return normalized;
  }
  async function action(name,params,success) {
    if(busy) return;
    busy=true;
    document.querySelectorAll('button').forEach(button=>button.disabled=true);
    try {
      await window.api.executeCommand(name,params);
      message(success);
      await load();
    } catch(error) {
      message(error.message||'业务操作未完成，请按提示恢复原请求',true);
    } finally {
      busy=false;
      document.querySelectorAll('button').forEach(button=>button.disabled=false);
    }
  }
  $('#submit-form').addEventListener('submit',event=>{
    event.preventDefault();
    const form=event.currentTarget.elements;
    const amount=Number(form.amount.value);
    if (!Number.isFinite(amount)||amount<=0||!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(form.amount.value.trim())) {
      message('金额应大于零，最多两位小数',true);return;
    }
    let reference;
    try { reference=validReference(form.payment_reference.value); }
    catch(e){message(e.message,true);return;}
    action('payment.submit',{
      payment_reference:reference,
      student_id:form.student_id.value,
      course_id:form.course_id.value,
      amount,
      account_destination:form.account_destination.value
    },'已登记待核对收款；该操作不发放课时');
  });
  $('#confirm-form').addEventListener('submit',event=>{
    event.preventDefault();
    const receipt=state.receipt;
    if (!receipt || receipt.status!=='pending' ||
        state.user.role!=='super_admin' || receipt.submitted_by===state.user.id) {
      message('无权核对该付款',true);return;
    }
    let statement;
    try {statement=validReference(event.currentTarget.elements.statement_reference.value);}
    catch(e){message(e.message,true);return;}
    if(!window.confirm('请确认已经在官方银行或支付平台查证该笔交易真实入账，且金额与收款账户一致。系统不会自动验证此声明。'))return;
    action('payment.confirm',{
      payment_reference:receipt.payment_reference,statement_reference:statement
    },'已保存人工核对记录；可继续办理购课');
  });
  $('#reject-form').addEventListener('submit',event=>{
    event.preventDefault();
    const receipt=state.receipt;
    if (!receipt || receipt.status!=='pending' ||
        state.user.role!=='super_admin' || receipt.submitted_by===state.user.id) {
      message('无权拒绝该付款',true);return;
    }
    const reason=event.currentTarget.elements.reason.value.trim();
    if(!reason){message('请输入拒绝理由',true);return;}
    action('payment.reject',{payment_reference:receipt.payment_reference,reason},'已拒绝待核对收款');
  });
  $('#purchase-form').addEventListener('submit',event=>{
    event.preventDefault();
    const receipt=state.receipt;
    const fields=event.currentTarget.elements;
    if(!receipt || receipt.status!=='confirmed'){message('请选择已确认收款',true);return;}
    const paid=Number(fields.paid_hours_total.value),gift=Number(fields.gift_hours_total.value);
    if(!Number.isFinite(paid)||paid<=0||!Number.isFinite(gift)||gift<0||
      Math.abs(paid*100-Math.round(paid*100))>1e-6||
      Math.abs(gift*100-Math.round(gift*100))>1e-6){
      message('课时必须为非负且最多两位小数，付费课时需大于零',true);return;
    }
    if(!window.confirm('将使用这笔已人工核对的金额、课程、学员和收款账户创建课时包并自动冲抵历史欠课，确认继续吗？'))return;
    action('package.purchase',{
      payment_reference:receipt.payment_reference,
      student_id:receipt.student_id,course_id:receipt.course_id,
      total_amount:receipt.amount_cents/100,account_destination:receipt.account_destination,
      term_id:fields.term_id.value,paid_hours_total:paid,gift_hours_total:gift
    },'购课入账成功；请在课时账本核对余额');
  });
  $('#reload').addEventListener('click',()=>load().catch(error=>message(error.message,true)));
  async function boot() {
    const user=await window.api.whoAmI();
    if(!user || !['admin','super_admin'].includes(user.role)){
      window.location.replace('/login.html');return;
    }
    state.user=user;
    $('#identity').textContent=user.name+'（'+user.role+'）';
    const ctx=await window.api.commandContext();
    state.students=ctx.data.snapshot.students||[];
    state.courses=ctx.data.snapshot.courses_and_class_types||[];
    state.terms=ctx.data.snapshot.terms||[];
    optionList('#student',state.students,x=>x.name);
    optionList('#course',state.courses,x=>x.course_name);
    optionList('#term',state.terms,x=>x.name);
    await load();
  }
  boot().catch(error=>message(error.message||'无法读取服务器',true));
})();
