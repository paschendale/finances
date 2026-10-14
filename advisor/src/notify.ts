/**
 * Outbound notifications. Channels register themselves (Discord does when enabled); the web
 * app learns about changes through the Bus/SSE. Nothing here is required for the daemon to run.
 */
export interface PlanNotification {
  planId: string;
  conversationId: string;
  title: string;
  summary: string | null;
  status: string;
  version: number;
  counts: { create: number; update: number; skip: number; adjust: number; total: number };
  balance?: { ok: boolean; difference: number; account_name?: string } | null;
}

export interface NotifyTarget {
  name: string;
  planPending(n: PlanNotification): Promise<void>;
  planApplied(n: PlanNotification & { result: Record<string, unknown> }): Promise<void>;
  assistantReply(conversationId: string, text: string): Promise<void>;
  alert(text: string): Promise<void>;
}

export class Notifier {
  private targets: NotifyTarget[] = [];

  register(t: NotifyTarget): void {
    this.targets.push(t);
  }

  async planPending(n: PlanNotification): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.planPending(n)));
  }

  async planApplied(n: PlanNotification & { result: Record<string, unknown> }): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.planApplied(n)));
  }

  async assistantReply(conversationId: string, text: string): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.assistantReply(conversationId, text)));
  }

  async alert(text: string): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.alert(text)));
  }
}
