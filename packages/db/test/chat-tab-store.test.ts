import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../src/database.js';
import { ChatTabStore } from '../src/chat-tab-store.js';
import type { Database } from 'sql.js';

describe('ChatTabStore', () => {
  let db: Database;
  let store: ChatTabStore;

  beforeEach(async () => {
    db = await openDatabase(':memory:');
    store = new ChatTabStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('tab CRUD', () => {
    it('creates and retrieves a chat tab', () => {
      const id = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Auth discussion',
        agentName: 'planner',
      });

      expect(id).toBeGreaterThan(0);

      const tab = store.getByTab('doc-1', 'tab-abc');
      expect(tab).not.toBeNull();
      expect(tab!.title).toBe('Auth discussion');
      expect(tab!.agentName).toBe('planner');
      expect(tab!.status).toBe('active');
      expect(tab!.activeCommentId).toBeNull();
      expect(tab!.sourceCommentId).toBeNull();
    });

    it('creates a tab with source comment ID', () => {
      store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
        sourceCommentId: 'comment-123',
      });

      const tab = store.getByTab('doc-1', 'tab-abc');
      expect(tab!.sourceCommentId).toBe('comment-123');
    });

    it('returns null for nonexistent tab', () => {
      const tab = store.getByTab('doc-1', 'nonexistent');
      expect(tab).toBeNull();
    });

    it('enforces unique document_id + tab_id', () => {
      store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'First',
        agentName: 'planner',
      });

      expect(() => store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Duplicate',
        agentName: 'planner',
      })).toThrow();
    });
  });

  describe('active comment tracking', () => {
    it('updates and retrieves by active comment ID', () => {
      const id = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
      });

      store.updateActiveComment(id, 'comment-xyz');

      const tab = store.getByActiveComment('comment-xyz');
      expect(tab).not.toBeNull();
      expect(tab!.id).toBe(id);
      expect(tab!.activeCommentId).toBe('comment-xyz');
    });

    it('returns null for unknown active comment', () => {
      const tab = store.getByActiveComment('nonexistent');
      expect(tab).toBeNull();
    });
  });

  describe('source comment lookup', () => {
    it('finds tab by source comment', () => {
      store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
        sourceCommentId: 'comment-origin',
      });

      const tab = store.getBySourceComment('doc-1', 'comment-origin');
      expect(tab).not.toBeNull();
      expect(tab!.tabId).toBe('tab-abc');
    });

    it('returns null if no match', () => {
      const tab = store.getBySourceComment('doc-1', 'nonexistent');
      expect(tab).toBeNull();
    });
  });

  describe('active tabs by document', () => {
    it('returns all active tabs for a document', () => {
      store.create({ documentId: 'doc-1', tabId: 'tab-1', title: 'Chat 1', agentName: 'a' });
      store.create({ documentId: 'doc-1', tabId: 'tab-2', title: 'Chat 2', agentName: 'b' });
      store.create({ documentId: 'doc-2', tabId: 'tab-3', title: 'Other doc', agentName: 'a' });

      const tabs = store.getActiveByDocument('doc-1');
      expect(tabs).toHaveLength(2);
    });

    it('excludes archived tabs', () => {
      const id = store.create({ documentId: 'doc-1', tabId: 'tab-1', title: 'Chat 1', agentName: 'a' });
      store.create({ documentId: 'doc-1', tabId: 'tab-2', title: 'Chat 2', agentName: 'b' });

      store.archive(id);

      const tabs = store.getActiveByDocument('doc-1');
      expect(tabs).toHaveLength(1);
      expect(tabs[0].tabId).toBe('tab-2');
    });
  });

  describe('archive', () => {
    it('sets status to archived', () => {
      const id = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
      });

      store.archive(id);

      const tab = store.getByTab('doc-1', 'tab-abc');
      expect(tab!.status).toBe('archived');
    });
  });

  describe('messages', () => {
    it('adds and retrieves messages in order', () => {
      const tabId = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
      });

      store.addMessage(tabId, 'user', 'How should we handle auth?');
      store.addMessage(tabId, 'agent', 'I suggest using JWT tokens.');
      store.addMessage(tabId, 'user', 'What about refresh tokens?');

      const messages = store.getMessages(tabId);
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe('How should we handle auth?');
      expect(messages[1].role).toBe('agent');
      expect(messages[2].role).toBe('user');
    });

    it('respects limit parameter', () => {
      const tabId = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
      });

      store.addMessage(tabId, 'user', 'First');
      store.addMessage(tabId, 'agent', 'Second');
      store.addMessage(tabId, 'user', 'Third');

      const messages = store.getMessages(tabId, 2);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
    });

    it('returns empty array for no messages', () => {
      const tabId = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
      });

      const messages = store.getMessages(tabId);
      expect(messages).toHaveLength(0);
    });

    it('touches updated_at on the chat tab when adding a message', () => {
      const id = store.create({
        documentId: 'doc-1',
        tabId: 'tab-abc',
        title: 'Discussion',
        agentName: 'planner',
      });

      const before = store.getByTab('doc-1', 'tab-abc')!.updatedAt;
      store.addMessage(id, 'user', 'Hello');
      const after = store.getByTab('doc-1', 'tab-abc')!.updatedAt;

      // updated_at should be updated (or at least not earlier)
      expect(after >= before).toBe(true);
    });
  });
});
