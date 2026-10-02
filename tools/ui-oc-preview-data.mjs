// Read-only synthetic data for literal UI preview. No pi/OpenCode engine or files.
export const previewDirectory = '/preview/project';
const inputs = {text:true, image:false, audio:false, video:false, pdf:false};
const model = {
  id:'ui-sample', providerID:'preview-only', api:{id:'ui-sample', url:'', npm:'preview-only'},
  name:'UI sample · 未连接',
  capabilities:{temperature:false, reasoning:false, attachment:false, toolcall:false, input:inputs, output:inputs, interleaved:false},
  cost:{input:0, output:0, cache:{read:0, write:0}}, limit:{context:32000, output:1000},
  status:'active', options:{}, headers:{}, release_date:'preview-only',
};
const provider = {id:'preview-only', name:'Preview only · 未连接', source:'custom', env:[], options:{}, models:{'ui-sample':model}};
const project = {id:'preview-project', name:'UI preview · 样机', worktree:previewDirectory, time:{created:0, updated:0}, sandboxes:[]};
const agent = {name:'preview', description:'仅UI样机，不执行任务', mode:'primary', native:true, hidden:false, permission:[], options:{}, model:{providerID:'preview-only', modelID:'ui-sample'}};
// Shapes from the installed original SDK/read-only web settings boundaries.
const fixtures = new Map([
  ['/health', {healthy:true, previewOnly:true, backendConnected:false}],
  ['/api/opencode/health', {healthy:true, version:'preview-only', previewOnly:true, backendConnected:false}],
  ['/auth/session', {previewOnly:true, backendConnected:false}],
  ['/auth/passkey/status', {enabled:false, supported:false}],
  ['/api/path', {home:'/preview', state:'/preview/state', config:'/preview/config', worktree:previewDirectory, directory:previewDirectory}],
  ['/api/fs/home', {home:'/preview', chatsRoot:previewDirectory}],
  ['/api/fs/list', {path:previewDirectory, entries:[], directories:[], files:[]}],
  ['/api/config/settings', {projects:[{id:project.id, path:previewDirectory, label:'UI preview · 样机'}], lastDirectory:previewDirectory}],
  ['/api/config', {model:'preview-only/ui-sample', default_agent:'preview'}],
  ['/api/global/config', {model:'preview-only/ui-sample', default_agent:'preview'}],
  ['/api/config/providers', {providers:[provider], default:{'preview-only':'ui-sample'}}],
  ['/api/provider', {all:[provider], default:{'preview-only':'ui-sample'}, connected:['preview-only']}],
  ['/api/agent', [agent]], ['/api/app/agents', [agent]],
  ['/api/project', [project]], ['/api/project/current', project],
  ['/api/session/status', {}], ['/api/session', []], ['/api/experimental/session', []],
  ['/api/session-folders', {folders:[]}],
  ['/api/command', []], ['/api/config/skills', []], ['/api/config/themes', []],
  ['/api/question', []], ['/api/permission', []], ['/api/lsp', []], ['/api/mcp', {}],
  ['/api/message-queue', []], ['/api/guests', []], ['/api/terminal/sessions', []],
  ['/api/permission-auto-accept', {}], ['/api/vcs', {branch:'preview-only'}],
  ['/api/git/check', {isGitRepository:false}],
  ['/api/github/auth/status', {connected:false, authenticated:false}],
  ['/api/linear/auth/status', {connected:false, authenticated:false}],
]);
export function previewGet(pathname) {
  return fixtures.has(pathname) ? structuredClone(fixtures.get(pathname)) : undefined;
}
export const previewEventPaths = new Set(['/api/global/event', '/api/notifications/stream', '/api/openchamber/events']);
