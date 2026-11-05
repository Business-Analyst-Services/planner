(function(root){
 function model(summary,partialCount=0){
  const goal=Math.max(1,Math.min(21,Math.floor(Number(summary.goal)||1)));
  const completed=Math.max(0,Math.floor(Number(summary.completed)||0));
  const checkins=Math.max(0,Math.floor(Number(summary.checkins)||0));
  const partial=Math.max(0,Math.floor(Number(partialCount)||0));
  let message;
  if(completed>=goal)message='Weekly goal reached. Take a moment to enjoy it.';
  else if(completed===0){
   if(partial)message='You made some time for it. That effort counts, even if the session wasn’t finished.';
   else if(summary.status==='paused')message='Taking a break is okay. Your plan can meet you where you are.';
   else if(checkins)message='Thanks for checking in honestly. You can adjust your plan when you’re ready.';
   else message='A small first step is enough to begin. Go at your own pace.';
  }else if(completed===1)message='You’ve made a start—one session completed. Each one counts.';
  else if(goal-completed===1)message='One more to reach your goal. Each session counts.';
  else if(completed/goal>.5)message='More than halfway to your weekly goal.';
  else if(completed/goal===.5)message='Halfway to your weekly goal. Each session counts.';
  else message=completed+' sessions in. Each one counts.';
  return {goal,completed,checkins,partial,message,filled:Math.min(completed,goal)};
 }
 function render(summary,partialCount=0){const m=model(summary,partialCount);
  return `<div class="session-progress"><p class="minimum">${m.completed} of ${m.goal} sessions completed</p><div class="session-segments" role="progressbar" aria-label="Weekly sessions completed" aria-valuemin="0" aria-valuemax="${m.goal}" aria-valuenow="${m.filled}" aria-valuetext="${m.completed} of ${m.goal} sessions completed" style="--session-goal:${m.goal}">${Array.from({length:m.goal},(_,i)=>`<span aria-hidden="true" class="session-segment ${i<m.filled?'filled':''}">${i<m.filled?'✓':''}</span>`).join('')}</div><p class="progress-encouragement">${m.message}</p><p class="progress-context">${m.checkins} ${m.checkins===1?'check-in':'check-ins'} recorded${m.partial?' · '+m.partial+' '+(m.partial===1?'partly completed session':'partly completed sessions'):''}</p>${m.partial?'<p class="partial-credit">Partial effort is recognised here; only fully completed sessions fill the bar.</p>':''}</div>`;
 }
 function orderMembers(members,ownSlot){return ownSlot==null?[...members]:[...members.filter(p=>p.slot===ownSlot),...members.filter(p=>p.slot!==ownSlot)]}
 function weekDays(summary,logs,week){const m=model(summary),met=m.completed>=m.goal;return Array.from({length:7},(_,i)=>{const date=new Date(Date.parse(week+'T12:00:00Z')+i*86400000).toISOString().slice(0,10),dayLogs=logs.filter(l=>!l.deleted&&l.date===date),done=dayLogs.filter(l=>l.status==='done').length,partial=dayLogs.filter(l=>l.status==='partial').length,skipped=dayLogs.filter(l=>['skipped','paused','rescheduled'].includes(l.status)).length;return {date,day:['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],number:Number(date.slice(-2)),state:met?'goal-met':done?'day-done':partial?'day-partial':skipped?'day-skipped':'day-empty',symbol:met?'✓':done>1?String(done):done?'✓':partial?'◐':skipped?'–':'',label:met?'Weekly goal met; this green day represents the weekly target, not daily attendance':done?done+' completed session'+(done===1?'':'s'):partial?partial+' partly completed session'+(partial===1?'':'s'):skipped?'Skipped, paused or rescheduled check-in':'No check-in recorded'};})}
 root.CommitmentProgress={model,render,orderMembers,weekDays};
})(globalThis);
