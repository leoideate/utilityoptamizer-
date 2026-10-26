import { daysBetween, today } from "./dates";
import { STAGES, type StageKey, stageIndex } from "./stages";

/**
 * "Needs your attention" (Home) and the morning summary notification. Rule-based, no AI:
 *
 * - **Stuck deal**: outcome open, no open activity on it, and at its stage for longer than
 *   `STUCK_AFTER_DAYS[stage]` (counted in Irish calendar days from `stageEnteredAt`). A deal
 *   with an open task is already being chased (the automations in `AUTOMATION_RULES` create
 *   those), so it shows up as a task instead of twice.
 * - **Overdue task**: the user's own open activity due before today.
 * - **Follow-up due**: an open deal whose follow-up date is today or earlier.
 * - **Renewal due**: the `renewals_due` saved view (open renewals ending within 120 days).
 *
 * Every list is scoped to the deals the user can see; tasks are the user's own.
 */

/** Rows returned per list; totals are counted separately. */
export const ATTENTION_LIMIT = 10;

const EARLY_STAGES_UNTIL: StageKey = "details_received";
const SUPPLIER_STAGES: readonly StageKey[] = ["submitted", "compliance_query", "awaiting_confirmation"];
const NEVER_STUCK: readonly StageKey[] = ["live_won", "renewal_scheduled"];

/** Days a deal may sit at a stage before it counts as stuck; null = never stuck. */
export const STUCK_AFTER_DAYS: Readonly<Record<StageKey, number | null>> = Object.fromEntries(
  STAGES.map((s) => {
    if (NEVER_STUCK.includes(s.key)) return [s.key, null];
    // Early stages move fast; when the customer has the ball they get a little longer.
    if (stageIndex(s.key) <= stageIndex(EARLY_STAGES_UNTIL)) return [s.key, 7];
    if (s.waitingOn === "customer") return [s.key, 10];
    if (SUPPLIER_STAGES.includes(s.key)) return [s.key, 7];
    return [s.key, 14];
  }),
) as Record<StageKey, number | null>;

/** The fewest days any stage allows, for narrowing a database query before `isStuck`. */
export const MIN_STUCK_DAYS = Math.min(...Object.values(STUCK_AFTER_DAYS).filter((d): d is number => d !== null));

export interface StuckFacts {
  stage: StageKey;
  outcome: "open" | "won" | "lost";
  stageEnteredAt: Date;
  hasOpenActivity: boolean;
}

/** Whole Irish calendar days since the deal entered its stage. */
export function daysAtStage(stageEnteredAt: Date, now: Date = new Date()): number {
  return daysBetween(today(stageEnteredAt), today(now));
}

export function isStuck(o: StuckFacts, now: Date = new Date()): boolean {
  const limit = STUCK_AFTER_DAYS[o.stage];
  return o.outcome === "open" && !o.hasOpenActivity && limit !== null && daysAtStage(o.stageEnteredAt, now) > limit;
}

export interface AttentionCounts {
  stuck: number;
  overdueTasks: number;
  followUps: number;
  renewals: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 deals stuck, 2 overdue tasks, 1 renewal due"; empty when there's nothing. */
export function attentionSummary(c: AttentionCounts): string {
  return [
    c.stuck && plural(c.stuck, "deal stuck", "deals stuck"),
    c.overdueTasks && plural(c.overdueTasks, "overdue task", "overdue tasks"),
    c.followUps && plural(c.followUps, "follow-up due", "follow-ups due"),
    c.renewals && plural(c.renewals, "renewal due", "renewals due"),
  ]
    .filter(Boolean)
    .join(", ");
}
