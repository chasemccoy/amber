/**
 * An expected, user-fixable failure (missing optional dependency, bad flag
 * combination, unreachable URL). The CLI prints these as a plain message —
 * stack traces are reserved for actual bugs.
 */
export class AmberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmberError";
  }
}
