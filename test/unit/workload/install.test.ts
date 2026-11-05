import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { constant, element, subarray, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { type WorkloadPhysical, withWorkload } from "#compiler/physical/access/extension.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, defined, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { owning } from "#test/support/policy.ts"
import {
	Board,
	operatorsByPrefix,
	orderedTasks,
	planOf,
	W,
	workPrograms
} from "#test/unit/workload/fixtures.ts"

/**
 * The workload in the installation (physical/access withWorkload): access requests merge with law maintenance against the
 * key and law indexes, every installed index and statistics object stands on a law id or the workload's access, and
 * the installation of any sub-workload of the worked example holds exactly the objects of the whole workload's that the
 * laws alone install or one of its own programs asks for, as installing each of those programs alone asks for it, and
 * the laws' own index where the whole workload's serving one is wider for programs the sub-workload drops: a law's
 * request lands on a wider index a program asks for, and on an index of its own without one (physical/indexes/engine.ts
 * planIndexes). It stands on every law the laws alone stand on. A workload that cannot install is refused with its
 * reason.
 */

const installWith = (
	schema: unknown,
	physical: WorkloadPhysical
): Result.Result<Installation, CompileError> => {
	const owned = owning(schemaDescOf(schema))
	return compileInstallation(owned, withWorkload(installOptions(owned, "grizzle_owner"), physical))
}

const justified = (i: Installation) =>
	Arr.filter(i.manifest.objects, (o) => o.kind === "index" || o.kind === "statistics")

const hasLaw = (reasons: ReadonlyArray<PhysicalReason>): boolean =>
	Arr.some(reasons, (r) => r.kind === "law")

const hasAccess = (reasons: ReadonlyArray<PhysicalReason>): boolean =>
	Arr.some(reasons, (r) => r.kind === "access")

/** The laws installed objects stand on, in order. */
const lawsOf = (objects: Installation["manifest"]["objects"]): ReadonlyArray<string> =>
	Arr.sort(
		Arr.dedupe(
			Arr.flatMap(objects, (o) => Arr.flatMap(o.reasons, (r) => (r.kind === "law" ? [r.law] : [])))
		),
		Order.String
	)

/** The objects of an installation the workload's access stands on, by ident. */
const accessIdents = (i: Installation): ReadonlySet<string> =>
	new Set(
		Arr.map(
			Arr.filter(i.manifest.objects, (o) => hasAccess(o.reasons)),
			(o) => o.ident
		)
	)

const named = Rec.toEntries(workPrograms)
const whole = planOf(W.Work, workPrograms)
const all = succeeded(
	installWith(W.Work, whole),
	"the worked example installs with its whole workload"
)
const lawsAlone = succeeded(
	installWith(W.Work, planOf(W.Work, {})),
	"the worked example installs with the empty workload"
)
const lawsAloneIdents = new Set(Arr.map(lawsAlone.manifest.objects, (o) => o.ident))
const wholeIdents = new Set(Arr.map(all.manifest.objects, (o) => o.ident))

/** The objects each program alone asks for, by its name. */
const alone: ReadonlyMap<string, ReadonlySet<string>> = new Map(
	Arr.map(named, ([name, program]) => [
		name,
		accessIdents(
			succeeded(installWith(W.Work, planOf(W.Work, { [name]: program })), `${name} installs alone`)
		)
	])
)

type SubFeature =
	| "an index only removed programs asked for"
	| "a key or law object a kept program asks for too"
	| "an index a kept program asks for alone"
	| "a law's own index, where the whole workload's is wider for a dropped program"
	| "the empty workload"

describe("the worked example's workload in the installation", () => {
	it.effect(
		"holds exactly the objects a law stands on or one of the workload's own programs asks for, byte for byte the same",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/install-sub",
						/**
						 * The empty workload most sub-workloads never are, weighted in and planted: one case in three, since the
						 * floor stream is the suite's own and may hold none, and the rotating stream's twenty then miss it one
						 * run in three thousand.
						 */
						draw: drawn(
							weighted<ReadonlyArray<(typeof named)[number]>>([
								[1, constant([])],
								[2, subarray(named)]
							])
						),
						literal: Formatter.format,
						coverage: required<SubFeature>(
							[
								"an index only removed programs asked for",
								"a key or law object a kept program asks for too",
								"an index a kept program asks for alone",
								"a law's own index, where the whole workload's is wider for a dropped program",
								"the empty workload"
							],
							{ cases: 20, sense: notesOnly }
						),
						kept: [
							{ note: "the empty workload", sketch: [], draws: "", reaches: ["the empty workload"] }
						],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(kept, c) =>
						Effect.sync(() => {
							const sub = succeeded(
								installWith(W.Work, planOf(W.Work, Rec.fromEntries(kept))),
								"a sub-workload installs"
							)
							for (const o of justified(sub)) {
								assert.ok(hasLaw(o.reasons) || hasAccess(o.reasons), `${o.ident} stands on nothing`)
							}
							const asked = new Set(
								Arr.flatMap(kept, ([name]) => [...defined(alone.get(name), name)])
							)
							/**
							 * The whole workload's objects the laws alone install or a kept program asks for, each standing on the
							 * access only where a kept program asks for it: one only the access stands on goes with the programs that
							 * asked for it.
							 */
							const keptWhole = Arr.filter(all.manifest.objects, (o) => {
								const access = asked.has(o.ident)
								const standsElsewhere = Arr.some(o.reasons, (r) => r.kind !== "access")
								if (standsElsewhere && access) {
									c.note("a key or law object a kept program asks for too")
								}
								if (!standsElsewhere && access) {
									c.note("an index a kept program asks for alone")
								}
								if (!standsElsewhere && !access) {
									c.note("an index only removed programs asked for")
								}
								return access || lawsAloneIdents.has(o.ident)
							})
							/** The laws a kept program's object serves beside it, an object the laws alone do not install. */
							const widened = new Set(
								lawsOf(Arr.filter(keptWhole, (o) => !lawsAloneIdents.has(o.ident)))
							)
							/**
							 * The laws alone's objects the whole workload holds none of, whose laws no kept program's object serves: a
							 * law's own index, where the whole workload's serving one is wider for programs the sub-workload drops.
							 */
							const lawsOwn = Arr.filter(lawsAlone.manifest.objects, (o) => {
								const own =
									!wholeIdents.has(o.ident) &&
									Arr.every(o.reasons, (r) => r.kind !== "law" || !widened.has(r.law))
								if (own) {
									c.note(
										"a law's own index, where the whole workload's is wider for a dropped program"
									)
								}
								return own
							})
							const byIdent = Order.mapInput(
								Order.String,
								(o: { readonly ident: string }) => o.ident
							)
							assert.deepEqual(
								Arr.sort(
									Arr.map(sub.manifest.objects, (o) => ({
										ident: o.ident,
										access: hasAccess(o.reasons)
									})),
									byIdent
								),
								Arr.sort(
									Arr.map([...keptWhole, ...lawsOwn], (o) => ({
										ident: o.ident,
										access: asked.has(o.ident)
									})),
									byIdent
								)
							)
							assert.deepEqual(lawsOf(sub.manifest.objects), lawsOf(lawsAlone.manifest.objects))
							/** The same workload listed in reverse installs the same statements. */
							const reversed = succeeded(
								installWith(W.Work, planOf(W.Work, Rec.fromEntries(Arr.reverse(kept))))
							)
							assert.deepEqual(reversed.statements, sub.statements)
							if (kept.length === 0) {
								c.note("the empty workload")
							}
						})
				)
			)
	)
})

