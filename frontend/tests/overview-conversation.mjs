import assert from 'node:assert/strict'
import { chromium, webkit } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { createTourFixture } from './interactive-onboarding-fixture.mjs'
import { menuFor } from './fixtures/prompt-dialogs.mjs'

// The chat tile of a waiting session shows the terminal dialog 1:1 (PromptMenu):
// the CLI's option labels, Enter confirms the highlighted line, a digit sends at
// once, a stale 409 reloads the question and never resends.
const out = new URL('../../packaging/artifacts/overview-chat-20261014/', import.meta.url).pathname
await mkdir(out, { recursive: true })
const engine = process.env.IVE_QA_BROWSER || 'chromium'
const browser = await (engine === 'webkit' ? webkit : chromium).launch()
const two = `Bash command
Find Orbit and traffic projects
──────────────────────────────
ls -d */ Projects/*/ | grep -i 'orbit|traffic'
Safety check not configured: missing API key 'api_key_gemini_api' (fail-closed)
Do you want to proceed?
 ❯ 1. Yes
   2. No

Esc to cancel · Tab to amend`
const FOOT = '↵ confirm · ↑↓ or 1-9 choose'

let count = 0
async function fixture(screen = two, theme = 'light', width = 1440, expectLoading = false, { legacy = false } = {}) {
 const f=await createTourFixture(browser,{width,height:960,theme,settings:{product_tour_version:'2'},workspaces:[{id:'w',name:'Orbit',path:'/isolated/orbit'}],sessions:[{id:'s',workspace_id:'w',name:'Orbit traffic software',cli_type:'claude',model:'sonnet',permission_mode:'auto',status:'waiting',agentState:'waiting',pty_alive:true,session_type:'worker',archived:0,tags:[],attention:{kind:'permission',title:'Permission needed',asked_at:1760435760}}],storage:{'ive.operator-desk':{activeWorkspaceId:'w',activeSessionId:'s',openTabs:['s'],showHome:false,activeNavGroup:'work'},'ive.grid-session-views':{s:'chat'},'cc-gridColumns':'1'},messages:{s:[
 {id:'user',session_id:'s',role:'user',content:'Find the Orbit traffic project and help me continue working on it.',created_at:'2026-10-14T09:56:00Z'},
 {id:'empty',session_id:'s',role:'assistant',content:JSON.stringify([{type:'thinking',thinking:''}]),created_at:'2026-10-14T09:56:01Z'},
 {id:'reply',session_id:'s',role:'assistant',content:'I’ll find the project folder and check where you left off.',created_at:'2026-10-14T09:56:02Z'},
 {id:'tools',session_id:'s',role:'assistant',content:JSON.stringify([{type:'tool_use',name:'Bash',id:'t1',input:{command:'ls -d */ Projects/*/',description:'Find Orbit and traffic projects'}},{type:'tool_use',name:'mcp__worker-board__search_memory',id:'t2',input:{query:'orbit traffic software'}}]),created_at:'2026-10-14T09:56:03Z'},
 ]}})
 f.promptScreen=screen;f.inputs=[];f.reject=false;f.legacy=legacy
 f.menu=()=>f.legacy?undefined:menuFor(f.promptScreen)
 await f.context.route('**/api/sessions/s/output**',route=>route.fulfill({json:{screen:f.promptScreen,text:'OLD HISTORICAL OUTPUT MUST NOT BE USED',menu:f.menu()||null,permission_view_state:null}}))
 await f.context.route('**/api/sessions/s/input',async route=>{const body=route.request().postDataJSON();f.inputs.push(body)
  const menu=f.menu()
  if(menu&&!body.prompt_reply){assert.equal(body.expected_identity,menu.identity,'answers carry the identity of the dialog on screen');assert.equal(body.message,undefined);assert.ok(menu.choices.includes(body.choice),'only an option of the current dialog')}
  else assert.equal(body.expected_screen,f.promptScreen)
  if(f.reject){f.promptScreen=two.replace('Find Orbit and traffic projects','Read a different project');return route.fulfill({status:409,json:{error:'The question changed.',code:'stale_session_prompt'}})}
  return route.fulfill({json:{ok:true}})})
 await f.page.goto('http://ive-guide.test/#board')
 await f.page.locator('[data-session-prompt-actions]').waitFor()
 if (expectLoading) await f.page.locator('[data-request-loading]').waitFor()
 else if (menuFor(screen)) await f.page.locator('[data-prompt-menu="s"] [role="listbox"]').waitFor()
 return f
}
const option=(p,name)=>p.getByRole('option',{name,exact:true})
const sent=(p)=>p.getByRole('status').filter({hasText:'Sent, continuing'}).first()
try {
 for(const [theme,width] of [['light',1440],['dark',1440],['light',390]]) {
  const f=await fixture(two,theme,width);const p=f.page
  assert.equal(await p.locator('[data-chat-message-id="empty"]').count(),0)
  assert.equal(await p.locator('.ive-conversation-activity pre').count(),0)
  assert.equal(await p.locator('.ive-conversation-history').count(),0)
  // The CLI's own words, in terminal order: request, question, options with the cursor.
  assert.equal(await option(p,'1. Yes').count(),1)
  assert.equal(await option(p,'2. No').count(),1)
  assert.equal(await p.getByRole('button',{name:/Allow once|Don’t allow|Allow this action/}).count(),0)
  assert.equal(await option(p,'1. Yes').getAttribute('aria-selected'),'true')
  assert.equal(await option(p,'1. Yes').locator('.ive-prompt-menu-cursor').innerText(),'❯')
  assert.match(await p.locator('[data-prompt-menu="s"] pre').innerText(),/ls -d \*\/ Projects/)
  assert.equal(await p.getByText('Do you want to proceed?',{exact:true}).isVisible(),true)
  assert.equal(await p.getByText(FOOT,{exact:true}).isVisible(),true)
  assert.equal(await p.locator('.ive-chat-question-notice').isVisible(),true)
  const box=await p.locator('[data-prompt-menu="s"]').boundingBox(), composer=await p.locator('.ive-session-composer').boundingBox()
  assert(box.y+box.height<=composer.y+1,'the question sits right above the composer')
  await p.locator('.ive-session-composer textarea').click()
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  await p.screenshot({path:`${out}overview-${engine}-${theme}-${width}.png`,fullPage:true})
  if (width === 1440) {
   await p.getByRole('button',{name:'History',exact:true}).click()
   assert.equal(await p.locator('.ive-conversation-history').isVisible(),true)
   await p.locator('.ive-conversation-history button').filter({hasText:/Calling tool/}).last().click()
   assert.equal(await p.locator('.ive-conversation-process').isVisible(),true)
   await p.getByRole('button',{name:'History',exact:true}).click()
   await p.getByRole('button',{name:'Details',exact:true}).click()
   await p.locator('.ive-conversation-activity pre').first().waitFor()
   assert.equal(await p.locator('.ive-conversation-activity-toggle').getAttribute('aria-expanded'),'true')
   await p.getByRole('button',{name:'Details',exact:true}).click()
   await p.locator('.ive-conversation-activity pre').first().waitFor({state:'hidden'})
   assert.equal(await p.locator('.ive-conversation-activity pre').count(),0)
  }
  await option(p,'1. Yes').click()
  await sent(p).waitFor()
  assert.equal(f.inputs.length,1);assert.equal(f.inputs[0].choice,'1')
  assert.equal(f.errors.length,0);count++;await f.context.close()
 }
 const deny=await fixture();await option(deny.page,'2. No').click();await sent(deny.page).waitFor();assert.equal(deny.inputs[0].choice,'2');count++;await deny.context.close()
 const three=await fixture(two.replace('2. No',"2. Yes, and don't ask again for commands in /project\n   3. No"))
 assert.equal(await option(three.page,"2. Yes, and don't ask again for commands in /project").count(),1)
 await option(three.page,'3. No').click();await sent(three.page).waitFor();assert.equal(three.inputs[0].choice,'3');count++;await three.context.close()
 // Keyboard: ↑/↓ move the highlight locally, Enter confirms it, Escape never sends.
 const keys=await fixture();{const p=keys.page,list=p.locator('[data-prompt-menu="s"] [role="listbox"]')
  await list.focus();await p.keyboard.press('Escape');assert.equal(keys.inputs.length,0)
  assert.equal(await list.evaluate(el=>el===document.activeElement),false,'Escape only blurs the menu')
  await list.focus();await p.keyboard.press('ArrowDown')
  assert.equal(await option(p,'2. No').getAttribute('aria-selected'),'true');assert.equal(keys.inputs.length,0,'arrows send nothing')
  assert.equal(await list.getAttribute('aria-activedescendant'),await option(p,'2. No').getAttribute('id'))
  await p.keyboard.press('ArrowUp');await p.keyboard.press('ArrowDown');await p.keyboard.press('Enter')
  await sent(p).waitFor();assert.equal(keys.inputs.length,1);assert.equal(keys.inputs[0].choice,'2');count++;await keys.context.close()}
 // A digit selects and sends in one press.
 const digit=await fixture(two.replace('2. No',"2. Yes, and don't ask again for commands in /project\n   3. No"));{const p=digit.page
  await p.locator('[data-prompt-menu="s"] [role="listbox"]').focus();await p.keyboard.press('3')
  await sent(p).waitFor();assert.equal(digit.inputs.length,1);assert.equal(digit.inputs[0].choice,'3');count++;await digit.context.close()}
 // 409 stale: the question is reloaded, the user looks again, nothing is resent on its own.
 const stale=await fixture();stale.reject=true;await option(stale.page,'1. Yes').click()
 await stale.page.getByRole('alert').filter({hasText:'The question changed, look again'}).waitFor()
 assert.equal(stale.inputs.length,1);stale.reject=false
 await stale.page.getByText('Read a different project',{exact:false}).waitFor()
 await stale.page.waitForTimeout(2000);assert.equal(stale.inputs.length,1,'no automatic resend')
 await option(stale.page,'1. Yes').click();await sent(stale.page).waitFor()
 assert.equal(stale.inputs.length,2);assert.equal(stale.inputs[1].expected_identity,menuFor(stale.promptScreen).identity);count++;await stale.context.close()
 // Older backend without `menu`: the browser parses the screen and replies with expected_screen.
 const legacy=await fixture(two,'light',1440,false,{legacy:true});await option(legacy.page,'2. No').click();await sent(legacy.page).waitFor()
 assert.equal(legacy.inputs[0].message,'2');assert.equal(legacy.inputs[0].expected_screen,two);assert.equal(legacy.inputs[0].choice,undefined);count++;await legacy.context.close()
 const clipped=await fixture(two.slice(two.indexOf('Safety check')), 'light', 1440, true)
 assert.equal(await clipped.page.locator('[role="listbox"]').count(),0)
 assert.equal(await clipped.page.locator('.ive-chat-question-reply').count(),0)
 assert.equal(await clipped.page.getByRole('button',{name:'Open terminal to review',exact:true}).count(),0)
 assert.equal(await clipped.page.getByText('Loading request…',{exact:true}).isVisible(),true)
 assert((await clipped.page.locator('[data-request-loading]').boundingBox()).height < 70)
 await clipped.page.screenshot({path:`${out}loading-${engine}.png`,fullPage:true})
 await clipped.page.getByRole('button',{name:'Retry',exact:true}).waitFor({timeout:12000})
 assert.equal(await clipped.page.getByText('The request is taking longer than expected.',{exact:true}).isVisible(),true)
 assert.equal(clipped.inputs.length,0)
 clipped.promptScreen=two
 await option(clipped.page,'1. Yes').waitFor()
 assert.equal(await clipped.page.locator('[data-request-loading]').count(),0)
 assert.equal(await clipped.page.locator('[data-board-screen]').count(),1)
 await option(clipped.page,'1. Yes').click()
 await sent(clipped.page).waitFor()
 assert.equal(clipped.inputs.length,1)
 count++;await clipped.context.close()
 const empty=await fixture('', 'light', 390, true)
 assert.equal(await empty.page.getByRole('alert').count(),0)
 empty.promptScreen=two
 await option(empty.page,'2. No').waitFor()
 assert.equal(await empty.page.locator('[data-request-loading]').count(),0)
 count++;await empty.context.close()
 const recovery=await fixture('', 'light', 1440, true)
 let readFailed=true
 await recovery.context.route('**/api/sessions/s/output**',route=>readFailed
   ? route.fulfill({status:503,json:{error:'Temporary request read failure'}})
   : route.fulfill({json:{screen:two,text:'',menu:menuFor(two)}}))
 await recovery.page.getByRole('alert').filter({hasText:'Temporary request read failure'}).waitFor()
 readFailed=false
 await option(recovery.page,'1. Yes').waitFor()
 assert.equal(await recovery.page.getByRole('alert').count(),0)
 assert.equal(recovery.inputs.length,0)
 count++;await recovery.context.close()
 // An unrecognised question keeps one explicit, guarded line of text.
 const manual=await fixture('What should this project be called?\n>');await manual.page.getByLabel('Your reply',{exact:true}).fill('Orbit');await manual.page.getByRole('button',{name:'Send reply',exact:true}).click();await sent(manual.page).waitFor();assert.equal(manual.inputs[0].message,'Orbit');assert.equal(manual.inputs[0].prompt_reply,true);count++;await manual.context.close()
 const hook=await fixture(`ToolSearch
──────────────────────────────
│ Hook PreToolUse:ToolSearch requires confirmation for this tool:
│ [Safety Gate] LLM safety classifier provider 'gemini_api' is not configured: missing API key 'api_key_gemini_api' (fail-closed)
settings.json to update hooks
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for ToolSearch commands in /test/project
  3. No

Esc to cancel · Tab to amend`)
 assert.equal(await hook.page.getByRole('button',{name:'Open terminal to review',exact:true}).count(),0)
 assert.equal(await option(hook.page,'1. Yes').count(),1)
 assert.equal(await option(hook.page,"2. Yes, and don't ask again for ToolSearch commands in /test/project").count(),1)
 assert.equal(await hook.page.locator('.ive-chat-question-notice').isVisible(),true)
 assert.match(await hook.page.locator('[data-prompt-menu="s"] pre').innerText(),/missing API key/)
 assert.equal(await hook.page.getByRole('button',{name:'Show full request'}).count(),0)
 await hook.page.screenshot({path:`${out}toolsearch-${engine}.png`,fullPage:true})
 await option(hook.page,'3. No').click()
 await sent(hook.page).waitFor()
 assert.equal(hook.inputs.length,1);assert.equal(hook.inputs[0].choice,'3')
 assert.equal(hook.errors.length,0);count++;await hook.context.close()
 // A long request folds after eight lines; the full text is one click away.
 const long=await fixture(two.replace('Find Orbit and traffic projects',Array.from({length:14},(_,i)=>`request line ${i+1}`).join('\n')))
 assert.doesNotMatch(await long.page.locator('[data-prompt-menu="s"] pre').innerText(),/request line 12/)
 await long.page.getByRole('button',{name:'Show full request',exact:true}).click()
 assert.match(await long.page.locator('[data-prompt-menu="s"] pre').innerText(),/request line 14/)
 assert.equal(await long.page.getByRole('button',{name:'Show less',exact:true}).count(),1)
 count++;await long.context.close()
 console.log(JSON.stringify({engine,passed:count}))
} finally {await browser.close()}
