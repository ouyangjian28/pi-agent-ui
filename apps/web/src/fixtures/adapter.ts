// draft：展示契约冻结前的临时数据面
// 不消费 packages/protocol；这里没有恢复算法，也没有网络或真实写命令。
export type Attention = 'running' | 'done' | 'needs-input' | 'unknown' | 'recovering';
export type DemoState = 'ready' | 'empty' | 'loading' | 'offline';
export interface DraftPart { type: string; text: string; source: 'fixture'; version: 1 }
export interface DraftMessage { id: string; seq: number; role: 'user' | 'assistant'; parts: DraftPart[] }
export interface DraftSession {
  id: string; title: string; cwd: string; attention: Attention; summary: string;
  unread: number; pending: number; messages: DraftMessage[];
}
// draft：展示契约冻结前的临时数据面
export interface DraftAdapter { sessions: readonly DraftSession[]; models: readonly string[] }
const message = (id: string, seq: number, role: DraftMessage['role'], text: string): DraftMessage =>
  ({ id, seq, role, parts: [{ type: 'text', text, source: 'fixture', version: 1 }] });
export const fixtureAdapter: DraftAdapter = {
  models: ['演示模型 · GPT', '演示模型 · Claude'],
  sessions: [
    { id: 'shell', title: '搭建会话工作台', cwd: 'pi-agent-ui', attention: 'running', summary: '正在整理页面结构', unread: 0, pending: 0,
      messages: [message('shell-1', 1, 'user', '先搭好壳，让手机也能轻松浏览。'), message('shell-2', 2, 'assistant', '正在整理页面结构。这是静态样本，不代表真实执行进度。')] },
    { id: 'review', title: '确认交互方案', cwd: 'pi-agent-ui', attention: 'needs-input', summary: '有一项选择等待你确认', unread: 2, pending: 1,
      messages: [message('review-1', 1, 'assistant', '待答演示：需要你确认交互方向。此切片只读，不提供批准或提交操作。')] },
    { id: 'notes', title: '整理设计笔记', cwd: '个人工作区', attention: 'done', summary: '演示结果已整理', unread: 1, pending: 0,
      messages: [message('notes-1', 1, 'assistant', '设计笔记样本已整理。绿色只表示这个已知完成的样本。')] },
    { id: 'unknown', title: '中断后的会话', cwd: '个人工作区', attention: 'unknown', summary: '未获得完整完成证据', unread: 0, pending: 0,
      messages: [message('unknown-1', 1, 'assistant', '状态待确认：未获得完整完成证据，不重发原命令。')] },
    { id: 'recovering', title: '恢复中的会话', cwd: '个人工作区', attention: 'recovering', summary: '恢复结果暂定', unread: 0, pending: 0,
      messages: [message('recovering-1', 1, 'assistant', '状态待确认：恢复结果暂定，不代表成功。')] },
  ],
};
export const attentionLabels: Record<Attention, string> = {
  running: '运行中', done: '已完成', 'needs-input': '待你确认', unknown: '状态待确认', recovering: '状态待确认',
};
