/** What the property of plain-native.test.ts reads: its schema and template, its space, and each case's run. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { lawsOfConstraint } from "#compiler/ir/products.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { int4 } from "#compiler/public/fields.ts"
import { contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { asDataStep } from "#test/support/data-step.ts"
import { type Installed, migratedTemplate, noPlaceholders } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { attempt } from "#test/support/substrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The source: a row of a unit g at its place i, of a kind. */
const C = relation("C", { g: int4, i: int4, kind: int4 }, ["g", "i"])
/** A target keyed by the unit first, with a field beyond its key. */
const B = relation("B", { g: int4, i: int4, kind: int4 }, ["g", "i"])
/** A target with a declared key (g, j) beside its primary key. */
const G = relation("G", { g: int4, i: int4, j: int4 }, ["g", "i"])
/** A target with a field beyond a superkey of its key. */
const F = relation("F", { g: int4, i: int4, kind: int4, n: int4 }, ["g", "i"])
/** A target each of whose fields is its key's. */
const E = relation("E", { g: int4, i: int4 }, ["g", "i"])

/** The plain containments of the schema, by the target each reaches. */
const containments = ["into B", "into G", "into F", "into E"] as const
type Containment = (typeof containments)[number]

/**
 * The schema the property installs: four plain containments out of C, every relation immutable and keyed by its unit
 * g first, so each joins within one unit, the containments whose discharge laws/model/plan.ts containmentDischarge
 * decides:
 *
 * - into B: C(g, i) in B at its primary key, B holding a field beyond it, so its foreign key is deferred;
 * - into G: C(g, i) in G at its declared key (g, j);
 * - into F: C(g, i, kind) in F at a superkey of its primary key, F holding a field beyond it;
 * - into E: C(g, i) in E at its every field, its foreign key immediate.
 */
const Plain = schema(
	"PlainNative",
	[C, B, G, F, E],
	[
		key(on(G, "g", "j")),
		contained(on(C, "g", "i"), on(B, "g", "i")),
		contained(on(C, "g", "i"), on(G, "g", "j")),
		contained(on(C, "g", "i", "kind"), on(F, "g", "i", "kind")),
		contained(on(C, "g", "i"), on(E, "g", "i"))
	]
)

export const plainTemplate = migratedTemplate({
	declaredIn: import.meta,
	name: "plain native",
	content: { schema: Plain.name, logins: [] },
	versions: [{ schema: Plain, declarations: noDeclarations }],
	options: {
		label: "plain_native",
		extensions: [],
		compile: compileInstallation,
		ambient: ordinarySession,
		review: noPlaceholders
	}
})

/** A place of a unit: g in 1 and 2, i in 0 to 2. */
interface Place {
	readonly g: number
	readonly i: number
}

const placeList: Arr.NonEmptyReadonlyArray<Place> = [
	{ g: 1, i: 0 },
	{ g: 1, i: 1 },
	{ g: 1, i: 2 },
	{ g: 2, i: 0 },
	{ g: 2, i: 1 },
	{ g: 2, i: 2 }
]

/** One state of the five relations: each one's rows, at most one a place. */
interface State {
	readonly c: ReadonlyArray<Place & { readonly kind: number }>
	readonly b: ReadonlyArray<Place & { readonly kind: number }>
	readonly gs: ReadonlyArray<Place & { readonly j: number }>
	readonly f: ReadonlyArray<Place & { readonly kind: number; readonly n: number }>
	readonly e: ReadonlyArray<Place>
}

/**
 * A change of a lawful state: one row a containment needs taken away, or changed so it no longer matches, or G's key
 * broken by a second row at a value its key holds; or a row added that nothing needs.
 */
type Change = "drop B" | "drop G" | "shift G" | "flip F" | "drop E" | "repeat G" | "extra targets"

const changes: Arr.NonEmptyReadonlyArray<Change> = [
	"drop B",
	"drop G",
	"shift G",
	"flip F",
	"drop E",
	"repeat G",
	"extra targets"
]

