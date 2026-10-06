import type { RuntimeAPIs } from '../vendor/openchamber-frontend/packages/ui/src/lib/api/types';

/** Deny legacy factories without ever calling their captured transport.
 * Terminal attach is synchronous in the original contract; other commands
 * reject normally. Capability checks must never claim an unbound capability.
 */
const denied = <T extends object>(api: T, category: string): T => new Proxy(api, {
  get(_target, key) {
    if (key === 'canNotify') return () => false;
    if (key === 'restartOpenCode' || typeof Reflect.get(api, key) !== 'function') return undefined;
    const fail = () => { throw new Error(`${category}尚未接入pi；没有执行旧后台操作。`); };
    if (key === 'attach') return fail;
    return async () => fail();
  },
});
/** Only settings.load is a render dependency. All command/read features outside
 * the native chat scope are explicitly unavailable, not invented empty data.
 * No spreading optional integrations through from the original factory.
 */
export function sealOriginalRuntimeAPIs(original: RuntimeAPIs): RuntimeAPIs {
  return {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false, label: 'pi-native' },
    terminal: denied(original.terminal, '终端'),
    git: denied(original.git, 'Git'),
    files: denied(original.files, '文件浏览'),
    settings: {
      load: () => original.settings.load(),
      save: async () => { throw new Error('设置保存尚未接入pi；没有修改后台配置。'); },
    },
    permissions: denied(original.permissions, '权限'),
    notifications: denied(original.notifications, '通知'),
    tools: denied(original.tools, '工具管理'),
  };
}
