// navigation-events.ts — Shared client-side conversation navigation helpers.
//
// Opening a conversation from the Sidebar ("Recent Chats"), TopBar search, or
// History page does `router.push('/?c=<id>')`. On the chat page that is a
// client-side navigation that does NOT remount '/' and does NOT fire
// `popstate`, so the page's conversation hook never notices. Callers fire
// OPEN_CONVERSATION_EVENT after navigating; useConversation listens and loads
// the conversation by the id carried in the event detail.

export const OPEN_CONVERSATION_EVENT = "orplex:open-conversation";

/** Announce an in-app navigation to a conversation so the mounted chat page
 *  hook can load it without a full page reload. */
export function announceConversationOpen(id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: { id } }));
}
