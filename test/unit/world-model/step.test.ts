/**
 * The worlds model's step function by itself, over the docs installation: from its initial state over a generated
 * reality, a walk of generated actions under swarm weights, each answered by every branch `step` allows and continued
 * along one of them.
 *
 * - Every branch of every step keeps every invariant `invariantsOf` judges: the laws hold on reality, no pooled
 *   connection keeps a role or claims, no session holds another login's role, and a whole entry shows exactly reality.
 * - Every outcome agrees with itself as the real system shows it, each draw an integer no fact of the state holds,
 *   and the state the branch then takes holds each draw the outcome showed as that integer; rows and read-backs agree
 *   as keyed sets: reordered rows agree, and rows missing a fact, or repeating one, do not, nor does a read-back
 *   repeating a row of its rows or its delta.
 * - The walks reach every action kind, so each kind's branches are judged.
 *
 * The installation's names are the compiler's, read once: the model's semantics, not the compiler, is under test.
 *
 * The migration folders: from an installation over the docs base to another, or to it with one native law added, the
 * files the model drafts (model/session/migrate.ts folderFiles) are the phases, in order and number, of the folder
 * grizzle's generate drafts (execute/catalog.ts draftedPhases).
 *
 * Oracles: the specification for the step (invariantsOf, and the model's outcome as the real system shows it, read
 * back by observedNext); a second implementation for the folders, grizzle's generate. Features: every action kind,
 * rows and read-backs compared as keyed sets; a worlds change, none, and a new law.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): step-leftover-claims.patch (an opened connection left holding claims)
 * turns the step property red; folder-worlds-unstructured.patch (a worlds change drafting no Structure file) the
 * folders'.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { maxOf } from "#compiler/core/array.ts"
import { assert, defined } from "#test/support/assert.ts"
import { isDrawn, sameValues } from "#test/support/laws/model.ts"
import { caseHang } from "#test/support/limits.ts"
import { draftedPhases } from "#test/support/worlds/execute/catalog.ts"
import { installedNames } from "#test/support/worlds/execute/names.ts"
import { actionGen } from "#test/support/worlds/generate/action.ts"
import { knownNonEmpty, sameDomain } from "#test/support/worlds/generate/domain.ts"
import { installGen } from "#test/support/worlds/generate/install.ts"
import { realityGen } from "#test/support/worlds/generate/reality.ts"
import { actionKinds, type Weights, weightsGen } from "#test/support/worlds/generate/weights.ts"
import { takenIdentity } from "#test/support/worlds/invalid/migrations.ts"
import { docsBase, docsInstall } from "#test/support/worlds/model/bases/docs.ts"
import { identitySpan } from "#test/support/worlds/model/draws.ts"
import { hostSchemaOf } from "#test/support/worlds/model/host.ts"
import { invariantsOf } from "#test/support/worlds/model/invariants.ts"
import { changesWorlds } from "#test/support/worlds/model/session/catalog.ts"
import { type FolderFile, folderFiles } from "#test/support/worlds/model/session/migrate.ts"
import { initialState, observedNext, settle, step } from "#test/support/worlds/model/step.ts"
import type {
	ActionKind,
	ActionOutcome,
	BaseSpec,
	Branch,
	HostFact,
	HostState,
	InstallSpec,
	LawSpec,
	ModelState,
	RelationSpec
} from "#test/support/worlds/model/types.ts"

type StepFeature =
	| `step:${ActionKind}`
	| "rows compared as keyed sets"
	| "read-backs compared as keyed sets"

const stepFeatures: Arr.NonEmptyReadonlyArray<StepFeature> = [
	...Arr.map(actionKinds, (k): StepFeature => `step:${k}`),
	"rows compared as keyed sets",
	"read-backs compared as keyed sets"
]

/** The longest walk a case takes. */
const depth = 16

const names = installedNames(docsInstall)
const host = hostSchemaOf(docsBase, names)

