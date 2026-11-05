// Matched toolbar checks. Use only the disposable fixture described in TM-SIMPLIFY-04.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||process.argv[2]||'playwright');
const out=process.env.TM_TEST_ARTIFACTS||'/tmp/tm-simplify-04/evidence';mkdirSync(out,{recursive:true});
const widths=process.argv.includes('--quick')?[1440]:[1440,1100,390];
const themes=process.argv.includes('--quick')?['dark']:['dark','light'];
const browser=await chromium.launch({headless:true});const records=[],errors=[];
const fixtureWidths={'col-task':180,'col-sub':120,'col-freq':44,'col-days':44,'col-notes':100};
const result={browser:browser.version(),dpr:1,zoom:1,fixtureWidths,records,errors};
const save=()=>writeFileSync(out+'/toolbar-measurements.json',JSON.stringify(result,null,2)+'\n');
try{
for(const theme of themes)for(const width of widths)for(const [build,port] of [['baseline',15301],['before',15302],['current',15303]]){
 const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,colorScheme:theme,locale:'en-US',timezoneId:'America/New_York'});
 const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(String(e)));
 await page.clock.setFixedTime(new Date('2026-10-30T16:00:00Z'));
 await page.addInitScript(({theme,fixtureWidths})=>{
  localStorage.setItem('taskos-appearance',JSON.stringify({mode:theme,theme:'classic',accent:'blue',motion:'off'}));
  if(!localStorage.getItem('taskos-col-widths'))localStorage.setItem('taskos-col-widths',JSON.stringify(fixtureWidths));
  localStorage.setItem('taskos-saved-views',JSON.stringify({version:1,views:[{id:'old',name:'Old view',filter:'active',groupMode:'section',searchQuery:'hidden'}]}));
 },{theme,fixtureWidths});
 await page.goto(`http://127.0.0.1:${port}`);
 const task=page.locator('tr[data-task-id]').filter({hasText:'Current active task'});await task.waitFor().catch(async e=>{console.log(await page.locator('body').innerText());throw e;});
 const button=(name,root=page)=>root.getByRole('button',{name,exact:true});
 const settle=()=>page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 async function metrics(el){await el.waitFor({state:'visible'});return el.evaluate(n=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return {text:n.textContent.trim(),x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,fontFamily:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,lineHeight:s.lineHeight,padding:s.padding,border:s.border,borderColor:s.borderColor,radius:s.borderRadius,background:s.backgroundColor,color:s.color,textTransform:s.textTransform,letterSpacing:s.letterSpacing,textOverflow:s.textOverflow,outline:s.outline,outlineOffset:s.outlineOffset};});}
 const row={build,theme,width,controls:{}};
 for(const [id,selector] of Object.entries({add:'.ws-shelf-btn--primary',edit:'.ws-shelf-btn:not(.ws-shelf-btn--primary)',filter:'.ws-filter-seg-btn',group:'.ws-group-btn',jump:'.ws-filter-pill',today:'.ws-sheet-nav--today',search:'.workspace-search-field input',help:'.ws-kbd-help-btn'}))row.controls[id]=await metrics(page.locator(selector).first());
 row.navigation=await Promise.all(['Main','Grid','Reading','Calendar','Reports','Settings'].map(name=>metrics(button(name))));
 row.filter=await metrics(page.locator('.ws-filter-bar'));row.header=await metrics(page.locator('.ws-sheet-header'));
 if(build!=='before')row.shelf=await metrics(page.locator('.ws-grid-shelf'));
 row.fontStatus=await page.evaluate(()=>document.fonts.status);row.scale=await page.evaluate(()=>({dpr:devicePixelRatio,zoom:visualViewport.scale}));
 assert.deepEqual(row.scale,{dpr:1,zoom:1});assert.equal(row.fontStatus,'loaded');
 assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('taskos-col-widths'))),fixtureWidths);
 row.gridRows=await page.locator('tr[data-task-id]').evaluateAll(ns=>ns.map(n=>n.getBoundingClientRect().height));
 if(build==='current'){
  assert.equal(row.shelf.height,38);assert.equal(row.controls.add.height,36);assert.equal(row.controls.edit.height,36);
  assert.equal(row.shelf.y,(await metrics(page.locator('.app-header'))).bottom);
  assert.equal(row.header.y,row.shelf.bottom);assert.equal(row.filter.y,row.header.bottom);
  assert.equal(await page.locator('.ws-filter-bar .ws-shelf-btn').count(),0);
  assert.equal(await page.locator('.ws-inspector-strip').count(),0);
  for(const c of [row.controls.add,row.controls.edit]){assert.equal(c.radius,'0px');assert.equal(c.textTransform,'uppercase');assert.equal(c.padding,'0px 14px');}
  for(const property of ['fontFamily','fontSize','fontWeight','letterSpacing','padding','radius'])assert.equal(row.controls.add[property],row.controls.edit[property],property);
  if(width>700)assert.equal(row.filter.height,34);
  for(const c of row.navigation){assert.equal(c.height,23);assert.equal(c.radius,'2px');assert.notEqual(c.borderColor,'rgba(0, 0, 0, 0)');}
  for(const [id,height] of Object.entries({filter:19,group:19,jump:19,today:18,search:33,help:20}))assert.equal(row.controls[id].height,height,id);
  assert.equal(row.controls.filter.radius,'0px');assert.equal(row.controls.group.radius,'0px');assert.equal(row.controls.jump.radius,'0px');
  const date=await metrics(page.locator('.sheet-date-controls'));row.headerCenter=row.header.x+row.header.width/2;row.dateCenter=date.x+date.width/2;assert.ok(Math.abs(row.headerCenter-row.dateCenter)<=1);
  assert.equal(await page.locator('.topbar-network-canvas').count(),1);
  assert.equal(await button('Edit Task').isDisabled(),true);assert.equal(await button('Edit Task').getAttribute('aria-describedby'),'edit-task-guidance');
  assert.match(await page.locator('#edit-task-guidance').textContent(),/Select a task/);
  assert.equal(await page.locator('.month-history,.month-version-select,[data-history-task]').count(),0);
  const search=await metrics(page.locator('.workspace-search-field')),help=row.controls.help;assert.ok(help.x>=search.x+search.width&&help.x-search.x-search.width<16);
 }
 // Reference visibility comes from scrolling non-frozen metadata behind Subtask, not deleting columns.
 const wrapper=page.locator('.grid-wrapper');await wrapper.evaluate((n,x)=>{n.scrollLeft=x;n.scrollTop=0;},width>700?188:0);await settle();
 row.scrollLeft=await wrapper.evaluate(n=>n.scrollLeft);
 await page.screenshot({path:`${out}/${build}-${theme}-${width}-grid.png`});
 // Alt-click selects without changing completion data.
 const cell=task.locator('td[data-dc-date="2026-10-01"]');await cell.scrollIntoViewIfNeeded();await cell.click({modifiers:['Alt']});
 await page.locator('.ws-inspector-strip').waitFor();await wrapper.evaluate((n,x)=>{n.scrollLeft=x;n.scrollTop=0;},width>700?188:0);await settle();
 row.selection=await page.locator('.edit-bar-info').innerText();assert.match(row.selection,/Current active task/);
 await page.screenshot({path:`${out}/${build}-${theme}-${width}-selected.png`});
 if(build==='current'){
  assert.equal(await button('Edit Task').isDisabled(),false);assert.equal((await metrics(button('Edit Task'))).height,36);
  await button('Edit Task').click();await page.locator('#tm-name').waitFor();assert.equal(await page.locator('#tm-name').inputValue(),'Current active task');await button('Cancel').click();
  await button('+ Add Task').click();await page.locator('#tm-name').waitFor();assert.equal(await page.locator('#tm-name').inputValue(),'');await button('Cancel').click();
  await button('Hiatus').click();assert.equal(await page.locator('tr[data-task-id]').count(),0);await button('All',page.locator('.ws-filter-seg')).click();
  await page.locator('.ws-group-btn').click();await page.getByRole('option',{name:'None',exact:true}).click();assert.equal(await page.locator('.ws-section-title').count(),0);
  await page.locator('.ws-group-btn').click();await page.getByRole('option',{name:'Section',exact:true}).click();await task.waitFor();
  assert.ok(await task.locator('.drag-handle').isVisible());
  await button('Jump').click();await page.getByRole('dialog',{name:/jump/i}).waitFor();await page.keyboard.press('Escape');
  await button('Previous month').click();assert.match(await page.locator('.ws-sheet-range').innerText(),/Sep/);await button('Next month').click();assert.match(await page.locator('.ws-sheet-range').innerText(),/Oct/);
  const search=page.getByRole('combobox',{name:'Search workspace'});await search.fill('Current active task');await page.getByRole('option').filter({hasText:'Current active task'}).waitFor();await search.press('ArrowDown');await search.press('Enter');await page.locator('.ws-inspector-strip').waitFor();
  await button('Reading').click();await button('+ Add Book').waitFor();await button('Reports').click();await page.locator('.dashboard-command-panel').waitFor();assert.deepEqual(await page.locator('.app-utility-nav button').allTextContents(),['Main','Reports','Settings']);await button('Main').click();assert.equal(await button('Reading').getAttribute('aria-current'),'page');await button('Grid').click();await task.waitFor();
  await page.reload();await task.waitFor();assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('taskos-col-widths'))),fixtureWidths);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('taskos-appearance')).mode),theme);
  // Optional columns at scroll zero, including a deliberately narrow saved Freq width.
  await wrapper.evaluate(n=>{n.scrollLeft=0;n.scrollTop=0;});await settle();
  row.frequency=await metrics(page.locator('th.col-freq'));row.frequencyText=await page.locator('th.col-freq').evaluate(n=>{const range=document.createRange();range.selectNodeContents(n.firstChild);return range.getBoundingClientRect().width;});
  // Full original labels; like b15a9f6, they clip at narrow default widths (title keeps the full name).
  assert.equal((await page.locator('th.col-freq').evaluate(n=>n.firstChild.textContent)).trim(),'Frequency');
  assert.equal(row.frequency.textOverflow,'clip');
  row.shortLabels=await page.locator('th.col-urg,th.col-pri').evaluateAll(ns=>ns.map(n=>({text:n.firstChild.textContent.trim(),textOverflow:getComputedStyle(n).textOverflow,transform:getComputedStyle(n).textTransform})));assert.deepEqual(row.shortLabels.map(c=>c.text),['Urgency','Priority']);for(const c of row.shortLabels){assert.equal(c.textOverflow,'clip');assert.equal(c.transform,'uppercase');}
  row.labelStyles=await Promise.all([page.locator('th.col-task'),page.locator('.ws-section-title').first()].map(metrics));for(const c of row.labelStyles)assert.equal(c.textTransform,'uppercase');
  for(const name of ['Main','Grid','Reading','Calendar','Reports','Settings','+ Add Task','Jump']){
   const el=button(name);await el.scrollIntoViewIfNeeded();const normal=await metrics(el);await el.hover();assert.equal((await metrics(el)).height,normal.height);await page.keyboard.press('Shift');await el.focus();const focused=await metrics(el);assert.equal(focused.height,normal.height);assert.match(focused.outline,/solid/);await el.evaluate(n=>n.blur());
  }
  await button('+ Add Task').focus();await page.screenshot({path:`${out}/current-${theme}-${width}-focus-columns.png`});
  await page.evaluate(()=>{const widths=JSON.parse(localStorage.getItem('taskos-col-widths'));widths['col-freq']=24;localStorage.setItem('taskos-col-widths',JSON.stringify(widths));});await page.reload();await task.waitFor();
  const narrow=await metrics(page.locator('th.col-freq'));assert.equal(narrow.width,24);assert.equal(narrow.textOverflow,'clip');row.narrowFrequency=narrow;
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 records.push(row);save();console.log('PASS',build,theme,width);await context.close();
}
assert.deepEqual(errors,[]);
console.log('PASS matched toolbar structure, height spot checks, preserved widths/theme and read-only interactions');
}finally{save();await browser.close();}
