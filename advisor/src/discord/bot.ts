import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type ThreadChannel,
  type User,
} from 'discord.js';
import type { AppContext } from '../context.js';
import type { Conversation, PlanWithCounts } from '../db/types.js';
import type { Notice, NotifyTarget, PlanNotification } from '../notify.js';
import { createConversation, findConversationByExternalRef, getConversation, updateConversation } from '../db/repo/conversations.js';
import { getPlan, listPlanItems, listPlans } from '../db/repo/plans.js';
import { claimEvent, getState, setState } from '../db/repo/misc.js';
import { approveAndApply, ApplyError, rejectPlan } from '../plan/apply.js';
import { ingestBuffer } from '../jobs/ingest-statement.js';
import { detectCheckin, checkinInstruction } from '../jobs/checkin.js';
import { APPROVE_WORDS, REJECT_WORDS, chunkMessage, fmtBRL, fmtDay, formatReply, headline, mobileify, trackerText, type TrackerState } from './poster.js';
import { setChannelStatus } from '../http/routes/health.js';
import { scoped } from '../log.js';

const log = scoped('discord');

interface SummaryRef {
  /** messages that accept a ✅ reaction as approval (thread summary and channel tracker) */
  messageIds: string[];
  version: number;
}

interface NoticeRef {
  day: string;
  threadId: string;
}

const HINT_THREAD = 'Detalhes na thread.';
const HINT_APPROVE = 'Reaja ✅ para aplicar · "rejeita" descarta.';

/**
 * Discord channel, designed for a phone: every topic (a question, a statement, a nudge) is one short
 * **tracker** message in the channel that is edited in place as the topic moves along (thinking →
 * answered, plan waiting → applied); everything else happens in the topic's thread. Messages in a
 * thread are turns of that conversation; ✅ on the latest plan summary or on the tracker (or "aprova")
 * applies the plan. Only DISCORD_OBEYED_USER_IDS are acted on.
 */
export class DiscordBot implements NotifyTarget {
  name = 'discord';
  private client: Client;
  private channel: TextChannel | null = null;
  /** plan id → messages whose ✅ approves it, at a given version */
  private summaries = new Map<string, SummaryRef>();
  /** notice key → thread of today's notice */
  private notices = new Map<string, NoticeRef>();
  private ready = false;

