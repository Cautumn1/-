// Explicit local UI test harness. It replaces only the CloudBase adapter; no
// production credentials, database calls, or deployed code changes are involved.
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = `
const members=[{id:'study-user-1',userKey:'user1',name:'蔡',color:'#4f6bf6'}, {id:'study-user-2',userKey:'user2',name:'刘',color:'#7c5cfc'}];
let active=null, connected=true;
const tasks=[{id:'done',title:'已完成的学习任务',completed:true},{id:'remaining',title:'待完成的学习任务',completed:false}];
export async function callStudyApi(action,payload={}) {
 const query=new URLSearchParams(location.search);
 const day=payload.day||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()-18000000));
 const me=members.find(x=>x.userKey===payload.token)||members[0];
 const focus={serverNow:Date.now(),summaryRevision:'qa',activeByMember:{[me.id]:active},todaySecondsByMember:{'study-user-1':120,'study-user-2':60},todayTaskSecondsByMember:{'study-user-1':{done:120},'study-user-2':{}}};
 if(action==='selectUser')return {token:payload.userKey};
 if(action==='getData')return {me,members,tasksByMember:{'study-user-1':tasks,'study-user-2':[{id:'liu',title:'刘的任务',completed:false}]},planDays:[{day,tasks}],taskTemplate:tasks,courseTemplates:[],overdueTasks:[],repeatDaily:false,focus};
 if(action==='getFocusStatus')return focus;
 if(action==='getAssistantConnection')return {configured:query.get('connection')!=='disabled',connected,mcpUrl:'https://a1-d4gbxgxqmc01c0e55-1462114738.ap-shanghai.app.tcloudbase.com/study-assistant/mcp',setupFingerprint:'a'.repeat(64)};
 if(action==='revokeAssistant'){connected=false;return {revoked:true};}
 if(action==='authorizeAssistant')throw new Error('这是本地验收，未建立真实连接。');
 if(action==='startFocus'){active={id:'qa-focus',memberId:me.id,day,taskId:payload.taskId||null,taskTitle:'自由自习',startedAt:Date.now(),timerMode:payload.timerMode,pomodoro:payload.timerMode==='pomodoro'?{focusMinutes:payload.focusMinutes,breakMinutes:payload.breakMinutes}:null};return {session:active,serverNow:Date.now()};}
 if(action==='setFocusPaused'){active={...active,pausedAt:payload.paused?Date.now():null,pausedDurationMs:0};return {session:active,serverNow:Date.now()};}
 if(action==='stopFocus'){const result={sessionId:active.id,day,taskId:active.taskId,taskTitle:active.taskTitle,durationSeconds:1,summaryRevision:'qa-end'};active=null;return result;}
 if(action==='getStudyHistory')return {days:{},totalSeconds:0,studyDays:0,completedDays:0};
 throw new Error('本地验收未支持操作:'+action);
}`;
const virtual = "\0assistant-qa-cloudbase";
const server = await createServer({ root, configFile: path.join(root, "vite.config.ts"),
  plugins: [{ name: "assistant-qa-only", enforce: "pre",
    resolveId(id) { if (id === "./cloudbase") return virtual; },
    load(id) { if (id === virtual) return source; },
  }], server: { host: "127.0.0.1", port: 5174, strictPort: true },
});
await server.listen();
console.log("Local fixture UI: http://127.0.0.1:5174 — never calls CloudBase");
