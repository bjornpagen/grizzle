import { layer } from "@effect/vitest"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	breakingAtCommit,
	dbSession,
	directTransaction,
	docsAtCapacityRealities,
	docsInstalls,
	everyAction,
	everyWriter,
	fresh,
	leadsOf,
	noCheck,
	openPastATamper,
	opIn,
	programTests,
	requiredWhere,
	startingWith
} from "#test/support/worlds/drive/suite.ts"
import type { ActionOutcome } from "#test/support/worlds/model/types.ts"

/**
 * Errors over the documents base: programs of every action kind with invalid inputs of every kind, so every refusal
 * kind is met (an open refused at each stage, an apply refused or rejected, a direct statement refused, a law at
 * COMMIT, a compile refusal, an encoding refusal, a stale handle, drift). The executor reads every field of what each
 * refusal carries (message, detail, hint, every notice, the witness) and reports any token of reality hidden from the
 * acting session that the action did not submit, which the driver never allows: no error quotes a value from outside
 * the world. The worlds model names the typed error or outcome of each refusal, and the driver holds the real one to
 * it. A law function withholds its witness from a writer that does not hold the witness relation whole, so half the
 * realities hold a document at its capacity (drive/suite.ts docsAtCapacityRealities), which a member's own share of it
 * breaks. A tamper changes database settings, so the file runs in a database of its own. A token that does not decode
 * through a role's contexts is the claims suite's (isolation.test.ts).
 */
const refusals: ReadonlyArray<ActionOutcome["kind"]> = [
	"open-refused",
	"invariant-rejected",
	"law-refused",
	"encoding-refused",
	"outside-world",
	"compile-refused",
	"resource-bound",
	"refused",
	"handle-refused",
	"migration-refused",
	"drift"
]

const required = requiredWhere(
	(f) =>
		opIn({ kinds: everyAction, writers: everyWriter, observations: refusals })(f) ||
		startingWith("object:law-function:witness", "invariant:no-hidden-value")(f)
)

layer(Substrate.isolatedLayer, { excludeTestServices: true })("the worlds model: errors", (it) => {
	programTests(it, {
		suite: "pg/world-model/errors",
		name: "every refusal is the typed outcome the README names, and none carries a value from outside the world",
		installs: docsInstalls,
		realize: fresh,
		focus: everyAction,
		steps: 10,
		cases: 32,
		required,
		realities: docsAtCapacityRealities,
		lead: leadsOf(
			directTransaction(required),
			dbSession(required),
			breakingAtCommit(required),
			openPastATamper(required)
		),
		check: noCheck
	})
})
