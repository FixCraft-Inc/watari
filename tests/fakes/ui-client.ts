import type { ChatListEntry } from "../../src/watari/state/chat-library.ts";

/**
 * The chat-management half of the UI client, answered without a service.
 *
 * Spread into each test's fake client so a test only spells out the calls it
 * is about. Nothing here starts a harness or a model turn.
 */
export const chatClientDefaults = {
  async clearAgent(): Promise<void> {},
  async listChats(): Promise<readonly ChatListEntry[]> {
    return [];
  },
  async resumeChat(chat: string) {
    return { chatId: chat, title: chat, goal: null, messages: 0, claims: 0, todos: 0, findings: 0, events: 0, activities: 0 };
  },
  async saveChat() {
    return { path: "/state/watari/chats/chat.json" };
  },
  async exportChat() {
    return { path: "/state/watari/exports/chat.md", handoffs: [] };
  },
};
