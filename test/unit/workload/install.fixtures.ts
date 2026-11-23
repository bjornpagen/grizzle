/** What the properties of install.test.ts read: its spaces, models and helpers. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	constant,
	type Gen,
	int,
	subarray,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import type { CompileError, CompileReasonTag } from "#compiler/core/errors.ts"
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
import { succeeded } from "#test/support/assert.ts"
import type { FixtureSchema } from "#test/support/compile.ts"
import * as W from "#test/support/fixtures/api/work.ts"
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
	workPrograms
} from "#test/unit/workload/fixtures.ts"

/** The installation of `schema` with the workload `physical`, under the owner role. */
export const installWith = (
	schema: FixtureSchema,
	physical: WorkloadPhysical
): Result.Result<Installation, CompileError> => {
	const owned = owning(schema)
	return compileInstallation(owned, withWorkload(installOptions(owned), physical))
}

/** The installed objects a law or the workload's access must justify: its indexes. */
export const justified = (i: Installation) =>
	Arr.filter(i.manifest.objects, (o) => o.kind === "index")

/** Whether an object stands on a law. */
export const hasLaw = (reasons: ReadonlyArray<PhysicalReason>): boolean =>
	Arr.some(reasons, (r) => r.kind === "law")

/** Whether an object stands on the workload's access. */
export const hasAccess = (reasons: ReadonlyArray<PhysicalReason>): boolean =>
	Arr.some(reasons, (r) => r.kind === "access")

/** The laws installed objects stand on, in order. */
export const lawsOf = (objects: Installation["manifest"]["objects"]): ReadonlyArray<string> =>
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

/** The worked example's programs, each under its name. */
const named = Object.freeze(Rec.toEntries(workPrograms))

const whole = planOf(W.Work, workPrograms)

/** The worked example's installation with its whole workload. */
export const all = succeeded(
	installWith(W.Work, whole),
	"the worked example installs with its whole workload"
)

/** The worked example's installation with the empty workload: what its laws alone install. */
export const lawsAlone = succeeded(
	installWith(W.Work, planOf(W.Work, {})),
	"the worked example installs with the empty workload"
)

/** The identifier of an object an installation's manifest lists. */
type ManifestIdent = (typeof all.manifest.objects)[number]["ident"]

/** The objects the laws alone install, by ident. */
export const lawsAloneIdents: ReadonlySet<ManifestIdent> = new Set(
	Arr.map(lawsAlone.manifest.objects, (o) => o.ident)
)

/** The objects the whole workload's installation holds, by ident. */
export const wholeIdents: ReadonlySet<ManifestIdent> = new Set(
	Arr.map(all.manifest.objects, (o) => o.ident)
)

/**
 * The objects each program alone asks for, by its name: those its access stands on, and every object its installation
 * alone holds beyond the laws alone's, its parameters' pattern domains and their text domains among them.
 */
export const alone: ReadonlyMap<
	string,
	{ readonly access: ReadonlySet<string>; readonly asked: ReadonlySet<string> }
> = new Map(
	Arr.map(named, ([name, program]) => {
		const installed = succeeded(
			installWith(W.Work, planOf(W.Work, { [name]: program })),
			`${name} installs alone`
		)
		const access = accessIdents(installed)
		return [
			name,
			{
				access,
				asked: new Set([
					...access,
					...Arr.flatMap(installed.manifest.objects, (o) =>
						lawsAloneIdents.has(o.ident) ? [] : [o.ident]
					)
				])
			}
		] as const
	})
)

/**
 * A sub-workload of the worked example: some of its programs, in their order. The empty workload most sub-workloads
 * never are is weighted in, one case in three, and kept besides.
 */
export const subWorkloadGen = weighted<ReadonlyArray<(typeof named)[number]>>([
	[1, constant([])],
	[2, subarray(named)]
])

/** What a sub-workload's installation came to, object by object. */
export type SubFeature =
	| "an index only removed programs asked for"
	| "a key or law object a kept program asks for too"
	| "an index a kept program asks for alone"
	| "a law's own index, where the whole workload's is wider for a dropped program"
	| "the empty workload"

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

/** A workload over the worked example or Board, of programs drawn by their picks, with at most one defect. */
interface InstallCase {
	readonly work: boolean
	/** The installed schema's programs the workload holds, by their picks. */
	readonly programs: ReadonlyArray<number>
	readonly defect: Defect
}

/** A workload to install: the worked example's or Board's, its programs, and at most one defect. */
export const installCaseGen: Gen<InstallCase> = (source) => {
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
export const installOf = (
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
							fixed: 0,
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

/** What an installed or refused workload came to: its defect, and where a prefix search or Board was admitted. */
export type InstallFeature =
	| Defect["kind"]
	| "admitted over Board"
	| "a prefix search over a bounded text"
	| "a prefix search over the wildcard"
