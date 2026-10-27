import type Anthropic from "@anthropic-ai/sdk";
import { HttpException, Inject, Injectable, Logger } from "@nestjs/common";
import { type AssistantAttachmentKind, can, today } from "@uo/shared";
import { z } from "zod";
import { DOCUMENT_READER, type DocumentReader, ReadFailed } from "../ai/document-reader";
import { AuditService } from "../audit/audit.service";
import { ENV, type Env } from "../config/env";
import type { Actor } from "../common/actor";
import { Conflict, Forbidden, NotFound, RuleViolation } from "../common/errors";
import { PrismaService } from "../common/prisma.service";
import { dateOnly } from "../common/values";
import { sniffMatches } from "../documents/documents.service";
import { AssistantActions, type Prepared, proposalKind } from "./actions";
import { ATTACHMENT_TYPES, DEFAULT_QUESTION, attachmentText } from "./attachments";
import { assistantInstructions } from "./instructions";
import { AssistantTools, toolDefinitions } from "./tools";

/** The Messages API, or a scripted stand-in in tests. */
export type AssistantModel = Pick<Anthropic["messages"], "create">;
export const ASSISTANT_MODEL = Symbol("ASSISTANT_MODEL");

/** Tool calls per question; past this the model is asked to answer with what it has. */
const MAX_TOOL_CALLS = 6;
/** Changes one answer may prepare. */
const MAX_PROPOSALS = 5;
/** Earlier turns of the conversation sent with each question. */
const HISTORY = 20;
const SORRY = "Sorry, I couldn't answer that just now. Try again in a minute, or ask it a different way.";

@Injectable()
export class AssistantService {
  private readonly log = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tools: AssistantTools,
    private readonly actions: AssistantActions,
    @Inject(ASSISTANT_MODEL) private readonly model: AssistantModel,
    @Inject(DOCUMENT_READER) private readonly reader: DocumentReader,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async conversation(actor: Actor, id: string) {
    const c = await this.prisma.assistantConversation.findUnique({ where: { id } });
    if (!c || c.userId !== actor.id) throw new NotFound("Conversation");
    return c;
  }