/** An outcome's facts, each through `f`: its rows, its read-backs' rows and deltas, the keys its witness shows. */
const mapFacts = (o: ActionOutcome, f: (fact: HostFact) => HostFact): ActionOutcome => {
	if (o.kind === "rows") {
		return { ...o, rows: Arr.map(o.rows, f) }
	}
	if (o.kind === "applied") {
		return {
			...o,
			reads: Arr.map(o.reads, (r) => ({
				...r,
				rows: Arr.map(r.rows, f),
				delta: { inserted: Arr.map(r.delta.inserted, f), deleted: Arr.map(r.delta.deleted, f) }
			}))
		}
	}
	return (o.kind === "invariant-rejected" || o.kind === "law-refused") && o.witness.kind === "shown"
		? { ...o, witness: { kind: "shown", keys: Arr.map(o.witness.keys, f) } }
		: o
}

/** Every fact of a state the real system can show: reality's and each direct writer's view's. */
const stateFacts = (state: ModelState): ReadonlyArray<HostFact> =>
	Arr.flatMap(
		[state.reality, ...Arr.flatMap(state.sessions, (s) => (s.kind === "direct" ? [s.view] : []))],
		(place) => [...place.values()].flat()
	)

/**
 * A branch's outcome as the real system shows it: each draw it holds an integer of its identity's range past every
 * integer of that range the branch's state holds, a distinct one per draw, as an identity draws a value no stored fact
 * repeats.
 */
const shownOf = (b: Branch): ActionOutcome => {
	const held = Arr.flatMap(stateFacts(b.next), (f) =>
		Arr.filter(Rec.values(f), (v): v is number => typeof v === "number")
	)
	const past = (ceiling: number): number =>
		maxOf(
			Arr.filter(held, (n) => n > ceiling - identitySpan && n <= ceiling),
			ceiling - identitySpan
		)
	return mapFacts(b.observation, (fact) =>
		Rec.map(fact, (v) => (isDrawn(v) ? past(v.ceiling) + v.draw : v))
	)
}

/** An outcome's facts: its rows, its read-backs' rows and deltas, the keys its witness shows. */
const outcomeFacts = (o: ActionOutcome): ReadonlyArray<HostFact> => {
	if (o.kind === "rows") {
		return o.rows
	}
	if (o.kind === "applied") {
		return Arr.flatMap(o.reads, (r) => [...r.rows, ...r.delta.inserted, ...r.delta.deleted])
	}
	return (o.kind === "invariant-rejected" || o.kind === "law-refused") && o.witness.kind === "shown"
		? o.witness.keys
		: []
}

/** The draws a list of facts holds. */
const drawsIn = (facts: ReadonlyArray<HostFact>): ReadonlyArray<number> =>
	Arr.flatMap(facts, (f) => Arr.flatMap(Rec.values(f), (v) => (isDrawn(v) ? [v.draw] : [])))

/** Facts with their first fact repeated after them: what a delivery that repeats a row shows. */
const repeatingFirst = (facts: ReadonlyArray<HostFact>): ReadonlyArray<HostFact> =>
	facts.concat(facts.slice(0, 1))

/**
 * Rows as keyed sets, as the real system shows them (shownOf): the branch agrees with its rows reordered, and not with a
 * row repeated or a row gone.
 */
const checkRowsAsKeyedSets = (
	b: Branch,
	shown: Extract<ActionOutcome, { readonly kind: "rows" }>
): void => {
	assert.ok(
		observedNext(b, { kind: "rows", rows: Arr.reverse([...shown.rows]) }) !== undefined,
		"rows reordered agree"
	)
	const [gone, ...kept] = shown.rows
	if (gone === undefined) {
		return
	}
	assert.ok(
		observedNext(b, { kind: "rows", rows: repeatingFirst(Arr.reverse([...shown.rows])) }) ===
			undefined,
		"rows repeating a row do not agree"
	)
	if (!Arr.some(kept, (r) => sameValues(r, gone))) {
		assert.ok(
			observedNext(b, { kind: "rows", rows: kept }) === undefined,
			"rows missing a fact do not agree"
		)
	}
}

