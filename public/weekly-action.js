// The planner is the only local view. Commitments are owned by My Group.
let actionMode='planner';
function activeWeeklyAction(week){const candidates=[...weeklyTasks(week),...Array.from({length:7},(_,i)=>tasks(add(week,i))).flat()];return candidates.find(t=>t.weeklyActionKey===week)}
document.querySelector('header').insertAdjacentHTML('afterend','<nav id="actionnav" class="view-tabs" aria-label="Main views"><a id="plannermode" class="view-tab" href="/" aria-current="page">Full Planner</a><a class="view-tab" href="/circle">My Group</a></nav>');
function renderWeeklyAction(){$('.workspace').style.display='';$('.toolbar').style.display='';$('#new').hidden=false}
$('#plannermode').onclick=e=>{e.preventDefault();render()};
const renderBeforeWeeklyAction=render;render=()=>{renderBeforeWeeklyAction();renderWeeklyAction()};render();
