import { layer } from "@effect/vitest"
import type { Reached } from "@grizzle/testing/features"
import { Array as Arr, String as Str } from "effect"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { reachingPastRefused } from "#test/support/worlds/drive/acting.ts"
import {
	dbSession,
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
	requiredWhere,
	startingWith
} from "#test/support/worlds/drive/suite.ts"
import { invalidKinds } from "#test/support/worlds/invalid/kinds.ts"
import type { InvalidKind, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Tenant and login isolation over the documents base, judged by the worlds model: every read a role makes, through a
 * Db (executed, by key, page by page, prepared; both artifacts must agree) or as a direct writer that took the role on
 * (its views and tables, with predicates that raise on one value, prepared and executed under other claims), answers
 * exactly its world under the claims it holds, whatever lies outside it; every write through an entry (in one stratum,
 * a union or a sequence, with its read-backs and their deltas; as a direct INSERT, ON CONFLICT or MERGE) lands inside
 * its world or is refused as the README says; nothing a role of
 * another login holds is reachable from a session of this login (a SET ROLE to it, another role's filter and key-probe
 * functions, another tenant's claims set by hand); and a Db's contexts hold exactly the facts its verified token
 * decodes to. Realities hold facts outside every world (the owner loads them), so the model's answers over them are
 * README "Security model"'s promise: a role reads exactly its own view, whatever lies outside it. Beside the model, one rule is held directly: a
 * direct writer's statement that reaches past its login (another login's role or views, another identity, another
 * role's filter or key probe) is refused (drive/acting.ts reachingPastRefused).
 */
const reads: Focus = [
	"open-db",
	"read",
	"apply",
	"close",
	"direct-begin",
	"direct",
	"direct-end",
	"refresh"
]

const crossing: Focus = [
	"open-db",
	"direct-begin",
	"direct",
	"direct-end",
	"read",
	"apply",
	"close"
]

const ofKinds = (prefix: string): ReadonlyArray<InvalidKind> =>
	Arr.filter(invalidKinds, Str.startsWith(prefix))

/** What the reads suite must reach. */
const readsRequired: ReadonlyArray<Reached<WorldFeature>> = [
	...requiredWhere(
		(f) =>
			opIn({ kinds: ["read"], writers: ["db"], observations: ["rows"] })(f) ||
			opIn({ kinds: ["direct"], writers: ["direct-role"], observations: ["rows"] })(f) ||
			startingWith("object:view:", "object:barrier-view:")(f)
	),
	"via:execute",
	"via:get",
	"via:page",
	"via:compile"
]

/** What the writes suite must reach. */
const writesRequired: ReadonlyArray<Reached<WorldFeature>> = [
	...requiredWhere(
		(f) =>
			opIn({
				kinds: ["apply"],
				writers: ["db"],
				observations: ["applied", "outside-world", "invariant-rejected"]
			})(f) ||
			opIn({
				kinds: ["direct"],
				writers: ["direct-role"],
				observations: ["ok", "refused", "law-refused"]
			})(f) ||
			opIn({ kinds: ["direct"], writers: everyWriter, observations: ["refused", "rows"] })(f) ||
			startingWith(
				"object:policy:",
				"object:filter-function:",
				"object:key-probe:",
				"object:unique-probe:",
				"object:membership:"
			)(f)
	),
	"strata:one",
	"strata:union",
	"strata:sequence",
	"strata:refused-order",
	"readback:empty-delta",
	"readback:projected-delta",
	"readback:refused-delta",
	...invalidFeatures([
		"fact:outside-world",
		"fact:hidden-key-collision",
		"fact:hidden-capacity-collision",
		"fact:domain-refused",
		...ofKinds("role:"),
		...ofKinds("claims:"),
		"handle:other-role",
		"handle:other-login"
	])
]

/**
 * A stale token refused (op:open-db:inside:not-matching:db:open-refused) is no case of the claims suite. A stale token
 * is a payload the layer's verify returns and the role's contexts decode, each value in its field's domain (a removed
 * user, a deleted or left organization, an earlier request: invalid/tokens.ts staleVariants), so Db.open refuses it
 * only at a stage after the token that a catalog change (admission) or an unfinished migration (ledger) decides. The
 * suite draws neither (its kinds are open-db, read, close and wild), so no case of it can reach the feature; the errors
 * suite, which draws every kind, and privileges/open-check, which draws catalog changes, require it.
 */
const staleTokenRefused: WorldFeature = "op:open-db:inside:not-matching:db:open-refused"

/** What the claims suite must reach. */
const claimsRequired: ReadonlyArray<Reached<WorldFeature>> = [
	...Arr.filter(
		requiredWhere(
			(f) =>
				opIn({ kinds: ["open-db"], writers: ["db"], observations: ["opened", "open-refused"] })(
					f
				) || opIn({ kinds: ["read"], writers: ["db"], observations: ["rows"] })(f)
		),
		(r) => r !== staleTokenRefused
	),
	...invalidFeatures(ofKinds("token:"))
]

layer(Substrate.layer, { excludeTestServices: true })("the worlds model: isolation", (it) => {
	programTests(it, {
		suite: "pg/world-model/isolation/reads",
		name: "every role reads exactly its world",
		installs: docsInstalls,
		realize: fresh,
		focus: reads,
		steps: 10,
		cases: 24,
		required: readsRequired,
		realities: docsTenantRealities,
		lead: leadsOf(directTransaction(readsRequired), dbSession(readsRequired)),
		check: noCheck
	})
	programTests(it, {
		suite: "pg/world-model/isolation/writes",
		name: "every write through an entry meets its world, and no tenant's facts or other login's objects are reachable",
		installs: docsInstalls,
		realize: fresh,
		focus: crossing,
		steps: 10,
		cases: 32,
		required: writesRequired,
		realities: docsTenantRealities,
		lead: leadsOf(directTransaction(writesRequired), dbSession(writesRequired)),
		check: reachingPastRefused
	})
	programTests(it, {
		suite: "pg/world-model/isolation/claims",
		name: "a Db's contexts hold exactly the facts its verified claims decode to",
		installs: docsInstalls,
		realize: fresh,
		focus: ["open-db", "read", "close", "wild"],
		steps: 8,
		cases: 32,
		required: claimsRequired,
		realities: docsTenantRealities,
		lead: dbSession(claimsRequired),
		check: noCheck
	})
})
