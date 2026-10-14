import type { Role } from "@uo/shared";

/** The authenticated user (or the automation system) performing an action. */
export interface Actor {
  id: string;
  name: string;
  roles: Role[];
  ip?: string;
}

/** Used by background jobs. Not a database user: rows it writes have a null actor. */
export const SYSTEM: Actor = { id: "00000000-0000-0000-0000-000000000000", name: "Automation", roles: ["administrator"] };
export const isSystem = (a: Actor) => a.id === SYSTEM.id;
/** For foreign-key columns: the system actor is stored as null. */
export const actorRef = (a: Actor): string | null => (isSystem(a) ? null : a.id);
