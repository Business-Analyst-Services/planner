// Keep the planner in step when another tab (for example Boards → "Add to planner") changes saved tasks.
window.addEventListener('storage',e=>{if(e.key!==key||!e.newValue)return;try{const next=JSON.parse(e.newValue);if(Array.isArray(next.tasks)&&next.overrides){data=next;render()}}catch{}});