  async messages(actor: Actor, conversationId: string) {
    await this.conversation(actor, conversationId);
    const rows = await this.prisma.assistantMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, body: true, toolsUsed: true, createdAt: true, feedback: { select: { helpful: true } }, actions: { orderBy: { createdAt: "asc" } } },
    });
    return rows.map((m) => ({ ...m, actions: m.actions.map((a) => this.actions.view(a)) }));
  }

  private async checkLimit(actor: Actor) {
    const asked = await this.prisma.assistantMessage.count({ where: { role: "user", conversation: { userId: actor.id }, createdAt: { gte: dateOnly(today()) } } });
    if (asked >= this.env.AI_ASSISTANT_DAILY_LIMIT) throw new HttpException("You've reached today's assistant limit. It resets at midnight.", 429);
  }

  /**
   * A question with a bill or business card attached. The AI reader pulls out its details, which go
   * with the question as text; the file isn't stored. The assistant then works as usual: it looks
   * things up and prepares changes the user confirms.
   */
  async askWithFile(
    actor: Actor,
    file: Express.Multer.File | undefined,
    input: { conversationId?: string | null; opportunityId?: string | null; kind: AssistantAttachmentKind; message?: string },
  ) {
    if (!file) throw new RuleViolation([input.kind === "bill" ? "Choose the bill to attach." : "Choose a photo of the card."]);
    if (!this.reader.configured) throw new RuleViolation(["Reading files with AI isn't set up yet. An administrator needs to add the Anthropic API key."]);
    if (!ATTACHMENT_TYPES[input.kind].includes(file.mimetype) || !sniffMatches(file.mimetype, file.buffer))
      throw new RuleViolation([input.kind === "bill" ? "Attach the bill as a PDF or a JPG, PNG or WEBP photo." : "Attach a JPG, PNG or WEBP photo of the card."]);
    // Checked before reading, so a user over the limit doesn't run up a read.
    await this.checkLimit(actor);
    let read;
    try {
      read = input.kind === "bill" ? await this.reader.readBill(file.buffer, file.mimetype) : await this.reader.readCard(file.buffer, file.mimetype);
    } catch (e) {
      if (e instanceof ReadFailed) throw new RuleViolation([e.message]);
      throw e;
    }
    const message = input.message?.trim() || DEFAULT_QUESTION[input.kind];
    return this.ask(actor, { conversationId: input.conversationId, opportunityId: input.opportunityId, message }, { kind: input.kind, text: attachmentText(input.kind, read) });
  }

  /** Answers one question. The user's message, the answer and any changes it prepared are stored; nothing else changes. */
  async ask(actor: Actor, input: { conversationId?: string | null; opportunityId?: string | null; message: string }, attachment?: { kind: AssistantAttachmentKind; text: string }) {
    await this.checkLimit(actor);

    // The deal on screen, only if the user can see it (otherwise it's just not mentioned).
    const dealId = input.opportunityId ? await this.tools.dealId(actor, input.opportunityId).catch(() => null) : null;
    const conversation = input.conversationId ? await this.conversation(actor, input.conversationId) : await this.prisma.assistantConversation.create({ data: { userId: actor.id, opportunityId: dealId } });
    const earlier = await this.prisma.assistantMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" }, take: HISTORY, select: { role: true, body: true } });
    const body = attachment ? `${input.message}\n\n${attachment.text}` : input.message;
    const question = await this.prisma.assistantMessage.create({ data: { conversationId: conversation.id, role: "user", body, toolsUsed: [] } });

    // Today's date goes with the question (not the cached instructions) so "next Tuesday" can be scheduled.
    const now = today();
    const weekday = new Date(`${now}T12:00:00Z`).toLocaleDateString("en-IE", { weekday: "long", timeZone: "UTC" });
    const context = `(Today is ${weekday} ${now}.${dealId ? ` I'm looking at deal ${dealId}.` : ""})\n\n`;
    const messages: Anthropic.MessageParam[] = [...earlier.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.body })), { role: "user", content: context + body }];
    const { answer, toolsUsed, usage, proposals } = await this.converse(actor, messages);

    const reply = await this.prisma.assistantMessage.create({
      data: { conversationId: conversation.id, role: "assistant", body: answer, toolsUsed, model: this.env.AI_ASSISTANT_MODEL, inputTokens: usage.input, outputTokens: usage.output },
    });
    const actions = await this.actions.save(actor, reply.id, proposals);
    await this.audit.log(actor, {
      action: "assistant.message",
      entityType: "assistant_conversation",
      entityId: conversation.id,
      summary: "Asked the CRM assistant",
      data: { questionId: question.id, answerId: reply.id, ...(attachment ? { attachment: attachment.kind, reader: this.reader.model } : {}), tools: toolsUsed, proposed: actions.map((a) => a.kind), model: this.env.AI_ASSISTANT_MODEL, inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached },
    });
    return { conversationId: conversation.id, question: { id: question.id, role: "user", body }, message: { id: reply.id, role: "assistant", body: answer, toolsUsed, createdAt: reply.createdAt, feedback: [], actions } };
  }

  /** The tool loop: Claude calls read-only tools and prepares changes (as the user) until it can answer. */
  private async converse(actor: Actor, messages: Anthropic.MessageParam[]) {
    const toolsUsed: string[] = [];
    const proposals: Prepared[] = [];
    const usage = { input: 0, output: 0, cached: 0 };
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: assistantInstructions(), cache_control: { type: "ephemeral" } }];
    try {
      for (let round = 0; round <= MAX_TOOL_CALLS; round++) {
        const res = await this.model.create({ model: this.env.AI_ASSISTANT_MODEL, max_tokens: 4000, system, tools: toolDefinitions(), messages });
        usage.input += res.usage.input_tokens;
        usage.output += res.usage.output_tokens;
        usage.cached += res.usage.cache_read_input_tokens ?? 0;
        if (res.stop_reason === "refusal") return { answer: "I can't help with that one.", toolsUsed, usage, proposals: [] };
        if (res.stop_reason !== "tool_use") {
          const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
          return { answer: text || SORRY, toolsUsed, usage, proposals };
        }
        // Thinking and tool_use blocks go back unchanged, then one result per tool call.
        messages.push({ role: "assistant", content: res.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== "tool_use") continue;
          if (toolsUsed.length >= MAX_TOOL_CALLS) {
            results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: "Tool limit reached. Answer with what you have." });
            continue;
          }
          toolsUsed.push(block.name);
          const kind = proposalKind(block.name);
          const out = kind ? await this.propose(actor, kind, block.input, proposals) : await this.tools.run(actor, block.name, block.input);
          results.push({ type: "tool_result", tool_use_id: block.id, content: out.text, ...(out.error ? { is_error: true } : {}) });
        }
        messages.push({ role: "user", content: results });
      }
      return { answer: SORRY, toolsUsed, usage, proposals: [] };
    } catch (e) {
      this.log.warn({ err: (e as Error).message, status: (e as { status?: number }).status }, "Assistant request failed");
      return { answer: SORRY, toolsUsed, usage, proposals: [] };
    }
  }

  /** A propose_ tool call: checked and described now, stored with the answer, made only when the user confirms. */
  private async propose(actor: Actor, kind: NonNullable<ReturnType<typeof proposalKind>>, input: unknown, proposals: Prepared[]) {
    if (proposals.length >= MAX_PROPOSALS) return { text: `At most ${MAX_PROPOSALS} changes per answer. Offer the rest next time.`, error: true };
    try {
      const p = await this.actions.prepare(actor, kind, input);
      proposals.push(p);
      return { text: JSON.stringify({ prepared: p.summary, note: "Shown to the user as a card with Confirm. Nothing has changed yet." }), error: false };
    } catch (e) {
      if (e instanceof z.ZodError) return { text: `Invalid input: ${e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, error: true };
      if (e instanceof RuleViolation) return { text: `Can't prepare that: ${e.issues.join(" ")}`, error: true };
      if (e instanceof NotFound || e instanceof Forbidden || e instanceof Conflict) return { text: e.message, error: true };
      throw e;
    }
  }

  async feedback(actor: Actor, messageId: string, input: { helpful: boolean; comment?: string | null }) {
    const m = await this.prisma.assistantMessage.findUnique({ where: { id: messageId }, include: { conversation: true } });
    if (!m || m.conversation.userId !== actor.id || m.role !== "assistant") throw new NotFound("Answer");
    await this.prisma.assistantFeedback.create({ data: { messageId, userId: actor.id, helpful: input.helpful, comment: input.comment ?? null } });
  }

  /** Unhelpful answers with the question before them, newest first, to improve the instructions. */
  async unhelpful(actor: Actor) {
    if (!can(actor, "assistant.review")) throw new Forbidden();
    const rows = await this.prisma.assistantFeedback.findMany({
      where: { helpful: false },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { message: { select: { id: true, body: true, toolsUsed: true, createdAt: true, conversationId: true } } },
    });
    return Promise.all(
      rows.map(async (f) => {
        const question = await this.prisma.assistantMessage.findFirst({
          where: { conversationId: f.message.conversationId, role: "user", createdAt: { lte: f.message.createdAt } },
          orderBy: { createdAt: "desc" },
          select: { body: true },
        });
        return { id: f.id, createdAt: f.createdAt, comment: f.comment, question: question?.body ?? null, answer: f.message.body, toolsUsed: f.message.toolsUsed };
      }),
    );
  }
}
