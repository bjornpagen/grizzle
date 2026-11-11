import { Schema } from "effect"

export type FaultTag = "UnseenOccupant" | "CursorOversized" | "plain"

export class TodoNotFound extends Schema.TaggedError<
	TodoNotFound,
	{ readonly brand: unique symbol }
>()("TodoNotFound", { id: Schema.String }) {}

class PostgresTransientFailure extends Schema.TaggedError<
	PostgresTransientFailure,
	{ readonly brand: unique symbol }
>()("PostgresTransientFailure", {}) {}

class PostgresStatementRejected extends Schema.TaggedError<
	PostgresStatementRejected,
	{ readonly brand: unique symbol }
>()("PostgresStatementRejected", {}) {}

export type TodoFailure = PostgresTransientFailure | PostgresStatementRejected
