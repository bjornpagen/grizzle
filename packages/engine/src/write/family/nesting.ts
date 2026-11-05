/**
 * A nested write: an insert of an owner, or of a tree's roots, with every family it owns nested at its count fields,
 * to any depth (fin.md §4.5, D4).
 *
 * At compile time a nesting is the insert's relation and every family its rows reach, each at its depth (`Reached`), the
 * heading each level's own fields are admitted by, and the filler that draws and fills the rest (fold.ts). At bind time
 * each fact is split along its families (write/changeset/value.ts encodeAddition), each level's own fields admitted
 * through its carriers' codecs, the whole nesting filled in one walk, and its rows cut into each family's write
 * (order.ts FamilyWrite): every owner the ChangeSet inserts is fresh, so each family's write is each owner's members
 * placed at slots 0 … n − 1 with no count statement (`count: inserted`), and a tree's every node in pre-order
 * (tree.ts walk). The insert's own relation, when no tree's, is written by its own insert with its drawn count and its
 * accumulated ends; a tree's roots are written with the rest of their trees.
 */
import { encodeFailure, slotPlace } from "#compiler/codec/fault.ts"
import {
	positionalColumns,
	type RelationNormalizer,
	relationNormalizer
} from "#compiler/codec/recordset.ts"
import { carrierSpecOf } from "#compiler/codec/scalar.ts"
import { type CompileError, type EncodingFailure, unsupported } from "#compiler/core/errors.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { Family } from "#compiler/ir/family.ts"
import type { LawField, LawRelation } from "#compiler/ir/law.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { admittedText } from "#compiler/scalar/values/identity.ts"
import { encodeAddition, type NestedAddition } from "#compiler/write/changeset/value.ts"
import type { Row } from "#compiler/write/family/draw.ts"
import {
	familyKey,
	fieldKey,
	type FilledNode,
	type FillRefusal,
	filler as fillerOf,
	type Filler,
	type HostEvaluator,
	type HostNode
} from "#compiler/write/family/fold.ts"
import { type RowLayout, rowLayout } from "#compiler/write/family/statements.ts"

/** A family a nesting reaches, at its depth: 1 for a family of the insert's own rows, n + 1 for one whose owners are a
 * depth-n family's members. */
export interface Reached {
	readonly family: Family
	readonly depth: number
}

/** Where a level of a nesting stands: the insert's own rows, a tree's roots, or a family's members. */
type LevelOf =
	| { readonly kind: "top" }
	| { readonly kind: "root"; readonly family: Family }
	| { readonly kind: "member"; readonly family: Family }

/** One level of a nesting: its relation, where it stands, and the heading its own fields are admitted by. */
interface Level {
	readonly relation: string
	readonly at: LevelOf
	readonly heading: Heading
}

/** A nested write as compiled: see the module's header. */
export interface Nesting {
	readonly relation: LawRelation
	/** The tree the insert's relation is the relation of, whose roots its facts are. */
	readonly tree: Family | undefined
	readonly families: ReadonlyArray<Family>
	/** Every family the nesting reaches, in the order its writes are composed: shallowest first. */
	readonly reached: ReadonlyArray<Reached>
	readonly codes: Codebook
	readonly filler: Filler
	readonly levels: ReadonlyArray<Level>
	/** Each reached member relation's row layout (statements.ts rowLayout). */
	readonly layouts: ReadonlyMap<string, RowLayout>
	/** The fields the insert's own row writes: every field of its relation but a generated one. */
	readonly top: Heading
}

/** Whether a family is a sequence, ordered or a tree, whose order the caller states by nesting; else counted. */
export const isSequence = (family: Family): boolean =>
	family.members.kind === "tree" || family.index.kind === "field"

/** Whether a family is the tree of `relation`: its family over itself whose members are a tree's. */
export const isTreeOf = (family: Family, relation: string): boolean =>
	family.members.kind === "tree" &&
	family.member.name === relation &&
	family.owner.name === relation

/** A level's key in a nesting's normalizers. */
const levelKey = (relation: string, at: LevelOf): string =>
	at.kind === "top"
		? `${relation}\u0000top`
		: `${relation}\u0000${at.kind}\u0000${familyKey(at.family.id)}`

