import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { API } from "typescript/sync"

/**
 * TypeScript 7's own API process (typescript/sync), once per worker: the parser every property that reads printed
 * source back shares, closed when the worker ends. A process that will not start fails the properties that need it,
 * never a case.
 */
export const typescriptApi: Need<API> = {
	key: "test/support/typescript.ts typescriptApi",
	open: Effect.map(
		Effect.acquireRelease(
			Effect.try({
				try: () => new API(),
				catch: (error) =>
					NeedFailed.make({
						need: "typescriptApi",
						message: `TypeScript's API did not start: ${String(error)}`
					})
			}),
			(api) => Effect.sync(() => api.close())
		),
		(api) => Effect.succeed(api)
	)
}