/** A lawful state over the places `sources` holds C rows at, each of a kind: every target row each containment needs. */
const lawful = (sources: ReadonlyArray<Place & { readonly kind: number }>): State => ({
	c: sources,
	b: Arr.map(sources, (s) => ({ g: s.g, i: s.i, kind: 0 })),
	gs: Arr.map(sources, (s) => ({ g: s.g, i: s.i, j: s.i })),
	f: Arr.map(sources, (s) => ({ g: s.g, i: s.i, kind: s.kind, n: 0 })),
	e: Arr.map(sources, (s) => ({ g: s.g, i: s.i }))
})

/** `state` with the row at `at` of the targets the change names taken away, changed, repeated or added to. */
const changed = (state: State, change: Change, at: Place): State => {
	const away = <R extends Place>(rows: ReadonlyArray<R>) =>
		Arr.filter(rows, (r) => r.g !== at.g || r.i !== at.i)
	/** The places `rows` holds no row at. */
	const freeOf = (rows: ReadonlyArray<Place>) =>
		Arr.filter(placeList, (p) => !Arr.some(rows, (r) => r.g === p.g && r.i === p.i))
	switch (change) {
		case "drop B":
			return { ...state, b: away(state.b) }
		case "drop G":
			return { ...state, gs: away(state.gs) }
		case "shift G":
			return {
				...state,
				gs: Arr.map(state.gs, (r) => (r.g === at.g && r.i === at.i ? { ...r, j: r.j + 3 } : r))
			}
		case "flip F":
			return {
				...state,
				f: Arr.map(state.f, (r) => (r.g === at.g && r.i === at.i ? { ...r, kind: 1 - r.kind } : r))
			}
		case "drop E":
			return { ...state, e: away(state.e) }
		case "repeat G":
			return {
				...state,
				gs: [
					...state.gs,
					...Arr.map(
						Arr.take(
							Arr.filter(freeOf(state.gs), (p) => p.g === at.g),
							1
						),
						(p) => ({ g: p.g, i: p.i, j: at.i })
					)
				]
			}
		case "extra targets":
			return {
				...state,
				b: [...state.b, ...Arr.map(freeOf(state.b), (p) => ({ ...p, kind: 1 }))],
				e: [...state.e, ...freeOf(state.e)]
			}
	}
}

const sourcesGen: Gen<ReadonlyArray<Place & { readonly kind: number }>> = (s) =>
	Arr.flatMap(placeList, (p) => (s.draw(boolean) ? [{ ...p, kind: s.draw(element([0, 1])) }] : []))

/** A state: a lawful one, then none, one or two changes, each at one of its C rows' places. */
const stateGen: Gen<State> = (s) => {
	const sources = s.draw(sourcesGen)
	let state = lawful(sources)
	for (let k = s.draw(int(0, 2)); k > 0; k--) {
		if (Arr.isReadonlyArrayNonEmpty(sources)) {
			state = changed(state, s.draw(element(changes)), s.draw(element(sources)))
		}
	}
	return state
}

/** A case: the states written one after another, each in a transaction of its own that replaces the last. */
const statesGen: Gen<ReadonlyArray<State>> = array(stateGen, { min: 1, max: 6 })

/** A case aimed at a refusal by one containment, or a removal under a source: a lawful state with a C row at a drawn
 * place, then the same state under `change` at that place. */
const aimed =
	(change: Change): Gen<ReadonlyArray<State>> =>
	(s) => {
		const at = s.draw(element(placeList))
		const sources = [
			{ ...at, kind: s.draw(element([0, 1])) },
			...Arr.filter(s.draw(sourcesGen), (r) => r.g !== at.g || r.i !== at.i)
		]
		return [lawful(sources), changed(lawful(sources), change, at)]
	}

