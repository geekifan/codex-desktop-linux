"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAIN_MARKER = "codexLinuxRemoteWebHostStart";
const RENDERER_MARKER = "codexLinuxRemoteWebSocketMessagePort";
const BUILD_ID_PLACEHOLDER = "0".repeat(64);
const CSP_META_PATTERN = /\s*<meta\s+http-equiv=(?:"|&#39;)Content-Security-Policy(?:"|&#39;)\s+content=(?:"[^"]*"|&#39;[^&]*(?:&(?!#39;)[^&]*)*&#39;)\s*\/?>/u;

function findMainAnchors(source) {
  const rpcMatch = source.match(
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+new\s+[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\s*\(\s*new\s+[A-Za-z_$][\w$]*\s*\(\s*\2\s*\)\s*,\s*\3\s*,\s*\4\s*\)\.getRemoteMain\(\)\s*\}/u,
  );
  if (rpcMatch == null) {
    return null;
  }

  const registrationMatch = source.match(
    /([A-Za-z_$][\w$]*)\.ipcMain\.on\(\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*,\s*([A-Za-z_$][\w$]*)\s*=>\s*\{\s*if\s*\(\s*![A-Za-z_$][\w$]*\s*\(\s*\2\s*\)\s*\)\s*return\s*;\s*let\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*\2\.ports\s*,\s*[A-Za-z_$][\w$]*\s*=\s*([A-Za-z_$][\w$]*)\s*\(\s*\2\.sender\s*\)\s*,\s*[A-Za-z_$][\w$]*\s*=\s*[A-Za-z_$][\w$]*\?\.createAppHost\(\s*\2\.sender\s*\)/u,
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
    "let t=globalThis.__codexLinuxCreateReliableChannel(e,{buildId:globalThis.__codexLinuxRemoteBuildId??null}),n=new Map,i=!1,a=null;",
    "let o=(e,t)=>{for(let r of n.get(e)??[])r(t)};",
    "t.addEventListener(`message`,e=>{typeof e.data==`string`?o(`message`,{data:e.data}):o(`messageerror`,e)});",
    "t.addEventListener(`reset`,e=>{i=!0,o(`messageerror`,e)});",
    "return{",
    "start(){},",
    "postMessage(e){if(i)throw Error(`Remote App Host reliable transport is closed`);if(e===null){this.close();return}if(typeof e!=`string`)throw TypeError(`Remote App Host transport only supports string frames`);t.send(e)},",
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

function applyRendererAssetsPatch(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) throw new Error("Could not find webview assets for remote App Host transport");
  const pendingWrites = [];
  let matched = false;
  for (const name of fs.readdirSync(assetsDir).filter((entry) => entry.endsWith(".js")).sort()) {
    const assetPath = path.join(assetsDir, name);
    const source = fs.readFileSync(assetPath, "utf8");
    if (source.includes(RENDERER_MARKER)) {
      matched = true;
      continue;
    }
    if (!source.includes("connect-app-host")) continue;
    const patched = applyRendererBundlePatch(source);
    if (patched === source) throw new Error("Could not find renderer App Host bootstrap for remote Web host patch");
    matched = true;
    pendingWrites.push({ assetPath, patched });
  }
  if (!matched) throw new Error("Could not find renderer App Host channel for remote Web host patch");
  for (const { assetPath, patched } of pendingWrites) fs.writeFileSync(assetPath, patched);
  return { matched: true, changed: pendingWrites.length > 0 };
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

function browserReliableTransportSource() {
  return `
function codexLinuxCreateReliableChannel(url,options={}){
const PROTOCOL_VERSION=1,RECONNECT_DELAY_MS=1000,SOCKET_TIMEOUT_MS=20000,MAX_UNACKED_BYTES=64*1024*1024,MAX_IN_FLIGHT_BYTES=256*1024;
const connectionId=crypto.randomUUID(),listeners=new Map;
let socket=null,socketReady=false,reconnectTimer=null,timeoutTimer=null,lastIncomingAt=Date.now(),serverEpoch=null,disposed=false;
let outgoingMessageId=0,outgoingAckId=0,outgoingSentId=0,outgoingUnackedBytes=0,incomingMessageId=0,outgoingUnacked=[];
let emit=(type,event)=>{for(let listener of listeners.get(type)??[])try{listener(event)}catch(error){console.error(\`[remote-web-host] reliable listener failed\`,error)}};
let sendRaw=frame=>{if(socket?.readyState!==WebSocket.OPEN)return false;try{socket.send(JSON.stringify(frame));return true}catch{socket.close();return false}};
let scheduleReconnect=()=>{if(disposed||reconnectTimer!==null)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;ensureSocket()},RECONNECT_DELAY_MS)};
let stopTimeout=()=>{timeoutTimer!==null&&clearInterval(timeoutTimer),timeoutTimer=null};
let startTimeout=current=>{stopTimeout(),timeoutTimer=setInterval(()=>{if(socket!==current)return;if(Date.now()-lastIncomingAt>=SOCKET_TIMEOUT_MS){current.close();return}sendRaw({type:\`bridge-keepalive\`})},5000)};
let reset=reason=>{if(disposed)return;disposed=true,socketReady=false,reconnectTimer!==null&&clearTimeout(reconnectTimer),reconnectTimer=null,stopTimeout();let current=socket;socket=null,current?.close();emit(\`reset\`,{reason});options.reloadOnReset!==false&&setTimeout(()=>location.reload(),100)};
let acceptAck=(ack,pump=true)=>{if(!Number.isSafeInteger(ack)||ack<0||ack>outgoingSentId){reset(\`invalid reliable bridge acknowledgement\`);return false}if(ack<=outgoingAckId)return true;outgoingAckId=ack;for(let message of outgoingUnacked){if(message.id>ack)break;outgoingUnackedBytes-=message.byteLength}outgoingUnacked=outgoingUnacked.filter(message=>message.id>ack),pump&&pumpOutgoing();return true};
let writeAck=()=>socketReady&&sendRaw({type:\`bridge-ack\`,ack:incomingMessageId});
let pumpOutgoing=()=>{if(!socketReady)return;let inFlightBytes=outgoingUnacked.filter(message=>message.id<=outgoingSentId).reduce((total,message)=>total+message.byteLength,0);for(let message of outgoingUnacked){if(message.id<=outgoingSentId)continue;if(inFlightBytes>0&&inFlightBytes+message.byteLength>MAX_IN_FLIGHT_BYTES)break;if(!sendRaw({type:\`bridge-data\`,id:message.id,ack:incomingMessageId,message:message.message}))break;outgoingSentId=message.id,inFlightBytes+=message.byteLength}};
let acceptMessage=frame=>{if(!Number.isSafeInteger(frame.id)||frame.id<=0){reset(\`invalid reliable bridge message id\`);return}if(frame.id===incomingMessageId+1){incomingMessageId=frame.id,emit(\`message\`,{data:frame.message}),writeAck();return}if(frame.id<=incomingMessageId){writeAck();return}sendRaw({type:\`bridge-replay-request\`,ack:incomingMessageId})};
let handleFrame=frame=>{if(frame?.type===\`bridge-ready\`){if(frame.protocolVersion!==PROTOCOL_VERSION||frame.connectionId!==connectionId){reset(\`reliable bridge handshake mismatch\`);return}if(serverEpoch!==null&&serverEpoch!==frame.serverEpoch){reset(\`backend restarted\`);return}if(options.buildId!=null&&frame.buildId!==options.buildId){reset(\`browser bundle version mismatch\`);return}serverEpoch=frame.serverEpoch,globalThis.__codexLinuxRemoteBuildId=frame.buildId,socketReady=true,writeAck(),outgoingSentId=outgoingAckId,pumpOutgoing(),emit(\`ready\`,frame);return}if(frame?.type===\`bridge-reset\`){reset(frame.reason);return}if(frame?.type===\`bridge-data\`){acceptAck(frame.ack)&&acceptMessage(frame);return}if(frame?.type===\`bridge-ack\`){acceptAck(frame.ack);return}if(frame?.type===\`bridge-replay-request\`){if(frame.ack<outgoingAckId){reset(\`invalid reliable bridge replay acknowledgement\`);return}if(acceptAck(frame.ack,false))outgoingSentId=frame.ack,pumpOutgoing();return}if(frame?.type===\`bridge-keepalive\`){sendRaw({type:\`bridge-keepalive\`});return}reset(\`unsupported reliable bridge frame\`)};
function ensureSocket(){if(disposed||socket&&(socket.readyState===WebSocket.OPEN||socket.readyState===WebSocket.CONNECTING))return;let next=new WebSocket(url);socket=next,socketReady=false;next.addEventListener(\`open\`,()=>{if(socket!==next)return;lastIncomingAt=Date.now(),sendRaw({type:\`bridge-hello\`,protocolVersion:PROTOCOL_VERSION,connectionId,serverEpoch,buildId:options.buildId??globalThis.__codexLinuxRemoteBuildId??null}),startTimeout(next)});next.addEventListener(\`message\`,event=>{if(socket!==next)return;lastIncomingAt=Date.now();try{handleFrame(JSON.parse(String(event.data)))}catch{reset(\`invalid reliable bridge frame\`)}});next.addEventListener(\`close\`,()=>{if(socket!==next)return;stopTimeout(),socket=null,socketReady=false,scheduleReconnect()});next.addEventListener(\`error\`,()=>{socket===next&&next.close()})}
let channel={send(message){if(disposed)throw Error(\`Reliable WebSocket bridge is closed\`);let serialized=JSON.stringify(message),snapshot=JSON.parse(serialized),byteLength=new TextEncoder().encode(serialized).length,outgoing={id:++outgoingMessageId,message:snapshot,byteLength};outgoingUnacked.push(outgoing),outgoingUnackedBytes+=byteLength;if(outgoingUnackedBytes>MAX_UNACKED_BYTES){reset(\`reliable bridge buffer exceeded\`);return}ensureSocket(),pumpOutgoing()},close(){if(disposed)return;socketReady&&sendRaw({type:\`bridge-disconnect\`}),disposed=true,reconnectTimer!==null&&clearTimeout(reconnectTimer),stopTimeout(),socket?.close(),socket=null},addEventListener(type,listener){let values=listeners.get(type)??new Set;values.add(listener),listeners.set(type,values)},removeEventListener(type,listener){listeners.get(type)?.delete(listener)},get connectionId(){return connectionId}};
ensureSocket();return channel
}
globalThis.__codexLinuxCreateReliableChannel=codexLinuxCreateReliableChannel;
`;
}

function browserPreloadShimSource(channels, buildId) {
  return `
${browserReliableTransportSource()}
globalThis.__codexLinuxRemoteBuildId=${JSON.stringify(buildId)};
const codexLinuxIpcSocket=codexLinuxCreateReliableChannel(\`${"${location.protocol===`https:`?`wss:`:`ws:`}"}//${"${location.host}"}/electron-ipc\`,{buildId:globalThis.__codexLinuxRemoteBuildId});
const codexLinuxIpcPending=new Map,codexLinuxIpcListeners=new Map,codexLinuxSyncResults=new Map;
let codexLinuxIpcRequestId=0,codexLinuxIpcReadyResolve,codexLinuxIpcReadyReject;
const codexLinuxIpcReady=new Promise((resolve,reject)=>{codexLinuxIpcReadyResolve=resolve,codexLinuxIpcReadyReject=reject});
function codexLinuxIpcRequest(type,channel,args=[]){return new Promise((resolve,reject)=>{let requestId=\`ipc_${"${++codexLinuxIpcRequestId}"}\`;codexLinuxIpcPending.set(requestId,{resolve,reject}),codexLinuxIpcSocket.send({requestId,type,channel,args})})}
function codexLinuxRemoteMessagePort(descriptor){let{port1,port2}=new MessageChannel,url=(location.protocol===\`https:\`?\`wss:\`:\`ws:\`)+\`//\`+location.host+\`/message-port/\`+descriptor.portId+\`?token=\`+encodeURIComponent(descriptor.token),channel=codexLinuxCreateReliableChannel(url,{buildId:globalThis.__codexLinuxRemoteBuildId,reloadOnReset:!1}),nativeClose=port1.close.bind(port1),closed=!1,close=()=>{closed||(closed=!0,channel.close(),port2.close(),nativeClose())};Object.defineProperty(port1,\`close\`,{value:close}),port2.start(),port2.addEventListener(\`message\`,event=>{if(event.ports.length>0){close();return}channel.send({type:\`message\`,data:event.data})}),channel.addEventListener(\`message\`,event=>{let frame=event.data;frame.type===\`message\`&&port2.postMessage(frame.data)}),channel.addEventListener(\`reset\`,()=>{closed||(closed=!0,port2.close(),nativeClose())});return port1}
codexLinuxIpcSocket.addEventListener(\`message\`,event=>{let message=event.data;if(message.type===\`ready\`){codexLinuxIpcReadyResolve();return}if(message.type===\`result\`){let pending=codexLinuxIpcPending.get(message.requestId);if(pending==null)return;codexLinuxIpcPending.delete(message.requestId),message.ok?pending.resolve(message.value):pending.reject(Error(message.error));return}if(message.type===\`event\`){let ports=(message.ports??[]).map(codexLinuxRemoteMessagePort);for(let listener of codexLinuxIpcListeners.get(message.channel)??[])listener({sender:null,ports},...message.args)}});
codexLinuxIpcSocket.addEventListener(\`reset\`,event=>{let error=Error(event.reason??\`IPC bridge reset\`);codexLinuxIpcReadyReject(error);for(let pending of codexLinuxIpcPending.values())pending.reject(error);codexLinuxIpcPending.clear()});
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

function buildBrowserPreload(source, buildId = crypto.createHash("sha256").update(source).digest("hex")) {
  const channels = findStartupSendSyncChannels(source);
  const patched = source.replace(/require\((?:`|"|')electron(?:`|"|')\)/u, "globalThis.__codexElectronShim");
  if (patched === source) throw new Error("Could not replace Electron import in upstream preload");
  return `if(globalThis.electronBridge==null){\n${browserPreloadShimSource(channels, buildId)}\n${patched}\n}`;
}

function electronPreloadRelaySource() {
  return `;(()=>{const{ipcRenderer}=require(\`electron\`),subscriptions=new Map;let reply=(command,result)=>ipcRenderer.send(\`codex-linux:remote-ipc-result\`,{relayId:command.relayId,requestId:command.requestId,...result});ipcRenderer.on(\`codex-linux:remote-ipc-command\`,async(_event,command)=>{try{if(command.type===\`dispose-relay\`){for(let[key,listener]of subscriptions)if(key.startsWith(\`${"${command.relayId}"}:\`))ipcRenderer.removeListener(key.slice(key.indexOf(\`:\`)+1),listener),subscriptions.delete(key);return}if(command.type===\`send-sync\`){reply(command,{ok:!0,value:ipcRenderer.sendSync(command.channel,...command.args)});return}if(command.type===\`invoke\`){reply(command,{ok:!0,value:await ipcRenderer.invoke(command.channel,...command.args)});return}if(command.type===\`send\`){ipcRenderer.send(command.channel,...command.args),reply(command,{ok:!0});return}let key=\`${"${command.relayId}"}:${"${command.channel}"}\`;if(command.type===\`subscribe\`){if(!subscriptions.has(key)){let listener=(event,...args)=>{let ports=(event.ports??[]).map(port=>{let portId=globalThis.crypto.randomUUID(),token=globalThis.crypto.randomUUID();ipcRenderer.postMessage(\`codex-linux:remote-port-register\`,{relayId:command.relayId,portId,token},[port]);return{portId,token}});ipcRenderer.send(\`codex-linux:remote-ipc-event\`,{relayId:command.relayId,channel:command.channel,args,ports})};subscriptions.set(key,listener),ipcRenderer.on(command.channel,listener)}reply(command,{ok:!0});return}if(command.type===\`unsubscribe\`){let listener=subscriptions.get(key);listener&&(ipcRenderer.removeListener(command.channel,listener),subscriptions.delete(key)),reply(command,{ok:!0});return}throw Error(\`Unsupported remote IPC command: ${"${command.type}"}\`)}catch(error){reply(command,{ok:!1,error:error instanceof Error?error.message:String(error)})}})})();`;
}

function applyExtractedWebviewCspPatch(extractedDir) {
  const indexPath = path.join(extractedDir, "webview", "index.html");
  if (!fs.existsSync(indexPath)) throw new Error("Could not find extracted webview index for remote Web host patch");
  const source = fs.readFileSync(indexPath, "utf8");
  const patched = applyWebviewCspPatch(source);
  const preloadPath = path.join(extractedDir, ".vite", "build", "preload.js");
  if (!fs.existsSync(preloadPath)) throw new Error("Could not find upstream preload for remote Web host patch");
  const browserPreloadPath = path.join(extractedDir, "webview", "assets", "codex-linux-remote-preload.js");
  const preloadImport = 'await import("./assets/codex-linux-remote-preload.js");';
  const entryPattern = /<script type="module" crossorigin src="([^"]+)"><\/script>/u;
  const entryMatch = patched.match(entryPattern);
  if (!patched.includes(preloadImport) && entryMatch == null) {
    throw new Error("Could not find upstream renderer entry for remote Web host patch");
  }
  const withPreload = patched.includes(preloadImport)
    ? patched
    : patched.replace(
        entryPattern,
        `<script type="module">\n    ${preloadImport}\n    await import("${entryMatch[1]}");\n  </script>`,
      );
  const upstreamPreload = fs.readFileSync(preloadPath, "utf8");
  if (!fs.existsSync(browserPreloadPath)) {
    fs.writeFileSync(browserPreloadPath, buildBrowserPreload(upstreamPreload, BUILD_ID_PLACEHOLDER));
  }
  if (!upstreamPreload.includes("codex-linux:remote-ipc-command")) {
    fs.writeFileSync(preloadPath, `${upstreamPreload}\n${electronPreloadRelaySource()}`);
  }
  if (withPreload !== source) fs.writeFileSync(indexPath, withPreload);
  return { matched: true, changed: withPreload !== source };
}

function applyRemoteBuildIdentity(extractedDir) {
  const browserPreloadPath = path.join(extractedDir, "webview", "assets", "codex-linux-remote-preload.js");
  if (!fs.existsSync(browserPreloadPath)) throw new Error("Could not find generated browser preload for remote build identity");
  const buildHash = crypto.createHash("sha256");
  const packagePath = path.join(extractedDir, "package.json");
  if (fs.existsSync(packagePath)) buildHash.update(fs.readFileSync(packagePath));
  const mainDir = path.join(extractedDir, ".vite", "build");
  for (const name of fs.readdirSync(mainDir).filter((name) => /^main-.*\.js$/u.test(name)).sort()) {
    buildHash.update(name).update(fs.readFileSync(path.join(mainDir, name)));
  }
  const webviewDir = path.join(extractedDir, "webview");
  const pendingDirectories = [webviewDir];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(entryPath);
      } else if (entry.isFile()) {
        let content = fs.readFileSync(entryPath);
        if (entryPath === browserPreloadPath) {
          content = Buffer.from(
            content
              .toString("utf8")
              .replace(/globalThis\.__codexLinuxRemoteBuildId="[a-f0-9]{64}";/u, `globalThis.__codexLinuxRemoteBuildId="${BUILD_ID_PLACEHOLDER}";`),
          );
        }
        buildHash.update(path.relative(webviewDir, entryPath)).update(content);
      }
    }
  }
  const buildId = buildHash.digest("hex");
  const buildIdPath = path.join(extractedDir, ".codex-linux-remote-build-id");
  const browserPreload = fs.readFileSync(browserPreloadPath, "utf8");
  const withBuildId = browserPreload.replace(
    /globalThis\.__codexLinuxRemoteBuildId="[a-f0-9]{64}";/u,
    `globalThis.__codexLinuxRemoteBuildId="${buildId}";`,
  );
  const previousBuildId = fs.existsSync(buildIdPath) ? fs.readFileSync(buildIdPath, "utf8") : null;
  fs.writeFileSync(buildIdPath, buildId);
  if (withBuildId !== browserPreload) fs.writeFileSync(browserPreloadPath, withBuildId);
  return { matched: true, changed: previousBuildId !== buildId || withBuildId !== browserPreload };
}

module.exports = {
  applyMainBundlePatch,
  applyRendererBundlePatch,
  applyRendererAssetsPatch,
  applyWebviewCspPatch,
  applyExtractedWebviewCspPatch,
  applyRemoteBuildIdentity,
  buildBrowserPreload,
  browserReliableTransportSource,
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
      phase: "extracted-app:pre-webview",
      order: 20_100,
      ciPolicy: "optional",
      apply: applyRendererAssetsPatch,
    },
    {
      id: "remote-web-host-csp",
      phase: "extracted-app:pre-webview",
      order: 20_101,
      ciPolicy: "optional",
      apply: applyExtractedWebviewCspPatch,
    },
    {
      id: "remote-web-host-build-identity",
      phase: "extracted-app:post-webview",
      order: 99_900,
      ciPolicy: "optional",
      apply: applyRemoteBuildIdentity,
    },
  ],
};
