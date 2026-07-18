"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAIN_MARKER = "codexLinuxRemoteWebHostStart";
const RENDERER_MARKER = "codexLinuxRemoteWebSocketMessagePort";
const CSP_META_PATTERN = /\s*<meta\s+http-equiv=(?:"|&#39;)Content-Security-Policy(?:"|&#39;)\s+content=(?:"[^"]*"|&#39;[^&]*(?:&(?!#39;)[^&]*)*&#39;)\s*\/?>/u;

function findMainAnchors(source) {
  const rpcMatch = source.match(
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+new\s+[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(\s*new\s+[A-Za-z_$][\w$]*\s*\(\s*\2\s*\)\s*,\s*\3\s*,\s*\4\s*\)\.getRemoteMain\(\)\s*\}/u,
  );
  if (rpcMatch == null) {
    return null;
  }

  const registrationMatch = source.match(
    /([A-Za-z_$][\w$]*)\.ipcMain\.on\(\s*[A-Za-z_$][\w$]*\s*,\s*([A-Za-z_$][\w$]*)\s*=>\s*\{\s*if\s*\(\s*![A-Za-z_$][\w$]*\s*\(\s*\2\s*\)\s*\)\s*return\s*;\s*let\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*\2\.ports\s*,\s*[A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\2\.sender\s*\)\s*,\s*[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*\?\.createAppHost\(\s*\2\.sender\s*\)/u,
  );
  if (registrationMatch == null) {
    return null;
  }

  return {
    electronName: registrationMatch[1],
    getContextName: registrationMatch[3],
    registrationNeedle: registrationMatch[0],
    rpcName: rpcMatch[1],
    rpcNeedle: rpcMatch[0],
  };
}

function applyMainBundlePatch(source) {
  if (source.includes(MAIN_MARKER)) {
    return source;
  }
  const anchors = findMainAnchors(source);
  if (anchors == null) {
    console.warn("WARN: Could not find App Host main-process anchors - skipping remote Web host patch");
    return source;
  }

  const helper = [
    "function codexLinuxRemoteWebHostStart(e,t){",
    "if(process.env.CODEX_REMOTE_WEB_HOST!==`1`||globalThis.__codexLinuxRemoteWebHostStarted)return;",
    "globalThis.__codexLinuxRemoteWebHostStarted=!0;",
    "try{",
    "let n=require(require(`node:path`).join(process.resourcesPath,`..`,`.codex-linux`,`features`,`remote-web-host`,`app-host-server.cjs`));",
    `n.start({electron:e,getContext:t,createRpc:(e,t)=>${anchors.rpcName}(e,t)}).catch(e=>console.error(\`[remote-web-host] failed to start\`,e));`,
    "}catch(e){console.error(`[remote-web-host] failed to load`,e)}",
    "}",
  ].join("");

  return source
    .replace(anchors.rpcNeedle, `${helper}${anchors.rpcNeedle}`)
    .replace(
      anchors.registrationNeedle,
      `${MAIN_MARKER}(${anchors.electronName},${anchors.getContextName}),${anchors.registrationNeedle}`,
    );
}

function rendererTransportSource() {
  return [
    "function codexLinuxRemoteWebSocketMessagePort(e){",
    "let t=new WebSocket(e),n=new Map,r=[],i=!1,a=null;",
    "let o=(e,t)=>{for(let r of n.get(e)??[])r(t)};",
    "t.addEventListener(`open`,()=>{for(let e of r)t.send(e);r.length=0});",
    "t.addEventListener(`message`,e=>{typeof e.data==`string`?o(`message`,{data:e.data}):o(`messageerror`,e)});",
    "t.addEventListener(`error`,e=>o(`messageerror`,e));",
    "t.addEventListener(`close`,()=>{i=!0,o(`messageerror`,new Event(`messageerror`))});",
    "return{",
    "start(){},",
    "postMessage(e){if(i)throw Error(`Remote App Host WebSocket is closed`);if(e===null){this.close();return}if(typeof e!=`string`)throw TypeError(`Remote App Host transport only supports string frames`);t.readyState===WebSocket.OPEN?t.send(e):r.push(e)},",
    "addEventListener(e,t){let r=n.get(e)??new Set;r.add(t),n.set(e,r)},",
    "removeEventListener(e,t){n.get(e)?.delete(t)},",
    "close(){i||(i=!0,t.close())},",
    "get onmessage(){return a},",
    "set onmessage(e){a!=null&&this.removeEventListener(`message`,a),a=e,e!=null&&this.addEventListener(`message`,e)}",
    "}",
    "}",
  ].join("");
}

function applyRendererBundlePatch(source) {
  if (source.includes(RENDERER_MARKER)) {
    return source;
  }
  if (!source.includes("connect-app-host")) {
    return source;
  }

  const match = source.match(
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{\s*let\s*\{\s*port1\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*port2\s*:\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*new\s+MessageChannel(?:\s*\(\s*\))?\s*;\s*return\s*\(?\s*window\.postMessage\(\s*\{\s*type\s*:\s*`connect-app-host`\s*,\s*port\s*:\s*\3\s*\}\s*,\s*window\.location\.origin\s*,\s*\[\s*\3\s*\]\s*\)\s*,\s*([A-Za-z_$][\w$]*)\s*\(\s*\2\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\)?\s*\}/u,
  );
  if (match == null) {
    console.warn("WARN: Could not find renderer App Host bootstrap - skipping remote Web host patch");
    return source;
  }

  const [needle, functionName, port1, port2, connectRpc, rendererServices] = match;
  const replacement = [
    rendererTransportSource(),
    `function ${functionName}(){`,
    "let codexLinuxRemoteWebSocketUrl=new URLSearchParams(window.location.search).get(`codexRemoteAppHost`);",
    "if(codexLinuxRemoteWebSocketUrl==null&&globalThis.__codexLinuxRemoteWebHost===!0)codexLinuxRemoteWebSocketUrl=`${window.location.protocol===`https:`?`wss:`:`ws:`}//${window.location.host}/app-host`;",
    `if(codexLinuxRemoteWebSocketUrl!=null)return ${connectRpc}(codexLinuxRemoteWebSocketMessagePort(codexLinuxRemoteWebSocketUrl),${rendererServices});`,
    `let{port1:${port1},port2:${port2}}=new MessageChannel();`,
    `return window.postMessage({type:\`connect-app-host\`,port:${port2}},window.location.origin,[${port2}]),${connectRpc}(${port1},${rendererServices})`,
    "}",
  ].join("");
  return source.replace(needle, replacement);
}

function applyWebviewCspPatch(source) {
  return source.replace(CSP_META_PATTERN, "");
}

function findStartupSendSyncChannels(source) {
  const bridgeStart = source.indexOf(",j={");
  const startup = bridgeStart === -1 ? source : source.slice(0, bridgeStart);
  const constants = new Map();
  for (const match of source.matchAll(/(?:^|[,;])([A-Za-z_$][\w$]*)=`([^`]*)`/gu)) {
    constants.set(match[1], match[2]);
  }
  const channels = [];
  for (const match of startup.matchAll(/\.ipcRenderer\.sendSync\((?:([A-Za-z_$][\w$]*)|`([^`]*)`)\)/gu)) {
    const channel = match[2] ?? constants.get(match[1]);
    if (channel == null) throw new Error(`Could not resolve startup sendSync channel ${match[1]}`);
    channels.push(channel);
  }
  return channels;
}

function browserPreloadShimSource(channels) {
  return `
const codexLinuxIpcSocket=new WebSocket(\`${"${location.protocol===`https:`?`wss:`:`ws:`}"}//${"${location.host}"}/electron-ipc\`);
const codexLinuxIpcPending=new Map,codexLinuxIpcListeners=new Map,codexLinuxSyncResults=new Map;
let codexLinuxIpcRequestId=0,codexLinuxIpcReadyResolve;
const codexLinuxIpcReady=new Promise(e=>codexLinuxIpcReadyResolve=e);
function codexLinuxIpcRequest(type,channel,args=[]){return new Promise((resolve,reject)=>{let requestId=\`ipc_${"${++codexLinuxIpcRequestId}"}\`;codexLinuxIpcPending.set(requestId,{resolve,reject}),codexLinuxIpcSocket.send(JSON.stringify({requestId,type,channel,args}))})}
function codexLinuxRemoteMessagePort(descriptor){let{port1,port2}=new MessageChannel,url=(location.protocol===\`https:\`?\`wss:\`:\`ws:\`)+\`//\`+location.host+\`/message-port/\`+descriptor.portId+\`?token=\`+encodeURIComponent(descriptor.token),socket=new WebSocket(url),queue=[];port2.start(),port2.addEventListener(\`message\`,event=>{if(event.ports.length>0){socket.close(1003,\`Nested transferred ports are not supported\`);return}let frame=JSON.stringify({type:\`message\`,data:event.data});socket.readyState===WebSocket.OPEN?socket.send(frame):queue.push(frame)}),socket.addEventListener(\`open\`,()=>{for(let frame of queue)socket.send(frame);queue.length=0}),socket.addEventListener(\`message\`,event=>{let frame=JSON.parse(event.data);frame.type===\`message\`&&port2.postMessage(frame.data)}),socket.addEventListener(\`close\`,()=>port2.close());return port1}
codexLinuxIpcSocket.addEventListener(\`message\`,event=>{let message=JSON.parse(event.data);if(message.type===\`ready\`){codexLinuxIpcReadyResolve();return}if(message.type===\`result\`){let pending=codexLinuxIpcPending.get(message.requestId);if(pending==null)return;codexLinuxIpcPending.delete(message.requestId),message.ok?pending.resolve(message.value):pending.reject(Error(message.error));return}if(message.type===\`event\`){let ports=(message.ports??[]).map(codexLinuxRemoteMessagePort);for(let listener of codexLinuxIpcListeners.get(message.channel)??[])listener({sender:null,ports},...message.args)}});
await codexLinuxIpcReady;
for(let channel of ${JSON.stringify(channels)}){let value=await codexLinuxIpcRequest(\`send-sync\`,channel,[]);if(channel===\`codex_desktop:get-sentry-init-options\`&&value!=null)value={...value,enabled:!1};codexLinuxSyncResults.set(JSON.stringify([channel,[]]),value)}
const codexLinuxIpcRenderer={
invoke:(channel,...args)=>codexLinuxIpcRequest(\`invoke\`,channel,args),
send:(channel,...args)=>{codexLinuxIpcRequest(\`send\`,channel,args).catch(console.error)},
sendSync:(channel,...args)=>{let key=JSON.stringify([channel,args]);if(!codexLinuxSyncResults.has(key))throw Error(\`Unsupported runtime sendSync: ${"${channel}"}\`);return structuredClone(codexLinuxSyncResults.get(key))},
on(channel,listener){let listeners=codexLinuxIpcListeners.get(channel);if(listeners==null)listeners=new Set,codexLinuxIpcListeners.set(channel,listeners),codexLinuxIpcRequest(\`subscribe\`,channel).catch(console.error);listeners.add(listener);return this},
once(channel,listener){let wrapped=(event,...args)=>{this.removeListener(channel,wrapped),listener(event,...args)};return this.on(channel,wrapped)},
addListener(channel,listener){return this.on(channel,listener)},
removeListener(channel,listener){let listeners=codexLinuxIpcListeners.get(channel);if(listeners==null)return this;listeners.delete(listener);if(listeners.size===0)codexLinuxIpcListeners.delete(channel),codexLinuxIpcRequest(\`unsubscribe\`,channel).catch(console.error);return this},
off(channel,listener){return this.removeListener(channel,listener)},
postMessage(){throw Error(\`Transferred ipcRenderer.postMessage is handled by the remote App Host transport\`)}
};
globalThis.__codexElectronShim={ipcRenderer:codexLinuxIpcRenderer,contextBridge:{exposeInMainWorld:(key,value)=>Reflect.set(globalThis,key,value)},webUtils:{getPathForFile:()=>null}};
globalThis.__codexLinuxRemoteWebHost=true;
globalThis.process??={platform:\`linux\`,arch:\`x64\`};
`;
}

function buildBrowserPreload(source) {
  const channels = findStartupSendSyncChannels(source);
  const patched = source.replace(/require\((?:`|"|')electron(?:`|"|')\)/u, "globalThis.__codexElectronShim");
  if (patched === source) throw new Error("Could not replace Electron import in upstream preload");
  return `${browserPreloadShimSource(channels)}\n${patched}`;
}

function electronPreloadRelaySource() {
  return `;(()=>{const{ipcRenderer}=require(\`electron\`),subscriptions=new Map;let reply=(command,result)=>ipcRenderer.send(\`codex-linux:remote-ipc-result\`,{relayId:command.relayId,requestId:command.requestId,...result});ipcRenderer.on(\`codex-linux:remote-ipc-command\`,async(_event,command)=>{try{if(command.type===\`send-sync\`){reply(command,{ok:!0,value:ipcRenderer.sendSync(command.channel,...command.args)});return}if(command.type===\`invoke\`){reply(command,{ok:!0,value:await ipcRenderer.invoke(command.channel,...command.args)});return}if(command.type===\`send\`){ipcRenderer.send(command.channel,...command.args),reply(command,{ok:!0});return}let key=\`${"${command.relayId}"}:${"${command.channel}"}\`;if(command.type===\`subscribe\`){if(!subscriptions.has(key)){let listener=(event,...args)=>{let ports=(event.ports??[]).map(port=>{let portId=globalThis.crypto.randomUUID(),token=globalThis.crypto.randomUUID();ipcRenderer.postMessage(\`codex-linux:remote-port-register\`,{relayId:command.relayId,portId,token},[port]);return{portId,token}});ipcRenderer.send(\`codex-linux:remote-ipc-event\`,{relayId:command.relayId,channel:command.channel,args,ports})};subscriptions.set(key,listener),ipcRenderer.on(command.channel,listener)}reply(command,{ok:!0});return}if(command.type===\`unsubscribe\`){let listener=subscriptions.get(key);listener&&(ipcRenderer.removeListener(command.channel,listener),subscriptions.delete(key)),reply(command,{ok:!0});return}throw Error(\`Unsupported remote IPC command: ${"${command.type}"}\`)}catch(error){reply(command,{ok:!1,error:error instanceof Error?error.message:String(error)})}})})();`;
}

function applyExtractedWebviewCspPatch(extractedDir) {
  const indexPath = path.join(extractedDir, "webview", "index.html");
  if (!fs.existsSync(indexPath)) return { matched: false, changed: false };
  const source = fs.readFileSync(indexPath, "utf8");
  const patched = applyWebviewCspPatch(source);
  const preloadPath = path.join(extractedDir, ".vite", "build", "preload.js");
  if (!fs.existsSync(preloadPath)) return { matched: false, changed: false };
  const browserPreloadPath = path.join(extractedDir, "webview", "assets", "codex-linux-remote-preload.js");
  const preloadTag = '<script type="module" src="./assets/codex-linux-remote-preload.js"></script>';
  const withPreload = patched.includes(preloadTag)
    ? patched
    : patched.replace("</head>", `  ${preloadTag}\n</head>`);
  const upstreamPreload = fs.readFileSync(preloadPath, "utf8");
  fs.writeFileSync(browserPreloadPath, buildBrowserPreload(upstreamPreload));
  if (!upstreamPreload.includes("codex-linux:remote-ipc-command")) {
    fs.writeFileSync(preloadPath, `${upstreamPreload}\n${electronPreloadRelaySource()}`);
  }
  if (withPreload !== source) fs.writeFileSync(indexPath, withPreload);
  return { matched: true, changed: withPreload !== source };
}

module.exports = {
  applyMainBundlePatch,
  applyRendererBundlePatch,
  applyWebviewCspPatch,
  applyExtractedWebviewCspPatch,
  buildBrowserPreload,
  findStartupSendSyncChannels,
  findMainAnchors,
  descriptors: [
    {
      id: "remote-web-host-main-transport",
      phase: "main-bundle",
      order: 20_100,
      ciPolicy: "optional",
      apply: applyMainBundlePatch,
    },
    {
      id: "remote-web-host-renderer-transport",
      phase: "webview-asset",
      order: 20_100,
      ciPolicy: "optional",
      assetPattern: /^app-initial~.*\.js$/u,
      missingWarning: "WARN: Could not find renderer App Host asset for remote Web host patch",
      apply: applyRendererBundlePatch,
    },
    {
      id: "remote-web-host-csp",
      phase: "extracted-app:pre-webview",
      order: 20_101,
      ciPolicy: "optional",
      apply: applyExtractedWebviewCspPatch,
    },
  ],
};