/**
 * Read-backs as keyed sets, as the real system shows them (shownOf): the branch agrees with no read-back that repeats a
 * row of its rows, of its inserted delta or of its deleted delta. Whether any was checked.
 */
const checkReadBacksAsKeyedSets = (
	b: Branch,
	shown: Extract<ActionOutcome, { readonly kind: "applied" }>
): boolean => {
	const sites = Arr.flatMap(shown.reads, (r, i) =>
		Arr.map(
			[
				...(r.rows.length > 0 ? [{ ...r, rows: repeatingFirst(r.rows) }] : []),
				...(r.delta.inserted.length > 0
					? [{ ...r, delta: { ...r.delta, inserted: repeatingFirst(r.delta.inserted) } }]
					: []),
				...(r.delta.deleted.length > 0
					? [{ ...r, delta: { ...r.delta, deleted: repeatingFirst(r.delta.deleted) } }]
					: [])
			],
			(repeated) => Arr.map(shown.reads, (other, j) => (j === i ? repeated : other))
		)
	)
	for (const reads of sites) {
		assert.ok(
			observedNext(b, { ...shown, reads }) === undefined,
			"a read-back repeating a row does not agree"
		)
	}
	return sites.length > 0
}

/** A walk's start: a reality of the docs base, and the swarm weights its actions are drawn under. */
interface Walk {
	readonly reality: HostState
	readonly weights: Weights
}

const walkGen: Gen<Walk> = (source) => ({
	reality: source.draw(realityGen(docsBase, host)),
	weights: source.draw(weightsGen)
})

describe("the worlds model's step", () => {
	it.effect("keeps every invariant on every branch and agrees with its own outcomes", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "invariantsOf on every branch, and each outcome read back by observedNext as the real system shows it"
					},
					suite: "unit/world-model/step",
					draw: drawn(walkGen),
					literal: Formatter.format,
					coverage: required<StepFeature>(stepFeatures, { cases: 150, sense: notesOnly }),
					kept: [],
					runs: 150,
					shrink: { kind: "bounded", candidates: 200 },
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ reality, weights }, c) =>
					Effect.sync(() => {
						let state = initialState(docsInstall, names, reality)
						assert.deepEqual(invariantsOf(state), [], "the initial state")
						for (let i = 0; i < depth; i++) {
							const action = c.draw(actionGen(state, weights))
							c.note(`step:${action.kind}`)
							const branches = Arr.map(step(state, action), (s) => settle(s, installedNames))
							for (const b of branches) {
								assert.deepEqual(
									invariantsOf(b.next),
									[],
									`a branch of ${action.kind} observing ${b.observation.kind}`
								)
								const shown = shownOf(b)
								const taken = defined(
									observedNext(b, shown),
									`${b.observation.kind} agrees with itself as the real system shows it`
								)
								const showed = new Set(drawsIn(outcomeFacts(b.observation)))
								assert.ok(
									!Arr.some(drawsIn(stateFacts(taken)), (d) => showed.has(d)),
									`${b.observation.kind}: the state taken holds every draw it showed as its value`
								)
								if (b.observation.kind === "rows" && shown.kind === "rows") {
									c.note("rows compared as keyed sets")
									checkRowsAsKeyedSets(b, shown)
								}
								if (shown.kind === "applied" && checkReadBacksAsKeyedSets(b, shown)) {
									c.note("read-backs compared as keyed sets")
								}
							}
							state = c.draw(element(branches)).next
						}
					})
			)
		)
	)
})

