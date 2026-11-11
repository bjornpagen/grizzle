/**
 * A process's whole life over the test substrate, run as a child by test/pg/substrate/exit.test.ts: it builds
 * Substrate.isolatedLayer in a scope, installs a schema of one relation in it and opens `dbs` Dbs over it one after
 * another, each reading the relation through a query when `read` says so, then closes every scope. Once the event
 * loop has settled the closes, it writes the kinds of the resources still holding the process open
 * (process.getActiveResourcesInfo), one JSON line on standard output, and returns: the process must then exit by
 * itself, since nothing it opened outlives the scopes that opened it.
 *
 * Its case is its one argument, JSON: `{ "dbs": 0 | 1 | 2, "read": boolean }`.
 */
import { Effect, Layer } from "effect"
import { Db } from "#adapter/public/db.ts"
import { jsonText, trustedJson } from "#compiler/core/trusted.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { installed } from "#test/pg/reads/support.ts"
import { defined } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** The child's case: how many Dbs it opens, and whether each reads through a query. */
interface ExitCase {
	readonly dbs: 0 | 1 | 2
	readonly read: boolean
}

const Note = relation("Note", { id: pg.integer }, ["id"])
const Notes = schema("Notes", { Note }, [])

const notes = query(Notes).rule((r) => {
	const { id } = v(Note, "note")
	return r.match(Note, { id }).find({ id })
})

/** One turn of the event loop, so a socket or a timer a close ended has released its handle. */
const turn = Effect.callback<void>((resume) => {
	setImmediate(() => resume(Effect.void))
})

const run = (c: ExitCase) =>
	Effect.scoped(
		Effect.gen(function* () {
			const substrate = yield* Layer.build(Layer.fresh(Substrate.isolatedLayer))
			yield* Effect.provideContext(work(c), substrate)
		})
	)

/** The child's work over its substrate: install, then open and read through its Dbs in turn. */
const work = (c: ExitCase) =>
	Effect.scoped(
		Effect.gen(function* () {
			const o = yield* installed(
				Notes,
				{ Note: [{ id: 1 }] },
				{ label: "exit", extensions: [], programs: { notes } }
			)
			for (let opened = 0; opened < c.dbs; opened++) {
				yield* Effect.scoped(
					Effect.gen(function* () {
						const db = yield* Db.open(o.served.login.roles.app, {})
						if (c.read) {
							yield* rowsOf(db.workload.notes.once({ params: {}, facts: {} }))
						}
					}).pipe(withLayer(o.served.layer))
				)
			}
		})
	)

const exitCase = trustedJson<ExitCase>(
	defined(process.argv[2], "the case, the child's one argument")
)

await Effect.runPromise(run(exitCase))
await Effect.runPromise(Effect.andThen(turn, turn))
process.stdout.write(`${jsonText(process.getActiveResourcesInfo())}\n`)
