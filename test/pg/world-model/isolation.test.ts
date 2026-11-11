import { layer } from "@effect/vitest"
import type { Situations } from "@grizzle/testing/features"
import { constant, oneOf } from "@grizzle/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { reachingPastRefused } from "#test/support/worlds/drive/acting.ts"
import {
	dbSession,
	directTransaction,
	docsChainedRealities,
	docsInstalls,
	docsTenantRealities,
	everyWriter,
	type Focus,
	fresh,
	handSetTransaction,
	invalidFeatures,
	leadsOf,
	noCheck,
	opIn,
	orgHeldRealities,
	programTests,
	requiredWhere,
	startingWith
} from "#test/support/worlds/drive/suite.ts"
import { invalidKinds } from "#test/support/worlds/invalid/kinds.ts"
import { docsProfileInstall } from "#test/support/worlds/model/bases/docs.ts"
import type { InvalidKind, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Tenant and login isolation over the documents base, judged by the worlds model: every read a role makes, through a
 * Db (executed, by key, page by page under a drawn order, from the first page or the last, whose ties grizzle breaks by
 * a key it proves of a table's entry or of a derived relation, or by the whole heading, so every row arrives exactly
 * once; prepared; with another of its relations attached to each row; as the pairs a recursive query chains, over a reality holding a chain at every relation one chains
 * (docsChainedRealities), so a chain past one step is there to read whatever installation is drawn; both artifacts
 * must agree, a paged read's window by window, on the windows after and before every row's key its windows reached too) or as a
 * direct writer that
 * took the role on (its views and tables, with predicates that raise on one value, prepared and executed under other
 * claims), answers exactly its world under the claims it holds, whatever lies outside it; every write through an entry
 * (in one stratum, a union or a sequence, with its read-backs, each classified by the model's restatement of the
 * read-back rule, untouched, written, beside its written entry or undetermined and refused; as a direct INSERT, ON
 * CONFLICT or MERGE) lands inside its world or is refused as the README says; nothing a role of
 * another login holds is reachable from a session of this login (a SET ROLE to it, another role's filter and key-probe
 * functions, another tenant's claims set by hand); a Db's contexts hold exactly the facts its verified token decodes
 * to, a claim of every type a context field takes read through a rule (the Profile context of docsProfileInstall: a
 * uuid, a text whose pattern needs PostgreSQL to read it as ECMAScript does, an integer of each width, a boolean, a
 * closed id and a contract), a refined claim at its bounds or past them judged by PostgreSQL
 * (invalid:token:refinement-edge); and a direct writer's hand-set claim its field's type refuses, of every type, meets
 * README's SQLSTATE where a statement reads it: 22P02 for no uuid, no integer, no boolean or a handle's name where its
 * code belongs, 22003 for an integer past its range, 23514 for a value its contract, pattern or roster refuses. Realities hold facts outside every world (the owner loads them), so the model's answers over them are
 * README "Security model"'s promise: a role reads exactly its own view, whatever lies outside it. Beside the model, one rule is held directly: a
 * direct writer's statement that reaches past its login (another login's role or views, another identity, another
 * role's filter or key probe) is refused (drive/acting.ts reachingPastRefused).
 *
 * Plants (main's test phase): worlds-isolation-view-barrier-off.patch, worlds-isolation-row-security-off.patch.
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
const readsRequired: Situations<WorldFeature> = [
	...requiredWhere(
		(f) =>
			opIn({ kinds: ["read"], writers: ["db"], observations: ["rows"] })(f) ||
			opIn({ kinds: ["direct"], writers: ["direct-role"], observations: ["rows"] })(f) ||
			startingWith("object:view:", "object:barrier-view:")(f)
	),
	"via:execute",
	"via:get",
	"via:page",
	"via:compile",
	"via:attach",
	"via:reach",
	"page:proven-key:first",
	"page:proven-key:last",
	"page:derived-key:first",
	"page:derived-key:last",
	"page:heading-key:first",
	"page:heading-key:last",
	"attach:nested",
	"reach:chained"
]

/** What the writes suite must reach. */
const writesRequired: Situations<WorldFeature> = [
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
				"object:membership:"
			)(f)
	),
	"strata:one",
	"strata:union",
	"strata:sequence",
	"strata:refused-order",
	"readback:untouched",
	"readback:written",
	"readback:beside",
	"readback:undetermined",
	...invalidFeatures([
		"fact:outside-world",
		"fact:hidden-key-collision",
		"fact:domain-refused",
		...ofKinds("role:"),
		...ofKinds("claims:"),
		"handle:other-role",
		"handle:other-login"
	])
]

/** What the claims suite must reach. */
const claimsRequired: Situations<WorldFeature> = [
	...requiredWhere(
		(f) =>
			opIn({ kinds: ["open-db"], writers: ["db"], observations: ["opened", "open-refused"] })(f) ||
			opIn({ kinds: ["read"], writers: ["db"], observations: ["rows"] })(f)
	),
	...invalidFeatures(ofKinds("token:")),
	"claim:uuid",
	"claim:text",
	"claim:integer",
	"claim:boolean",
	"claim:handle",
	"claim:contract"
]

/**
 * What the hand-set claims suite must reach: each way a hand-set claim's cast refuses it, of every type a context field
 * takes, met where a direct writer's statement reads the context; and a contract's, a pattern's and a roster's
 * refusal met both where a view delivers the claim into an output column and where it reads the claim only in its
 * filter, which no cast to the field's domain in the view's own columns reaches.
 */
const handSetRequired: Situations<WorldFeature> = [
	"claim-refused:uuid:22P02",
	"claim-refused:text:23514",
	"claim-refused:integer:22P02",
	"claim-refused:integer:22003",
	"claim-refused:boolean:22P02",
	"claim-refused:handle:22P02",
	"claim-refused:handle:22003",
	"claim-refused:handle:23514",
	"claim-refused:contract:22P02",
	"claim-refused:contract:22003",
	"claim-refused:contract:23514",
	"claim-refused-read:contract:filter",
	"claim-refused-read:contract:output",
	"claim-refused-read:text:filter",
	"claim-refused-read:text:output",
	"claim-refused-read:handle:filter",
	"claim-refused-read:handle:output"
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
		realities: docsChainedRealities,
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
		installs: oneOf([docsInstalls, constant(docsProfileInstall)]),
		realize: fresh,
		focus: ["open-db", "read", "close", "wild"],
		steps: 8,
		cases: 32,
		required: claimsRequired,
		realities: docsTenantRealities,
		lead: dbSession(claimsRequired),
		check: noCheck
	})
	programTests(it, {
		suite: "pg/world-model/isolation/hand-set-claims",
		name: "a direct writer's hand-set claim its field refuses meets README's SQLSTATE where a statement reads it",
		installs: constant(docsProfileInstall),
		realize: fresh,
		focus: ["direct-begin", "direct", "direct-end"],
		steps: 8,
		cases: 16,
		required: handSetRequired,
		realities: orgHeldRealities,
		lead: handSetTransaction(handSetRequired),
		check: noCheck
	})
})
