import * as vscode from 'vscode';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  filePath?: string;
  commitMsg?: string;
}

export interface Session {
  id: string;
  createdAt: number;
  providerId: string;
  providerLabel: string;
  messages: ChatMessage[];
}

export class SessionManager {
  private static readonly STORAGE_KEY = 'aider-studio.sessions';
  private sessions: Session[] = [];
  private activeSessionId: string | null = null;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.load();
  }

  newSession(providerId: string, providerLabel: string): Session {
    const session: Session = {
      id: Date.now().toString(),
      createdAt: Date.now(),
      providerId,
      providerLabel,
      messages: [],
    };
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.save();
    return session;
  }

  getActive(): Session | undefined {
    if (!this.activeSessionId) {
      return this.sessions[0];
    }
    return this.sessions.find(s => s.id === this.activeSessionId);
  }

  addMessage(msg: Omit<ChatMessage, 'timestamp'>): void {
    const session = this.getActive();
    if (!session) return;
    session.messages.push({ ...msg, timestamp: Date.now() });
    this.save();
  }

  getAllSessions(): Session[] {
    return this.sessions;
  }

  setActive(id: string): void {
    this.activeSessionId = id;
  }

  clearActive(): void {
    const session = this.getActive();
    if (session) {
      session.messages = [];
      this.save();
    }
  }

  deleteSession(id: string): void {
    this.sessions = this.sessions.filter(s => s.id !== id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
    }
    this.save();
  }

  private load(): void {
    const stored = this.context.workspaceState.get<Session[]>(SessionManager.STORAGE_KEY);
    this.sessions = stored ?? [];
  }

  private save(): void {
    // Keep last 20 sessions, max 200 messages each to avoid bloat
    const trimmed = this.sessions.slice(0, 20).map(s => ({
      ...s,
      messages: s.messages.slice(-200),
    }));
    this.context.workspaceState.update(SessionManager.STORAGE_KEY, trimmed);
  }
}
