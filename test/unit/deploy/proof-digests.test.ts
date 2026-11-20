/**
 * The drift check's proof digests (deploy/admission/proof.ts proofDigests, replayedOver): an object's digest digests
 * its replayed statements, the digests of the objects it is created after and the environment, so a drift check
 * replays exactly what a proof no longer covers.
 *
 * - **Property:** over every pair of the shop's histories, a version and one at or after it (none before the first),
 *   the objects of the later version whose digest the earlier's digests do not hold are exactly the tainted ones the
 *   specification names (test/support/migrate/proofs.ts specifiedTainted), the replay over them is the specification's
 *   (specifiedReplay), and another environment changes every object's digest.
 * - **Oracle:** specification: the objects compared by the canonical text of their replayed statements and the objects
 *   they are created after, read off the two manifests, never digested.
 * - **Box, exhausted:** each later version of the shop's three over each earlier, the empty snapshot among them.
 * - **Features:** a first version, a changed version, an unchanged one, and the environment's change.
 *
 * And the replay's order (replayedOver over manifest.ts ReplayedObject after): a replay over any one unproven object
 * creates every object its statements name before them, so PostgreSQL resolves every name the replay sends.
 *
 * - **Property:** over each object of each record, that object alone unproven, every object of the manifest a replayed
 *   object's statements name is replayed before it.
 * - **Oracle:** specification: the objects a statement names read off its printed text, each name quoted as grizzle
 *   prints it (test/support/migrate/proofs.ts specifiedAfter), never off its tree.
 * - **Box, exhausted:** each object of the shop's three versions and of a set's schema (setsSchema), whose table's CHECK
 *   and generated field each cast a singleton set's literal to the bits domain of a roster no column of the table is
 *   typed by, as qti's attribute does.
 * - **Features:** a replay of an object alone, and one that creates a type a statement casts to and no edge names.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, type Gen, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { manifestStatements } from "#compiler/deploy/admission/manifest.ts"
import { proofDigests, replayedOver } from "#compiler/deploy/admission/proof.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import { parseIdent } from "#compiler/physical/obligations/graph.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, generated, pg } from "#compiler/public/fields.ts"
import { check, closed, relation, schema } from "#compiler/public/schema.ts"
import { succeeded } from "#test/support/assert.ts"
import { firstCodes } from "#test/support/compile.ts"
import { atName } from "#test/support/kernel/naming.ts"
import { draftChain, fromEmpty, noDeclarations } from "#test/support/migrate/kit.ts"
import { specifiedAfter, specifiedReplay, specifiedTainted } from "#test/support/migrate/proofs.ts"
import { shopV1, shopV2, shopV3, shopV3Declared } from "#test/unit/deploy/schemas.ts"

/** A pair of the shop's versions: the one the proofs were recorded at (0, none) and one at or after it. */
interface Pair {
	readonly proven: number
	readonly now: number
}

const pairGen: Gen<Pair> = (source) => {
	const now = source.draw(int(1, 3))
	return { proven: source.draw(int(0, now)), now }
}

type DigestFeature =
	| "a first version"
	| "a changed version"
	| "an unchanged version"
	| "another environment"

/** The shop's three versions drafted in one chain under one schema, each over the one before. */
const chain: ReadonlyArray<DeploySnapshot> = Arr.map(
	draftChain(
		Arr.map(
			[
				[shopV1, noDeclarations],
				[shopV2, noDeclarations],
				[shopV3, shopV3Declared]
			] as const,
			([desc, declared]) => ({
				desc,
				options: {
					schema: atName("proof_digests"),
					extensions: [],
					codes: firstCodes
				},
				declared
			})
		),
		fromEmpty
	),
	(g) => g.snapshot
)

/** Each object's proof digest of `snapshot` under `environment`, by identity. */
const digestsOf = (snapshot: DeploySnapshot, environment: string): ReadonlyMap<string, string> =>
	new Map(
		Arr.map(
			succeeded(proofDigests(succeeded(manifestStatements(snapshot)).objects, environment)),
			(p) => [p.object.ident, p.digest] as const
		)
	)

