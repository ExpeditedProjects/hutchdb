/**
 * An intentional, client-facing rejection of caller input (bad filter
 * operator, invalid field name, unsupported aggregation). The message is
 * written for the agent and reaches the MCP client verbatim; these are
 * expected outcomes, not bugs, so they are not sent to error reporting.
 */
export class ClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientInputError";
  }
}
