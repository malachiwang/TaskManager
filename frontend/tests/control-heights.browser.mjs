import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/Users/malachiwang/Projects/last-match/.cache/ms-playwright';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'/Users/malachiwang/Projects/last-match/node_modules/playwright/index.mjs');
const out=process.env.AUDIT_OUT||'/tmp/tm-simplify-03/heights';mkdirSync(out+'/crops',{recursive:true});
const browser=await chromium.launch({headless:true});const records=[],errors=[];
const modes=(process.env.AUDIT_PRIMARY_ONLY||process.argv.includes('--primary'))?[['dark',1440]]:['dark','light'].flatMap(mode=>[1440,1100,390].map(width=>[mode,width]));
const metadata={browser:browser.version(),date:new Date().toISOString(),viewports:modes.map(([theme,width])=>({theme,width,height:900})),baseline:'37c60e50a0295c484686ba951fa6d25d8b61c09c',current:'7ad3add5b0857f42bd846beed26c58be7670e22a + uncommitted TM-SIMPLIFY-03'};
const flush=()=>writeFileSync(out+'/measurements.json',JSON.stringify({metadata,records,errors},null,2));
try{
for(const [theme,width] of modes)for(const [build,port] of [['baseline',15201],['current',15202]]){
 const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,colorScheme:theme,locale:'en-US',timezoneId:'America/New_York'});
 const page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push({build,theme,width,error:String(e)}));
 // Only this disposable context receives settings; no installed app profile is read or changed.
 await page.addInitScript(theme=>localStorage.setItem('taskos-appearance',JSON.stringify({mode:theme,theme:'classic',accent:'blue',motion:'off'})),theme);
 await page.goto(`http://127.0.0.1:${port}`);const btn=(name,root=page)=>root.getByRole('button',{name,exact:true});
 const loc=s=>page.locator(s);await loc('td.col-task').filter({hasText:'Current active task'}).waitFor().catch(async e=>{console.log(await page.locator('body').innerText());throw e;});
 metadata.gridRows ||= [];metadata.gridRows.push({build,theme,width,heights:await loc('tr[data-task-id]').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height))});
 const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
 const sheets=new Map();cdp.on('CSS.styleSheetAdded',({header})=>sheets.set(header.styleSheetId,header));
 // Re-enable to obtain stylesheet headers.
 await cdp.send('CSS.disable');await cdp.send('CSS.enable');
 async function settle(){await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});}
 const props=['fontFamily','fontSize','fontWeight','fontStyle','lineHeight','height','minHeight','maxHeight','paddingTop','paddingBottom','borderTopWidth','borderBottomWidth','boxSizing','display','alignItems','alignSelf','appearance','outlineStyle','outlineWidth','outlineOffset'];
 async function read(el){return el.evaluate((n,props)=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();const parent=getComputedStyle(n.parentElement);let textBounds=null;
 const ranges=[...n.childNodes].filter(x=>x.nodeType===Node.TEXT_NODE&&x.textContent.trim()).map(x=>{const range=document.createRange();range.selectNodeContents(x);const q=range.getBoundingClientRect();return {top:q.top-r.top,bottom:q.bottom-r.top,height:q.height};});if(ranges.length)textBounds=ranges;
 return {height:r.height,width:r.width,rect:{x:r.x,y:r.y,width:r.width,height:r.height},styles:Object.fromEntries(props.map(k=>[k,s[k]])),text:n.matches('input,select,textarea')?n.value:n.textContent.trim(),aria:n.getAttribute('aria-label'),disabled:n.disabled??false,pressed:n.getAttribute('aria-pressed'),selected:n.getAttribute('aria-current'),classes:n.className,textBounds,parent:{display:parent.display,alignItems:parent.alignItems,alignSelf:parent.alignSelf},scale:visualViewport.scale,dpr:devicePixelRatio,zoom:getComputedStyle(document.documentElement).zoom,fontsStatus:document.fonts.status,focusVisible:n.matches(':focus-visible')};},props);}
 async function snap(el,path){const b=await el.boundingBox();const x=Math.max(0,Math.floor(b.x-5)),y=Math.max(0,Math.floor(b.y-5));await page.screenshot({path,clip:{x,y,width:Math.min(width-x,Math.ceil(b.x+b.width+5)-x),height:Math.min(900-y,Math.ceil(b.y+b.height+5)-y)}});}
 async function measure(group,id,el,expected,{states=true,newControl=false}={}){
  assert.equal(await el.count(),1,`${build} ${id}: expected one control`);await el.waitFor({state:'visible'});await el.scrollIntoViewIfNeeded();await page.mouse.move(width-1,899);await el.evaluate(n=>n.blur());await settle();
  const normal=await read(el);assert(normal.height>0&&normal.width>0&&normal.rect.y>=-1&&normal.rect.y<900,`${id} not on screen`);assert.match(normal.text+' '+(normal.aria||''),expected,`${id} unexpected content`);assert.equal(normal.scale,1);assert.equal(normal.dpr,1);assert.equal(normal.zoom,'1');assert.equal(normal.fontsStatus,'loaded');
  const record={build,theme,viewport:width,group,id,newControl,normal};
  const token=`${build}-${theme}-${width}-${id}`;await el.evaluate((n,id)=>n.setAttribute('data-audit-id',id),token);
  if(width===1440&&theme==='dark'){
   const {root}=await cdp.send('DOM.getDocument');const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector:`[data-audit-id="${token}"]`});
   record.platformFonts=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts;
   const matched=await cdp.send('CSS.getMatchedStylesForNode',{nodeId});
   const relevant=/^(height|min-height|max-height|padding.*|line-height|border.*|box-sizing|font.*|align.*|display|flex.*)$/;
   record.matchedRules=(matched.matchedCSSRules||[]).map(({rule})=>({selector:rule.selectorList.text,origin:rule.origin,line:(rule.style.range?.startLine??-1)+1,source:sheets.get(rule.style.styleSheetId)?.sourceURL,properties:rule.style.cssProperties.filter(p=>relevant.test(p.name)&&!p.disabled).map(p=>({name:p.name,value:p.value,important:p.important}))})).filter(r=>r.properties.length);
  }
  record.crop=`crops/${token}.png`;await snap(el,out+'/'+record.crop);
  if(states&&!normal.disabled){
   await el.hover();await settle();record.hover=await read(el);
   // Keyboard modality first, then focus the exact measured element without invoking its action.
   await page.keyboard.press('Shift');await el.focus();await settle();record.focus=await read(el);
   if(width===1440&&theme==='dark'&&['nav-main','add-task','jump','search','help','cal-today','report-history','reading-add','settings-change','dialog-cancel'].includes(id)){
    record.focusCrop=`crops/${token}-focus.png`;await snap(el,out+'/'+record.focusCrop);
   }
   await el.evaluate(n=>n.blur());
  }
  if(build==='current'){
   if(record.hover)assert.equal(record.hover.height,normal.height,`${id} resized on hover`);
   if(record.focus)assert.equal(record.focus.height,normal.height,`${id} resized on focus`);
  }
  records.push(record);flush();
 }
 async function list(group,defs){for(const [id,selector,expected] of defs)await measure(group,id,loc(selector),new RegExp(expected));}
 if(build==='current'){
  const center=async()=>{
   const h=await loc('.ws-sheet-header--task').boundingBox(),d=await loc('.sheet-date-controls').boundingBox();
   assert.ok(Math.abs(h.x+h.width/2-d.x-d.width/2)<=1,'date center drift');
   return {header:h.x+h.width/2,date:d.x+d.width/2};
  };
  await settle();metadata.headerCenters ||= [];metadata.headerCenters.push({theme,width,state:'default',...await center()});
  // Layout stress only in this disposable page, restored before measurement.
  const left=loc('.ws-sheet-meta'),utilities=loc('.ws-sheet-header--task > .header-utilities');
  const original=await left.innerHTML();await left.evaluate(n=>n.textContent='123456 active · 98765 paused · 222221 total');
  await utilities.evaluate(n=>n.style.width='240px');await settle();
  metadata.headerCenters.push({theme,width,state:'unequal side content',...await center()});
  await left.evaluate((n,v)=>n.innerHTML=v,original);await utilities.evaluate(n=>n.style.removeProperty('width'));await settle();
  await page.screenshot({path:`${out}/${theme}-${width}-header.png`});
 }
 // Navigation and grid toolbar.
 for(const name of ['Main','Grid','Reading','Calendar','Reports','Settings'])await measure('navigation','nav-'+name.toLowerCase(),btn(name),new RegExp(name));
 await list('grid',[
 ['add-task','.ws-shelf-btn--primary','Add Task'],['edit-disabled','.ws-shelf-btn:not(.ws-shelf-btn--primary)','Edit Task'],
 ['filter-all','.ws-filter-seg-btn >> text="All"','All'],['filter-active','.ws-filter-seg-btn >> text="Active"','Active'],['filter-hiatus','.ws-filter-seg-btn >> text="Hiatus"','Hiatus'],['filter-finished','.ws-filter-seg-btn >> text="Finished"','Finished'],
 ['group','.ws-group-btn','Group'],['jump','.ws-filter-pill','Jump'],['month-prev','.ws-sheet-nav:first-child','‹'],['month-today','.ws-sheet-nav--today','Today'],['month-next','.ws-sheet-nav:last-child','›'],['search','.workspace-search-field input','Search workspace'],['help','.ws-kbd-help-btn','Keyboard shortcuts']]);
 await btn('All',loc('.ws-filter-seg')).click();await measure('grid','filter-all-active',btn('All',loc('.ws-filter-seg')),/All/);
 await btn('Active',loc('.ws-filter-seg')).click();await measure('grid','filter-active-active',btn('Active',loc('.ws-filter-seg')),/Active/);
 // Existing ordering affordances are drag handles, not a toolbar Order button. Do not drag or write data.
 await measure('grid','task-order',loc('tr[data-task-id]').filter({hasText:'Current active task'}).locator('.drag-handle'),/reorder|⋮|⠿|⠇/,{states:false});
 await loc('.ws-group-btn').click();await measure('grid','group-open',loc('.ws-group-btn'),/Group/);await measure('grid','group-section',page.getByRole('option',{name:'Section',exact:true}),/Section/);await page.keyboard.press('Escape');
 // Select through read-only search reveal so Edit becomes enabled without writing task data.
 const search=page.getByRole('combobox',{name:'Search workspace'});await search.fill('Current active task');await page.getByRole('option').filter({hasText:'Current active task'}).first().click();
 await measure('grid','edit-enabled',btn('Edit Task'),/Edit Task/);
 await btn('Edit Task').click();await loc('#tm-name').waitFor();
 await measure('dialog','dialog-name',loc('#tm-name'),/Current active task/);
 await measure('dialog','dialog-section',loc('#tm-section'),/Work/);
 await measure('dialog','dialog-interval',loc('#tm-interval'),/3/);
 await measure('dialog','dialog-status-active',btn('Active',loc('.task-modal-seg')),/Active/);
 await measure('dialog','dialog-status-hiatus',btn('Hiatus',loc('.task-modal-seg')),/Hiatus/);
 await measure('dialog','dialog-cancel',loc('.task-modal-actions .task-modal-cancel'),/Cancel/);
 await measure('dialog','dialog-save',loc('.task-modal-actions .task-modal-save'),/Save/);
 await measure('dialog','dialog-delete',loc('.task-modal-delete-btn'),/Delete/);
 await loc('.task-modal-actions .task-modal-cancel').click();
 await search.fill('January note needle');
 const ordinary = page.getByRole('option').filter({hasText:'Current task'}).first();await ordinary.click();
 await page.locator('.ws-sheet-range').filter({hasText:'Jan 1'}).waitFor();
 await measure('history','history-month-prev',loc('.ws-sheet-nav:first-child'),/‹/);
 if(build==='current'){
   assert.equal(await page.locator('.month-history, .month-version-select, [data-history-task]').count(),0);
   assert.equal(await page.locator('.live-grid').isVisible(),true);
 }
 // Reading.
 await btn('Reading').click();await btn('+ Add Book').waitFor();
 await measure('reading','reading-tab-active',btn('Reading'),/Reading/);
 for(const name of ['+ Add Book','Library','To Buy','Active','Finished','Hidden','All'])await measure('reading','reading-'+({' + Add Book':'add'}[name]||name.replace('+ Add Book','add').replaceAll(' ','-').toLowerCase()),btn(name),new RegExp(name.replace('+','\\+')));
 await measure('reading','reading-edit',loc('.reading-row .action-btn').filter({hasText:/^Edit$/i}).first(),/Edit/i);
 await measure('reading','reading-page',loc('.rd-page-input').first(),/0/);
 // Calendar: standard density and Week default retained; only toggle view, not session data.
 await btn('Calendar').click();await loc('.cal-toolbar').waitFor();await loc('.cal-block').first().waitFor();
 await measure('calendar','calendar-tab-active',btn('Calendar'),/Calendar/);
 await list('calendar',[
 ['cal-today','.cal-nav-btn--today','Today'],['cal-prev','.cal-nav-btn[aria-label="Previous period"]','Previous period'],['cal-next','.cal-nav-btn[aria-label="Next period"]','Next period'],
 ['cal-week','.cal-seg-btn >> text="Week"','Week'],['cal-day','.cal-seg-btn >> text="Day"','Day'],['cal-density','.cal-nav-btn[title*="density"]','Standard'],['cal-command','.cal-nav-btn[title*="palette"]','⌘|command|Command'],
 ['cal-calendars','.cal-nav-btn >> text="Calendars"','Calendars'],['cal-import','.cal-nav-btn >> text="Import"','Import'],['cal-shift','.cal-nav-btn >> text="Shift"','Shift'],['cal-windows','.cal-nav-btn >> text="Windows"','Windows'],['cal-hide-done','.cal-nav-btn >> text="Hide done"','Hide done'],['cal-unscheduled','.cal-drawer-toggle','Unscheduled']]);
 metadata.calendarGeometry ||= [];metadata.calendarGeometry.push({build,theme,viewport:width,...await loc('.cal-block').filter({hasText:'Prepare research outline'}).first().evaluate(n=>({top:n.style.top,height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width}))});
 await measure('calendar','cal-event',loc('.cal-block').filter({hasText:'Prepare research outline'}).first(),/Prepare research outline/,{states:false});
 await btn('Day',loc('.cal-toolbar')).click();await measure('calendar','cal-day-active',btn('Day',loc('.cal-toolbar')),/Day/);await btn('Week',loc('.cal-toolbar')).click();
 if(build==='current')await measure('calendar','cal-help-new',loc('.ws-kbd-help-btn'),/Keyboard shortcuts/,{newControl:true});
 // Reports actions and History period controls.
 await btn('Reports').click();await loc('.dashboard-command-panel').waitFor();
 await measure('reports','reports-tab-active',btn('Reports'),/Reports/);
 for(const name of ['Today','History','Execution'])await measure('reports','report-'+name.toLowerCase(),btn(name,loc('[aria-label="Report view"]')),new RegExp(name));
 await measure('reports','report-dismiss',loc('.dashboard-rec-btn').filter({hasText:/^Dismiss$/}).first(),/Dismiss/);
 await measure('reports','report-snooze',loc('.dashboard-rec-btn').filter({hasText:/Snooze/}).first(),/Snooze/);
 await btn('History',loc('[aria-label="Report view"]')).click();await loc('.report-nav').first().waitFor();
 await measure('reports','report-history-active',btn('History',loc('[aria-label="Report view"]')),/History/);
 for(const name of ['Week','Month','Quarter','Year'])await measure('reports','report-period-'+name.toLowerCase(),btn(name,loc('[aria-label="Report period"]')),new RegExp(name));
 await measure('reports','report-prev',loc('.report-nav').first(),/‹/);await measure('reports','report-current',loc('.report-nav--today'),/Current/);await measure('reports','report-next',loc('.report-nav').last(),/›/);
 // Settings: inspect only, never save or change preferences.
 await btn('Settings').click();await btn('Change').first().waitFor();
 await measure('settings','settings-tab-active',btn('Settings'),/Settings/);
 for(const name of ['System','Light','Dark'])await measure('settings','settings-mode-'+name.toLowerCase(),btn(name),new RegExp(name));
 await measure('settings','settings-section',loc('.settings-input').first(),/General/);
 await measure('settings','settings-priority',loc('.settings-input').nth(1),/5/);
 await measure('settings','settings-save',btn('Save defaults'),/Save defaults/);
 await measure('settings','settings-change',btn('Change').first(),/Change/);
 await measure('settings','settings-export',btn('Export…'),/Export/);
 await context.close();console.log('Completed',build,theme,width,records.filter(r=>r.build===build&&r.theme===theme&&r.viewport===width).length,'controls');flush();
}
// The primary reference is measured in the same browser run, not inferred from CSS.
for(const theme of ['dark','light']){
 const baseline=new Map(records.filter(r=>r.build==='baseline'&&r.theme===theme&&r.viewport===1440).map(r=>[r.id,r]));
 for(const r of records.filter(r=>r.build==='current'&&r.theme===theme&&r.viewport===1440&&!r.newControl)){
  assert.ok(baseline.has(r.id),`${r.id} missing baseline`);
  assert.ok(Math.abs(r.normal.height-baseline.get(r.id).normal.height)<=1/64,`${r.id} differs from rendered baseline`);
 }
}
assert.deepEqual(errors,[]);console.log('PASS rendered desktop heights, stable hover/focus, centered header and removed snapshot UI:',records.length,'measurements');
}finally{flush();await browser.close();}
