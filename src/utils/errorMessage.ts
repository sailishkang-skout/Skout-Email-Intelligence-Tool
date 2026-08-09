/*
==================================================
ERROR MESSAGE EXTRACTION
==================================================

Purpose:

Node's AggregateError (thrown by the `pg` driver when
a dual-stack "localhost" connection is refused on both
::1 and 127.0.0.1 - the exact shape of a real Postgres-
down failure) is an instanceof Error but its `.message`
is empty by default; the actual detail lives in
`.errors[]`. The naive `error instanceof Error ?
error.message : String(error)` pattern used throughout
this codebase silently degrades to an empty string for
this specific, common infrastructure-outage case -
exactly when a clear message matters most.
==================================================
*/

export function extractErrorMessage(
  error: unknown
): string {

  if (
    error instanceof Error &&
    error.message
  ) {
    return error.message;
  }

  if (
    error instanceof AggregateError
  ) {

    const subMessages =
      error.errors
        .map((subError) =>
          subError instanceof Error
            ? subError.message
            : String(subError)
        )
        .filter(Boolean);

    if (subMessages.length > 0) {
      return subMessages.join("; ");
    }

  }

  if (error instanceof Error) {
    return error.name || "Unknown error";
  }

  return String(error);

}
