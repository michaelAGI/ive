// Offline visual fixture of the production component. No server or agent calls.
// Run after the normal frontend build, then open the emitted HTML in a browser.
import { build } from 'esbuild'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const frontend = fileURLToPath(new URL('..', import.meta.url))
const output = path.join(frontend, 'device-hub-review')
await mkdir(output, { recursive: true })
const bundle = await build({
  stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import DeviceHub from './src/components/devices/DeviceHub.jsx';
    import useStore from './src/state/store.js'; import { api } from './src/lib/api.js';
    const id = '11111111-1111-1111-1111-111111111111';
    let value = {checks:{supported_mac:true,xcode_ready:true,helper_ready:false}, devices:[{id,name:'Preview iPhone',model:'iPhone',os_version:'27.0',transport:'wired',developer_mode:'disabled',control_available:false}], setup:null};
    window.previewCalls = [];
    const log = text => { document.getElementById('feedback').textContent = text; };
    for (const key of Object.keys(api)) api[key] = async () => {throw new Error('Offline fixture: '+key)};
    api.deviceHubStatus = async () => structuredClone(value);
    api.quickSession = async args => {window.previewCalls.push(['create',args]);return {id:'preview-agent',name:args.name,cli_type:args.cli_type}};
    api.sendSessionInput = async (session, text) => {window.previewCalls.push(['send',session,text]);log('Fixture received task in '+session+': '+text.slice(-220));return {ok:true}};
    api.deviceHubAction = async (op,args) => {
      window.previewCalls.push([op,args]);log('Fixture action: '+op);
      if(op==='grant-setup') value.setup={session_id:args.session_id,state:'needs_user',message:'Preview: accept Trust This Computer on your iPhone.'};
      if(op==='assign') value.devices[0].assignment={session_id:args.session_id,lease_id:'fixture'};
      if(op==='unassign') delete value.devices[0].assignment;
      if(op==='stop-setup') value.setup=null;
      if(op==='observe') { const canvas=document.createElement('canvas');canvas.width=390;canvas.height=844;const ctx=canvas.getContext('2d');ctx.fillStyle='#eef0f3';ctx.fillRect(0,0,390,844);ctx.fillStyle='#0e1014';ctx.font='18px sans-serif';ctx.fillText('Offline screen fixture',92,410);return {image_base64:canvas.toDataURL('image/png').split(',')[1],observed_at:Date.now()/1000}; }
      return {};
    };
    useStore.setState({cliProfiles:{codex:{id:'codex',label:'Codex',available:true},claude:{id:'claude',label:'Claude Code',available:true}},sessions:{'preview-agent':{id:'preview-agent',name:'Preview agent',cli_type:'codex'}},goSession:id=>log('Opened fixture session '+id)});
    window.previewState = kind => {
      window.previewCalls.length=0;value.setup=null;value.checks.supported_mac=kind!=='unsupported';value.checks.requirements='Requires Apple silicon, macOS 27 and Xcode 27.';
      value.devices = kind==='empty' ? [] : [{id,name:'Preview iPhone',model:'iPhone',os_version:'27.0',transport:'wired',developer_mode:kind==='initial'?'disabled':'enabled',control_available:kind!=='initial'}];
      value.checks.helper_ready=kind!=='initial';
      if(kind==='assigned') value.devices[0].assignment={session_id:'preview-agent',lease_id:'fixture'};
      if(kind==='multiple') value.devices.push({...value.devices[0],id:'22222222-2222-2222-2222-222222222222',name:'Second iPhone'});
      render();
    };
    const root=createRoot(document.getElementById('root'));let version=0;
    function render(){root.render(<DeviceHub key={++version} onClose={()=>log('Closed fixture dialog')}/>)} render();
  `, resolveDir: frontend, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', jsx: 'automatic', minify: true,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
  loader: { '.css': 'empty' }, logLevel: 'error',
})
const assets = path.join(frontend, 'dist/assets')
const names = (await readdir(assets)).filter(name => /^index-.*\.css$/.test(name))
let css = (await Promise.all(names.map(name => readFile(path.join(assets, name), 'utf8')))).join('\n')
for (const match of [...css.matchAll(/url\((?:["']?)(\/fonts\/[^)'" ]+)(?:["']?)\)/g)]) {
  const bytes = await readFile(path.join(frontend, 'public', match[1]))
  css = css.replaceAll(match[0], 'url(data:font/woff2;base64,' + bytes.toString('base64') + ')')
}
const child = '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>'+css+'</style><body><div id="root"></div><div id="feedback" style="position:fixed;bottom:0;background:#15171a;color:white;padding:6px;font:11px monospace;z-index:100;width:100%">Offline fixture · no device connected</div><script>'+bundle.outputFiles[0].text.replaceAll('</script','<\\/script')+'</script></body></html>'
const html = '<!doctype html><html lang="en"><meta charset="utf-8"><title>IVE Devices · offline UI review</title><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; frame-src \'self\' about:; connect-src \'none\'"><style>body{margin:0;background:#e6e8eb;color:#15171a;font:13px system-ui}nav{display:flex;gap:8px;align-items:center;padding:10px;flex-wrap:wrap}button{padding:5px 9px}iframe{display:block;width:min(1280px,100%);height:900px;border:0;margin:auto;background:white}strong{margin-right:auto}</style><nav><strong>OFFLINE PREVIEW · Production component with fixture data</strong><button onclick="frame.style.width=\'min(1280px,100%)\'">Wide</button><button onclick="frame.style.width=\'390px\'">390 px</button>'+['initial','empty','ready','assigned','unsupported','multiple'].map(kind=>'<button onclick="frame.contentWindow.previewState(\''+kind+'\')">'+kind+'</button>').join('')+'</nav><iframe id="frame" title="Device Hub preview"></iframe><script>frame.srcdoc='+JSON.stringify(child).replaceAll('</script','<\\/script')+'</script></html>'
await writeFile(path.join(output, 'index.html'), html)
console.log(path.join(output, 'index.html'))
