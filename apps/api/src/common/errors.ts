/** Domain errors. The HTTP layer maps them to status codes in HttpErrorFilter. */

/** A business rule wasn't met. `issues` are complete, user-facing sentences. */
export class RuleViolation extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(" "));
    this.name = "RuleViolation";
  }
}

export class Forbidden extends Error {
  constructor(message = "You don't have permission to do that.") {
    super(message);
    this.name = "Forbidden";
  }
}

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found.`);
    this.name = "NotFound";
  }
}

export class Conflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Conflict";
  }
}

export function assertRules(issues: (string | false | null | undefined)[]): void {
  const list = issues.filter((i): i is string => typeof i === "string" && i.length > 0);
  if (list.length) throw new RuleViolation(list);
}
