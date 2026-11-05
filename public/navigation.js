function navigatePlannerDays(days){const date=add(selected,days);selected=date;anchor=date;render()}
function handlePlannerNavigation(e){
 if(e.defaultPrevented||e.isComposing||e.altKey||e.shiftKey||!['ArrowLeft','ArrowRight'].includes(e.key))return;
 if(actionMode==='simple'&&(e.metaKey||e.ctrlKey))return;
 if(document.querySelector('dialog[open]'))return;
 const target=e.target;
 if(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="tablist"]'))return;
 e.preventDefault();navigatePlannerDays((e.key==='ArrowLeft'?-1:1)*(actionMode==='simple'||e.metaKey||e.ctrlKey?7:1));
}
document.addEventListener('keydown',handlePlannerNavigation);
function renderPlannerNavigation(){
 const first=monday(anchor),last=add(first,6);
 $('#month').textContent=parse(first).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})+' – '+parse(last).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'});
 $('#month').setAttribute('aria-live','polite');
 $('#prev').textContent='‹ Previous';$('#next').textContent='Next ›';
 $('#prev').title='Previous week (⌘ ←)';$('#next').title='Next week (⌘ →)';
 $('#prev').onclick=()=>navigatePlannerDays(-7);$('#next').onclick=()=>navigatePlannerDays(7);
 $('#prev').setAttribute('aria-keyshortcuts','Meta+ArrowLeft Control+ArrowLeft');$('#next').setAttribute('aria-keyshortcuts','Meta+ArrowRight Control+ArrowRight');
 $('.toolbar').querySelector('.hideSmall').textContent='← / → day · ⌘ ← / → week';
 if(actionMode==='simple'){
  $('#actionprev').title='Previous week (←)';$('#actionnext').title='Next week (→)';
  $('#actionprev').setAttribute('aria-keyshortcuts','ArrowLeft');$('#actionnext').setAttribute('aria-keyshortcuts','ArrowRight');
 }
}
const renderBeforeNavigation=render;render=()=>{renderBeforeNavigation();renderPlannerNavigation()};render();