/** The kinds of manifest identity no description names (adapter/admission/drift.ts describedKinds' complement). */
const undescribed: ReadonlyArray<string> = [
	"extension",
	"role",
	"membership",
	"privileges",
	"publication",
	"other"
]

/** The proof digests change exactly where the specification says a proof no longer covers an object. */
export const proofDigestsChangeExactlyWhereAProofNoLongerCoversAnObject = property.exhaust(
	finite(pairGen),
	{
		needs: {},
		situations: [
			"a first version",
			"a changed version",
			"an unchanged version",
			"another environment"
		] satisfies ReadonlyArray<Reached<DigestFeature>>,
		check: (_, c: Case<DigestFeature>) => (pair) =>
			Effect.sync(() => {
				const now = defined(chain[pair.now - 1], "a drafted version")
				const proven = pair.proven === 0 ? undefined : defined(chain[pair.proven - 1], "a version")
				c.note(
					proven === undefined
						? "a first version"
						: pair.proven === pair.now
							? "an unchanged version"
							: "a changed version"
				)
				const environment = "the environment"
				const after = digestsOf(now, environment)
				const before =
					proven === undefined ? new Map<string, string>() : digestsOf(proven, environment)
				const moved = new Set(
					Arr.flatMap([...after], ([ident, digest]) =>
						before.get(ident) === digest ? [] : [ident]
					)
				)
				assert.deepEqual(
					Arr.sort([...moved], Order.String),
					Arr.sort([...specifiedTainted(proven, now)], Order.String),
					"the digests that moved are exactly the objects a proof no longer covers"
				)
				const objects = succeeded(manifestStatements(now)).objects
				const unproven = new Set(
					Arr.filter([...moved], (ident) =>
						Arr.every(undescribed, (kind) => kind !== parseIdent(ident).kind)
					)
				)
				assert.deepEqual<ReadonlyArray<string>>(
					Arr.map(replayedOver(objects, unproven), (o) => o.ident),
					specifiedReplay(proven, now),
					"the replay is every unproven object and every object one is created after"
				)
				const elsewhere = digestsOf(now, "another environment")
				assert.ok(
					Arr.every([...after], ([ident, digest]) => elsewhere.get(ident) !== digest),
					"another environment moves every digest"
				)
				c.note("another environment")
			}),
		oracle: {
			kind: "specification",
			name: "the objects a proof no longer covers, compared by the canonical text of their statements and what they are created after"
		},
		box: "each later version of the shop's three over each earlier one, the empty snapshot among them",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/admission/proof.ts",
				original: "\t\t\t\t\t\tafter: before.toSorted()",
				replacement: "\t\t\t\t\t\tafter: []",
				why: "An object's digest is blind to what it is created after, so a changed table's indexes and views keep their proofs."
			},
			{
				file: "packages/engine/src/deploy/admission/proof.ts",
				original: "\t\t\t\t\t\tstatements: o.statements,\n",
				replacement: "",
				why: "An object's digest is blind to its own statements, so a changed object keeps its proof."
			},
			{
				file: "packages/engine/src/deploy/admission/proof.ts",
				original: "\t\t\t\t\t\tenvironment,\n",
				replacement: "",
				why: "A digest is blind to the environment, so a proof another server's or another extension's description made stands."
			}
		]
	}
)

/**
 * A set's schema: Flag, a roster of three handles; Allowed, the flags each flag admits, closed; Tagged, rows of a flag
 * and another, its generated `covered` whether the other is among those its flag admits; and Admitted, Tagged's CHECK
 * that it is. Each membership test's singleton set is a literal cast to Flag's bits domain, which no column of Tagged
 * is typed by, so only the casts name it, as qti's attribute's admission CHECK names its roster's.
 */
