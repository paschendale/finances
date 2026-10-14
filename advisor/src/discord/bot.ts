import {
  AttachmentBuilder,
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
import type { NotifyTarget, PlanNotification } from '../notify.js';
import { createConversation, findConversationByExternalRef, getConversation, updateConversation } from '../db/repo/conversations.js';
import { getPlan, listPlanItems, listPlans } from '../db/repo/plans.js';
import { claimEvent, getState, setState } from '../db/repo/misc.js';
import { approveAndApply, ApplyError, rejectPlan } from '../plan/apply.js';
import { ingestBuffer } from '../jobs/ingest-statement.js';
import { detectCheckin, checkinInstruction } from '../jobs/checkin.js';
import { APPROVE_WORDS, REJECT_WORDS, chunkMessage, discordify } from './poster.js';
import { setChannelStatus } from '../http/routes/health.js';
import { scoped } from '../log.js';

const log = scoped('discord');
const fmt = (n: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n);

interface SummaryRef {
  messageId: string;
  version: number;
}

/**
 * Discord channel: one thread per statement/plan and per ad-hoc question; messages in a thread are
 * turns of that conversation; ✅ on the latest plan summary (or "aprova") applies the plan. Only
 * DISCORD_OBEYED_USER_IDS are acted on.
 */
export class DiscordBot implements NotifyTarget {
  name = 'discord';
  private client: Client;
  private channel: TextChannel | null = null;
  /** plan id → latest summary message (approval by reaction is accepted only on this one) */
  private summaries = new Map<string, SummaryRef>();
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
    const saved = await getState<Record<string, SummaryRef>>(this.ctx.db, 'discord_summaries');
    if (saved) for (const [k, v] of Object.entries(saved)) this.summaries.set(k, v);
    // Assistant replies for Discord conversations go back to their thread.
    this.ctx.bus.onAnyConversation((conversationId, ev) => {
      if (ev.type === 'message' && ev.role === 'assistant' && (ev.status === 'done' || ev.status === 'failed')) {
        void this.relayAssistant(conversationId, ev.content).catch((err) => log.warn({ err }, 'relay failed'));
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

    // Conversation: existing thread or a new thread off the channel
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
      target = await m.startThread({ name: title, autoArchiveDuration: 1440 });
      const c = await createConversation(this.ctx.db, { channel: 'discord', title, external_ref: target.id, created_by: actor });
      conversationId = c.id;
    }

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
    const planId = [...this.summaries.entries()].find(([, ref]) => ref.messageId === msg.id)?.[0];
    if (!planId) return;
    if (!(await claimEvent(this.ctx.db, { source: 'discord', external_id: `react:${msg.id}:${user.id}:${reaction.emoji.name}`, kind: 'reaction' }))) return;
    const thread = msg.channel.isThread() ? (msg.channel as ThreadChannel) : null;
    await this.applyPlan(planId, `discord:${user.id}`, thread ?? this.channel!);
  }

  private async applyPlan(planId: string, actor: string, target: ThreadChannel | TextChannel): Promise<void> {
    const plan = await getPlan(this.ctx.db, planId);
    if (!plan) return;
    const ref = this.summaries.get(planId);
    if (ref && ref.version !== plan.version) {
      await target.send(`O plano mudou desde o último resumo (v${ref.version} → v${plan.version}). Confira o novo resumo antes de aprovar.`);
      await this.postSummary(plan.id, target);
      return;
    }
    try {
      await target.send('Aplicando…');
      const r = await approveAndApply(this.ctx, planId, { actor, version: plan.version });
      const rec = r.reconciliation?.reconciliation;
      const lines = [
        r.status === 'applied' ? `✅ Plano aplicado: ${r.applied} itens, ${r.skipped} ignorados.` : `⚠️ Plano parcialmente aplicado: ${r.applied} ok, ${r.failed} falhou.`,
        ...r.items.filter((i) => i.status === 'failed').map((i) => `• item ${i.seq} (${i.kind}): ${i.error}`),
        rec
          ? rec.status === 'balanced'
            ? `Conciliação fechada: saldo bate até ${rec.period_end}.`
            : rec.status === 'adjusted'
              ? `Conciliação fechada com ajuste de ${fmt(Number(rec.difference ?? 0))} até ${rec.period_end}.`
              : `Conciliação aberta: diferença ${fmt(Number(rec.difference ?? 0))} até ${rec.period_end}. ${rec.notes ?? ''}`
          : '',
      ].filter(Boolean);
      await this.send(target, lines.join('\n'));
    } catch (err) {
      const msg = err instanceof ApplyError ? err.message : (err as Error).message;
      await target.send(`Não consegui aplicar: ${msg}`);
    }
  }

  // ---- outbound ------------------------------------------------------------------------------

  private async send(target: ThreadChannel | TextChannel, text: string, files?: AttachmentBuilder[]): Promise<Message | null> {
    const chunks = chunkMessage(discordify(text));
    let last: Message | null = null;
    for (let i = 0; i < chunks.length; i++) {
      last = await target.send({ content: chunks[i]!, files: i === chunks.length - 1 ? files : undefined });
    }
    return last;
  }

  private async threadFor(conversationId: string, title: string): Promise<ThreadChannel | null> {
    const conv = await getConversation(this.ctx.db, conversationId);
    if (!conv || !this.channel) return null;
    if (conv.channel === 'discord' && conv.external_ref) {
      const t = await this.client.channels.fetch(conv.external_ref).catch(() => null);
      if (t && t.isThread()) return t as ThreadChannel;
    }
    if (conv.channel !== 'discord' && conv.external_ref) {
      const t = await this.client.channels.fetch(conv.external_ref).catch(() => null);
      if (t && t.isThread()) return t as ThreadChannel;
    }
    // Web/system conversation that reached Discord for the first time (a plan to approve): open a thread.
    const starter = await this.channel.send(`🧵 ${title}`);
    const thread = await starter.startThread({ name: title.slice(0, 90), autoArchiveDuration: 1440 });
    await updateConversation(this.ctx.db, conv.id, { external_ref: thread.id });
    return thread;
  }

  private async relayAssistant(conversationId: string, content: string): Promise<void> {
    const conv = await getConversation(this.ctx.db, conversationId);
    if (!conv || conv.channel !== 'discord' || !conv.external_ref || !content.trim()) return;
    const t = await this.client.channels.fetch(conv.external_ref).catch(() => null);
    if (!t || !t.isThread()) return;
    await this.send(t as ThreadChannel, content);
  }

  private async postSummary(planId: string, target: ThreadChannel | TextChannel): Promise<void> {
    const plan = await getPlan(this.ctx.db, planId);
    if (!plan) return;
    const items = await listPlanItems(this.ctx.db, planId);
    const balance = (plan.result as { balance?: { ok: boolean; difference: number; account_name?: string | null } } | null)?.balance;
    const byAccount = new Map<string, number>();
    for (const it of items) {
      if (it.status === 'removed' || !['create', 'adjust', 'update'].includes(it.kind)) continue;
      for (const e of it.entries) byAccount.set(e.account_id, (byAccount.get(e.account_id) ?? 0) + e.amount_base);
    }
    const csv = ['seq,kind,date,description,amount_base,confidence,status', ...items.map((i) => {
      const leg = i.entries.find((e) => e.amount_base < 0) ?? i.entries[0];
      return [i.seq, i.kind, i.date ?? '', JSON.stringify(i.description ?? ''), leg?.amount_base ?? '', i.confidence ?? '', i.status].join(',');
    })].join('\n');
    const text = [
      `**${plan.title}** · v${plan.version}`,
      plan.summary ?? '',
      `Criar ${plan.create_count} · Atualizar ${plan.update_count} · Ignorar ${plan.skip_count} · Ajustar ${plan.adjust_count}`,
      balance ? (balance.ok ? `✓ Saldo bate com o extrato${balance.account_name ? ` (${balance.account_name})` : ''}` : `✗ Diferença de ${fmt(balance.difference)} contra o extrato`) : '',
      '',
      'Reaja com ✅ ou responda "aprova" para aplicar; "rejeita" para descartar; qualquer outra mensagem conversa com o assistente.',
    ].filter((l) => l !== '').join('\n');
    const msg = await this.send(target, text, [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `plan-${plan.id.slice(0, 8)}-v${plan.version}.csv` })]);
    if (msg) {
      await msg.react('✅').catch(() => undefined);
      this.summaries.set(planId, { messageId: msg.id, version: plan.version });
      await setState(this.ctx.db, 'discord_summaries', Object.fromEntries(this.summaries));
    }
  }

  async planPending(n: PlanNotification): Promise<void> {
    if (!this.ready) return;
    const thread = await this.threadFor(n.conversationId, n.title);
    if (!thread) return;
    await this.postSummary(n.planId, thread);
  }

  async planApplied(n: PlanNotification & { result: Record<string, unknown> }): Promise<void> {
    if (!this.ready) return;
    const conv = await getConversation(this.ctx.db, n.conversationId);
    if (!conv?.external_ref) return;
    const t = await this.client.channels.fetch(conv.external_ref).catch(() => null);
    if (!t || !t.isThread()) return;
    const rec = (n.result.reconciliation ?? null) as { status?: string; difference?: number; period_end?: string } | null;
    const text = [
      n.status === 'applied' ? `✅ ${n.title}: aplicado.` : `⚠️ ${n.title}: ${n.status}.`,
      rec ? `Conciliação ${rec.status}${rec.period_end ? ` até ${rec.period_end}` : ''}${rec.difference ? `, diferença ${fmt(Number(rec.difference))}` : ''}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    await this.send(t as ThreadChannel, text);
  }

  async assistantReply(): Promise<void> {
    /* handled through the bus (relayAssistant) */
  }

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
