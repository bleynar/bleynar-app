(() => {
  'use strict';
  const root=document.querySelector('#issues');
  const dates=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'});
  function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
  function entry(item,lead){
    const card=node('details','issue-card');card.id=item.id;card.open=lead;
    const head=node('summary'),photo=node('img','article-art'),stamp=node('span','stamp'),title=node('span','issue-title');
    const headline=item.title.split(' · выпуск отозван')[0];
    photo.src='art/'+item.art+'.webp';photo.alt='Иллюстрация к новости «'+headline+'»';photo.width=960;photo.height=640;photo.draggable=false;if(!lead)photo.loading='lazy';
    const day=node('time','',dates.format(new Date(item.date+'T12:00:00Z')).replace(/ г\.$/,''));day.dateTime=item.date;
    stamp.append(node('b','',item.type==='release'?'Версия '+item.version:'Объявление'),day);
    title.append(node('strong','',headline));if(headline!==item.title)title.append(node('small','withdrawn','Выпуск отозван'));
    const arrow=node('span','chevron');arrow.setAttribute('aria-hidden','true');
    head.append(stamp,photo,title,arrow);card.append(head);
    const body=node('div','notes');let previous=null,list=null;
    for(const note of item.changes){
      if(previous!==note.kind){previous=note.kind;list=null;if(note.kind)body.append(node('h3','',note.kind));}
      if(item.type==='release'||item.format==='list'){if(!list){list=node('ul','patch-list');body.append(list);}list.append(node('li','',note.text));}
      else body.append(node('p','',note.text));
    }
    card.append(body);
    const link=node('a','permalink','Ссылка на новость');link.href='#'+item.id;card.append(link);return card;
  }
  function render(feed){
    if(feed.schema!==1||!Array.isArray(feed.items)||!feed.items.length||!feed.items.every(i=>/^[a-z0-9_-]+$/.test(i.id)&&/^[a-z0-9_-]+$/.test(i.art)&&Array.isArray(i.changes)))return;
    const open=new Set(Array.from(root.querySelectorAll('details[open]'),d=>d.id));
    const next=document.createDocumentFragment();
    feed.items.forEach((item,i)=>{if(i===1)next.append(node('h2','archive-title','История выпусков'));const card=entry(item,i===0);if(open.has(item.id))card.open=true;next.append(card);});
    root.replaceChildren(next);root.dataset.revision=String(feed.revision);
  }
  // Preserve the native disclosure and follow the same artwork as it changes size.
  function toggleSummary(event){
    const summary=event.target.closest('summary');
    if(!summary||!root.contains(summary)||event.target.closest('a,button')||event.defaultPrevented)return;
    const card=summary.parentElement;
    if(!Element.prototype.animate||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    event.preventDefault();
    const parts=[summary.querySelector('.article-art'),summary.querySelector('.issue-title')];
    const before=parts.map(part=>part.getBoundingClientRect()),height=card.getBoundingClientRect().height;
    for(const part of [card,...parts,card.querySelector('.notes')])part.getAnimations().forEach(animation=>animation.cancel());
    card.open=!card.open;
    const after=parts.map(part=>part.getBoundingClientRect()),end=card.getBoundingClientRect().height;
    const timing={duration:235,easing:'cubic-bezier(.22,0,.18,1)'};
    card.animate([{height:height+'px',overflow:'clip'},{height:end+'px',overflow:'clip'}],timing);
    parts.forEach((part,i)=>{
      const x=before[i].left-after[i].left,y=before[i].top-after[i].top;
      const scale=i===0&&after[i].width?before[i].width/after[i].width:1;
      part.animate([{transformOrigin:'top left',transform:'translate('+x+'px,'+y+'px) scale('+scale+')'},
                    {transformOrigin:'top left',transform:'none'}],timing);
    });
    if(card.open)card.querySelector('.notes').animate([{opacity:0},{opacity:1}],{duration:180,delay:55,fill:'backwards'});
  }
  root.addEventListener('click',toggleSummary);

  function reveal(){
    const id=location.hash.slice(1);if(!id)return;
    const target=document.getElementById(id);if(!target||!root.contains(target))return;
    if(target.tagName==='DETAILS')target.open=true;target.scrollIntoView({block:'start'});
  }
  window.addEventListener('hashchange',reveal);reveal();
  if(location.protocol==='https:'||location.protocol==='http:')fetch('feed.json',{cache:'no-cache',credentials:'omit'}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(feed=>{if(Number(feed.revision)>Number(root.dataset.revision)){render(feed);reveal();}}).catch(()=>{});
})();