export const space: Gen<ReadonlyArray<State>> = weighted<ReadonlyArray<State>>([
	[6, statesGen],
	[1, aimed("drop B")],
	[1, aimed("drop G")],
	[1, aimed("shift G")],
	[1, aimed("flip F")],
	[1, aimed("drop E")],
	[1, aimed("repeat G")],
	[1, aimed("extra targets")]
])

/** What a state breaks, as its laws state it: G's key, and each containment one of its C rows has no target row of. */
const brokenBy = (state: State): ReadonlyArray<Containment | "G's key"> => {
	const has = <R>(rows: ReadonlyArray<R>, p: (r: R) => boolean) => Arr.some(rows, p)
	const gKey = Arr.some(state.gs, (r, at) =>
		Arr.some(state.gs, (q, other) => other !== at && q.g === r.g && q.j === r.j)
	)
	const broken = (c: Containment): boolean =>
		Arr.some(state.c, (s) => {
			switch (c) {
				case "into B":
					return !has(state.b, (r) => r.g === s.g && r.i === s.i)
				case "into G":
					return !has(state.gs, (r) => r.g === s.g && r.j === s.i)
				case "into F":
					return !has(state.f, (r) => r.g === s.g && r.i === s.i && r.kind === s.kind)
				case "into E":
					return !has(state.e, (r) => r.g === s.g && r.i === s.i)
			}
		})
	return [...(gKey ? ["G's key" as const] : []), ...Arr.filter(containments, broken)]
}

export type PlainFeature =
	| "committed"
	| "refused by a containment into a primary key"
	| "refused by a containment into a declared key"
	| "refused by a containment into a superkey"
	| "refused by a containment into a target's every field"
	| "refused by G's key"
	| "a target row removed under its source"

const refusedFeature: { readonly [K in Containment | "G's key"]: PlainFeature } = {
	"into B": "refused by a containment into a primary key",
	"into G": "refused by a containment into a declared key",
	"into F": "refused by a containment into a superkey",
	"into E": "refused by a containment into a target's every field",
	"G's key": "refused by G's key"
}

class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

/** The law of each containment of the installation and of G's key, by the name its features read. */
const lawsOf = (installation: Installation): ReadonlyMap<LawId, Containment | "G's key"> => {
	const named = Arr.flatMap(installation.laws.theory.laws, (law) => {
		const d = law.detail
		if (d.kind === "key") {
			return d.rel.name === "G" && !d.key.primary
				? [[law.id, "G's key"] as const]
				: ([] satisfies ReadonlyArray<readonly [LawId, Containment | "G's key"]>)
		}
		if (d.kind !== "containment" || d.from.relation !== "C") {
			return [] satisfies ReadonlyArray<readonly [LawId, Containment | "G's key"]>
		}
		const into = Arr.findFirst(containments, (c) => c === `into ${d.to.relation}`)
		return Option.match(into, {
			onNone: (): ReadonlyArray<readonly [LawId, Containment | "G's key"]> => [],
			onSome: (c) => [[law.id, c] as const]
		})
	})
	return new Map(named)
}

/** The relations a state is written over, sources first. */
const writtenRelations: NonEmptyReadonlyArray<
	typeof C | typeof B | typeof G | typeof F | typeof E
> = [C, B, G, F, E]

/** The statements writing `state` in place of whatever stands, on the installation's tables `table`: every source row
 * deleted, then every target's, then the targets' rows inserted and the source's last, a data step's, since it removes
 * closed relations' rows (data-step.ts asDataStep). */
const statementsOf = (
	table: (relation: typeof C | typeof B | typeof G | typeof F | typeof E) => string,
	state: State
): ReadonlyArray<string> => {
	const rows = <R>(
		into: string,
		columns: string,
		list: ReadonlyArray<R>,
		values: (r: R) => string
	) =>
		list.length === 0
			? []
			: [`INSERT INTO ${into} (${columns}) VALUES ${Arr.join(Arr.map(list, values), ", ")}`]
	return [
		...Arr.map(writtenRelations, (r) => `DELETE FROM ${table(r)}`),
		...rows(table(B), "g, i, kind", state.b, (r) => `(${r.g}, ${r.i}, ${r.kind})`),
		...rows(table(G), "g, i, j", state.gs, (r) => `(${r.g}, ${r.i}, ${r.j})`),
		...rows(table(F), "g, i, kind, n", state.f, (r) => `(${r.g}, ${r.i}, ${r.kind}, ${r.n})`),
		...rows(table(E), "g, i", state.e, (r) => `(${r.g}, ${r.i})`),
		...rows(table(C), "g, i, kind", state.c, (r) => `(${r.g}, ${r.i}, ${r.kind})`)
	]
}

