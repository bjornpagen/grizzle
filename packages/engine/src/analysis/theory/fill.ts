/**
 * The fill order of a schema's families (ir/fill.ts), built once when the schema compiles, and every column no write
 * can fill refused there, so a schema `grizzle generate` accepts is one every write of fills.
 *
 * Each relation a family reaches is laid out at every position a row of it can stand at: written by the ChangeSet
 * itself, a tree's root, or a family's member. Each column grizzle writes there gets its rule (how it is filled), the
 * columns of its own row it reads, its writer (the nested walk, or a counted family's own fill) and what it waits on,
 * its own and its reads': a copy along a sequence's last axis, a fold's end over it among them, waits on that
 * sequence's members; a counted family's end on that family's settling, after its own members; any other column on
 * nothing, filled on entering its row. A tree's interval is drawn on entering, its end its start plus its subtree's
 * size, which the nesting's shape gives before any member is filled.
 *
 * The walk fills a row's sequences one after another, and a member of one may copy a column of its owner that waits on
 * another: the walk fills that one first. So each layout orders its sequences, every one after each sequence the
 * copies its members take wait on, else in the law model's order, and a column's stage is after the last sequence it
 * waits on in that order (ir/fill.ts FillStage).
 *
 * Refused, as UnfillableField, a column that reads a source its write fills after it:
 * - along a sequence's owner axis, an owner's column that waits on that sequence's own members, or on a sequence the
 *   walk can fill only after this one, since the copies its members take wait on this one's (`afterMembers`);
 * - along a counted family's owner axis, the owner's end of that family's own fold: a counted family's members are
 *   filled after their owner's row is written whole, but before their own family's ends;
 * - anywhere, a column a counted family fills (its count and its ends) read by the walk or by another family's fill:
 *   each counted family fills on its own, from its owner's row as the walk left it, and only its own members, its own
 *   copies of its count and its own ends read what it fills;
 * - a column whose row's own columns read it back in a cycle, or that reads a column no fill that writes it reaches.
 *
 * Refused, as UnwritableRelation, a relation no write fills: sequences that nest each other in a cycle, an ordered
 * family over its own relation among them, so no row of the cycle is written first. A tree's own recursion is no
 * cycle: each of its nodes is nested under its parent.
 *
 * A counted family's member may also be a sequence's member, a tree's node or a sequence's owner. The walk fills such a
 * row as it fills any row of its position, and the counted family's own fill completes it afterwards, from its owner's
 * row and the stored family: the walk reads none of the columns a counted family fills, so it never waits on one. The
 * counted family's fill reads the row as the walk left it, so its layout holds, beside its own columns and the row's
 * caller's, the copies the row takes along the owner axis of each sequence it is a member of, which a fold's step or
 * selection may read. A sequence's other columns on the row, its index and the copies and accumulators along its
 * predecessor axis, are no counted family's to read: a change of a sibling re-places them, which no fill of that row's
 * counted families follows.
 */
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { FamilyName, FilledLater, FillAxis, UnwritableCause } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { lastNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { predicateTable, type ScalarExpr, tableReads } from "#compiler/ir/expr.ts"
import {
	baseLiteral,
	type Family,
	familyColumnType,
	isCopy,
	isSequence,
	isTreeOf
} from "#compiler/ir/family.ts"
import {
	type FillLayout,
	type FillOrder,
	type FillPosition,
	type FillRule,
	type FillStage,
	type FillWriter,
	layoutKey
} from "#compiler/ir/fill.ts"
import {
	familyKey,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type TableRelation
} from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** The field names an expression reads of its row. */
export const readsOf = (expr: ScalarExpr): ReadonlyArray<string> => tableReads(predicateTable(expr))

/**
 * `fields` of `relation`, then every field a generated one among them reads, transitively, each once: every field the
 * host needs of a row to evaluate again each generated field it reads of it (write/family/edit.ts valueAt).
 */
export const withGenerationInputs = (
	relation: LawRelation,
	fields: ReadonlyArray<LawField>
): ReadonlyArray<LawField> => {
	const out = [...fields]
	const held = new Set(fields.map((f) => f.name))
	const pending = [...fields]
	for (let field = pending.pop(); field !== undefined; field = pending.pop()) {
		if (field.writing.kind !== "generated") {
			continue
		}
		for (const name of readsOf(field.writing.expr)) {
			if (held.has(name)) {
				continue
			}
			const input = relation.fields.find((f) => f.name === name)
			if (input === undefined) {
				throw defect(`the field ${name} of ${relation.name} a generated field reads`)
			}
			held.add(name)
			out.push(input)
			pending.push(input)
		}
	}
	return out
}

/** A native column's identity within its relation: a field by its name, a law column by its identifier. */
const keyOf = (c: NativeColumn): string =>
	c.kind === "field" ? `field\u0000${c.field.name}` : `law\u0000${c.column}`

/** A native column's name as a refusal names it: a field's name, a law column's identifier. */
const nameOf = (c: NativeColumn): string => (c.kind === "field" ? c.field.name : c.column)

const fieldColumn = (field: LawField): NativeColumn => ({ kind: "field", field })

/** A family as a refusal names it. */
const named = (f: Family): FamilyName => ({ owner: f.id.owner, count: f.id.count })

const sameFamily = (a: Family, b: Family): boolean => familyKey(a.id) === familyKey(b.id)

/**
 * Every position a row of `relation` stands at: a tree's root, a family's member, or the ChangeSet's own when it is no
 * sequence's member, a counted family's member among them, which the ChangeSet writes as a row of its own.
 */
const positionsOf = (
	families: ReadonlyArray<Family>,
	relation: string
): ReadonlyArray<FillPosition> => {
	const tree = families.find((f) => isTreeOf(f, relation))
	const memberOf = families.filter((f) => f.member.name === relation)
	return [
		...(tree === undefined ? [] : [{ kind: "root", family: tree } as const]),
		...memberOf.map((family) => ({ kind: "member", family }) as const),
		...(memberOf.some(isSequence) ? [] : [{ kind: "top" } as const])
	]
}

/**
 * Every position at which the walk fills a row of `relation`, the rows a member's copy along an owner axis reads: every
 * position it stands at but a counted family's member's, which the walk never fills, since that family's own fill
 * completes the row the walk left.
 */
const walkPositionsOf = (
	families: ReadonlyArray<Family>,
	relation: string
): ReadonlyArray<FillPosition> =>
	positionsOf(families, relation).filter((p) => p.kind !== "member" || isSequence(p.family))

/**
 * What a column of a row waits on before a write fills it: the sequences the row owns whose members the walk must fill
 * first, by family key, and whether a counted family the row owns must settle it first.
 */
interface Waits {
	readonly after: ReadonlyMap<string, Family>
	readonly settling: boolean
}

/** Nothing: a column filled on entering its row. */
const waitsNothing: Waits = { after: new Map(), settling: false }

/** Every wait of both. */
const both = (a: Waits, b: Waits): Waits => ({
	after: new Map([...a.after, ...b.after]),
	settling: a.settling || b.settling
})

/** A column as the layout first lays it out: its waits by its rule alone, before its reads are known. */
interface Entry {
	readonly column: NativeColumn
	readonly name: string
	readonly type: ScalarType
	readonly rule: FillRule
	readonly writer: FillWriter
	/** A sequence's last copy waits on that sequence's members, a counted family's on its settling, any other nothing. */
	readonly own: Waits
}

/** Who fills a family's columns: the walk a sequence's, the family's own fill a counted family's. */
const writerOf = (f: Family): FillWriter =>
	isSequence(f) ? { kind: "walk" } : { kind: "counted", family: f }

/** The first law of the pair of `family`'s `axis` whose source is `from` and target `to`. */
const pairLaw = (
	family: Family,
	axis: "owner" | "predecessor" | "last",
	from: NativeColumn,
	to: NativeColumn
): LawId => {
	const pair = family.axes[axis].find(
		(p) => keyOf(p.from) === keyOf(from) && keyOf(p.to) === keyOf(to)
	)
	if (pair === undefined) {
		throw defect(`the ${axis} axis of ${familyKey(family.id)} carries the pair it is read from`)
	}
	return pair.laws[0]
}

/** The column handle `name` of `relation`, which an expression over its row reads. */
const readColumn = (relation: LawRelation, name: string): NativeColumn => {
	const field = relation.fields.find((f) => f.name === name)
	if (field === undefined) {
		throw defect(`a field ${relation.name}.${name} an expression over its row reads`)
	}
	return fieldColumn(field)
}

/** The row's own columns a rule reads. */
const readsOfRule = (relation: LawRelation, rule: FillRule): ReadonlyArray<NativeColumn> => {
	switch (rule.kind) {
		case "self":
		case "own":
			return [rule.to]
		case "after":
			return [
				...rule.befores,
				...(rule.x === undefined ? [] : [rule.x]),
				...rule.fold.where.flatMap((w) => readsOf(w).map((name) => readColumn(relation, name)))
			]
		case "generated":
			return readsOf(rule.expr).map((name) => readColumn(relation, name))
		case "given":
		case "owner":
		case "index":
		case "copy":
		case "count":
		case "start":
		case "end":
		case "parentStart":
		case "ownerCopy":
		case "predecessor":
		case "last":
			return []
	}
}

/** The columns of `relation` at `position`, by key, in the order a refusal meets them: its fields', its families', then
 * its position's family's. */
const entriesAt = (
	families: ReadonlyArray<Family>,
	relation: LawRelation,
	position: FillPosition
): ReadonlyMap<string, Entry> => {
	const entries = new Map<string, Entry>()
	const set = (
		column: NativeColumn,
		type: ScalarType,
		rule: FillRule,
		writer: FillWriter
	): void => {
		const own: Waits =
			rule.kind !== "last"
				? waitsNothing
				: isSequence(rule.family)
					? { after: new Map([[familyKey(rule.family.id), rule.family]]), settling: false }
					: { after: new Map(), settling: true }
		entries.set(keyOf(column), { column, name: nameOf(column), type, rule, writer, own })
	}
	const walk: FillWriter = { kind: "walk" }
	for (const field of relation.fields) {
		switch (field.writing.kind) {
			case "caller":
			case "serial":
				set(fieldColumn(field), field.type, { kind: "given" }, walk)
				break
			case "generated":
				set(fieldColumn(field), field.type, { kind: "generated", expr: field.writing.expr }, walk)
				break
			case "drawn":
			case "accumulated":
			case "retirement":
				break
		}
	}
	for (const f of families.filter((g) => g.owner.name === relation.name)) {
		set(fieldColumn(f.count), f.count.type, { kind: "count", family: f }, writerOf(f))
		for (const pair of f.axes.last) {
			if (pair.from.kind !== "field" || !isCopy(f, pair.from)) {
				continue
			}
			const base = baseLiteral(f, pair.from)
			if (base === undefined) {
				throw defect(`the start of ${pair.from.field.name}, a copy along a last axis`)
			}
			set(
				pair.from,
				pair.from.field.type,
				{ kind: "last", family: f, to: pair.to, base, law: pair.laws[0] },
				writerOf(f)
			)
		}
	}
	if (position.kind === "top") {
		return entries
	}
	const f = position.family
	const root = position.kind === "root"
	const writer = writerOf(f)
	for (const g of f.group) {
		set(
			fieldColumn(g.member),
			g.member.type,
			root
				? { kind: "self", to: fieldColumn(g.owner) }
				: { kind: "owner", to: fieldColumn(g.owner) },
			walk
		)
	}
	set(
		f.index,
		f.index.kind === "field" ? f.index.field.type : f.count.type,
		{ kind: "index" },
		writer
	)
	set({ kind: "law", column: f.copy }, f.count.type, { kind: "copy" }, writer)
	if (f.members.kind === "tree") {
		const t = f.members
		set(fieldColumn(t.start), t.start.type, { kind: "start" }, walk)
		set(fieldColumn(t.end), t.end.type, { kind: "end" }, walk)
		set({ kind: "law", column: t.parentStart }, t.start.type, { kind: "parentStart" }, walk)
		if (!root) {
			set(fieldColumn(t.root), t.root.type, { kind: "owner", to: fieldColumn(t.root) }, walk)
		}
	}
	const typeOf = (column: NativeColumn): ScalarType => {
		const type = familyColumnType(f, column)
		if (type === undefined) {
			throw defect(`the type of ${nameOf(column)}, a column ${familyKey(f.id)} fills`)
		}
		return type
	}
	for (const pair of f.axes.owner) {
		if (!isCopy(f, pair.from)) {
			continue
		}
		const law = pair.laws[0]
		set(
			pair.from,
			typeOf(pair.from),
			root ? { kind: "own", to: pair.to, law } : { kind: "ownerCopy", family: f, to: pair.to, law },
			writer
		)
	}
	for (const pair of f.axes.predecessor) {
		if (!isCopy(f, pair.from)) {
			continue
		}
		const base = baseLiteral(f, pair.from)
		if (base === undefined) {
			throw defect(`the start of ${nameOf(pair.from)}, a copy along a predecessor axis`)
		}
		set(
			pair.from,
			typeOf(pair.from),
			{ kind: "predecessor", family: f, to: pair.to, base, law: pair.laws[0] },
			writer
		)
	}
	for (const fold of f.folds) {
		const befores = fold.planes.map((p) => p.before)
		for (const [p, plane] of fold.planes.entries()) {
			set(
				plane.after,
				typeOf(plane.after),
				{
					kind: "after",
					family: f,
					fold,
					plane: p === 0 ? 0 : 1,
					befores,
					x: fold.step.kind === "value" ? fieldColumn(fold.step.field) : undefined,
					law: pairLaw(f, "predecessor", plane.before, plane.after)
				},
				writer
			)
		}
	}
	if (!isSequence(f)) {
		for (const g of families.filter((h) => h.member.name === relation.name && isSequence(h))) {
			for (const pair of g.axes.owner) {
				if (!isCopy(g, pair.from)) {
					continue
				}
				const type = familyColumnType(g, pair.from)
				if (type === undefined) {
					throw defect(`the type of ${nameOf(pair.from)}, a column ${familyKey(g.id)} fills`)
				}
				set(pair.from, type, { kind: "ownerCopy", family: g, to: pair.to, law: pair.laws[0] }, walk)
			}
		}
	}
	return entries
}

/** A column's refusal, before the location of the law that fills it is looked up. */
interface Unfillable {
	readonly relation: string
	readonly field: string
	readonly law: LawId
	readonly axis: FillAxis
	readonly family: Family
	readonly source: { readonly relation: string; readonly column: string }
	readonly later: FilledLater
}

/** The law that fills a column read across rows or of its own row, and the family it fills it for. */
const lawAndFamily = (
	rule: FillRule,
	position: FillPosition
): { readonly law: LawId; readonly family: Family } => {
	switch (rule.kind) {
		case "ownerCopy":
		case "predecessor":
		case "last":
		case "after":
			return { law: rule.law, family: rule.family }
		case "own":
			if (position.kind === "top") {
				throw defect("a tree root's copy of itself stands at its tree's root")
			}
			return { law: rule.law, family: position.family }
		case "given":
		case "owner":
		case "self":
		case "index":
		case "copy":
		case "count":
		case "start":
		case "end":
		case "parentStart":
		case "generated":
			throw defect(`a column filled ${rule.kind}, which reads nothing a write fills after it`)
	}
}

/** Why a column of `writer` may not read a column `read` fills: none when it may. */
const readLater = (writer: FillWriter, read: FillWriter): FilledLater | undefined =>
	read.kind === "walk" || (writer.kind === "counted" && sameFamily(writer.family, read.family))
		? undefined
		: { kind: "countedFill", family: named(read.family) }

/** A column of a draft layout: its entry, the row's own columns it reads, and everything it waits on. */
interface DraftColumn {
	readonly entry: Entry
	readonly reads: ReadonlyArray<NativeColumn>
	readonly waits: Waits
}

/**
 * One relation's layout at one position before the walk's order of its sequences is known: each column with
 * everything it waits on, by key, in the order a refusal meets them.
 */
interface Draft {
	readonly relation: TableRelation
	readonly position: FillPosition
	readonly columns: ReadonlyMap<string, DraftColumn>
}

/** One relation's draft layout at one position: its columns' waits, or the first refusal its own row gives. */
const draftAt = (
	families: ReadonlyArray<Family>,
	relation: TableRelation,
	position: FillPosition
): Result.Result<Draft, Unfillable> => {
	const entries = entriesAt(families, relation, position)
	const waited = new Map<string, Waits>()
	const visiting = new Set<string>()
	const refusal = (entry: Entry, read: NativeColumn, why: FilledLater): Unfillable => ({
		relation: relation.name,
		field: entry.name,
		...lawAndFamily(entry.rule, position),
		axis: "row",
		source: { relation: relation.name, column: nameOf(read) },
		later: why
	})
	const waitsOf = (key: string): Result.Result<Waits, Unfillable> => {
		const known = waited.get(key)
		if (known !== undefined) {
			return Result.ok(known)
		}
		const entry = entries.get(key)
		if (entry === undefined) {
			throw defect(`a column ${key} of ${relation.name} its layout holds`)
		}
		visiting.add(key)
		let waits = entry.own
		for (const read of readsOfRule(relation, entry.rule)) {
			const readKey = keyOf(read)
			const target = entries.get(readKey)
			if (target === undefined) {
				return Result.err(refusal(entry, read, { kind: "unreached" }))
			}
			if (visiting.has(readKey)) {
				return Result.err(refusal(entry, read, { kind: "cycle" }))
			}
			const why = readLater(entry.writer, target.writer)
			if (why !== undefined) {
				return Result.err(refusal(entry, read, why))
			}
			const w = waitsOf(readKey)
			if (!w.ok) {
				return w
			}
			waits = both(waits, w.value)
		}
		visiting.delete(key)
		waited.set(key, waits)
		return Result.ok(waits)
	}
	const columns = new Map<string, DraftColumn>()
	for (const [key, entry] of entries) {
		const waits = waitsOf(key)
		if (!waits.ok) {
			return waits
		}
		columns.set(key, { entry, reads: readsOfRule(relation, entry.rule), waits: waits.value })
	}
	return Result.ok({ relation, position, columns })
}

/**
 * The order the walk fills the sequences `owned` of a row in at one position: each after every sequence `before` puts
 * before it, by family key, else in the law model's order. `before` holds no cycle: fillOrder refuses the copy that
 * would close one.
 */
const walkOrder = (
	owned: ReadonlyArray<Family>,
	before: ReadonlyMap<string, ReadonlySet<string>>
): ReadonlyArray<Family> => {
	const placed = new Set<string>()
	const order: Array<Family> = []
	while (order.length < owned.length) {
		const next = owned.find(
			(f) =>
				!placed.has(familyKey(f.id)) &&
				[...(before.get(familyKey(f.id)) ?? [])].every((g) => placed.has(g))
		)
		if (next === undefined) {
			throw defect("the walk's order of a row's sequences holds no cycle")
		}
		placed.add(familyKey(next.id))
		order.push(next)
	}
	return order
}

/** A draft layout's columns at their stages, its sequences in the walk's order `order`: see the module's header. */
const layoutOf = (
	families: ReadonlyArray<Family>,
	draft: Draft,
	order: ReadonlyArray<Family>
): FillLayout => {
	const rank = (f: Family): number => order.findIndex((g) => sameFamily(f, g))
	const stageOf = (waits: Waits): FillStage => {
		if (waits.settling) {
			return { kind: "settling" }
		}
		let last: Family | undefined
		for (const f of waits.after.values()) {
			if (last === undefined || rank(f) > rank(last)) {
				last = f
			}
		}
		return last === undefined ? { kind: "entering" } : { kind: "after", family: last }
	}
	const counted = families.filter((f) => f.owner.name === draft.relation.name && !isSequence(f))
	return Object.freeze({
		relation: draft.relation,
		position: draft.position,
		columns: Object.freeze(
			[...draft.columns.values()].map(({ entry, reads, waits }) =>
				Object.freeze({
					column: entry.column,
					name: entry.name,
					type: entry.type,
					rule: entry.rule,
					reads,
					stage: stageOf(waits),
					writer: entry.writer
				})
			)
		),
		owns: Object.freeze([...order, ...counted])
	})
}

/**
 * Why a member's copy along `family`'s owner axis may not read its owner's column `target` (`later`), or the sequences
 * of the owner whose members the walk fills before `family`'s so that it may (`after`). A sequence's members are filled
 * once the walk reaches their family: after the owner's entering columns and the columns that wait on the sequences it
 * walks first, never one that waits on their own family's members. A counted family's are filled after their owner's
 * row is written whole, its own count among it, which it knows before its members, but before its own ends.
 */
const ownerLater = (
	family: Family,
	target: DraftColumn
):
	| { readonly kind: "later"; readonly later: FilledLater }
	| { readonly kind: "after"; readonly families: ReadonlyArray<Family> } => {
	const writer = target.entry.writer
	if (writer.kind === "counted") {
		if (!sameFamily(writer.family, family)) {
			return { kind: "later", later: { kind: "countedFill", family: named(writer.family) } }
		}
		return target.entry.rule.kind === "count"
			? { kind: "after", families: [] }
			: { kind: "later", later: { kind: "afterMembers" } }
	}
	if (!isSequence(family)) {
		return { kind: "after", families: [] }
	}
	return target.waits.after.has(familyKey(family.id)) || target.waits.settling
		? { kind: "later", later: { kind: "afterMembers" } }
		: { kind: "after", families: [...target.waits.after.values()] }
}

/** Whether a read across rows of a column `target` fills is one a column of `family`'s fill may make. */
const acrossLater = (family: Family, target: DraftColumn): FilledLater | undefined =>
	readLater(
		isSequence(family) ? { kind: "walk" } : { kind: "counted", family },
		target.entry.writer
	)

/** The first relation, by the order families are stated in, that no write fills: see the module's header. */
const unwritable = (
	families: ReadonlyArray<Family>
):
	| { readonly relation: string; readonly family: Family; readonly cause: UnwritableCause }
	| undefined => {
	const nests = families.filter((f) => isSequence(f) && !isTreeOf(f, f.owner.name))
	/** The sequence a relation's rows are nested in, its tree's aside: a relation is a member of at most one. */
	const nestedIn = (relation: string): Family | undefined =>
		nests.find((f) => f.member.name === relation)
	for (const start of nests) {
		const cycle: [Family, ...Array<Family>] = [start]
		const seen = new Set<string>()
		for (let at = start.owner.name; at !== start.member.name;) {
			const up = nestedIn(at)
			if (up === undefined || seen.has(at)) {
				break
			}
			seen.add(at)
			cycle.push(up)
			at = up.owner.name
		}
		const closed = lastNonEmpty(cycle).owner.name === start.member.name
		if (closed) {
			return {
				relation: start.member.name,
				family: start,
				cause: { kind: "nestingCycle", families: cycle.toReversed().map(named) }
			}
		}
	}
	return undefined
}

/**
 * The fill order of the law model's `families`, or the first column or relation no write fills, refused at the
 * location of the law that states it (`laws`): see the module's header.
 */
export const fillOrder = (
	families: ReadonlyArray<Family>,
	laws: ReadonlyArray<TheoryLaw>
): Result.Result<FillOrder, CompileError> => {
	const locOf = (law: LawId): SourceLoc => {
		const found = laws.find((l) => l.id === law)
		if (found === undefined) {
			throw defect(`the law ${law} a family's fill names`)
		}
		return found.loc
	}
	const familyLoc = (f: Family): SourceLoc => {
		const found = laws.find(
			(l) =>
				(l.detail.kind === "family" || l.detail.kind === "tree") &&
				familyKey(l.detail.family.id) === familyKey(f.id)
		)
		if (found === undefined) {
			throw defect(`the law of the family ${familyKey(f.id)}`)
		}
		return found.loc
	}
	const refused = (u: Unfillable): Result.Result<FillOrder, CompileError> =>
		Result.err(
			CompileError.make({
				_tag: "UnfillableField",
				at: locOf(u.law),
				relation: u.relation,
				field: u.field,
				law: u.law,
				axis: u.axis,
				family: named(u.family),
				source: u.source,
				later: u.later
			})
		)
	const none = unwritable(families)
	if (none !== undefined) {
		return Result.err(
			CompileError.make({
				_tag: "UnwritableRelation",
				at: familyLoc(none.family),
				relation: none.relation,
				cause: none.cause
			})
		)
	}
	const relations = new Map<string, TableRelation>()
	for (const f of families) {
		relations.set(f.owner.name, f.owner)
		relations.set(f.member.name, f.member)
	}
	const drafts = new Map<string, Draft>()
	for (const [name, relation] of relations) {
		for (const position of positionsOf(families, name)) {
			const built = draftAt(families, relation, position)
			if (!built.ok) {
				return refused(built.error)
			}
			drafts.set(layoutKey(name, position), built.value)
		}
	}
	const columnAt = (relation: string, position: FillPosition, to: NativeColumn) => {
		const draft = drafts.get(layoutKey(relation, position))
		if (draft === undefined) {
			throw defect(`the layout of ${relation} at a position it stands at`)
		}
		return draft.columns.get(keyOf(to))
	}
	/** Each layout's sequences the walk fills before each of its sequences, by layout key and then family key: what the
	 * copies its members take of it wait on. */
	const before = new Map<string, Map<string, Set<string>>>()
	/** Whether, in the layout at `at`, the walk must fill `from`'s members before `to`'s, through the order so far. */
	const precedes = (at: string, from: string, to: string): boolean => {
		const order = before.get(at)
		const seen = new Set<string>()
		const pending = [to]
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			if (next === from) {
				return true
			}
			for (const g of order?.get(next) ?? []) {
				if (!seen.has(g)) {
					seen.add(g)
					pending.push(g)
				}
			}
		}
		return false
	}
	for (const draft of drafts.values()) {
		for (const { entry } of draft.columns.values()) {
			const rule = entry.rule
			const refusal = (
				axis: "owner" | "predecessor" | "last",
				family: Family,
				law: LawId,
				source: { readonly relation: string; readonly to: NativeColumn },
				later: FilledLater
			): Unfillable => ({
				relation: draft.relation.name,
				field: entry.name,
				law,
				axis,
				family,
				source: { relation: source.relation, column: nameOf(source.to) },
				later
			})
			if (rule.kind === "ownerCopy") {
				const owner = rule.family.owner.name
				const source = { relation: owner, to: rule.to }
				for (const position of walkPositionsOf(families, owner)) {
					const target = columnAt(owner, position, rule.to)
					const read =
						target === undefined
							? ({ kind: "later", later: { kind: "unreached" } } as const)
							: ownerLater(rule.family, target)
					if (read.kind === "later") {
						return refused(refusal("owner", rule.family, rule.law, source, read.later))
					}
					const at = layoutKey(owner, position)
					const to = familyKey(rule.family.id)
					for (const g of read.families) {
						const from = familyKey(g.id)
						if (precedes(at, to, from)) {
							return refused(
								refusal("owner", rule.family, rule.law, source, { kind: "afterMembers" })
							)
						}
						const order = before.get(at) ?? new Map<string, Set<string>>()
						const after = order.get(to) ?? new Set<string>()
						after.add(from)
						order.set(to, after)
						before.set(at, order)
					}
				}
			}
			if (rule.kind === "predecessor" || rule.kind === "last") {
				const member = rule.family.member.name
				const target = columnAt(member, { kind: "member", family: rule.family }, rule.to)
				const later =
					target === undefined ? { kind: "unreached" as const } : acrossLater(rule.family, target)
				if (later !== undefined) {
					return refused(
						refusal(rule.kind, rule.family, rule.law, { relation: member, to: rule.to }, later)
					)
				}
			}
		}
	}
	const layouts = new Map<string, FillLayout>()
	for (const [key, draft] of drafts) {
		const owned = families.filter((f) => f.owner.name === draft.relation.name && isSequence(f))
		layouts.set(
			key,
			layoutOf(families, draft, walkOrder(owned, before.get(key) ?? new Map<string, Set<string>>()))
		)
	}
	return Result.ok(Object.freeze({ families, layouts }))
}
