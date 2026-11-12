import { layer } from "@effect/vitest"
import { type Case, drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { constant, element, type Gen, int, subset, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { boundedShrink } from "@grizzle/testing/shrink"
import { swarm } from "@grizzle/testing/swarm"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import type { ApplyOutcome } from "#adapter/types/db.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { printObjectName } from "#compiler/sql/print.ts"
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
	targetsOf,
	unitRelations,
	unitRowsOf,
	withoutUnits
} from "#test/support/families/again.ts"
import {
	admittedFillSpecGen,
	besides,
	buildFill,
	familyAt,
	type FamilyKind,
	type FillSpec,
	fullInstance,
	groupFieldsOf,
	indexName,
	keyOfRelation,
	type InstanceRow,
	insertedRelations,
	instanceFacts,
	instanceGen,
	mutableOrDrawn,
	plantedGen,
	relationAt,
	relationName,
	rootEntries,
	treeOn,
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
 * an ordered family or a counted family, a top row left out, a row renamed, another instance beside it; now and then
 * every fact stated twice in the one call; and, one insert again in three where the stored instance holds a unit, a
 * replace (README "Families": "A replace is a delete and an insert in one stratum"), the same stratum first deleting
 * some stored units whole: tree roots by their root fields, and top rows of a relation that owns a family and is no
 * family's member, by their facts. The generator draws only units the README admits, whose nested relations are
 * members only of families owned within the unit (again.ts unitRelations); WHOLEDEL's suite searches the refusals.
 *
 * A replace is judged by the same rule from the stored instance less its deleted units: the state it leaves is
 * (S − units) ∪ the stated rows, it answers `no-change` where that is the stored state and `accepted` otherwise, and an
 * identical replace writes no row, every stored row keeping its ctid and xmin ("A row the replace adds again unchanged
 * is never written"). Its counts are not judged beyond its kind.
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
 * Features: each kind of difference, alone in its insert, at each family kind and place, with its verdict, a sequence's
 * member added, removed or moved under a mutable owner and under an immutable one (an owner stated again with fewer,
 * more or reordered members, README.md:2066); a counted family's member added under a tree node and under a top row,
 * the owner stated again as stored (a counted family is a set its inserts append to); the same instance again and
 * stated twice; two differences in one insert; a replace of the same units, with a difference, and dropping a unit. A
 * witness case aims at a pending one with a schema holding every family kind, a top row owning a counted and an ordered
 * family, every relation mutable or every one immutable, every count at its most, and one difference at it.
 *
 * Plants, each of which must turn the property red: ~/.cache/grizzle-release/KEYSTRESS/plants/
 * reinsert-no-change-as-accepted.patch, a committed write answered `accepted` whatever its counts; and under
 * ~/.cache/grizzle-release/RESTATED/plants/, restated-sequence-accepted.patch, a nested owner's facts stating none of
 * its sequences' counts and ends, and counted-append-refused.patch, a nested row compared at its counted families'
 * counts and ends too.
 */

/** A second insert of a case: its differences from the stored instance, in order, and whether it states every fact twice. */
interface Again {
	readonly differences: ReadonlyArray<Difference>
	readonly twice: boolean
	/** The stored units the same stratum deletes whole first, a replace where any (README "Families", replace). */
	readonly units: ReadonlyArray<number>
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

/** A sequence as a situation names it: a tree or an ordered family, whose owner states its members. */
type SequenceLabel = "a tree" | "an ordered family"

/** An owner's mutability as a situation names it. */
type MutabilityLabel = "a mutable" | "an immutable"

type Situation =
	| `the same instance again: ${VerdictLabel}`
	| `the same instance stated twice in one call: ${VerdictLabel}`
	| `${PlaceLabel}'s payload changed: ${VerdictLabel}`
	| `${PlaceLabel} renamed: ${VerdictLabel}`
	| `a member added to ${FamilyLabel}: ${VerdictLabel}`
	| `a member added to a counted family under ${PlaceLabel}: ${VerdictLabel}`
	| `a member removed from ${FamilyLabel}: ${VerdictLabel}`
	| `a member moved in ${FamilyLabel}: ${VerdictLabel}`
	| `a member ${"added to" | "removed from" | "moved in"} ${SequenceLabel} under ${MutabilityLabel} owner: ${VerdictLabel}`
	| `a top row left out: ${VerdictLabel}`
	| `another instance beside: ${VerdictLabel}`
	| "two differences in one insert"
	| `a replace of the same units: ${VerdictLabel}`
	| `a replace with a difference: ${VerdictLabel}`
	| `a replace dropping a unit: ${VerdictLabel}`

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
		case "renamed":
			return { kind: d.kind, place: standingOf(spec, row(d.id)) }
		case "added": {
			const at = defined(d.row.memberOf[0], "a new member's family")
			return {
				kind: "added",
				family: familyAt(spec, at.family).kind,
				owner: standingOf(spec, row(at.owner))
			}
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

/**
 * The mutability of the owner a difference's member change reaches: the owner relation of the family a new member
 * joins, a removed row's sequence, or a moved row's new family; none for any other difference.
 */
const ownerMutability = (
	spec: FillSpec,
	stored: ReadonlyArray<InstanceRow>,
	d: Difference
): MutabilityLabel => {
	const family = ((): number | undefined => {
		switch (d.kind) {
			case "added":
				return d.row.memberOf[0]?.family
			case "moved":
				return d.to.family
			case "removed":
				return Option.getOrUndefined(
					Arr.findFirst(
						Option.getOrUndefined(Arr.findFirst(stored, (r) => r.id === d.id))?.memberOf ?? [],
						(m) => familyAt(spec, m.family).kind !== "counted"
					)
				)?.family
			case "payload":
			case "renamed":
			case "beside":
				return undefined
		}
	})()
	return family !== undefined && relationAt(spec, familyAt(spec, family).owner).mutable
		? "a mutable"
		: "an immutable"
}

/** The situation of one difference alone in its insert, with its verdict and its owner's mutability. */
const situationOf = (t: Target, v: VerdictLabel, owner: MutabilityLabel): Situation => {
	if (
		(t.kind === "added" || t.kind === "removed" || t.kind === "moved") &&
		(t.family === "tree" || t.family === "ordered")
	) {
		const sequence: SequenceLabel = t.family === "tree" ? "a tree" : "an ordered family"
		switch (t.kind) {
			case "added":
				return `a member added to ${sequence} under ${owner} owner: ${v}`
			case "removed":
				return `a member removed from ${sequence} under ${owner} owner: ${v}`
			case "moved":
				return `a member moved in ${sequence} under ${owner} owner: ${v}`
		}
	}
	switch (t.kind) {
		case "payload":
			return `${placeLabels[t.place]}'s payload changed: ${v}`
		case "renamed":
			return `${placeLabels[t.place]} renamed: ${v}`
		case "added":
			return t.family === "counted"
				? `a member added to a counted family under ${placeLabels[t.owner]}: ${v}`
				: `a member added to ${familyLabels[t.family]}: ${v}`
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
	| { readonly kind: "target"; readonly target: Target; readonly mutable: boolean }
	| { readonly kind: "replace"; readonly change: "none" | "a difference" | "a unit dropped" }

/** The required situations, each with what a witness aims at to reach it, each verdict the set rule's for its aim. */
const aims: Arr.NonEmptyReadonlyArray<readonly [Situation, Aim]> = [
	["the same instance again: no-change", { kind: "drawn", differences: 0, twice: false }],
	[
		"the same instance stated twice in one call: no-change",
		{ kind: "drawn", differences: 0, twice: true }
	],
	[
		"a top row's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "top row" }, mutable: true }
	],
	[
		"a tree node's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "tree node" }, mutable: true }
	],
	[
		"an ordered member's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "ordered member" }, mutable: true }
	],
	[
		"a counted member's payload changed: refused on a key",
		{ kind: "target", target: { kind: "payload", place: "counted member" }, mutable: true }
	],
	[
		"a member added to a tree under a mutable owner: refused on a key",
		{
			kind: "target",
			target: { kind: "added", family: "tree", owner: "tree node" },
			mutable: true
		}
	],
	[
		"a member added to a tree under an immutable owner: refused on a key",
		{
			kind: "target",
			target: { kind: "added", family: "tree", owner: "tree node" },
			mutable: false
		}
	],
	[
		"a member added to an ordered family under a mutable owner: refused on a key",
		{
			kind: "target",
			target: { kind: "added", family: "ordered", owner: "top row" },
			mutable: true
		}
	],
	[
		"a member added to an ordered family under an immutable owner: refused on a key",
		{
			kind: "target",
			target: { kind: "added", family: "ordered", owner: "top row" },
			mutable: false
		}
	],
	[
		"a member added to a counted family under a tree node: accepted",
		{
			kind: "target",
			target: { kind: "added", family: "counted", owner: "tree node" },
			mutable: true
		}
	],
	[
		"a member added to a counted family under a top row: accepted",
		{
			kind: "target",
			target: { kind: "added", family: "counted", owner: "top row" },
			mutable: true
		}
	],
	[
		"a member removed from a tree under a mutable owner: refused on a key",
		{ kind: "target", target: { kind: "removed", family: "tree" }, mutable: true }
	],
	[
		"a member removed from a tree under an immutable owner: refused on a key",
		{ kind: "target", target: { kind: "removed", family: "tree" }, mutable: false }
	],
	[
		"a member removed from an ordered family under a mutable owner: refused on a key",
		{ kind: "target", target: { kind: "removed", family: "ordered" }, mutable: true }
	],
	[
		"a member removed from an ordered family under an immutable owner: refused on a key",
		{ kind: "target", target: { kind: "removed", family: "ordered" }, mutable: false }
	],
	[
		"a member removed from a counted family: no-change",
		{ kind: "target", target: { kind: "removed", family: "counted" }, mutable: true }
	],
	[
		"a member moved in a tree under a mutable owner: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "tree" }, mutable: true }
	],
	[
		"a member moved in a tree under an immutable owner: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "tree" }, mutable: false }
	],
	[
		"a member moved in an ordered family under a mutable owner: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "ordered" }, mutable: true }
	],
	[
		"a member moved in an ordered family under an immutable owner: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "ordered" }, mutable: false }
	],
	[
		"a member moved in a counted family: refused on a key",
		{ kind: "target", target: { kind: "moved", family: "counted" }, mutable: true }
	],
	[
		"a top row left out: no-change",
		{ kind: "target", target: { kind: "left out" }, mutable: true }
	],
	[
		"another instance beside: accepted",
		{ kind: "target", target: { kind: "beside" }, mutable: true }
	],
	[
		"a tree node renamed: refused on a key",
		{ kind: "target", target: { kind: "renamed", place: "tree node" }, mutable: true }
	],
	[
		"a counted member renamed: accepted",
		{ kind: "target", target: { kind: "renamed", place: "counted member" }, mutable: true }
	],
	["two differences in one insert", { kind: "drawn", differences: 2, twice: false }],
	["a replace of the same units: no-change", { kind: "replace", change: "none" }],
	["a replace with a difference: accepted", { kind: "replace", change: "a difference" }],
	["a replace dropping a unit: accepted", { kind: "replace", change: "a unit dropped" }]
]

const situations: Arr.NonEmptyReadonlyArray<Situation> = Arr.map(aims, ([s]) => s)

/** How often an insert again states every fact twice: one in five. */
const twiceGen: Gen<boolean> = weighted([
	[4, constant(false)],
	[1, constant(true)]
])

/** How often an insert again is a replace, where the stored instance holds a unit: one in three. */
const replaceGen: Gen<boolean> = weighted([
	[2, constant(false)],
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
			const unitIds = Arr.map(unitRowsOf(spec, stored), (r) => r.id)
			const units =
				Arr.isReadonlyArrayNonEmpty(unitIds) && source.draw(replaceGen)
					? source.draw(subset(unitIds, { min: 1, max: unitIds.length }))
					: []
			out.push({ differences, twice: source.draw(twiceGen), units })
			stored = storedAfter(stored, againVerdict(spec, withoutUnits(stored, units), again))
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

/** The folds an aimed schema's top row's families are drawn with. */
const folds: Arr.NonEmptyReadonlyArray<"none" | "sum" | "count"> = ["none", "sum", "count"]

/**
 * A top row owning a counted and an ordered family, each of a relation of no other family, so its ordered family takes
 * a new member under an immutable owner too, which an ordered member counted too never does (again.ts newMember joins
 * no immutable counted owner); an ordered family's member counted too; and a tree owning a counted family, every
 * relation mutable or every one immutable, as the aim says. An instance is made in relation order up to its bound
 * (fill.ts instanceBound), and a tree at its most outgrows it, so the tree comes last and holds what the others leave.
 */
const aimedSpecGen =
	(mutable: boolean): Gen<FillSpec> =>
	(source) => {
		const spec = besides(
			besides(
				{
					relations: [
						{ generated: false, mutable: true },
						{ generated: false, mutable: true },
						{ generated: false, mutable: true }
					],
					families: [
						{ kind: "counted", owner: 0, member: 1, fold: source.draw(element(folds)) },
						{ kind: "ordered", owner: 0, member: 2, fold: source.draw(element(folds)) }
					],
					copies: [],
					steps: []
				},
				source.draw(plantedGen("counted ordered member"))
			),
			source.draw(plantedGen("tree with a counted family"))
		)
		const [first, ...rest] = spec.relations
		return {
			...spec,
			relations: [{ ...first, mutable }, ...Arr.map(rest, (r) => ({ ...r, mutable }))]
		}
	}

/**
 * A case aimed at a pending situation: the aimed schema, every count at its most, and one insert again with the
 * aim's differences, one at its target where the instance admits it and drawn otherwise.
 */
const aimedGen =
	(aim: Aim): Gen<ReinsertCase> =>
	(source) => {
		const spec = source.draw(aimedSpecGen(aim.kind !== "target" || aim.mutable))
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
				return { spec, rows, again: [{ differences, twice: aim.twice, units: [] }] }
			}
			case "target": {
				const admitted = Arr.some(targetsOf(spec, rows, keys), (t) => deepEquals(t, aim.target))
				const d = source.draw(admitted ? differenceAt(spec, rows, keys, aim.target) : drawnAt(rows))
				return { spec, rows, again: [{ differences: [d], twice: false, units: [] }] }
			}
			case "replace": {
				const units = Arr.map(unitRowsOf(spec, rows), (r) => r.id)
				const differences = ((): ReadonlyArray<Difference> => {
					switch (aim.change) {
						case "none":
							return []
						case "a difference":
							return [source.draw(drawnAt(rows))]
						case "a unit dropped":
							return Arr.match(units, {
								onEmpty: () => [],
								onNonEmpty: (ids) => [{ kind: "removed", id: source.draw(element(ids)) }]
							})
					}
				})()
				return { spec, rows, again: [{ differences, twice: false, units }] }
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

/** The fields of family `f`'s own key: its group and index, a tree's root, parent and slot. */
const familyKey = (spec: FillSpec, f: number): ReadonlyArray<string> => [
	...groupFieldsOf(spec, f),
	indexName(f)
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
			at(x, keyOfRelation(spec, x.relation))) ||
			Arr.some(
				v.placed,
				(p) =>
					p.row.id === x.id &&
					named.includes(laws.family(p.family)) &&
					Arr.some([keyOfRelation(spec, x.relation), familyKey(spec, p.family)], (fields) =>
						at(x, fields)
					)
			))
	assert.ok(
		Arr.some(again, breaks),
		`${label}: the witness ${Formatter.format(witness)} is the key of a stated row breaking a law the refusal names, ${Formatter.format(named)}`
	)
}

/** Whether two instances store one state: every relation's rows as the reference writer fills them, as sets. */
const sameWritten = (
	spec: FillSpec,
	a: ReadonlyArray<InstanceRow>,
	b: ReadonlyArray<InstanceRow>
): boolean => {
	const wa = writtenRows(spec, a)
	const wb = writtenRows(spec, b)
	const rowsOf = (
		written: ReturnType<typeof writtenRows>,
		rows: ReadonlyArray<InstanceRow>,
		r: number
	) =>
		Arr.flatMap(rows, (x) =>
			x.relation === r ? [defined(written.get(x.id), "a written row")] : []
		)
	return Arr.every(spec.relations, (_, r) => {
		const x = rowsOf(wa, a, r)
		const y = rowsOf(wb, b, r)
		return (
			x.length === y.length && Arr.every(x, (row) => Arr.some(y, (other) => deepEquals(row, other)))
		)
	})
}

/** Every stored row's physical identity, its relation, ctid and xmin, over every relation of `spec`. */
const physicalRows = (done: Installed, spec: FillSpec) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const out: Array<readonly [string, string, string]> = []
		for (const [r] of spec.relations.entries()) {
			const rows = yield* s.admin.queryValues(
				`SELECT ctid::text, xmin::text FROM ${printObjectName(done.names.relation(relationName(r)))}`,
				[]
			)
			for (const row of rows) {
				out.push([relationName(r), String(row[0]), String(row[1])])
			}
		}
		return out
	})

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
							/** A replace: each unit relation deleted whole, then every relation a caller writes inserted, one stratum. */
							const units = unitRelations(spec)
							const replace = Arr.reduce(
								insertedRelations(spec),
								Arr.reduce(units, ChangeSet.empty(value), (cs, r) =>
									cs.delete(relationAtName(r), [])
								),
								(cs, r) => cs.insert(relationAtName(r), [])
							)
							/**
							 * The facts a delete of unit rows `ids` names, by relation: a tree's root fields, and any other unit's
							 * written fields, its `id` and `v`, since a unit is no family's member, never the members its insert
							 * nests at a sequence's count field.
							 */
							const unitFacts = (
								stored: ReadonlyArray<InstanceRow>,
								ids: ReadonlyArray<number>
							): Readonly<Record<string, ReadonlyArray<unknown>>> =>
								Rec.fromEntries(
									Arr.map(units, (r): readonly [string, ReadonlyArray<unknown>] => [
										relationName(r),
										Arr.map(
											Arr.filter(stored, (x) => x.relation === r && ids.includes(x.id)),
											(x: InstanceRow): unknown =>
												Option.match(Option.fromUndefinedOr(treeOn(spec, r)), {
													onSome: (f) => Rec.fromEntries(rootEntries(f, x.id)),
													onNone: () => ({ id: uuidOfRow(x.id), v: x.v })
												})
										)
									])
								)
							yield* Effect.gen(function* () {
								const db = yield* openServedDb(done, world.server.roles.app, {})
								const flight = yield* oneFlight(db.ctx, done.as(world.server))
								const loaded = yield* db.load(
									Arr.isReadonlyArrayNonEmpty(units) ? { insert, replace } : { insert }
								)
								const applied = (callFacts: CallFacts) =>
									appliedWith(memberOps(flight.context, member(loaded, "insert")), callFacts, {})
								const replaced = (callFacts: CallFacts) =>
									appliedWith(memberOps(flight.context, member(loaded, "replace")), callFacts, {})
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
									const left = withoutUnits(stored, step.units)
									const verdict = againVerdict(spec, left, restated)
									const identical =
										Arr.isReadonlyArrayNonEmpty(step.units) &&
										verdict.kind === "written" &&
										sameWritten(spec, stored, verdict.rows)
									const physicalBefore = identical ? yield* physicalRows(done, spec) : []
									const outcome = yield* flight.judged(
										label,
										Arr.isReadonlyArrayNonEmpty(step.units)
											? replaced({
													...factsOf(restated, step.twice),
													delete: unitFacts(stored, step.units)
												})
											: applied(factsOf(restated, step.twice))
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
										const changed = Arr.isReadonlyArrayNonEmpty(step.units)
											? !sameWritten(spec, stored, verdict.rows)
											: Arr.isReadonlyArrayNonEmpty(verdict.added)
										assert.equal(
											outcome.kind,
											changed ? "accepted" : "no-change",
											`${label}: every stated row is stored as stated, adding ${Formatter.format(Arr.map(verdict.added, (x) => x.id))}${Arr.isReadonlyArrayNonEmpty(step.units) ? ` after deleting the units ${Formatter.format(step.units)} whole` : ""}, so it is not ${Formatter.format(outcome)}`
										)
										if (identical) {
											const physicalAfter = yield* physicalRows(done, spec)
											unorderedEqual(
												physicalAfter,
												physicalBefore,
												`${label}: an identical replace writes no row, every row's ctid and xmin kept (README "Families", replace)`
											)
										}
										if (outcome.kind === "accepted" && !Arr.isReadonlyArrayNonEmpty(step.units)) {
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
									const v: VerdictLabel =
										verdict.kind === "written" && Arr.isReadonlyArrayNonEmpty(step.units)
											? sameWritten(spec, stored, verdict.rows)
												? "no-change"
												: "accepted"
											: verdictLabel(verdict)
									const [only, ...more] = step.differences
									if (Arr.isReadonlyArrayNonEmpty(step.units)) {
										c.note(
											only === undefined
												? `a replace of the same units: ${v}`
												: only.kind === "removed" && step.units.includes(only.id)
													? `a replace dropping a unit: ${v}`
													: `a replace with a difference: ${v}`
										)
									} else if (only === undefined) {
										c.note(
											step.twice
												? `the same instance stated twice in one call: ${v}`
												: `the same instance again: ${v}`
										)
									} else if (Arr.isReadonlyArrayNonEmpty(more)) {
										c.note("two differences in one insert")
									} else {
										c.note(
											situationOf(
												targetOf(spec, stored, only),
												v,
												ownerMutability(spec, stored, only)
											)
										)
									}
									stored = verdict.kind === "written" ? verdict.rows : stored
								}
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped)
				)
			)
	)
})