const refusal = (detail: string): CompileError =>
	unsupported(SourceLoc("ChangeSet.insert", []), detail)

/** The fields of a level a fact supplies: its caller's and its serial ones, but those its nesting supplies: a member's
 * group, a tree node's root field, and a tree root's parent, which is itself. */
const ownHeading = (relation: LawRelation, at: LevelOf): Heading => {
	const supplied = new Set<string>(
		at.kind === "top"
			? []
			: [
					...at.family.group.map((g) => g.member.name),
					...(at.kind === "member" && at.family.members.kind === "tree"
						? [at.family.members.root.name]
						: [])
				]
	)
	return relation.fields
		.filter(
			(f) => (f.writing.kind === "caller" || f.writing.kind === "serial") && !supplied.has(f.name)
		)
		.map((f) => ({ name: f.name, type: f.type }))
}

/**
 * The nesting of an insert into `relation` over the law model's `families`: every family it reaches, each at its depth,
 * its levels' headings, and its filler. Refused when its rows can't be ordered by depth: a relation that is the member
 * of two families, or families that reach each other in a cycle other than a tree's own.
 */
export const nestingOf = (
	relation: LawRelation,
	families: ReadonlyArray<Family>,
	codes: Codebook,
	evaluate: HostEvaluator
): Result.Result<Nesting, CompileError> => {
	const tree = families.find((f) => isTreeOf(f, relation.name))
	const reached: Array<Reached> = []
	const seen = new Map<string, number>()
	let frontier: ReadonlyArray<{ readonly relation: string; readonly depth: number }> = [
		{ relation: relation.name, depth: 1 }
	]
	while (frontier.length > 0) {
		const next: Array<{ readonly relation: string; readonly depth: number }> = []
		for (const { relation: owner, depth } of frontier) {
			for (const f of families.filter((g) => g.owner.name === owner && isSequence(g))) {
				const key = familyKey(f.id)
				const known = seen.get(key)
				if (known !== undefined) {
					if (isTreeOf(f, owner)) {
						continue
					}
					return Result.err(
						refusal(
							`a nested write reaches the family ${f.id.owner}.${f.id.count} twice, at depths ${known} and ${depth}: families that nest each other have no order to write their rows in`
						)
					)
				}
				const sequences = families.filter(
					(g) => g.member.name === f.member.name && isSequence(g) && !isTreeOf(g, g.member.name)
				)
				if (sequences.length > 1) {
					return Result.err(
						refusal(
							`${f.member.name} is the member of ${sequences.length} sequences, so no one order writes it: a relation is a member of at most one ordered family or tree`
						)
					)
				}
				seen.set(key, depth)
				reached.push({ family: f, depth })
				if (!isTreeOf(f, owner)) {
					next.push({ relation: f.member.name, depth: depth + 1 })
				} else {
					next.push({ relation: owner, depth: depth + 1 })
				}
			}
		}
		frontier = next
	}
	const counted = [relation.name, ...reached.map((r) => r.family.member.name)].find((name) =>
		families.some((g) => g.member.name === name && !isSequence(g))
	)
	if (counted !== undefined) {
		return Result.err(
			refusal(
				`a nested write of ${counted}, a member of a counted family: its counted slots are drawn by the rows-first planner, which this nesting does not reach`
			)
		)
	}
	const built = fillerOf(families, codes, evaluate)
	if (!built.ok) {
		return built
	}
	const layouts = new Map<string, RowLayout>()
	for (const name of new Set(reached.map((r) => r.family.member.name))) {
		const member = defined(
			reached.find((r) => r.family.member.name === name),
			"a reached member"
		).family.member
		const layout = rowLayout(member, families)
		if (!layout.ok) {
			return layout
		}
		layouts.set(name, layout.value)
	}
	const rootAt: LevelOf = tree === undefined ? { kind: "top" } : { kind: "root", family: tree }
	const levels: Array<Level> = [
		{ relation: relation.name, at: rootAt, heading: ownHeading(relation, rootAt) },
		...reached.map(({ family }) => {
			const at: LevelOf = { kind: "member", family }
			return { relation: family.member.name, at, heading: ownHeading(family.member, at) }
		})
	]
	return Result.ok(
		Object.freeze({
			relation,
			tree,
			families,
			reached: Object.freeze(reached.toSorted((a, b) => a.depth - b.depth)),
			codes,
			filler: built.value,
			levels: Object.freeze(levels),
			layouts,
			top: relation.fields
				.filter((f) => f.writing.kind !== "generated")
				.map((f) => ({ name: f.name, type: f.type }))
		})
	)
}

