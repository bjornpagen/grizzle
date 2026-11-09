/**
 * The law model's own judgments of a compiled write's binding (write/program/binding.ts Binding), read off the write's
 * front end and its law model as binding read them on every application before they were decided at compile time: the
 * oracle a binding is judged against (test/unit/write/program/binding.test.ts). Each judgment is stated here from the law
 * model's meaning, never through write/program/decide.ts.
 */
import { Array as Arr, Option, String as Str } from "effect"
import { layoutKey } from "#compiler/analysis/theory/fill.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import { type Family, isSequence } from "#compiler/ir/family.ts"
import type { FillPosition } from "#compiler/ir/fill.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import type { HeadingColumn } from "#compiler/ir/rel.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import { familyKey, fieldKey } from "#compiler/write/family/fold.ts"
import { endColumns, rowLayout } from "#compiler/write/family/statements.ts"
import type { EnumeratedInput, SlotGroup, WriteFrontend } from "#compiler/write/frontend/compile.ts"
import type { Proposal } from "#compiler/write/insert/statement.ts"
import type { Binding } from "#compiler/write/program/binding.ts"
import { assert, defined } from "#test/support/assert.ts"

/** Which facts of a member slot its statement proposes, by the law model: an INSERT into a relation of drawn or
 * accumulated fields proposes only those at no stored key, but for a generated addition; anything else every one. */
const proposalOf = (frontend: WriteFrontend, stratum: StratumAt, slot: ParamId): Proposal => {
	const action = Arr.findFirst(
		frontend.ir.strata[stratum]?.actions ?? [],
		(a) => a.source.kind !== "described" && a.source.slot === slot
	)
	if (Option.isNone(action) || action.value.op !== "insert") {
		return "every"
	}
	const { info, serial } = action.value
	return serial.kind !== "generated" &&
		Arr.some(
			info.relation.heading,
			(f) => f.writing.kind === "drawn" || f.writing.kind === "accumulated"
		)
		? "unstored"
		: "every"
}

/** Whether a stratum's family statements run in the call's one flight: its schedule places additions or removals. */
const inFlight = (frontend: WriteFrontend, stratum: StratumAt): boolean =>
	Arr.some(
		defined(frontend.ir.strata[stratum], "a stratum").family,
		({ node }) => node.kind === "additions" || node.kind === "removals"
	)

/** The counted families of the law model `relation` owns, in its order. */
const countedOwned = (frontend: WriteFrontend, relation: string): ReadonlyArray<Family> =>
	Arr.filter(frontend.laws.families, (f) => f.owner.name === relation && !isSequence(f))

/** A column's key and type, as two layouts are compared. */
const columnOf = (c: { readonly key: string; readonly type: unknown }) => [c.key, c.type] as const

/** A sorted copy of names. */
const sorted = (names: Iterable<string>): ReadonlyArray<string> => Arr.sort([...names], Str.Order)

/** The judged relations' facts, against the law model: their stated and primary fields, their row layouts, and each
 * column a counted family they own draws, the first in the law model's order, its count before its ends, with an end's
 * start. */
