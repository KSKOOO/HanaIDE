import { memo, useCallback, useMemo } from 'react';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ProcessFoldBlock } from './ProcessFoldBlock';
import { InterludeBlock } from './InterludeBlock';
import { buildTranscriptRenderItems, type TranscriptRenderItem } from './process-fold';
import { useStore } from '../../stores';
import { selectIsStreamingSession } from '../../stores/session-selectors';

interface Props {
  items: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  hideUserIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  enableProcessFold?: boolean;
}

export const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionPath,
  agentId,
  readOnly = false,
  hideUserIdentity = false,
  userIdentity,
  registerMessageElement,
  enableProcessFold = false,
}: Props) {
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const renderItems = useMemo(
    () => enableProcessFold
      ? buildTranscriptRenderItems(items, { isStreaming })
      : items.map((item, originalIndex) => ({ type: 'source' as const, item, originalIndex })),
    [enableProcessFold, isStreaming, items],
  );
  const turnState = useMemo(() => buildTurnState(items), [items]);

  return (
    <>
      {renderItems.map((renderItem) => (
        <TranscriptRenderItemView
          key={renderItemKey(renderItem)}
          renderItem={renderItem}
          sourceItems={items}
          sessionPath={sessionPath}
          agentId={agentId}
          readOnly={readOnly}
          hideUserIdentity={hideUserIdentity}
          userIdentity={userIdentity}
          latestUserMessage={turnState.latestUserMessage}
          latestUserIndex={turnState.latestUserIndex}
          latestAssistantIndex={turnState.latestAssistantIndex}
          turnCompletionAssistantIndexes={turnState.turnCompletionAssistantIndexes}
          isStreamingSession={isStreaming}
          registerMessageElement={registerMessageElement}
        />
      ))}
    </>
  );
});

function renderItemKey(renderItem: TranscriptRenderItem): string {
  if (renderItem.type === 'process_fold') return renderItem.id;
  const item = renderItem.item;
  if (item.type === 'message') return item.data.id;
  if (item.type === 'interlude') return `i-${item.id}`;
  return `c-${renderItem.originalIndex}`;
}

function buildTurnState(items: ChatListItem[]): {
  latestUserIndex: number;
  latestAssistantIndex: number;
  latestUserMessage: ChatMessage | null;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
} {
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  let latestUserMessage: ChatMessage | null = null;
  let pendingAssistantIndex = -1;
  const turnCompletionAssistantIndexes = new Set<number>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.type !== 'message') continue;

    if (item.data.role === 'user') {
      if (pendingAssistantIndex >= 0) turnCompletionAssistantIndexes.add(pendingAssistantIndex);
      pendingAssistantIndex = -1;
      latestUserIndex = i;
      latestUserMessage = item.data;
      continue;
    }

    if (item.data.role === 'assistant') {
      pendingAssistantIndex = i;
      latestAssistantIndex = i;
    }
  }

  if (pendingAssistantIndex >= 0) turnCompletionAssistantIndexes.add(pendingAssistantIndex);

  return {
    latestUserIndex,
    latestAssistantIndex,
    latestUserMessage,
    turnCompletionAssistantIndexes,
  };
}

const TranscriptRenderItemView = memo(function TranscriptRenderItemView({
  renderItem,
  sourceItems,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserMessage,
  latestUserIndex,
  latestAssistantIndex,
  turnCompletionAssistantIndexes,
  isStreamingSession,
  registerMessageElement,
}: {
  renderItem: TranscriptRenderItem;
  sourceItems: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserMessage?: ChatMessage | null;
  latestUserIndex: number;
  latestAssistantIndex: number;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  isStreamingSession: boolean;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const originalIndex = renderItem.originalIndex;
  const prevMessageItem = previousMessageItem(sourceItems, originalIndex);

  if (renderItem.type === 'process_fold') {
    const prevRole = prevMessageItem?.data.role ?? null;
    return (
      <ProcessFoldBlock
        group={renderItem}
        showAvatar={prevRole !== 'assistant'}
        sessionPath={sessionPath}
        agentId={agentId}
        readOnly={readOnly}
        turnCompletionAssistantIndexes={turnCompletionAssistantIndexes}
        completionTimePersistent={
          turnCompletionAssistantIndexes.has(groupLastOriginalIndex(renderItem))
          && groupLastOriginalIndex(renderItem) === latestAssistantIndex
          && latestAssistantIndex > latestUserIndex
          && !isStreamingSession
        }
        registerMessageElement={registerMessageElement}
      />
    );
  }

  return (
    <TranscriptItemView
      item={renderItem.item}
      prevItem={prevMessageItem}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      hideUserIdentity={hideUserIdentity}
      userIdentity={userIdentity}
      latestUserMessage={latestUserMessage}
      isLatestUserMessage={originalIndex === latestUserIndex}
      isLatestAssistantMessage={
        originalIndex === latestAssistantIndex
        && latestAssistantIndex > latestUserIndex
      }
      showTurnCompletionTime={turnCompletionAssistantIndexes.has(originalIndex)}
      registerMessageElement={registerMessageElement}
    />
  );
});

function previousMessageItem(items: ChatListItem[], beforeIndex: number): Extract<ChatListItem, { type: 'message' }> | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type === 'message') return item;
  }
  return undefined;
}

function groupLastOriginalIndex(renderItem: Extract<TranscriptRenderItem, { type: 'process_fold' }>): number {
  return renderItem.items[renderItem.items.length - 1]?.originalIndex ?? renderItem.originalIndex;
}

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  prevItem,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserMessage,
  isLatestUserMessage,
  isLatestAssistantMessage,
  showTurnCompletionTime,
  registerMessageElement,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserMessage?: ChatMessage | null;
  isLatestUserMessage: boolean;
  isLatestAssistantMessage: boolean;
  showTurnCompletionTime: boolean;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const messageId = item.type === 'message' ? item.data.id : null;
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (messageId) registerMessageElement?.(messageId, element);
  }, [messageId, registerMessageElement]);

  if (item.type === 'compaction') return null;
  if (item.type === 'interlude') return <InterludeBlock block={item.data} />;

  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;

  if (msg.role === 'user') {
    return (
      <UserMessage
        message={msg}
        showAvatar={showAvatar}
        sessionPath={sessionPath}
        readOnly={readOnly}
        hideIdentity={hideUserIdentity}
        userIdentity={userIdentity}
        isLatestUserMessage={isLatestUserMessage}
        messageRef={messageRef}
      />
    );
  }

  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      isLatestAssistantMessage={isLatestAssistantMessage}
      showTurnCompletionTime={showTurnCompletionTime}
      retrySourceMessage={latestUserMessage}
      messageRef={messageRef}
    />
  );
});