/** The rows of one nested member's facts: each fact's own row, when its relation is no tree's, as its insert writes it;
 * and each reached member relation's rows, whole (draw.ts Row), in the order they are inserted: each owner's members in
 * slot order, a tree's nodes in pre-order. */
export interface NestedRows {
	readonly tops: ReadonlyArray<{ readonly [field: string]: unknown }>
	readonly rows: ReadonlyMap<string, ReadonlyArray<Row>>
}

/** Why a nested member's facts cannot be written: an encoding failure, or two facts at one key of the insert's
 * relation that nest different families, `fact` the later's own row. */
export type NestedRefusal =
	| { readonly kind: "encoding"; readonly failure: EncodingFailure }
	| { readonly kind: "conflict"; readonly fact: { readonly [field: string]: unknown } }

/** A fill's refusal as the member's encoding failure: the value it could not fill is outside its column's type. */
const fillFailure = (member: string, refused: FillRefusal): EncodingFailure =>
	encodeFailure(refused.kind === "range" ? "integerRange" : "factShape", slotPlace(member))

/**
 * The rows of a nested member `member`'s facts, by the nesting's levels' normalizers for that member. Each fact is
 * split along its sequences, its levels admitted, filled, and cut into whole rows; two facts at one key of the insert's
 * relation are one fact when they nest the same rows, and a conflict otherwise.
 */
export const nestedRows = (
	nesting: Nesting,
	member: string,
	facts: Iterable<unknown>
): Result.Result<NestedRows, NestedRefusal> => {
	const normalizers = new Map(
		nesting.levels.map((l): readonly [string, RelationNormalizer] => [
			levelKey(l.relation, l.at),
			relationNormalizer({
				relation: l.relation,
				columns: positionalColumns(l.heading),
				slot: { kind: "slot", name: member },
				codes: nesting.codes
			})
		])
	)
	const sequences = nesting.families.filter(isSequence)
	const tops: Array<{ readonly [field: string]: unknown }> = []
	const rows = new Map<string, Array<Row>>()
	const byKey = new Map<string, string>()
	const keyFields = nesting.relation.keyNames.find((k) => k.primary)?.fields ?? []
	for (const fact of facts) {
		const split = encodeAddition(nesting.relation.name, fact, sequences)
		if (!split.ok) {
			return Result.err({
				kind: "encoding",
				failure: encodeFailure(split.error.fault, slotPlace(member))
			})
		}
		const host = hostNodes(nesting, normalizers, split.value)
		if (!host.ok) {
			return Result.err({ kind: "encoding", failure: host.error })
		}
		const filled = nesting.filler(host.value)
		if (!filled.ok) {
			return Result.err({ kind: "encoding", failure: fillFailure(member, filled.error) })
		}
		const root = filled.value
		const own = Object.freeze(
			Object.fromEntries(
				nesting.top.map((c) => [c.name, root.values.get(fieldKey(c.name))] as const)
			)
		)
		const key = keyFields
			.map((f) => text(nesting, f.type, root.values.get(fieldKey(f.name))))
			.join("\u0000")
		const written = rowsOf(nesting, root)
		const signature = JSON.stringify([...written].map(([r, list]) => [r, list]))
		const prior = byKey.get(key)
		if (prior !== undefined) {
			if (prior === signature) {
				continue
			}
			return Result.err({ kind: "conflict", fact: own })
		}
		byKey.set(key, signature)
		if (nesting.tree === undefined) {
			tops.push(own)
		}
		for (const [relation, list] of written) {
			const known = rows.get(relation) ?? []
			appendEach(known, list)
			rows.set(relation, known)
		}
	}
	return Result.ok({ tops, rows })
}

/** Appends every item of `items` to `to`, one by one: a family of any width is no argument list (spread arguments
 * overflow the stack at about a hundred thousand). */
