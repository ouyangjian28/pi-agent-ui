const marker = '// pi-native-bound-composer-overlay';
const hostImport = "import { getNativeSurfaceHost as piGetComposerHost } from '@pi-native/surface-host';\n";
const once = (source, needle) => { if (source.split(needle).length !== 2) throw new Error('Original bound composer anchor missing/duplicated: ' + needle); };
export function nativeBoundComposerTransform(source, kind) {
  if (source.includes(marker)) throw new Error('Original bound composer already applied');
  if (kind === 'input') {
    const anchor = 'export const ChatInput = React.memo(ChatInputComponent);'; once(source, anchor);
    return marker + '\n' + hostImport + "import { NativeSourceComposer as PiNativeComposer } from '@pi-native/source-composer';\nimport type { ComposerFooterProps as PiFooterProps } from './composer/ui/ComposerFooter';\n" + source.replace(anchor, `
const PiBoundChatInput = (props: ChatInputProps) => {
    const host = piGetComposerHost();
    const isMobile = useUIStore(state => state.isMobile);
    const { t } = useI18n();
    if (!host) return <ChatInputComponent {...props} />;
    if (props.active === false) return <div role="status">输入绑定当前原生会话，非活动列只读。</div>;
    return <PiNativeComposer host={host} isMobile={isMobile}
        renderEditor={({ bindEditor, editorKey, expanded, ...editorProps }) => <ComposerEditor {...editorProps} ref={bindEditor} key={editorKey}
            data-testid="chat-input" aria-label="原生消息输入" placeholder={t('chat.chatInput.placeholder.chat')}
            languageContext={{ inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(), knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [] }}
            preserveDeferredEnterShift spellCheck={isMobile} autoCapitalize={isMobile ? 'sentences' : 'none'} maxLines={expanded ? (isMobile ? 12 : 20) : (isMobile ? 5 : 8)}
            className={'min-h-[52px] px-3 relative z-10 pt-4 ' + (isMobile ? 'pb-2.5 typography-markdown' : 'pb-2 typography-markdown md:typography-ui-label')} />}
        renderFooter={footerProps => <ComposerFooter {...(footerProps as PiFooterProps)} />}
        renderModels={() => <ModelControls className="flex-1 min-w-0" />} />;
};
export const ChatInput = React.memo(PiBoundChatInput);`);
  }
  if (kind === 'footer') {
    let code = source;
    for (const [node, count] of [['SessionGoalButton', 2], ['SessionGoalObjectiveCounter', 2], ['MemoComposerDictation', 1], ['button', 1]]) {
      const anchor = '!isBtw ? <' + node; if (code.split(anchor).length !== count + 1) throw new Error('Original footer native child anchor drift: ' + node);
      code = code.split(anchor).join('!isBtw && !piGetComposerHost() ? <' + node);
    }
    const attachment = /<ComposerAttachmentControls\b[\s\S]*?\/>/g;
    if ([...code.matchAll(attachment)].length !== 2) throw new Error('Original footer attachment anchor drift');
    code = code.replace(attachment, node => `(piGetComposerHost() ? <button type="button" onClick={onPickLocalFiles} className={footerIconButtonClass} aria-label={t('chat.chatInput.actions.attachFiles')}><Icon name="attachment-2" className={cn(iconSizeClass, 'text-current')} /></button> : ${node})`);
    const permission = 'isInteractive={isPermissionAutoAcceptInteractive}';
    if (code.split(permission).length !== 3) throw new Error('Original footer permission anchor drift');
    code = code.split(permission).join('isInteractive={isPermissionAutoAcceptInteractive && !piGetComposerHost()}');
    return marker + '\n' + hostImport + code;
  }
  if (kind === 'actions') {
    once(source, '{hasContent ? (');
    return marker + '\n' + hostImport + source.replace('{hasContent ? (', '{hasContent && !piGetComposerHost() ? (');
  }
  throw new Error('Unknown bound composer transform kind');
}