const setsSchema = (() => {
	const Flag = closed.ordered("Flag", ["x", "y", "z"])
	const Allowed = closed.relation(
		"Allowed",
		{ from: closedId(Flag), to: closedId(Flag) },
		["from", "to"],
		[
			{ from: "x", to: "x" },
			{ from: "x", to: "y" },
			{ from: "y", to: "y" },
			{ from: "z", to: "z" }
		]
	)
	const Tagged = relation.generated(
		"Tagged",
		{ id: pg.integer, flag: closedId(Flag), other: closedId(Flag) },
		["id"],
		(r) => ({
			covered: generated(
				pg.boolean,
				Compute.subset(Compute.singleton(r.other), Allowed.row(r.flag))
			)
		})
	)
	return schema(
		"Sets",
		[Flag, Allowed, Tagged],
		[
			check("Admitted", Tagged, (t) =>
				t.eq(Compute.subset(Compute.singleton(t.other), Allowed.row(t.flag)), true)
			)
		]
	)
})()

/** The records the replay's order is held over: the shop's three versions, then the set's schema. */
const records: ReadonlyArray<DeploySnapshot> = [
	...chain,
	...Arr.map(
		draftChain(
			[
				{
					desc: setsSchema,
					options: { schema: atName("proof_sets"), extensions: [], codes: firstCodes },
					declared: noDeclarations
				}
			],
			fromEmpty
		),
		(g) => g.snapshot
	)
]

/** A record of `records` and one of its objects, by their places. */
interface Unproven {
	readonly record: number
	readonly object: number
}

const unprovenGen: Gen<Unproven> = (source) => {
	const record = source.draw(int(0, records.length - 1))
	const objects = defined(records[record], "a record").manifest.objects.length
	return { record, object: source.draw(int(0, objects - 1)) }
}

type OrderFeature = "a replay of one object" | "a cast's type no edge names, created first"

/** A replay creates every object a replayed statement names before that statement, whatever it replays. */
export const theReplayCreatesEveryObjectAStatementNamesBeforeIt = property.exhaust(
	finite(unprovenGen),
	{
		needs: {},
		situations: [
			"a replay of one object",
			"a cast's type no edge names, created first"
		] satisfies ReadonlyArray<Reached<OrderFeature>>,
		check: (_, c: Case<OrderFeature>) => (x) =>
			Effect.sync(() => {
				const record = defined(records[x.record], "a record")
				const ident = defined(record.manifest.objects[x.object], "an object").ident
				const replayed = Arr.map(
					replayedOver(succeeded(manifestStatements(record)).objects, new Set([ident])),
					(o) => o.ident
				)
				c.note("a replay of one object")
				const place = new Map(Arr.map(replayed, (o, at) => [o, at] as const))
				const named = specifiedAfter(record)
				const edges = new Set(Arr.map(record.manifest.edges, (e) => `${e.from} ${e.to}`))
				for (const [at, object] of replayed.entries()) {
					for (const before of named.get(object) ?? []) {
						const created = place.get(before)
						assert.ok(
							created !== undefined && created < at,
							`replaying ${ident}, ${object} names ${before}, which the replay creates before it`
						)
						if (parseIdent(before).kind === "domain" && !edges.has(`${before} ${object}`)) {
							c.note("a cast's type no edge names, created first")
						}
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "the objects a statement names, read off its printed text by each object's quoted name"
		},
		box: "each object of the shop's three versions and of a set's schema whose CHECK and generated field cast to a bits domain no column is typed by, that object alone unproven",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/deploy/admission/manifest.ts",
				original: "\t\t\t\t\tafter.add(ident)\n",
				replacement: "",
				why: "An object is created after only what the manifest's edges say, so a table whose CHECK casts to a set's domain, which no edge names, is replayed without the domain, and PostgreSQL refuses the cast (42704): S7's drift check on qti's attribute."
			}
		]
	}
)