const judgedAgrees = (frontend: WriteFrontend, binding: Binding): void => {
	const families = frontend.laws.families
	const relations = new Map<string, RelationInfo>()
	for (const r of [...frontend.written, ...Arr.map(frontend.slots, (g) => g.relation)]) {
		relations.set(r.name, r)
	}
	assert.deepEqual(sorted(binding.judged.keys()), sorted(relations.keys()), "the judged relations")
	for (const [name, relation] of relations) {
		const judged = defined(binding.judged.get(name), `the judged relation ${name}`)
		assert.deepEqual(
			judged.stated,
			Arr.map(
				Arr.filter(
					relation.fields,
					(f) => f.writing.kind === "caller" || f.writing.kind === "serial"
				),
				(f) => f.name
			),
			`${name}'s stated fields`
		)
		assert.deepEqual(
			judged.primary,
			Arr.map(relation.primaryFields, (f) => f.name),
			`${name}'s primary key`
		)
		const layout = rowLayout(relation, families)
		assert.deepEqual(
			Arr.map(judged.layout.key, columnOf),
			Arr.map(layout.key, columnOf),
			`${name}'s layout's key`
		)
		assert.deepEqual(
			Arr.map(judged.layout.columns, columnOf),
			Arr.map(layout.columns, columnOf),
			`${name}'s layout's columns`
		)
		const drawn = Arr.flatMap(countedOwned(frontend, name), (family) =>
			Arr.map([family.count, ...endColumns(family)], (field) => ({ family, field }))
		)
		assert.deepEqual(
			sorted(judged.owned.keys()),
			sorted(new Set(Arr.map(drawn, ({ field }) => fieldKey(field.name)))),
			`${name}'s owned columns`
		)
		for (const [key, owned] of judged.owned) {
			const law = defined(
				Option.getOrUndefined(Arr.findFirst(drawn, ({ field }) => fieldKey(field.name) === key)),
				`the family that draws ${name}'s ${key}`
			)
			assert.equal(
				familyKey(owned.family.id),
				familyKey(law.family.id),
				`${name}'s ${key}'s family`
			)
			const writing = law.field.writing
			if (law.field.name === law.family.count.name) {
				assert.equal(owned.kind, "count", `${name}'s ${key} is its family's count`)
			} else if (writing.kind === "accumulated") {
				assert.deepEqual(
					owned.kind === "end" ? owned.start : undefined,
					writing.start,
					`${name}'s ${key} is an end at its start`
				)
			} else {
				assert.fail(`${name}'s ${key}, an end, is accumulated`)
			}
		}
	}
}

/** Where a stratum's nested writes stand `relation`'s rows: the first that fills them. */
const nestedPosition = (
	frontend: WriteFrontend,
	stratum: StratumAt,
	relation: string
): FillPosition | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(frontend.nested, (n) => n.stratum === stratum && n.nesting.layouts.has(relation))
	)?.nesting.layouts.get(relation)?.position

/** A family's group as its names and types. */
const groupOf = (
	group: ReadonlyArray<{ readonly member: HeadingColumn; readonly owner: HeadingColumn }>
) => Arr.map(group, (g) => [g.member.name, g.owner.name, g.member.type, g.owner.type] as const)

/** The fresh fills, against the law model: one per stratum in the call's flight, its appended slots, the counted
 * families its appends and nested rows reach, and each of their owners' inserting slots and nested position. */
const freshAgrees = (frontend: WriteFrontend, binding: Binding): void => {
	const families = frontend.laws.families
	const strata = Arr.filter(strataAt(frontend.ir.strata), ([s]) => inFlight(frontend, s))
	assert.deepEqual(
		Arr.map(binding.fresh, (f) => f.stratum),
		Arr.map(strata, ([s]) => s),
		"the strata whose fresh owners the host counts"
	)
	for (const [i, [stratum]] of Arr.map(strata, (s, at) => [at, s] as const)) {
		const fresh = defined(binding.fresh[i], `the fresh fill of stratum ${stratum}`)
		const appended = Arr.flatMap(frontend.edits, (e) =>
			e.stratum === stratum
				? Arr.flatMap([e.inserts, e.puts], (slot) =>
						slot === undefined ? [] : [{ relation: e.relation.name, slot }]
					)
				: []
		)
		assert.deepEqual(fresh.appended, appended, `stratum ${stratum}'s appended slots`)
		const reaches = (relation: string): boolean =>
			Arr.some(appended, (a) => a.relation === relation) ||
			Arr.some(frontend.nested, (n) => n.stratum === stratum && n.nesting.layouts.has(relation))
		const counted = Arr.filter(families, (f) => !isSequence(f) && reaches(f.member.name))
		assert.deepEqual(
			Arr.map(fresh.counted, (f) => [
				familyKey(f.id),
				f.owner,
				f.member,
				f.count,
				f.ends,
				groupOf(f.group)
			]),
			Arr.map(counted, (f) => [
				familyKey(f.id),
				f.owner.name,
				f.member.name,
				f.count.name,
				Arr.map(endColumns(f), (e) => e.name),
				groupOf(f.group)
			]),
			`stratum ${stratum}'s counted families`
		)
		const owners = [...new Set(Arr.map(counted, (f) => f.owner.name))]
		assert.deepEqual([...fresh.owners.keys()], owners, `stratum ${stratum}'s fresh owners`)
		for (const owner of owners) {
			const at = defined(fresh.owners.get(owner), `the fresh owner ${owner}`)
			const sequenceMember = Arr.some(families, (f) => isSequence(f) && f.member.name === owner)
			const slots = Arr.flatMap(
				Arr.filter(
					frontend.slots,
					(g: SlotGroup) => g.stratum === stratum && g.relation.name === owner
				),
				(g: SlotGroup) =>
					Arr.flatMap(g.inputs, (input: EnumeratedInput) =>
						(input.kind === "single" && input.act.op !== "delete" && input.starts.length > 0) ||
						input.kind === "nested"
							? [input.slot.slot]
							: []
					)
			)
			assert.deepEqual(at.inserting, sequenceMember ? [] : slots, `${owner}'s inserting slots`)
			const position = nestedPosition(frontend, stratum, owner)
			assert.equal(
				at.nested.kind === "at" ? layoutKey(owner, at.nested.position) : undefined,
				position === undefined ? undefined : layoutKey(owner, position),
				`where stratum ${stratum}'s nested writes stand ${owner}`
			)
		}
	}
}

