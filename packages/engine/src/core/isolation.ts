/**
 * A transaction's isolation level: SERIALIZABLE, every role's unless generate certifies it otherwise, or READ COMMITTED,
 * a role's whose representation generate certifies needs no more. Its change members begin at it; every read begins
 * SERIALIZABLE READ ONLY, DEFERRABLE where its member is deferrable(...).
 */
export type Isolation = "serializable" | "readCommitted"
