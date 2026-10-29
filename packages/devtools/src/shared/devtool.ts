import { Schema } from "effect"

/**
 * The failure of a repository dev tool, in words. Built-in Error subclasses are banned, so every Effect.try catch
 * clause and admission check in the dev tools fails with this instead.
 */
export class DevtoolFailure extends Schema.TaggedError<
	DevtoolFailure,
	{ readonly brand: unique symbol }
>()("DevtoolFailure", {
	detail: Schema.String,
	cause: Schema.optional(Schema.Defect())
}) {}

/** The failure `detail` names, caused by the thrown or failed value it is handed. */
export const failureFrom =
	(detail: string) =>
	(cause: unknown): DevtoolFailure =>
		DevtoolFailure.make({ detail, cause })
