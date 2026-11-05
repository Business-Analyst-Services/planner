/* One-time calendar exports. No calendar account access or background sync. */
(function(root){
  const pad=n=>String(n).padStart(2,'0');
  function instant(day,time,zone){
    const parts=(day+'T'+time).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if(!parts)throw Error('Choose a valid date and time first.');
    const [,y,m,d,h,min]=parts.map(Number),wall=Date.UTC(y,m-1,d,h,min);
    const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    const local=t=>{const p=Object.fromEntries(fmt.formatToParts(new Date(t)).map(p=>[p.type,p.value]));return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)};
    let t=wall;for(let i=0;i<5;i++){const delta=wall-local(t);if(!delta)break;t+=delta}
    if(local(t)!==wall)throw Error('This time does not exist in the selected timezone. Choose another time.');
    return new Date(t);
  }
  const stamp=d=>d.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
  function times(e){const start=instant(e.day,e.time,e.timezone),duration=Number(e.duration);if(!Number.isFinite(duration)||duration<=0)throw Error('Choose a valid duration.');return [start,new Date(start.getTime()+duration*60000)]}
  function url(e,provider){
    const [a,b]=times(e);let u;
    if(provider==='google'){u=new URL('https://calendar.google.com/calendar/render');u.search=new URLSearchParams({action:'TEMPLATE',text:e.title,dates:stamp(a)+'/'+stamp(b),ctz:e.timezone,details:e.description||'',location:e.location||''}).toString()}
    else {u=new URL(provider==='outlook-work'?'https://outlook.office.com/calendar/0/deeplink/compose':'https://outlook.live.com/calendar/0/deeplink/compose');u.search=new URLSearchParams({path:'/calendar/action/compose',rru:'addevent',subject:e.title,startdt:a.toISOString(),enddt:b.toISOString(),body:e.description||'',location:e.location||''}).toString()}
    return u.href;
  }
  const escape=s=>String(s||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');
  function fold(line){let lines=[],chunk='',bytes=0;for(const c of line){const n=new TextEncoder().encode(c).length;if(bytes+n>75){lines.push(chunk);chunk=' ';bytes=1}chunk+=c;bytes+=n}lines.push(chunk);return lines.join('\r\n')}
  function ics(e){const [a,b]=times(e);return ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Community Planner//Calendar Export//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','BEGIN:VEVENT','UID:'+escape(e.uid),'DTSTAMP:'+stamp(new Date()),'DTSTART:'+stamp(a),'DTEND:'+stamp(b),'SUMMARY:'+escape(e.title),'DESCRIPTION:'+escape(e.description),'LOCATION:'+escape(e.location),'END:VEVENT','END:VCALENDAR'].map(fold).join('\r\n')+'\r\n'}
  function download(e,filename){const blob=new Blob([ics(e)],{type:'text/calendar;charset=utf-8'}),object=URL.createObjectURL(blob),a=document.createElement('a');a.href=object;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(object),10000)}
  root.CalendarExport={instant,times,url,ics,download};
})(globalThis);
