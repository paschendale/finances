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

/**
 * A topic the daemon raises on its own (stale accounts, plans waiting, …): a short tracker message
 * plus optional details. Channels that support threads put the details in one; the conversation
 * created for it carries `context` so the assistant knows what the person is replying to.
 */
export interface Notice {
  /** Stable key: the same key on the same day updates the earlier notice instead of posting again */
  key: string;
  title: string;
  /** One status line with a leading emoji */
  status: string;
  /** Two or three short lines for the tracker */
  lines?: string[];
  /** Longer detail, one item per line, posted where the channel keeps details */
  details?: string[];
  /** Hidden context for the assistant when the person replies */
  context?: string;
}

export interface NotifyTarget {
  name: string;
  planPending(n: PlanNotification): Promise<void>;
  planApplied(n: PlanNotification & { result: Record<string, unknown> }): Promise<void>;
  assistantReply(conversationId: string, text: string): Promise<void>;
  notice(n: Notice): Promise<void>;
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

  async notice(n: Notice): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.notice(n)));
  }

  async alert(text: string): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.alert(text)));
  }
}
