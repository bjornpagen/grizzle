import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, constant, type Gen, int, subarray, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order, Record as Rec } from "effect"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { type WorkloadPhysical, withWorkload } from "#compiler/physical/access/extension.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { queryOver, varsOver } from "#compiler/query/build/query.ts"
import type { RuleValue } from "#compiler/query/build/rule.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { assert, defined, nonEmpty, refused, succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { owning } from "#test/support/policy.ts"
import {
	Board,
	orderedTasks,
	planOf,
	tasksForAccount,
	titlesByPrefix,
	topThree,
	urgentAtLeast,
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
 * planIndexes). It stands on every law the laws alone stand on.
 *
 * A workload that cannot install is refused with its reason. Each case draws the worked example or Board, a workload of
 * drawn programs of its fixtures, and at most one defect: a workload compiled over the other schema, a path on a
 * relation the schema does not store (MalformedDescription), or a prefix search over a drawn text field of the worked
 * example, refused (UnrepresentableKey) exactly where its pattern bounds no length, the wildcard; the healthy workload
 * installs.
 *
 * Oracles: the installations of the whole workload, of the laws alone and of each program alone (a second
 * implementation of a sub-workload's objects); the specification of each defect's refusal.
 *
 * Features: an index only removed programs asked for, a key or law object a kept program asks for too, an index a kept
 * program asks for alone, a law's own index where the whole workload's is wider for a dropped program, the empty
 * workload; each defect and the healthy workload.
 *
 * Plants (~/.cache/grizzle-release/BR02/plants): install-request-order, index requests planned in the order the
 * workload lists its programs, which the reversed workload's statements refuse.
 */

const installWith = (
	schema: FixtureSchema,
	physical: WorkloadPhysical
): Result.Result<Installation, CompileError> => {
	const owned = owning(schema)
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
						oracle: {
							kind: "second-implementation",
							name: "the whole workload's installation, the laws' alone and each program's alone: a sub-workload's objects are exactly those"
						},
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

/** Board's programs, which a workload over Board draws from. */
const boardPrograms = {
	orderedTasks,
	tasksForAccount,
	topThree,
	urgentAtLeast,
	titlesByPrefix
} as const

/** The worked example's text fields: each relation and field, and whether its pattern bounds it (none is the wildcard). */
const workTexts: Arr.NonEmptyReadonlyArray<{
	readonly relation: string
	readonly field: string
	readonly bounded: boolean
}> = nonEmpty(
	Arr.flatMap(defined(schemaDescOf(W.Work), "the worked example's Description").relations, (r) =>
		r.kind === "relation"
			? Arr.flatMap(Rec.toEntries(r.fields), ([field, decl]) =>
					decl.type.kind === "text"
						? [{ relation: r.name, field, bounded: decl.type.language.kind !== "every" }]
						: []
				)
			: []
	),
	"the worked example's text fields"
)

/** A prefix search over a text field of the worked example: its field at least one bound and below another. */
const prefixSearch = (relation: string, field: string) => {
	const value = defined(
		Option.getOrUndefined(
			Arr.findFirst(
				Rec.values(W.Work.relations),
				(
					x
				): x is Extract<
					(typeof W.Work.relations)[keyof typeof W.Work.relations],
					{ readonly kind: "relation" }
				> => x.kind === "relation" && x.name === relation
			)
		),
		relation
	)
	return queryOver(W.Work).rule((r: RuleValue) => {
		const vars = varsOver(value, "searched")
		const fields: Readonly<Record<string, unknown>> = value.fields
		const type = defined(Option.getOrUndefined(Rec.get(fields, field)), field)
		return r
			.match(value, vars)
			.where(r.ge(vars[field], r.param("lo", type)), r.lt(vars[field], r.param("hi", type)))
			.find(vars)
	})
}

/** What a case does to an installable workload: nothing, or one way it cannot install. */
type Defect =
	| { readonly kind: "none" }
	| { readonly kind: "a workload over another schema" }
	| { readonly kind: "a path on a relation the schema does not store"; readonly name: number }
	| { readonly kind: "a prefix search"; readonly field: number }

interface InstallCase {
	readonly work: boolean
	/** The installed schema's programs the workload holds, by their picks. */
	readonly programs: ReadonlyArray<number>
	readonly defect: Defect
}

const installCaseGen: Gen<InstallCase> = (source) => {
	const defect = source.draw(
		weighted<Defect>([
			[2, (): Defect => ({ kind: "none" })],
			[1, (): Defect => ({ kind: "a workload over another schema" })],
			[
				1,
				(s) => ({ kind: "a path on a relation the schema does not store", name: s.draw(int(0, 9)) })
			],
			[2, (s) => ({ kind: "a prefix search", field: s.draw(pickGen) })]
		])
	)
	return {
		work: defect.kind === "a prefix search" || source.draw(boolean),
		programs: source.draw(array(pickGen, { min: 0, max: 3 })),
		defect
	}
}

/** The programs of a schema's workload, by their picks among its fixtures'. */
const programsOf = (
	programs: Readonly<Record<string, unknown>>,
	picks: ReadonlyArray<number>
): Readonly<Record<string, unknown>> => {
	const entries = nonEmpty(Rec.toEntries(programs), "a schema's programs")
	return Rec.fromEntries(Arr.map(picks, (pick) => pickFrom(entries, pick)))
}

/** The schema a case installs, the physical workload it installs with, and the refusal the model expects, if any. */
const installOf = (
	c: InstallCase
): {
	readonly schema: FixtureSchema
	readonly physical: WorkloadPhysical
	readonly refusal: Option.Option<CompileReasonTag>
} => {
	const [installed, programs, other, otherPrograms] = c.work
		? [W.Work, workPrograms, Board, boardPrograms]
		: [Board, boardPrograms, W.Work, workPrograms]
	const own = programsOf(programs, c.programs)
	switch (c.defect.kind) {
		case "none":
			return { schema: installed, physical: planOf(installed, own), refusal: Option.none() }
		case "a workload over another schema":
			return {
				schema: installed,
				physical: planOf(other, programsOf(otherPrograms, c.programs)),
				refusal: Option.some("MalformedDescription")
			}
		case "a path on a relation the schema does not store": {
			const plan = planOf(installed, own)
			return {
				schema: installed,
				physical: {
					...plan,
					paths: [
						...plan.paths,
						{
							relation: `Nowhere${c.defect.name}`,
							derived: false,
							method: "btree",
							keys: [{ field: "x", dir: "asc" }],
							use: "range"
						}
					]
				},
				refusal: Option.some("MalformedDescription")
			}
		}
		case "a prefix search": {
			const text = pickFrom(workTexts, c.defect.field)
			return {
				schema: W.Work,
				physical: planOf(W.Work, {
					...programsOf(workPrograms, c.programs),
					searched: prefixSearch(text.relation, text.field)
				}),
				refusal: text.bounded ? Option.none() : Option.some("UnrepresentableKey")
			}
		}
	}
}

type InstallFeature =
	| Defect["kind"]
	| "admitted over Board"
	| "a prefix search over a bounded text"
	| "a prefix search over the wildcard"

describe("a workload that cannot install", () => {
	it.effect(
		"is refused with its reason: another schema's, a path off its schema, an unbounded prefix search",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/workload/install-refused",
						draw: drawn(installCaseGen),
						literal: Formatter.format,
						oracle: {
							kind: "specification",
							name: "a workload installs only on its own schema, with paths on relations it stores, and keys whose B-tree entry its patterns bound"
						},
						coverage: required<InstallFeature>(
							[
								"none",
								"a workload over another schema",
								"a path on a relation the schema does not store",
								"a prefix search over a bounded text",
								"a prefix search over the wildcard",
								"admitted over Board"
							],
							{ cases: 80, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, k) =>
						Effect.sync(() => {
							k.note(c.defect.kind)
							const { schema, physical, refusal } = installOf(c)
							if (c.defect.kind === "a prefix search") {
								k.note(
									Option.isSome(refusal)
										? "a prefix search over the wildcard"
										: "a prefix search over a bounded text"
								)
							}
							const installed = installWith(schema, physical)
							if (Option.isSome(refusal)) {
								refused(installed, refusal.value)
								return
							}
							if (!c.work) {
								k.note("admitted over Board")
							}
							succeeded(installed, "an installable workload installs")
						})
				)
			)
	)
})