  constructor(private readonly ctx: AppContext) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.MessageContent],
      partials: [Partials.Message, Partials.Reaction, Partials.Channel],
    });
  }

  async start(): Promise<void> {
    const { config } = this.ctx;
    this.client.on(Events.MessageCreate, (m) => void this.onMessage(m).catch((err) => log.error({ err }, 'onMessage failed')));
    this.client.on(Events.MessageReactionAdd, (r, u) => void this.onReaction(r, u).catch((err) => log.error({ err }, 'onReaction failed')));
    this.client.on(Events.Error, (err) => log.error({ err }, 'gateway error'));
    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, () => resolve());
      this.client.login(config.DISCORD_BOT_TOKEN!).catch(reject);
    });
    const ch = await this.client.channels.fetch(config.DISCORD_CHANNEL_ID!);
    if (!ch || ch.type !== ChannelType.GuildText) throw new Error('DISCORD_CHANNEL_ID is not a text channel');
    this.channel = ch as TextChannel;
    this.ready = true;
    setChannelStatus({ name: 'discord', enabled: true, ok: true, detail: `connected as ${this.client.user?.tag}` });
    const saved = await getState<Record<string, SummaryRef | { messageId: string; version: number }>>(this.ctx.db, 'discord_summaries');
    if (saved) {
      for (const [k, v] of Object.entries(saved)) {
        this.summaries.set(k, 'messageIds' in v ? v : { messageIds: [v.messageId], version: v.version });
      }
    }
    const notices = await getState<Record<string, NoticeRef>>(this.ctx.db, 'discord_notices');
    if (notices) for (const [k, v] of Object.entries(notices)) this.notices.set(k, v);
    // Assistant replies for Discord conversations go back to their thread; the tracker follows.
    this.ctx.bus.onAnyConversation((conversationId, ev) => {
      if (ev.type === 'message' && ev.role === 'assistant' && (ev.status === 'done' || ev.status === 'failed')) {
        void this.relayAssistant(conversationId, ev.content, ev.status).catch((err) => log.warn({ err }, 'relay failed'));
      }
      if (ev.type === 'plan' && ev.status === 'rejected') {
        void this.onPlanRejected(conversationId, ev.planId).catch((err) => log.warn({ err }, 'tracker update failed'));
      }
    });
    await this.catchUp().catch((err) => log.warn({ err }, 'catch-up failed'));
    log.info({ guild: config.DISCORD_GUILD_ID, channel: config.DISCORD_CHANNEL_ID }, 'Discord bot ready');
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private isObeyed(userId: string): boolean {
    return this.ctx.config.discordObeyedUserIds.includes(userId);
  }

  private inScope(m: Message): boolean {
    if (!m.guildId || m.guildId !== this.ctx.config.DISCORD_GUILD_ID) return false;
    if (m.channelId === this.ctx.config.DISCORD_CHANNEL_ID) return true;
    const ch = m.channel;
    return ch.isThread() && ch.parentId === this.ctx.config.DISCORD_CHANNEL_ID;
  }

  private webLink(conversationId: string, planId?: string | null): string | null {
    const base = this.ctx.config.WEB_APP_URL;
    if (!base) return null;
    const u = new URL(base);
    u.searchParams.set('view', 'advisor');
    u.searchParams.set('conversation', conversationId);
    if (planId) u.searchParams.set('plan', planId);
    return u.toString();
  }

  // ---- inbound -------------------------------------------------------------------------------

  private async onMessage(m: Message): Promise<void> {
    if (m.author.bot || !this.inScope(m) || !this.isObeyed(m.author.id)) return;
    if (!(await claimEvent(this.ctx.db, { source: 'discord', external_id: `msg:${m.id}`, kind: 'message', payload: { channel: m.channelId } }))) return;
    await setState(this.ctx.db, 'discord_last_seen', { at: new Date().toISOString(), messageId: m.id });
    await this.handleMessage(m);
  }

  private async handleMessage(m: Message): Promise<void> {
    const actor = `discord:${m.author.id}`;
    const text = (m.content ?? '').trim();
    const thread = m.channel.isThread() ? (m.channel as ThreadChannel) : null;

    // Approval words inside a plan thread
    if (thread) {
      const conv = await findConversationByExternalRef(this.ctx.db, 'discord', thread.id);
      if (conv && (APPROVE_WORDS.test(text) || REJECT_WORDS.test(text))) {
        const pending = (await listPlans(this.ctx.db, { conversation_id: conv.id, status: ['pending_approval'] }))[0];
        if (pending) {
          if (APPROVE_WORDS.test(text)) await this.applyPlan(pending.id, actor, thread);
          else {
            await rejectPlan(this.ctx, pending.id, actor);
            await thread.send('Plano rejeitado.');
          }
          return;
        }
      }
    }

    // Conversation: existing thread, or a new tracker + thread off the channel
    let conversationId: string;
    let target: ThreadChannel;
    if (thread) {
      const conv = await findConversationByExternalRef(this.ctx.db, 'discord', thread.id);
      if (conv) conversationId = conv.id;
      else {
        const c = await createConversation(this.ctx.db, { channel: 'discord', title: thread.name.slice(0, 120), external_ref: thread.id, created_by: actor });
        conversationId = c.id;
      }
      target = thread;
    } else {
      const title = (text || m.attachments.first()?.name || 'Conversa').replace(/\s+/g, ' ').slice(0, 80);
      const tracker = await m.reply({ content: trackerText({ title, status: '⏳ Pensando…', hint: HINT_THREAD }), allowedMentions: { repliedUser: false } });
      target = await tracker.startThread({ name: title.slice(0, 90), autoArchiveDuration: 1440 });
      const c = await createConversation(this.ctx.db, { channel: 'discord', title, external_ref: target.id, created_by: actor });
      conversationId = c.id;
    }
    await this.setTracker(target, { status: '⏳ Pensando…' });

    // Attachments → uploads into the conversation (15 MB cap)
    const maxBytes = this.ctx.config.UPLOAD_MAX_MB * 1024 * 1024;
    let ingested = 0;
    for (const att of m.attachments.values()) {
      if (att.size > maxBytes) {
        await target.send(`Arquivo ${att.name} excede ${this.ctx.config.UPLOAD_MAX_MB} MB; ignorado.`);
        continue;
      }
      const res = await fetch(att.url);
      const buf = Buffer.from(await res.arrayBuffer());
      await ingestBuffer(this.ctx, { buffer: buf, filename: att.name ?? 'attachment', source: 'upload', conversationId, actor, message: text || null, kind: 'interactive' });
      ingested++;
    }
    if (ingested > 0) {
      await target.sendTyping().catch(() => undefined);
      return; // the ingest already started the turn with the text as the user's message
    }
    if (!text) return;

    const checkin = detectCheckin(text);
    await target.sendTyping().catch(() => undefined);
    void this.ctx.sessions.sendUserMessage(conversationId, text, { actor, kind: 'interactive', context: checkin ? checkinInstruction(checkin) : undefined });
  }

  private async onReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
    if (user.bot || !this.isObeyed(user.id)) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.emoji.name !== '✅' && reaction.emoji.name !== '👍') return;
    const msg = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    const planId = [...this.summaries.entries()].find(([, ref]) => ref.messageIds.includes(msg.id))?.[0];
    if (!planId) return;
    if (!(await claimEvent(this.ctx.db, { source: 'discord', external_id: `react:${msg.id}:${user.id}:${reaction.emoji.name}`, kind: 'reaction' }))) return;
    const plan = await getPlan(this.ctx.db, planId);
    const thread = msg.channel.isThread() ? (msg.channel as ThreadChannel) : plan ? await this.threadOf(plan.conversation_id) : null;
    if (!thread) return;
    await this.applyPlan(planId, `discord:${user.id}`, thread);
  }

  private async applyPlan(planId: string, actor: string, thread: ThreadChannel): Promise<void> {
    const plan = await getPlan(this.ctx.db, planId);
    if (!plan) return;
    const ref = this.summaries.get(planId);
    if (ref && ref.version !== plan.version) {
      await thread.send(`O plano mudou desde o último resumo (v${ref.version} → v${plan.version}). Confira o novo resumo antes de aprovar.`);
      await this.postSummary(plan, thread);
      return;
    }
    try {
      await this.setTracker(thread, { status: '⏳ Aplicando…', hint: null });
      const r = await approveAndApply(this.ctx, planId, { actor, version: plan.version });
      const rec = r.reconciliation?.reconciliation;
      const lines = [
        r.status === 'applied' ? `✅ Aplicado: ${r.applied} lançamento${r.applied === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} já estavam no ledger` : ''}.` : `⚠️ Parou no item ${r.items.find((i) => i.status === 'failed')?.seq ?? '?'}: ${r.applied} ok, ${r.failed} falhou.`,
        ...r.items.filter((i) => i.status === 'failed').map((i) => `Item ${i.seq} (${i.kind}): ${i.error}`),
        rec ? reconciliationLine(rec) : '',
        ...r.reopened.map((x) => (x.status === 'open' ? `Conciliação até ${fmtDay(x.period_end)} continua aberta: diferença ${fmtBRL(Number(x.difference ?? 0))}.` : `Conciliação até ${fmtDay(x.period_end)} fechada de novo: saldo bate.`)),
      ].filter(Boolean);
      await this.send(thread, lines.join('\n'));
    } catch (err) {
      const msg = err instanceof ApplyError ? err.message : (err as Error).message;
      await thread.send(`Não consegui aplicar: ${msg}`);
      await this.setTracker(thread, { status: '⚠️ Falhou ao aplicar', lines: [msg.slice(0, 160)], hint: HINT_THREAD });
    }
  }

  // ---- outbound ------------------------------------------------------------------------------

  private async send(target: ThreadChannel | TextChannel, text: string): Promise<Message | null> {
    const chunks = chunkMessage(mobileify(text));
    let last: Message | null = null;
    for (const chunk of chunks) last = await target.send({ content: chunk });
    return last;
  }

  /** The thread of a conversation on Discord (any channel, once it has reached Discord), if any. */
  private async threadOf(conversationId: string): Promise<ThreadChannel | null> {
    const conv = await getConversation(this.ctx.db, conversationId);
    if (!conv?.external_ref) return null;
    const t = await this.client.channels.fetch(conv.external_ref).catch(() => null);
    return t && t.isThread() ? (t as ThreadChannel) : null;
  }

  /** Thread for a conversation, opening a tracker + thread in the channel when it has none yet. */
  private async threadFor(conv: Conversation, title: string, initial: TrackerState): Promise<ThreadChannel | null> {
    if (!this.channel) return null;
    const existing = await this.threadOf(conv.id);
    if (existing) return existing;
    const starter = await this.channel.send(trackerText({ ...initial, title }));
    const thread = await starter.startThread({ name: title.slice(0, 90), autoArchiveDuration: 1440 });
    await updateConversation(this.ctx.db, conv.id, { external_ref: thread.id });
    return thread;
  }

  /**
   * Edits the channel message a thread hangs from (a thread started from a message shares its id).
   * Trackers the bot did not author (legacy threads off a person's message) are left alone.
   */
  private async setTracker(thread: ThreadChannel, patch: Partial<TrackerState>): Promise<void> {
    if (!this.channel) return;
    const starter = await this.channel.messages.fetch(thread.id).catch(() => null);
    if (!starter || starter.author.id !== this.client.user?.id) return;
    const current = parseTracker(starter.content);
    const next: TrackerState = { title: patch.title ?? current.title ?? thread.name, status: patch.status ?? current.status ?? '', lines: patch.lines ?? [], hint: patch.hint === undefined ? current.hint : patch.hint, link: patch.link === undefined ? current.link : patch.link };
    const content = trackerText(next);
    if (content !== starter.content) await starter.edit({ content, allowedMentions: { repliedUser: false } }).catch((err) => log.warn({ err }, 'tracker edit failed'));
  }

  private async relayAssistant(conversationId: string, content: string, status: 'done' | 'failed'): Promise<void> {
    const conv = await getConversation(this.ctx.db, conversationId);
    if (!conv || conv.channel !== 'discord' || !conv.external_ref) return;
    const t = await this.client.channels.fetch(conv.external_ref).catch(() => null);
    if (!t || !t.isThread()) return;
    const thread = t as ThreadChannel;
    if (content.trim()) {
      const chunks = chunkMessage(formatReply(content));
      for (const chunk of chunks) await thread.send({ content: chunk });
    }
    // A pending plan owns the tracker; otherwise the tracker shows the answer's headline.
    const pending = (await listPlans(this.ctx.db, { conversation_id: conv.id, status: ['pending_approval'] }))[0];
    if (pending) return;
    if (status === 'failed') await this.setTracker(thread, { status: '⚠️ A resposta falhou', lines: [headline(content, 140)], hint: HINT_THREAD });
    else await this.setTracker(thread, { status: '✅ Respondido', lines: [headline(content)], hint: HINT_THREAD, link: this.webLink(conv.id) });
  }

  private async planLines(plan: PlanWithCounts): Promise<string[]> {
    const balance = (plan.result as { balance?: { ok: boolean; difference: number; account_name?: string | null } } | null)?.balance;
    const items = (await listPlanItems(this.ctx.db, plan.id)).filter((i) => i.status !== 'removed');
    const n = (kinds: string[]) => items.filter((i) => kinds.includes(i.kind)).length;
    const accounts = n(['account_create', 'account_update']);
    const other = items.length - plan.create_count - plan.update_count - plan.adjust_count - plan.skip_count - accounts;
    const counts = [
      plan.create_count ? `${plan.create_count} novo${plan.create_count === 1 ? '' : 's'}` : '',
      plan.update_count ? `${plan.update_count} alteraç${plan.update_count === 1 ? 'ão' : 'ões'}` : '',
      plan.adjust_count ? `${plan.adjust_count} ajuste${plan.adjust_count === 1 ? '' : 's'}` : '',
      accounts ? `${accounts} conta${accounts === 1 ? '' : 's'}` : '',
      plan.skip_count ? `${plan.skip_count} já no ledger` : '',
      other > 0 ? `${other} outro${other === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    return [
      counts.join(' · '),
      balance ? (balance.ok ? `✓ Saldo bate com o extrato${balance.account_name ? ` (${balance.account_name})` : ''}` : `✗ Diferença de ${fmtBRL(balance.difference)} contra o extrato`) : '',
    ].filter(Boolean);
  }

  /** Compact plan summary in the thread (approval by ✅ on it), and the tracker set to "waiting". */
  private async postSummary(plan: PlanWithCounts, thread: ThreadChannel): Promise<void> {
    const lines = await this.planLines(plan);
    const text = [`**Plano v${plan.version} pronto para aprovar**`, ...lines, headline(plan.summary ?? '', 200), HINT_APPROVE].filter(Boolean).join('\n');
    const msg = await this.send(thread, text);
    await this.setTracker(thread, { status: '🟡 Plano aguardando aprovação', lines, hint: HINT_APPROVE, link: this.webLink(plan.conversation_id, plan.id) });
    const ids: string[] = [];
    if (msg) {
      await msg.react('✅').catch(() => undefined);
      ids.push(msg.id);
    }
    const starter = this.channel ? await this.channel.messages.fetch(thread.id).catch(() => null) : null;
    if (starter && starter.author.id === this.client.user?.id) {
      await starter.react('✅').catch(() => undefined);
      ids.push(starter.id);
    }
    this.summaries.set(plan.id, { messageIds: ids, version: plan.version });
    await setState(this.ctx.db, 'discord_summaries', Object.fromEntries(this.summaries));
  }

  async planPending(n: PlanNotification): Promise<void> {
    if (!this.ready) return;
    const conv = await getConversation(this.ctx.db, n.conversationId);
    const plan = await getPlan(this.ctx.db, n.planId);
    if (!conv || !plan) return;
    const thread = await this.threadFor(conv, n.title, { title: n.title, status: '🟡 Plano aguardando aprovação', hint: HINT_APPROVE });
    if (!thread) return;
    await this.postSummary(plan, thread);
  }

  async planApplied(n: PlanNotification & { result: Record<string, unknown> }): Promise<void> {
    if (!this.ready) return;
    const thread = await this.threadOf(n.conversationId);
    if (!thread) return;
    const rec = (n.result.reconciliation ?? null) as { status?: string; difference?: number; period_end?: string } | null;
    const reopened = (n.result.reopened ?? []) as Array<{ status: string; difference: number | null; period_end: string }>;
    const applied = Number(n.result.applied ?? 0);
    const ok = n.status === 'applied';
    const lines = [
      ok ? `${applied} lançamento${applied === 1 ? '' : 's'} gravado${applied === 1 ? '' : 's'}` : `${applied} ok, ${String(n.result.failed ?? 0)} falhou`,
      rec ? reconciliationLine(rec) : '',
      ...reopened.map((x) => (x.status === 'open' ? `Conciliação até ${fmtDay(x.period_end)} aberta: diferença ${fmtBRL(Number(x.difference ?? 0))}` : `Conciliação até ${fmtDay(x.period_end)} fechada de novo`)),
    ].filter(Boolean);
    await this.setTracker(thread, { status: ok ? '✅ Aplicado' : '⚠️ Aplicado em parte', lines, hint: ok ? null : HINT_THREAD, link: this.webLink(n.conversationId, n.planId) });
    // The thread already got the result line from applyPlan when approval came from Discord; approvals
    // from the web only get the tracker update.
    if (!this.summaries.has(n.planId)) return;
    this.summaries.delete(n.planId);
    await setState(this.ctx.db, 'discord_summaries', Object.fromEntries(this.summaries));
  }

  private async onPlanRejected(conversationId: string, planId: string): Promise<void> {
    const thread = await this.threadOf(conversationId);
    if (!thread) return;
    await this.setTracker(thread, { status: '❌ Plano rejeitado', lines: [], hint: null });
    if (this.summaries.delete(planId)) await setState(this.ctx.db, 'discord_summaries', Object.fromEntries(this.summaries));
  }

  async assistantReply(): Promise<void> {
    /* handled through the bus (relayAssistant) */
  }

  /** A daemon-raised topic: tracker in the channel, details in its thread; same key same day → edit. */
  async notice(n: Notice): Promise<void> {
    if (!this.ready || !this.channel) return;
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: this.ctx.config.TZ });
    const prev = this.notices.get(n.key);
    if (prev && prev.day === day) {
      const t = await this.client.channels.fetch(prev.threadId).catch(() => null);
      if (t && t.isThread()) {
        await this.setTracker(t as ThreadChannel, { title: n.title, status: n.status, lines: n.lines ?? [], hint: HINT_THREAD });
        return;
      }
    }
    const starter = await this.channel.send(trackerText({ title: n.title, status: n.status, lines: n.lines, hint: n.details?.length ? HINT_THREAD : null }));
    const thread = await starter.startThread({ name: n.title.slice(0, 90), autoArchiveDuration: 1440 });
    const conv = await createConversation(this.ctx.db, { channel: 'discord', title: n.title, external_ref: thread.id, created_by: 'system' });
    if (n.context) await updateConversation(this.ctx.db, conv.id, { summary: n.context });
    if (n.details?.length) {
      for (const chunk of chunkMessage(n.details.join('\n'))) await thread.send({ content: chunk });
    }
    this.notices.set(n.key, { day, threadId: thread.id });
    await setState(this.ctx.db, 'discord_notices', Object.fromEntries(this.notices));
  }

  /** Short operational alert (health, re-auth): one message in the channel, no thread. */
  async alert(text: string): Promise<void> {
    if (!this.ready || !this.channel) return;
    await this.send(this.channel, text);
  }

  /** Replays obeyed-user messages missed while the daemon was down (channel and active threads). */
  private async catchUp(): Promise<void> {
    if (!this.channel) return;
    const last = await getState<{ at: string }>(this.ctx.db, 'discord_last_seen');
    const since = last ? new Date(last.at).getTime() : Date.now() - 24 * 3_600_000;
    const sources: Array<TextChannel | ThreadChannel> = [this.channel];
    const threads = await this.channel.threads.fetchActive().catch(() => null);
    if (threads) for (const t of threads.threads.values()) sources.push(t);
    let replayed = 0;
    for (const src of sources) {
      const msgs = await src.messages.fetch({ limit: 50 }).catch(() => null);
      if (!msgs) continue;
      for (const m of [...msgs.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
        if (m.createdTimestamp <= since || m.author.bot || !this.isObeyed(m.author.id)) continue;
        if (!(await claimEvent(this.ctx.db, { source: 'discord', external_id: `msg:${m.id}`, kind: 'message', payload: { replay: true } }))) continue;
        await this.handleMessage(m);
        replayed++;
      }
    }
    await setState(this.ctx.db, 'discord_last_seen', { at: new Date().toISOString() });
    if (replayed) log.info({ replayed }, 'catch-up replayed messages');
  }
}

function reconciliationLine(rec: { status?: string; difference?: number | null; period_end?: string | null; notes?: string | null }): string {
  const until = rec.period_end ? ` até ${fmtDay(rec.period_end)}` : '';
  if (rec.status === 'balanced') return `Conciliação fechada${until}: saldo bate.`;
  if (rec.status === 'adjusted') return `Conciliação fechada com ajuste de ${fmtBRL(Number(rec.difference ?? 0))}${until}.`;
  return `Conciliação aberta${until}: diferença ${fmtBRL(Number(rec.difference ?? 0))}.`;
}

/** Reads title/status/hint/link back from a tracker message so partial edits keep the rest. */
export function parseTracker(content: string): Partial<TrackerState> {
  const parts = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const out: Partial<TrackerState> = {};
  const title = parts[0];
  if (title && /^\*\*.*\*\*$/.test(title)) out.title = title.slice(2, -2);
  if (parts[1]) out.status = parts[1];
  const link = parts.find((p) => /^<https?:\/\/.*>$/.test(p));
  if (link) out.link = link.slice(1, -1);
  const hint = parts.find((p) => p === HINT_THREAD || p === HINT_APPROVE);
  if (hint) out.hint = hint;
  return out;
}