/**
 * One case: every containment of the installation held by a foreign key and none by the judge, then each state
 * written in a transaction of its own as the owner, at SERIALIZABLE, replacing the last, a data step since it removes
 * the last state's closed rows (data-step.ts asDataStep): it commits exactly when it
 * breaks no law, as the laws' meaning reads it (`brokenBy`), and is refused otherwise with 23505 or 23503 under a law it
 * breaks, through the installation's constraint map. A state after a committed one that drops a target row a source row
 * kept needs is a target row removed under its source.
 */
export const runPlain = (
	installed: Installed,
	session: RawSession,
	states: ReadonlyArray<State>,
	c: Case<PlainFeature>
) =>
	Effect.gen(function* () {
		const installation = installed.installation
		const laws = lawsOf(installation)
		const names = namesOf(installed)
		/** The relation PostgreSQL names a refusal's table by. */
		const relationOf = (table: string) =>
			Arr.findFirst(
				["C", "B", "G", "F", "E"] as const,
				(r) => installation.names.relation(r).name === table
			)
		for (const [id, name] of laws) {
			if (name === "G's key") {
				continue
			}
			const native = Arr.some(
				installation.laws.natives,
				(n) => n.object.kind === "ForeignKey" && Arr.some(n.object.lawIds, (l) => l === id)
			)
			const judged = Arr.some(installation.laws.rules, (r) => r.law.id === id)
			if (!native || judged) {
				return yield* new Disagreed({
					message: `the plain containment ${name} is held ${judged ? "by the judge" : "by nothing"}, where its foreign key states it exactly`
				})
			}
		}
		let committed: ReadonlyArray<Place> = []
		for (const [at, state] of states.entries()) {
			const where = `state ${at} of ${Formatter.format(states)}`
			const broken = brokenBy(state)
			const outcome = yield* attempt(
				session,
				asDataStep(installation, statementsOf(names.table, state))
			)
			if (outcome.kind === "committed") {
				if (broken.length > 0) {
					return yield* new Disagreed({
						message: `a state breaking ${Formatter.format(broken)} committed, ${where}`
					})
				}
				c.note("committed")
				committed = state.c
				continue
			}
			const fields = outcome.fields
			const table = Option.getOrUndefined(fields.table)
			const relation = table === undefined ? Option.none() : relationOf(table)
			const served =
				Option.isNone(relation) || fields.constraint === undefined
					? []
					: (lawsOfConstraint(
							installation.constraintToLaw,
							{ kind: "table", name: installation.names.relation(relation.value).name },
							fields.constraint
						) ?? [])
			const name = Arr.findFirst(
				Arr.flatMap(served, (law) => Option.toArray(Option.fromUndefinedOr(laws.get(law)))),
				(n) => broken.includes(n)
			).pipe(Option.getOrUndefined)
			if (name === undefined || fields.code !== (name === "G's key" ? "23505" : "23503")) {
				return yield* new Disagreed({
					message: `refused with ${fields.code} ${fields.constraint ?? "naming no constraint"} on ${table ?? "no table"}, where the state breaks ${Formatter.format(broken)}, ${where}`
				})
			}
			c.note(refusedFeature[name])
			if (
				name !== "G's key" &&
				Arr.some(committed, (s) => Arr.some(state.c, (r) => r.g === s.g && r.i === s.i))
			) {
				c.note("a target row removed under its source")
			}
		}
	})