const appendEach = <A>(to: Array<A>, items: ReadonlyArray<A>): void => {
	for (const item of items) {
		to.push(item)
	}
}

/** A value's text in its column's carrier, as the transport writes it. */
const text = (nesting: Nesting, type: LawField["type"], value: unknown): string =>
	admittedText(carrierSpecOf(type, nesting.codes), value)

/**
 * A split fact as the filler's nesting: each level's own fields admitted through its normalizer, iteratively, members
 * built before their owners, so any depth converts.
 */
const hostNodes = (
	nesting: Nesting,
	normalizers: ReadonlyMap<string, RelationNormalizer>,
	root: NestedAddition
): Result.Result<HostNode, EncodingFailure> => {
	/** Every addition in pre-order, with the level it stands at. */
	const order: Array<{ readonly addition: NestedAddition; readonly at: LevelOf }> = []
	const pending: Array<{ readonly addition: NestedAddition; readonly at: LevelOf }> = [
		{
			addition: root,
			at: nesting.tree === undefined ? { kind: "top" } : { kind: "root", family: nesting.tree }
		}
	]
	const byId = new Map(nesting.families.map((f) => [familyKey(f.id), f] as const))
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		order.push(next)
		for (const g of next.addition.families) {
			const family = defined(byId.get(familyKey(g.family)), "a nested family of the law model")
			for (const m of g.members) {
				pending.push({ addition: m, at: { kind: "member", family } })
			}
		}
	}
	const built = new Map<NestedAddition, HostNode>()
	for (let i = order.length - 1; i >= 0; i -= 1) {
		const { addition, at } = defined(order[i], "a nested addition met in pre-order")
		const normalize = normalizers.get(levelKey(addition.relation, at))
		if (normalize === undefined) {
			throw defect(`the level of ${addition.relation} a nesting reaches`)
		}
		const admitted = normalize([addition.fact])
		if (!admitted.ok) {
			return admitted
		}
		const values = defined(admitted.value.facts[0], "one admitted fact of one")
		built.set(
			addition,
			Object.freeze({
				relation: addition.relation,
				values: new Map(Object.entries(values).map(([k, v]) => [fieldKey(k), v] as const)),
				families: Object.freeze(
					addition.families.map((g) =>
						Object.freeze({
							family: g.family,
							members: Object.freeze(
								g.members.map((m) => defined(built.get(m), "a member built before its owner"))
							)
						})
					)
				)
			})
		)
	}
	return Result.ok(defined(built.get(root), "the nesting's root"))
}

/** A filled row's texts in its relation's row layout: its key, then its other columns. */
const rowOfFilled = (nesting: Nesting, layout: RowLayout, row: FilledNode): Row => {
	const textOf = (c: RowLayout["columns"][number]): string => {
		if (!row.values.has(c.key)) {
			throw defect(`a column ${c.key} of ${row.relation} the filler filled`)
		}
		return text(nesting, c.type, row.values.get(c.key))
	}
	return { key: mapNonEmpty(layout.key, textOf), columns: layout.columns.map(textOf) }
}

/**
 * Every reached member relation's rows of one filled nesting, whole, in the order they are inserted: one iterative
 * pre-order pass over the rows, each owner's families' members in slot order, so a tree's nodes come in pre-order and
 * every sequence's members in ascending slot order, each after its owner.
 */
const rowsOf = (nesting: Nesting, root: FilledNode): ReadonlyMap<string, ReadonlyArray<Row>> => {
	const out = new Map<string, Array<Row>>()
	const pending: Array<FilledNode> = [root]
	for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
		if (row !== root || nesting.tree !== undefined) {
			const layout = nesting.layouts.get(row.relation)
			if (layout === undefined) {
				throw defect(`the row layout of ${row.relation}, a relation the nesting reaches`)
			}
			const list = out.get(row.relation) ?? []
			list.push(rowOfFilled(nesting, layout, row))
			out.set(row.relation, list)
		}
		const members = row.families.flatMap((g) => g.members)
		for (let i = members.length - 1; i >= 0; i -= 1) {
			pending.push(defined(members[i], "a member of a filled nesting"))
		}
	}
	return out
}
