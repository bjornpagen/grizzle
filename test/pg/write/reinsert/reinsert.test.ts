import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { AnyRelation } from "#compiler/types/schema/relation.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, deepEquals, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import {
	type AgainVerdict,
	againVerdict,
	type Difference,
	differenceAt,
	differenceGen,
	differenceKinds,
	differed,
	type Keys,
	type Standing,
	standingOf,
	type Target,
	targetsOf
} from "#test/support/families/again.ts"
import {
	admittedFillSpecGen,
	besides,
	buildFill,
	familyAt,
	type FamilyKind,
	type FillSpec,
	fullInstance,
	groupName,
	indexName,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	mutableOrDrawn,
	plantedGen,
	rootName,
	relationName,
	uuidOfRow,
	writtenRows
} from "#test/support/families/fill.ts"
import { installMigrated, type Installed } from "#test/support/install-migrate.ts"
import { lawNamesOf, type Names, namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { oneFlight } from "#test/support/one-flight.ts"
import { appliedWith, type CallFacts, member, openServedDb } from "#test/support/served-db.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * A stored nested instance inserted again, identically or with drawn differences, answers as the README's set rule
 * says, on PostgreSQL 19rc1 ("Writes": "add these rows; a row already present is no change"; "A row holds the fields
 * its caller writes"; "A relation's rows are a set. Identical rows are one row. Two rows of one relation that share a
 * key and differ elsewhere are invariant-rejected on that key"; "Families": "the insert states the owner's members").
 *
 * A case is a drawn schema of families and copies the reference admits (test/support/families/fill.ts, trees, ordered
 * and counted families, folds and copies along their axes), a drawn instance of it inserted by one ChangeSet, a
 * sequence's members nested under their owners and a tree's nodes under their roots, and then one to three inserts
 * of it again through the same served member, each the stored instance with none to two drawn differences
 * (test/support/families/again.ts): a row's payload changed, a member added to, removed from or moved within a tree,
 * an ordered family or a counted family, a top row left out, another instance beside it; now and then every fact
 * stated twice in the one call.
 *
 * The oracle is the set rule as a pure model of relations as sets of facts (again.ts againVerdict), with the reference
 * writer (fill.ts writtenRows) for every value grizzle draws:
 * - an insert whose every stated row is stored as stated answers `no-change`, and one that adds a row answers
 *   `accepted`, counting each relation's added rows, and every relation then stores the reference writer's rows of
 *   the stored instance and the added rows, a counted member under a stored owner recounting and refolding it;
 * - an insert stating a row that differs from the stored row at its key, a sequence's owner whose members differ
 *   among them, answers `invariant-rejected` naming only the primary keys of such rows and the keys of the families a
 *   stated row takes another stored row's place in, and stores what it stored before. Its witness is the key of a
 *   stated row breaking a law it names, in the fields that row was written in (README "Errors and outcomes",
 *   Witness: "A key … that grizzle's own write statement finds broken, by two rows you submitted or by a stored row
 *   …, is witnessed by the key you submitted"; it is `unreported` only "for a foreign key, and where no row you
 *   stated breaks the rule"), never `unreported`: every row these keys judge is one the insert states.
 *
 * Features: each kind of difference, alone in its insert, at each family kind and place, with its verdict; the same
 * instance again and stated twice; two differences in one insert. A witness case aims at a pending one with a
 * schema holding every family kind beside a plain relation, every count at its most, and one difference at it.
 *
 * Plants: ~/.cache/grizzle-release/KEYSTRESS/plants/reinsert-no-change-as-accepted.patch, a committed write answered
 * `accepted` whatever its counts, must turn the property red.
 */

/** A second insert of a case: its differences from the stored instance, in order, and whether it states every fact twice. */
interface Again {
	readonly differences: ReadonlyArray<Difference>
	readonly twice: boolean
}

/** A case: a specification, the instance its first insert writes, and the inserts again after it. */
interface ReinsertCase {
	readonly spec: FillSpec
	readonly rows: ReadonlyArray<InstanceRow>
	readonly again: Arr.NonEmptyReadonlyArray<Again>
}

/** A verdict as a situation names it. */
type VerdictLabel = "no-change" | "accepted" | "refused on a key"

/** A family kind as a situation names it. */
type FamilyLabel = "a tree" | "an ordered family" | "a counted family"

/** A place as a situation names it. */
type PlaceLabel = "a tree node" | "an ordered member" | "a counted member" | "a top row"

type Situation =
	| `the same instance again: ${VerdictLabel}`
	| `the same instance stated twice in one call: ${VerdictLabel}`
	| `${PlaceLabel}'s payload changed: ${VerdictLabel}`
	| `a member added to ${FamilyLabel}: ${VerdictLabel}`
	| `a member removed from ${FamilyLabel}: ${VerdictLabel}`
	| `a member moved in ${FamilyLabel}: ${VerdictLabel}`
	| `a top row left out: ${VerdictLabel}`
	| `another instance beside: ${VerdictLabel}`
	| "two differences in one insert"

const familyLabels: { readonly [K in FamilyKind]: FamilyLabel } = {
	tree: "a tree",
	ordered: "an ordered family",
	counted: "a counted family"
}

const placeLabels: { readonly [P in Standing]: PlaceLabel } = {
	"tree node": "a tree node",
	"ordered member": "an ordered member",
	"counted member": "a counted member",
	"top row": "a top row"
}

/** A verdict's label. */
const verdictLabel = (v: AgainVerdict): VerdictLabel =>
	v.kind === "refused"
		? "refused on a key"
		: Arr.isReadonlyArrayNonEmpty(v.added)
			? "accepted"
			: "no-change"

/** The target a difference of `stored` aimed at, read back from the difference. */
const targetOf = (spec: FillSpec, stored: ReadonlyArray<InstanceRow>, d: Difference): Target => {
	const row = (id: number) =>
		defined(
			Option.getOrUndefined(Arr.findFirst(stored, (r) => r.id === id)),
			"a stored row a difference names"
		)
	switch (d.kind) {
		case "payload":
			return { kind: "payload", place: standingOf(spec, row(d.id)) }
		case "added":
			return {
				kind: "added",
				family: familyAt(spec, defined(d.row.memberOf[0], "a new member's family").family).kind
			}
		case "removed": {
			const place = standingOf(spec, row(d.id))
			switch (place) {
				case "top row":
					return { kind: "left out" }
				case "tree node":
					return { kind: "removed", family: "tree" }
				case "ordered member":
					return { kind: "removed", family: "ordered" }
				case "counted member":
					return { kind: "removed", family: "counted" }
			}
		}
		case "moved":
			return { kind: "moved", family: familyAt(spec, d.to.family).kind }
		case "beside":
			return { kind: "beside" }
	}
}

/** The situation of one difference alone in its insert, with its verdict. */
const situationOf = (t: Target, v: VerdictLabel): Situation => {
	switch (t.kind) {
		case "payload":
			return `${placeLabels[t.place]}'s payload changed: ${v}`
		case "added":
			return `a member added to ${familyLabels[t.family]}: ${v}`
		case "removed":
			return `a member removed from ${familyLabels[t.family]}: ${v}`
		case "moved":
			return `a member moved in ${familyLabels[t.family]}: ${v}`
		case "left out":
			return `a top row left out: ${v}`
		case "beside":
			return `another instance beside: ${v}`
	}
}

/** What a witness aims at: none or two drawn differences, or one at a target, and the twice flag. */
type Aim =
	| { readonly kind: "drawn"; readonly differences: 0 | 2; readonly twice: boolean }
	| { readonly kind: "target"; readonly target: Target }

/** The required situations, each with what a witness aims at to reach it, each verdict the set rule's for its aim. */
const aims: Arr.NonEmptyReadonlyArray<readonly [Situation, Aim]> = [
	["the same instance again: no-change", { kind: "drawn", differences: 0, twice: false }],
	[
		"the same instance stated twice in one call: no-change",
		{ kind: "drawn", differences: 0, twice: true }
	],
	[
		"a top row's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "top row" } }
	],
	[
		"a tree node's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "tree node" } }
	],
	[
		"an ordered member's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "ordered member" } }
	],
	[
		"a counted member's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "counted member" } }
	],
	[
		"a member added to a tree: refused on a key",
		{ kind: "target", target: { kind: "added", family: "tree" } }
	],
	[
		"a member added to an ordered family: refused on a key",
		{ kind: "target", target: { kind: "added", family: "ordered" } }
	],
	[
		"a member added to a counted family: accepted",
		{ kind: "target", target: { kind: "added", family: "counted" } }
	],
	[
		"a member removed from a tree: refused on a key",
		{ kind: "target", target: { kind: "removed", family: "tree" } }
	],
	[
		"a member removed from an ordered family: refused on a key",
		{ kind: "target", target: { kind: "removed", family: "ordered" } }
	],
	[
		"a member removed from a counted family: no-change",
		{ kind: "target", target: { kind: "removed", family: "counted" } }
	],
	[
		"a member moved in a tree: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "tree" } }
	],
	[
		"a member moved in an ordered family: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "ordered" } }
	],
	[
		"a member moved in a counted family: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "counted" } }
	],
	["a top row left out: no-change", { kind: "target", target: { kind: "left out" } }],
	["another instance beside: accepted", { kind: "target", target: { kind: "beside" } }],
	["two differences in one insert", { kind: "drawn", differences: 2, twice: false }]
]

const situations: Arr.NonEmptyReadonlyArray<Situation> = Arr.map(aims, ([s]) => s)

/** How often an insert again states every fact twice: one in five. */
const twiceGen: Gen<boolean> = weighted([
	[4, constant(false)],
	[1, constant(true)]
])

/** The keys a case hands out next: past every id of its instance. */
const keysOf = (rows: ReadonlyArray<InstanceRow>): Keys => ({
	next: Arr.reduce(rows, 0, (most, r) => Math.max(most, r.id))
})

/** The stored instance after a verdict: what it writes, or what was stored where it is refused. */
const storedAfter = (
	stored: ReadonlyArray<InstanceRow>,
	v: AgainVerdict
): ReadonlyArray<InstanceRow> => (v.kind === "written" ? v.rows : stored)

/**
 * The inserts again of a case from its stored instance: one to three, each with none to two differences drawn from the
 * instance stored before it under the case's swarm of difference kinds, the stored instance advancing by the set rule.
 */
const againsGen =
	(spec: FillSpec, rows: ReadonlyArray<InstanceRow>): Gen<Arr.NonEmptyReadonlyArray<Again>> =>
	(source) => {
		const kinds = source.draw(swarm(differenceKinds))
		const keys = keysOf(rows)
		let stored = rows
		const out: Array<Again> = []
		for (let left = source.draw(int(1, 3)); left > 0; left -= 1) {
			const differences: Array<Difference> = []
			let again = stored
			for (let n = source.draw(int(0, 2)); n > 0; n -= 1) {
				const d = source.draw(differenceGen(spec, again, keys, kinds))
				differences.push(d)
				again = differed(spec, again, d)
			}
			out.push({ differences, twice: source.draw(twiceGen) })
			stored = storedAfter(stored, againVerdict(spec, stored, again))
		}
		return nonEmpty(out)
	}

const caseGen: Gen<ReinsertCase> = (source) => {
	const spec = source.draw(
		mutableOrDrawn(admittedFillSpecGen({ relations: 4, families: 4, copies: 3 }))
	)
	const rows = source.draw(instanceGen(spec))
	return { spec, rows, again: source.draw(againsGen(spec, rows)) }
}

/** A plain relation beside a tree owning a counted family and an ordered family's member counted too, every relation mutable. */
const aimedSpecGen: Gen<FillSpec> = (source) => {
	const spec = besides(
		besides(
			{ relations: [{ generated: false, mutable: true }], families: [], copies: [], steps: [] },
			source.draw(plantedGen("tree with a counted family"))
		),
		source.draw(plantedGen("counted ordered member"))
	)
	const [first, ...rest] = spec.relations
	return {
		...spec,
		relations: [{ ...first, mutable: true }, ...Arr.map(rest, (r) => ({ ...r, mutable: true }))]
	}
}

/**
 * A case aimed at a pending situation: the aimed schema, every count at its most, and one insert again with the
 * aim's differences, one at its target where the instance admits it and drawn otherwise.
 */
const aimedGen =
	(aim: Aim): Gen<ReinsertCase> =>
	(source) => {
		const spec = source.draw(aimedSpecGen)
		const rows = fullInstance(spec)
		const keys = keysOf(rows)
		const kinds = source.draw(swarm(differenceKinds))
		const drawnAt = (at: ReadonlyArray<InstanceRow>) => differenceGen(spec, at, keys, kinds)
		switch (aim.kind) {
			case "drawn": {
				const differences: Array<Difference> = []
				let again = rows
				for (let n = aim.differences; n > 0; n -= 1) {
					const d = source.draw(drawnAt(again))
					differences.push(d)
					again = differed(spec, again, d)
				}
				return { spec, rows, again: [{ differences, twice: aim.twice }] }
			}
			case "target": {
				const admitted = Arr.some(targetsOf(spec, rows, keys), (t) => deepEquals(t, aim.target))
				const d = source.draw(admitted ? differenceAt(spec, rows, keys, aim.target) : drawnAt(rows))
				return { spec, rows, again: [{ differences: [d], twice: false }] }
			}
		}
	}

/** The case a witness runs: its drawn one, or, while a situation is pending, a case aimed at one drawn among them. */
const aimedCase = (drawnCase: ReinsertCase, c: Case<Situation>): ReinsertCase => {
	const pending = Option.getOrUndefined(c.steering)
	const open = Arr.filter(aims, ([situation]) => pending?.has(situation) === true)
	return Arr.isReadonlyArrayNonEmpty(open)
		? c.draw(aimedGen(defined(open[c.draw(int(0, open.length - 1))], "a pending aim")[1]))
		: drawnCase
}

/** The laws a refusal is judged by: an outcome's law by its identity, a relation's primary key, a family's own law. */
interface Laws {
	readonly reported: Names["reported"]
	readonly primaryKey: (relation: number) => LawId
	readonly family: (family: number) => LawId
}

/**
 * The fields a witness of family `f`'s own key names: its group and index, and, for a tree, its root and start, the
 * tree's UNIQUE (root, start).
 */
const familyKeys = (spec: FillSpec, f: number): ReadonlyArray<ReadonlyArray<string>> => [
	[groupName(f), indexName(f)],
	...(familyAt(spec, f).kind === "tree" ? [[rootName(f), "start"]] : [])
]

/**
 * A refusal judged against the set rule's refused verdict: invariant-rejected, deciding its one law, each law a key
 * a stated row breaks, a row's primary key or a family's own key; its witness the key of a stated row breaking a law it
 * names, at that law's fields, as the row was written (README "Errors and outcomes", Witness).
 */
const judgeRefused = (
	label: string,
	spec: FillSpec,
	again: ReadonlyArray<InstanceRow>,
	outcome: ApplyOutcome<unknown>,
	v: Extract<AgainVerdict, { readonly kind: "refused" }>,
	laws: Laws
): void => {
	if (outcome.kind !== "invariant-rejected") {
		return assert.fail(
			`${label}: a stated row differs from the stored row at its key (${Formatter.format(Arr.map(v.keyed, (x) => x.id))}), so the insert is invariant-rejected, not ${outcome.kind}`
		)
	}
	const keyLaws = new Set(Arr.map(v.keyed, (x) => laws.primaryKey(x.relation)))
	const familyLaws = new Set(Arr.map(v.placed, (p) => laws.family(p.family)))
	const named = Arr.map(outcome.refused.laws, laws.reported)
	assert.equal(outcome.refused.kind, "every", `${label}: a key's refusal decides its one law`)
	for (const law of named) {
		assert.ok(
			keyLaws.has(law) || familyLaws.has(law),
			`${label}: the refusal names ${law}, which no stated row breaks: the primary keys broken are ${Formatter.format([...keyLaws])} and the family keys ${Formatter.format([...familyLaws])}`
		)
	}
	const witness = outcome.witness
	if (witness.kind === "unreported") {
		return assert.fail(
			`${label}: the refusal of ${Formatter.format(named)} reports no witness, where stated rows break it: ${Formatter.format(Arr.map(v.keyed, (x) => ({ relation: relationName(x.relation), id: uuidOfRow(x.id) })))}`
		)
	}
	const written = writtenRows(spec, again)
	const at = (x: InstanceRow, fields: ReadonlyArray<string>): boolean => {
		const row = defined(written.get(x.id), "a stated row as written")
		return (
			Rec.keys(witness.values).length === fields.length &&
			Arr.every(fields, (field) => deepEquals(witness.values[field], row[field]))
		)
	}
	const breaks = (x: InstanceRow): boolean =>
		relationName(x.relation) === witness.relation &&
		((named.includes(laws.primaryKey(x.relation)) &&
			Arr.some(v.keyed, (k) => k.id === x.id) &&
			at(x, ["id"])) ||
			Arr.some(
				v.placed,
				(p) =>
					p.row.id === x.id &&
					named.includes(laws.family(p.family)) &&
					Arr.some([["id"], ...familyKeys(spec, p.family)], (fields) => at(x, fields))
			))
	assert.ok(
		Arr.some(again, breaks),
		`${label}: the witness ${Formatter.format(witness)} is the key of a stated row breaking a law the refusal names, ${Formatter.format(named)}`
	)
}

/** Every relation of `spec` holds exactly the reference writer's rows of `instance`. */
const storesExactly = (
	done: Installed,
	spec: FillSpec,
	relations: Readonly<Record<string, AnyRelation>>,
	instance: ReadonlyArray<InstanceRow>,
	after: string
) =>
	Effect.gen(function* () {
		const expected = writtenRows(spec, instance)
		for (const [r] of spec.relations.entries()) {
			const stored = yield* tableState(
				done,
				defined(relations[relationName(r)], "a relation value")
			)
			unorderedEqual(
				stored,
				Arr.flatMap(instance, (row) => (row.relation === r ? [defined(expected.get(row.id))] : [])),
				`${relationName(r)}'s rows after ${after}, as the reference writer fills them`
			)
		}
	})

/** Each relation's added rows in an accepted outcome, none where its counts do not name it. */
const addedOf = (
	outcome: Extract<ApplyOutcome<unknown>, { readonly kind: "accepted" }>,
	relation: string
) => Option.getOrUndefined(Arr.findFirst(outcome.counts, (n) => n.relation === relation))

layer(Substrate.layer, { excludeTestServices: true })("a stored instance inserted again", (it) => {
	it.effect(
		"answers no-change where every stated row is stored as stated, accepted where it adds rows, and invariant-rejected on the key of a stated row that differs, witnessed by that row's key",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "pg/write/reinsert",
						draw: drawn(caseGen),
						literal: Formatter.format,
						coverage: required<Situation>(situations, { cases: 72, sense: notesOnly }),
						kept: [],
						runs: 16,
						shrink: boundedShrink(40),
						concurrency: 1,
						steerEvery: 8,
						caseHang,
						oracle: {
							kind: "specification",
							name: "the README's set rule over relations as sets of facts (test/support/families/again.ts againVerdict), every drawn value the reference writer's (test/support/families/fill.ts writtenRows)"
						}
					},
					(drawnCase, c) =>
						Effect.gen(function* () {
							const { spec, rows, again } = aimedCase(drawnCase, c)
							const built = buildFill(spec)
							const declared = built.rename("Again")
							const done = yield* installMigrated(declared, {
								ambient: ordinarySession,
								label: "again",
								logins: [fullWorld(declared, {}).server],
								extensions: []
							})
							const value = built.rename(done.schema)
							const world = fullWorld(value, {})
							const names = namesOf(done)
							const lawNames = lawNamesOf(value)
							const laws: Laws = {
								reported: names.reported,
								primaryKey: (r: number) => lawNames.primaryKeyLaw({ name: relationName(r) }),
								family: (f: number) =>
									lawNames.lawOf(defined(built.families[f], "a family's statement"))
							}
							const relationAtName = (r: number) =>
								defined(built.relations[relationName(r)], "a relation value")
							const insert = Arr.reduce(insertedRelations(spec), ChangeSet.empty(value), (cs, r) =>
								cs.insert(relationAtName(r), [])
							)
							/** An instance's facts under each relation the insert writes, every one twice where `twice` says. */
							const factsOf = (instance: ReadonlyArray<InstanceRow>, twice: boolean): CallFacts => {
								const facts = instanceFacts(spec, instance)
								return {
									insert: Rec.fromEntries(
										Arr.map(
											insertedRelations(spec),
											(r): readonly [string, ReadonlyArray<unknown>] => {
												const stated = facts.get(r) ?? []
												return [relationName(r), twice ? [...stated, ...stated] : stated]
											}
										)
									)
								}
							}
							yield* Effect.gen(function* () {
								const db = yield* openServedDb(done, world.server.roles.app, {})
								const flight = yield* oneFlight(db.ctx, done.as(world.server))
								const loaded = yield* db.load({ insert })
								const applied = (callFacts: CallFacts) =>
									appliedWith(memberOps(flight.context, member(loaded, "insert")), callFacts, {})
								const first = yield* flight.judged(
									"the first insert",
									applied(factsOf(rows, false))
								)
								assert.equal(
									first.kind,
									rows.length === 0 ? "no-change" : "accepted",
									`the first insert of ${Formatter.format(spec)}`
								)
								yield* storesExactly(done, spec, built.relations, rows, "the first insert")
								let stored = rows
								for (const [i, step] of again.entries()) {
									const label = `insert again ${String(i)} of ${Formatter.format(spec)}`
									const restated = Arr.reduce(step.differences, stored, (at, d) =>
										differed(spec, at, d)
									)
									const verdict = againVerdict(spec, stored, restated)
									const outcome = yield* flight.judged(
										label,
										applied(factsOf(restated, step.twice))
									)
									if (verdict.kind === "refused") {
										judgeRefused(label, spec, restated, outcome, verdict, laws)
										yield* storesExactly(
											done,
											spec,
											built.relations,
											stored,
											`the refused ${label}`
										)
									} else {
										assert.equal(
											outcome.kind,
											Arr.isReadonlyArrayNonEmpty(verdict.added) ? "accepted" : "no-change",
											`${label}: every stated row is stored as stated, adding ${Formatter.format(Arr.map(verdict.added, (x) => x.id))}`
										)
										if (outcome.kind === "accepted") {
											for (const [r] of spec.relations.entries()) {
												const counted = addedOf(outcome, relationName(r))
												assert.equal(
													counted?.added ?? 0n,
													BigInt(Arr.filter(verdict.added, (x) => x.relation === r).length),
													`${label}: ${relationName(r)}'s added rows`
												)
												assert.equal(
													counted?.deleted ?? 0n,
													0n,
													`${label}: an insert deletes nothing`
												)
											}
										}
										yield* storesExactly(done, spec, built.relations, verdict.rows, label)
									}
									const v = verdictLabel(verdict)
									const [only, ...more] = step.differences
									if (only === undefined) {
										c.note(
											step.twice
												? `the same instance stated twice in one call: ${v}`
												: `the same instance again: ${v}`
										)
									} else if (Arr.isReadonlyArrayNonEmpty(more)) {
										c.note("two differences in one insert")
									} else {
										c.note(situationOf(targetOf(spec, stored, only), v))
									}
									stored = storedAfter(stored, verdict)
								}
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped)
				)
			)
	)
})
