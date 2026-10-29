// Use only disposable TM-SIMPLIFY fixtures; this check opens editors but does not restore data.
// Same installed-Playwright convention as simplify.browser.mjs.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || process.argv[2] || 'playwright');
const output = process.env.TM_TEST_ARTIFACTS || '/tmp/tm-simplify-02-evidence';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({headless:true});
const records = [], errors = [];
try {
  for (const [mode,width,height] of [['dark',1440,1000],['dark',1100,850],['dark',390,844],['light',1440,1000]]) {
    const context = await browser.newContext({viewport:{width,height}});
    const page = await context.newPage();
    page.on('pageerror',e=>errors.push(String(e)));
    await page.addInitScript(mode => localStorage.setItem('taskos-appearance',JSON.stringify({mode,theme:'classic',accent:'blue',motion:'off'})),mode);
    const button=name=>page.getByRole('button',{name,exact:true});
    const search=page.getByRole('combobox',{name:'Search workspace'});
    await page.goto(process.env.TM_TEST_URL || 'http://127.0.0.1:15173');
    await button('+ Add Task').waitFor();
    async function capture(name) {
      await page.evaluate(()=>document.fonts.ready);
      const audit=await page.evaluate(()=>{
        const family=getComputedStyle(document.body).fontFamily;
        const visible=el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
        const elements=[...document.querySelectorAll('body *')].filter(el=>visible(el)&&(el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||el.matches('button,input,select,textarea,kbd')));
        return {family,fontsReady:document.fonts.status,overflow:document.documentElement.scrollWidth>innerWidth,
          mismatches:elements.filter(el=>getComputedStyle(el).fontFamily!==family).map(el=>({tag:el.tagName,class:el.className,font:getComputedStyle(el).fontFamily})),
          count:elements.length};
      });
      assert.deepEqual(audit.mismatches,[],`${name}: mixed fonts`);
      assert.equal(audit.overflow,false,`${name}: page overflow`);
      const s=await page.locator('.workspace-search-field').boundingBox(),h=await page.locator('.header-utilities').getByRole('button',{name:'Keyboard shortcuts',exact:true}).boundingBox();
      assert.ok(s&&h&&s.x+s.width<=h.x+1&&h.x-s.x-s.width<16,`${name}: search/help order`);
      await page.screenshot({path:`${output}/${mode}-${width}-${name}.png`});
      records.push({mode,width,name,...audit});
    }
    await page.locator('td.col-task').filter({hasText:'Current active task'}).waitFor();
    await capture('grid');
    // Keyboard navigation must expose a visible focus ring, including overflowed nav items.
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement, style = getComputedStyle(el);
      return {visible:el.matches(':focus-visible'), outline:style.outlineStyle, width:parseFloat(style.outlineWidth)};
    });
    assert.ok(focus.visible && focus.outline !== 'none' && focus.width >= 2, 'keyboard focus is visible');
    assert.equal(await page.locator('.ws-inspector-strip').count(),0);
    const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
    async function actualFont(selector) {
      const {root}=await cdp.send('DOM.getDocument');
      const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector});
      if(nodeId)records.push({mode,width,selector,platformFonts:(await cdp.send('CSS.getPlatformFontsForNode',{nodeId})).fonts});
    }
    await actualFont('.app-title');await actualFont('.ws-sheet-title');await actualFont('td.col-task');
    await button('+ Add Task').click();await page.locator('#tm-name').waitFor();
    await page.locator('#tm-name').fill('Disposable editor preview');
    await actualFont('#tm-name');await actualFont('.task-modal select');await capture('editor');
    await button('Add Task').scrollIntoViewIfNeeded();
    await capture('editor-actions');
    const modalOverflow = await page.locator('.task-modal-body').evaluate(el=>el.scrollWidth>el.clientWidth);
    assert.equal(modalOverflow,false,'editor has no horizontal overflow');
    await button('Cancel').click();
    await button('Keyboard shortcuts').click();await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();
    await actualFont('.ws-kbd-help-key');await capture('help');await button('Close keyboard shortcuts').click();
    await search.fill('Current');await page.getByRole('option').filter({hasText:'Current active task'}).waitFor();
    const results=await page.locator('.workspace-search-results').boundingBox();
    assert.ok(results.x>=0&&results.x+results.width<=width, 'search results fit viewport');
    await capture('search');await page.getByRole('option').filter({hasText:'Current active task'}).click();
    await page.locator('.ws-inspector-strip').waitFor();await capture('inspector');
    const clipped = await page.locator('.ws-inspector-strip').evaluate(el => [...el.querySelectorAll('input,button')].filter(n=>{
      const r=n.getBoundingClientRect(); return r.width && (r.left<0 || r.right>innerWidth);
    }).map(n=>n.outerHTML));
    assert.deepEqual(clipped,[], 'inspector controls fit the viewport');
    await page.keyboard.press('Shift+ArrowLeft');
    assert.match(await page.locator('.edit-bar-info').innerText(), /2 cells selected/);
    await capture('range');
    await page.keyboard.press('Escape');await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ws-inspector-strip').count(),0);
    if(width===1100){await context.close();continue;}
    await search.fill('Original historical');await page.getByRole('option').filter({hasText:'Original historical task'}).first().click();
    await page.locator('[data-history-task]').waitFor();
    await actualFont('.month-version-select');await capture('history');
    assert.match(await page.locator('.month-history').innerText(),/January note needle/);
    await page.locator('.history-note').scrollIntoViewIfNeeded();await capture('history-notes');
    await page.getByRole('combobox',{name:'Monthly history'}).selectOption('');
    await button('Reading').click();await button('+ Add Book').waitFor();await capture('reading');
    await button('Calendar').click();await page.locator('.cal-toolbar').waitFor();await capture('calendar');
    // Completion buttons must not stretch the time-proportional session blocks.
    assert.equal(await page.locator('.cal-block-check').evaluateAll(nodes=>nodes.some(n=>n.getBoundingClientRect().height>16)),false);
    if(width===390){await button('Day').click();await capture('calendar-day');}
    await button('Reports').click();await button('Execution').waitFor();
    await page.locator('.report-view > .grid-status').waitFor({state:'hidden'});
    await page.locator('.report-view .dashboard-command-panel').waitFor();
    await capture('reports');
    await button('Keyboard shortcuts').click();await page.getByRole('dialog',{name:'Keyboard shortcuts'}).waitFor();
    await page.keyboard.press('Escape');assert.equal(await button('Keyboard shortcuts').getAttribute('aria-expanded'),'false');
    await page.keyboard.press('?');assert.equal(await button('Keyboard shortcuts').getAttribute('aria-expanded'),'true');
    await page.keyboard.press('?');assert.equal(await button('Keyboard shortcuts').getAttribute('aria-expanded'),'false');
    assert.deepEqual(await page.getByRole('navigation',{name:'Pages',exact:true}).getByRole('button').allTextContents(),['Main','Reports','Settings']);
    await button('Settings').click();await button('Change').first().waitFor();await capture('settings');
    await actualFont('.ws-settings select');
    await button('Change').first().scrollIntoViewIfNeeded();
    // Utilities can scroll away with the settings content; typography is audited separately here.
    await page.screenshot({path:`${output}/${mode}-${width}-shortcuts.png`});
    const families=await page.locator('.ws-kbd-shortcut-row').first().evaluate(el=>[...el.querySelectorAll('*')].map(n=>getComputedStyle(n).fontFamily));
    assert.equal(new Set(families).size,1);
    await button('Main').click();assert.equal(await button('Calendar').getAttribute('aria-current'),'page');
    await context.close();
  }
  assert.deepEqual(errors,[]);
  writeFileSync(`${output}/layout-audit.json`,JSON.stringify(records,null,2));
  console.log(`PASS ${records.filter(r=>r.name).length} layout/font captures, utility placement, history and retained navigation; no runtime errors.`);
} finally { await browser.close(); }
