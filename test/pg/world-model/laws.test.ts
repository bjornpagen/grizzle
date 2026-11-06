import { layer } from "@effect/vitest"
import type { Situations } from "@grizzle/testing/features"
import { constant, type Gen, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option } from "effect"
import { assert } from "#test/support/assert.ts"
import { isImmediate } from "#test/support/laws/model.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { witnessesShowTheirOwn } from "#test/support/worlds/drive/acting.ts"
import {
	breakingAtCommit,
	dbSession,
	directTransaction,
	docsInstalls,
	docsTenantRealities,
	everyWriter,
	type Focus,
	fresh,
	invalidFeatures,
	leadsOf,
	opIn,
	programTests,
	requiredWhere,
	type StepCheck
} from "#test/support/worlds/drive/suite.ts"
import { docsVisitsInstall } from "#test/support/worlds/model/bases/docs.ts"
import type { InstallSpec, WorldFeature } from "#test/support/worlds/model/types.ts"

/**
 * Every law of the documents base (a foreign key, a candidate key, a row check, a contract's domain CHECK, and every
 * relation's primary key, each a native constraint) under every writer: grizzle's Db through whole and query entries, and direct SQL writers that took on a
 * role. Programs draw writes, live, stale and wild, with laws broken by the facts they submit, by facts outside the
 * writer's world, by references to hidden or deleted facts and by duplicates within one input, and insertions whose
 * facts leave out their serial fields, through an entry whose every carried field is serial among them; the worlds
 * model judges each outcome, and the driver holds every committed state, read as the owner, to the model's lawful
 * reality.
 *
 * Beside the model, two rules of the README are held directly: a refusal's shown witness carries only keys the writer
 * submitted (in its transaction, or through its claims) and keys of relations its role holds whole; and a law a direct
 * writer breaks at COMMIT is one checked at COMMIT, never an immediate law (a key, a span key, a row check), which
 * refuses at its statement.
 */
const writes: Focus = ["open-db", "apply", "read", "close", "direct-begin", "direct", "direct-end"]

/**
 * The invalid inputs a law meets: facts that break it, outside the world, colliding with or naming hidden facts, and
 * insertions that leave out some of their serial fields and not all, or one their entry's filter reads.
 */
const lawInputs = invalidFeatures([
	"fact:law-broken",
	"fact:outside-world",
	"fact:hidden-key-collision",
	"fact:hidden-reference",
	"fact:deleted-reference",
	"fact:duplicate-in-input",
	"fact:domain-refused",
	"fact:partial-serial",
	"fact:filtered-serial-omitted"
])

/**
 * Insertions whose every carried field is serial, the unit relation's generated class, through a query entry and into a
 * relation written whole: complete facts, and generated ones, which carry no field; and generated ones through a query
 * entry that supply a serial value its filter reads or its fill fixes, which is the value stored.
 */
const unitAdditions: ReadonlyArray<WorldFeature> = [
	"addition:generated:entry:unit",
	"addition:complete:entry:unit",
	"addition:generated:whole:unit",
	"addition:complete:whole:unit",
	"addition:generated:entry:supplied-serial"
]

const refusedByLaw = opIn({
	kinds: ["apply", "direct", "direct-end"],
	writers: everyWriter,
	observations: ["invariant-rejected", "law-refused"]
})

const committed = opIn({
	kinds: ["apply", "direct-end"],
	writers: everyWriter,
	observations: ["applied", "ok"]
})

/**
 * A law a direct writer breaks at COMMIT is checked at COMMIT: never a key, a span key, a row check or a containment
 * whose foreign key is immediate.
 */
const deferredAtCommit: StepCheck = ({ seen }) => {
	const o = seen.observation
	if (seen.action.kind !== "direct-end" || o.kind !== "law-refused") {
		return
	}
	Option.match(
		Arr.findFirst(seen.before.host.laws, (l) => l.law === o.law),
		{
			onNone: () =>
				assert.fail(`action ${seen.index}: the COMMIT names ${o.law}, no law of the installation`),
			onSome: (law) => {
				assert.ok(
					!isImmediate(seen.before.host, law),
					`action ${seen.index}: the COMMIT names ${o.law}, a law checked at its statement`
				)
			}
		}
	)
}

/**
 * The installations the laws are written under: the documents base's (docsInstalls) three times in four, and otherwise
 * its worlds with Visit written through a unit entry, one filtering on a serial field and one fixing one
 * (docsVisitsInstall), where an insertion leaving out its serial fields meets each rule the README states for them.
 */
const installs: Gen<InstallSpec> = weighted([
	[3, docsInstalls],
	[1, constant(docsVisitsInstall)]
])

const required: Situations<WorldFeature> = [
	...requiredWhere((f: WorldFeature) => refusedByLaw(f) || committed(f)),
	...lawInputs,
	...unitAdditions
]

/** Both rules the README states beside the model, held over every action of the suite. */
const besideTheModel: StepCheck = (checked) => {
	witnessesShowTheirOwn(checked)
	deferredAtCommit(checked)
}

layer(Substrate.layer, { excludeTestServices: true })("the worlds model: laws", (it) => {
	programTests(it, {
		suite: "pg/world-model/laws",
		name: "every law holds on every committed state whoever writes, and its refusals show only what the README allows",
		installs,
		realize: fresh,
		focus: writes,
		steps: 10,
		cases: 24,
		required,
		realities: docsTenantRealities,
		lead: leadsOf(directTransaction(required), breakingAtCommit(required), dbSession(required)),
		check: besideTheModel
	})
})