/** The member slots and their proposals, against the law model's actions. */
const membersAgree = (frontend: WriteFrontend, binding: Binding): void => {
	for (const [slot, at] of frontend.slotsById) {
		assert.equal(
			binding.proposals.get(slot),
			proposalOf(frontend, at.group.stratum, slot),
			`the proposal of member slot ${slot}`
		)
	}
	assert.equal(binding.proposals.size, frontend.slotsById.size, "a proposal per member slot")
	assert.deepEqual(
		Arr.flatMap(binding.groups, (g) => Arr.flatMap(g.inputs, (i) => i.members)),
		Arr.flatMap(frontend.slots, (g) => Arr.flatMap(g.inputs, (i) => i.members)),
		"the slot groups' members"
	)
}

/** The binding's fill holds exactly the layouts the write's fills may meet: each nested write's start, each fresh
 * owner's where its slots insert it and where its stratum's nested writes stand it, and from each, the members of
 * every family the layout's rows own. */
const fillCovers = (frontend: WriteFrontend, binding: Binding): void => {
	const fill = frontend.laws.theory.fill
	const pending: Array<string> = [
		...Arr.map(frontend.nested, (n) => layoutKey(n.nesting.relation.name, n.nesting.start)),
		...Arr.flatMap(binding.fresh, (f) =>
			Arr.flatMap([...f.owners], ([owner, at]) => [
				...(at.inserting.length > 0 ? [layoutKey(owner, { kind: "top" })] : []),
				...(at.nested.kind === "at" ? [layoutKey(owner, at.nested.position)] : [])
			])
		)
	]
	const met = new Set<string>()
	for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
		if (met.has(key)) {
			continue
		}
		met.add(key)
		const layout = defined(fill.layouts.get(key), `the law model's layout ${key}`)
		for (const f of layout.owns) {
			pending.push(layoutKey(f.member.name, { kind: "member", family: f }))
		}
	}
	assert.deepEqual(
		sorted(binding.fill.layouts.keys()),
		sorted(met),
		"the binding's fill holds exactly the layouts its walks and fresh fills meet"
	)
}

/**
 * A compiled write's binding agrees with its law model: every judgment it decided is the one the law model gives
 * (`membersAgree`, `judgedAgrees`, `freshAgrees`), and its fill holds exactly the layouts its fills meet
 * (`fillCovers`).
 */
export const bindingAgrees = (frontend: WriteFrontend, binding: Binding): void => {
	membersAgree(frontend, binding)
	judgedAgrees(frontend, binding)
	freshAgrees(frontend, binding)
	fillCovers(frontend, binding)
}