/** A workload that cannot install: its reason and why. */
interface Refused {
	readonly why: string
	readonly schema: unknown
	readonly physical: () => WorkloadPhysical
	readonly reason: CompileReasonTag
}

const refusals: Arr.NonEmptyReadonlyArray<Refused> = [
	{
		why: "a prefix search over an unbounded text field (ManualTask.operator is ^.*$, no byte bound), like a key",
		schema: W.Work,
		physical: () => planOf(W.Work, { operatorsByPrefix }),
		reason: "UnrepresentableKey"
	},
	{
		why: "a workload compiled against another schema installs on no other",
		schema: W.Work,
		physical: () => planOf(Board, { orderedTasks }),
		reason: "MalformedDescription"
	},
	{
		why: "an access path on a relation the schema does not store",
		schema: Board,
		physical: () => {
			const plan = planOf(Board, { orderedTasks })
			return {
				...plan,
				paths: [
					{
						relation: "Nowhere",
						derived: false,
						method: "btree",
						keys: [{ field: "x", dir: "asc" }],
						use: "range"
					}
				]
			}
		},
		reason: "MalformedDescription"
	}
]

describe("a workload that cannot install", () => {
	it.effect("is refused with its reason", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/workload/install-refused",
					generator: element(refusals),
					literal: Formatter.format,
					limit: refusals.length,
					coverage: noCoverage,
					caseHang
				},
				(r) =>
					Effect.sync(() => {
						refused(installWith(r.schema, r.physical()), r.reason, r.why)
					})
			)
		)
	)
})
