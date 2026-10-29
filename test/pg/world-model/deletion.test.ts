import { layer } from "@effect/vitest"
import type { Reached } from "@grizzle/testing/features"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	dbSession,
	derivedLeftStale,
	directTransaction,
	docsInstalls,
	docsTenantRealities,
	everyWriter,
	type Focus,
	fresh,
	invalidFeatures,
	leadsOf,
	noCheck,
	opIn,
	programTests,
	readPastADelete,
	requiredWhere
} from "#test/support/worlds/drive/suite.ts"
import type { WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Deletion really deletes, over the documents base: programs delete facts through Db entries (whole and query) and as
 * direct writers, read every world relation from sessions of every role, and refresh the derived relation OrgDocs. The
 * worlds model predicts each read, and the driver reads every base table and the derived relation as the owner after
 * each action: a deleted fact leaves its base relation and every world relation at once, and a derived relation keeps
 * it only until a refresh by a role whose refresh list names it, after which no world relation shows it.
 */
const deleting: Focus = [
	"apply",
	"read",
	"open-db",
	"refresh",
	"close",
	"direct-begin",
	"direct",
	"direct-end"
]

/** A delete accepted, through a Db or as a direct writer. */
const deleted = (f: WorldFeature): boolean =>
	opIn({ kinds: ["apply"], writers: ["db"], observations: ["applied"] })(f) ||
	opIn({ kinds: ["direct", "direct-end"], writers: everyWriter, observations: ["ok"] })(f)

const required: ReadonlyArray<Reached<WorldFeature>> = [
	"deletion:base-gone",
	"deletion:world-gone",
	"deletion:derived-kept",
	"deletion:derived-refreshed",
	...requiredWhere(
		(f) =>
			deleted(f) ||
			opIn({
				kinds: ["refresh"],
				writers: ["db"],
				observations: ["ok", "refused", "handle-refused"]
			})(f)
	),
	...invalidFeatures(["fact:deleted-reference"])
]

layer(Substrate.layer, { excludeTestServices: true })("the worlds model: deletion", (it) => {
	programTests(it, {
		suite: "pg/world-model/deletion",
		name: "a deleted fact is gone from every world and every relation, a derived relation keeping it only until refresh",
		installs: docsInstalls,
		realize: fresh,
		focus: deleting,
		steps: 12,
		cases: 32,
		required,
		realities: docsTenantRealities,
		lead: leadsOf(
			directTransaction(required),
			readPastADelete(required),
			dbSession(required),
			derivedLeftStale(required)
		),
		check: noCheck
	})
})