/**
 * The laws a migration may add to a base, each one PostgreSQL enforces itself: a key over a field outside a one-field
 * primary key, a check that an integer field is not negative, a containment of a field in another relation's one-field
 * key of its domain; the draw keeps those of an identity the base does not hold (takenIdentity).
 */
const nativeLaws = (base: BaseSpec): ReadonlyArray<LawSpec> => [
	...Arr.flatMap(base.relations, (r) =>
		Arr.map(
			Arr.filter(r.fields, (f) => !r.key.includes(f.name) || r.key.length > 1),
			(f): LawSpec => ({ kind: "key", relation: r.name, fields: [f.name] })
		)
	),
	...Arr.flatMap(base.relations, (r) =>
		Arr.flatMap(r.fields, (f): ReadonlyArray<LawSpec> =>
			f.domain.kind === "integer"
				? [
						{
							kind: "check",
							name: `Counted${r.name}${f.name}`,
							relation: r.name,
							predicate: { kind: "compare", field: f.name, op: ">=", value: 0 }
						}
					]
				: []
		)
	),
	...Arr.flatMap(base.relations, (s) =>
		Arr.flatMap(s.fields, (f) =>
			Arr.flatMap(base.relations, (t: RelationSpec): ReadonlyArray<LawSpec> => {
				const [key, ...more] = t.key
				const target = Arr.findFirst(t.fields, (g) => g.name === key)
				return t.name === s.name ||
					more.length > 0 ||
					Option.isNone(target) ||
					!sameDomain(target.value.domain, f.domain)
					? []
					: [
							{
								kind: "contained",
								source: { relation: s.name, fields: [f.name], where: {} },
								target: { relation: t.name, fields: [target.value.name], where: {} }
							}
						]
			})
		)
	)
]

/** The phase a folder file's name carries (`NN-<phase>.sql`): Setup's setup, the concurrent indexes' indexes, and so on. */
const phaseOf = (file: FolderFile): string => {
	switch (file) {
		case "setup":
			return "setup"
		case "structure":
			return "structure"
		case "indexes":
		case "concurrent":
			return "indexes"
		case "validate":
			return "validate"
		case "publish":
			return "publish"
	}
}

type FolderFeature = "worlds change" | "no worlds change" | "a new law"

/** A migration from one installation over the docs base: to another of its installations, or with one native law added. */
const migrationGen: Gen<{ readonly from: InstallSpec; readonly to: InstallSpec }> = (source) => {
	const from = source.draw(installGen(docsBase))
	const to = source.draw(
		oneOf([
			installGen(docsBase),
			map(
				element(
					knownNonEmpty(
						Arr.filter(nativeLaws(docsBase), (law) => !takenIdentity(docsBase, law)),
						"the native laws the docs base does not hold"
					)
				),
				(law): InstallSpec => ({ ...from, base: { ...from.base, laws: [...from.base.laws, law] } })
			)
		])
	)
	return { from, to }
}

describe("the worlds model's migration folders", () => {
	it.effect(
		"drafts a folder's files in the order and number grizzle's generate drafts them",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the phases of the folder grizzle's generate drafts"
						},
						suite: "unit/world-model/folder files",
						draw: drawn(migrationGen),
						literal: Formatter.format,
						coverage: required<FolderFeature>(["worlds change", "no worlds change", "a new law"], {
							cases: 30,
							sense: notesOnly
						}),
						kept: [],
						runs: 30,
						shrink: { kind: "bounded", candidates: 100 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ from, to }, c) =>
						Effect.gen(function* () {
							const drafted = yield* Effect.orDie(draftedPhases(from, to, "worlds_files"))
							assert.deepEqual(
								drafted,
								Arr.map(folderFiles(from, to), phaseOf),
								"the folder's files, by phase"
							)
							c.note(changesWorlds(from, to) ? "worlds change" : "no worlds change")
							if (to.base.laws.length > from.base.laws.length) {
								c.note("a new law")
							}
						})
				)
			)
	)
})
