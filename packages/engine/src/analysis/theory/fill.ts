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
 * size, which the nesting's shape gives before any member is filled. A tree root's copies along its owner axis are that
 * axis's base, each its copy's start, as a sequence's first slot is its predecessor axis's: the root has no parent to
 * copy, and no containment riding the axis states anything of it.
 *
 * A copy across rows may read a column that reads the copy back through its row, a generated field over it among them:
 * a predecessor copy of such a column is a chain along the family's slots, and a tree node's copy of its parent's along
 * the tree's depth, each a left fold whose step is that column's rule over its row. The walk fills it one member after
 * another, each copy reading the row before it filled whole, and a family's scan draws it by recursion over its group's
 * slots (write/family/scan.ts).
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
 * family over its own relation among them, so no row of the cycle is written first. And a unit no delete removes whole:
 * families, ordered or counted, that nest relations in a cycle below a unit's root, a relation that owns a family and
 * is no family's member, whose delete removes every row nested under its rows (write/frontend/compile.ts unitBelow),
 * which no cycle lets it order owner by owner. A tree's own recursion is no cycle: each of its nodes is nested under
 * its parent.
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
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { lastNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { FamilyName, FilledLater, FillAxis, UnwritableCause } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { fieldReads } from "#compiler/ir/expr.ts"
import {
	baseLiteral,
	type AxisKind,
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
	columnKey,
	familyKey,
	type LawField,
	type LawRelation,
	type NativeColumn,
	type TableRelation,
	fieldColumn
} from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/**
 * `fields` of `relation`, then every field a generated one among them reads, transitively, each once: every field the
 * host needs of a row to evaluate again each generated field it reads of it.
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
		for (const name of fieldReads([field.writing.expr])) {
			if (held.has(name)) {
				continue
			}
			const input = relation.fields.find((f) => f.name === name)
			if (input === undefined) {
				defect(`the field ${name} of ${relation.name} a generated field reads`)
			}
			held.add(name)
			out.push(input)
			pending.push(input)
		}
	}
	return out
}

/** A native column's identity within its relation: a field by its name, a law column by its identifier. */

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
const pairLaw = (family: Family, axis: AxisKind, from: NativeColumn, to: NativeColumn): LawId => {
	const pair = family.axes[axis].find(
		(p) => columnKey(p.from) === columnKey(from) && columnKey(p.to) === columnKey(to)
	)
	if (pair === undefined) {
		defect(`the ${axis} axis of ${familyKey(family.id)} carries the pair it is read from`)
	}
	return pair.laws[0]
}

/** The column handle `name` of `relation`, which an expression over its row reads. */
const readColumn = (relation: LawRelation, name: string): NativeColumn => {
	const field = relation.fields.find((f) => f.name === name)
	if (field === undefined) {
		defect(`a field ${relation.name}.${name} an expression over its row reads`)
	}
	return fieldColumn(field)
}

/** The row's own columns a rule reads. */
const readsOfRule = (relation: LawRelation, rule: FillRule): ReadonlyArray<NativeColumn> => {
	switch (rule.kind) {
		case "self":
			return [rule.to]
		case "after":
			return [
				...rule.befores,
				...(rule.step.kind === "value" ? [rule.step.x] : []),
				...rule.fold.where.flatMap((w) => fieldReads([w]).map((name) => readColumn(relation, name)))
			]
		case "generated":
			return fieldReads([rule.expr]).map((name) => readColumn(relation, name))
		case "given":
		case "owner":
		case "base":
		case "index":
		case "next":
		case "count":
		case "start":
		case "end":
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
		entries.set(columnKey(column), { column, name: columnKey(column), type, rule, writer, own })
	}
	const walk: FillWriter = { kind: "walk" }
	for (const field of relation.fields) {
		switch (field.writing.kind) {
			case "caller":
				set(fieldColumn(field), field.type, { kind: "given" }, walk)
				break
			case "generated":
			case "keyGenerated":
			case "drawn":
			case "accumulated":
			case "instant":
			case "place":
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
				defect(`the start of ${pair.from.field.name}, a copy along a last axis`)
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
		return generatedAt(relation, entries)
	}
	const f = position.family
	const root = position.kind === "root"
	const writer = writerOf(f)
	for (const g of root ? [] : f.group) {
		set(fieldColumn(g.member), g.member.type, { kind: "owner", to: fieldColumn(g.owner) }, walk)
	}
	set(
		f.shape.index,
		f.shape.index.kind === "field" ? f.shape.index.field.type : f.count.type,
		{ kind: "index" },
		writer
	)
	set({ kind: "law", column: f.next }, f.count.type, { kind: "next" }, writer)
	if (f.shape.kind === "tree") {
		const t = f.shape
		set(fieldColumn(t.start), t.start.type, { kind: "start" }, walk)
		set(fieldColumn(t.end), t.end.type, { kind: "end" }, walk)
		if (root) {
			set(fieldColumn(t.parent), t.parent.type, { kind: "self", to: fieldColumn(t.start) }, walk)
		}
	}
	const typeOf = (column: NativeColumn): ScalarType => {
		const type = familyColumnType(f, column)
		if (type === undefined) {
			defect(`the type of ${columnKey(column)}, a column ${familyKey(f.id)} fills`)
		}
		return type
	}
	for (const pair of f.axes.owner) {
		if (!isCopy(f, pair.from)) {
			continue
		}
		const law = pair.laws[0]
		const base = baseLiteral(f, pair.from)
		if (root && base === undefined) {
			defect(`the start of ${columnKey(pair.from)}, a copy along a tree's owner axis`)
		}
		set(
			pair.from,
			typeOf(pair.from),
			root && base !== undefined
				? { kind: "base", base, law }
				: { kind: "ownerCopy", family: f, to: pair.to, law },
			writer
		)
	}
	for (const pair of f.axes.predecessor) {
		if (!isCopy(f, pair.from)) {
			continue
		}
		const base = baseLiteral(f, pair.from)
		if (base === undefined) {
			defect(`the start of ${columnKey(pair.from)}, a copy along a predecessor axis`)
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
					step:
						fold.step.kind === "value"
							? { kind: "value", x: fieldColumn(fold.step.field) }
							: { kind: "one" },
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
					defect(`the type of ${columnKey(pair.from)}, a column ${familyKey(g.id)} fills`)
				}
				set(pair.from, type, { kind: "ownerCopy", family: g, to: pair.to, law: pair.laws[0] }, walk)
			}
		}
	}
	return generatedAt(relation, entries)
}

/**
 * `entries` with each generated field of `relation` laid out, among its fields in their order, where one fill writes
 * every column its generation reads: its rule its generation, its writer that fill (the counted family that writes one
 * of those columns, else the walk), and its own waits none, so it waits on what the columns it reads wait on (draftAt).
 * A generation reads no generated field (check/generated.ts), so every column it reads is laid out without it. A
 * generated field that reads a column this position does not lay out, or columns two counted families' fills write, no
 * fill evaluates here: PostgreSQL alone computes it, and a column here that reads it is refused as reading a column no
 * fill that writes it reaches. A key generation (ir/law.ts FieldWriting `keyGenerated`) is a column grizzle writes,
 * which PostgreSQL never computes, so it is laid out at every position: its generation reads caller fields alone, each
 * laid out wherever its row is, and it is generated so even where it is its member's group field, a flat member's own
 * key generation, never copied from its owner (its axis's foreign key and its CHECK prove the two agree).
 */
const generatedAt = (
	relation: LawRelation,
	entries: ReadonlyMap<string, Entry>
): ReadonlyMap<string, Entry> => {
	const laid = new Map<string, Entry>()
	for (const field of relation.fields) {
		const column = fieldColumn(field)
		if (field.writing.kind === "caller") {
			laid.set(
				columnKey(column),
				defined(entries.get(columnKey(column)), `the column of ${field.name}`)
			)
		}
		if (field.writing.kind !== "generated" && field.writing.kind !== "keyGenerated") {
			continue
		}
		const rule: FillRule = { kind: "generated", expr: field.writing.expr }
		const read = readsOfRule(relation, rule).map((c) => entries.get(columnKey(c)))
		const counted = new Map(
			read.flatMap((e) =>
				e?.writer.kind === "counted" ? [[familyKey(e.writer.family.id), e.writer] as const] : []
			)
		)
		const laidOut = !read.includes(undefined) && counted.size <= 1
		if (field.writing.kind === "keyGenerated" && !laidOut) {
			defect(
				`the key generation ${relation.name}.${field.name}, whose reads are caller fields every position lays out`
			)
		}
		if (laidOut) {
			laid.set(columnKey(column), {
				column,
				name: field.name,
				type: field.type,
				rule,
				writer: [...counted.values()][0] ?? { kind: "walk" },
				own: waitsNothing
			})
		}
	}
	for (const [key, entry] of entries) {
		laid.getOrInsert(key, entry)
	}
	return laid
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
const lawAndFamily = (rule: FillRule): { readonly law: LawId; readonly family: Family } => {
	switch (rule.kind) {
		case "ownerCopy":
		case "predecessor":
		case "last":
		case "after":
			return { law: rule.law, family: rule.family }
		case "given":
		case "owner":
		case "self":
		case "base":
		case "index":
		case "next":
		case "count":
		case "start":
		case "end":
			defect(`a column filled ${rule.kind}, which reads nothing a write fills after it`)
		case "generated":
			defect(
				"a generated column, laid out only where its own fill writes every column it reads, and refused at its reader"
			)
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
		...lawAndFamily(entry.rule),
		axis: "row",
		source: { relation: relation.name, column: columnKey(read) },
		later: why
	})
	/**
	 * What the column `key` waits on, its reads' waits among them, or the first refusal its reads give. `reader` is the
	 * column whose reads reached it, none for a column the layout's own order reaches first: a generated field is filled
	 * by no law, so a cycle closing at one is refused at the column that reads it, whose source it is.
	 */
	const waitsOf = (key: string, reader: Entry | undefined): Result.Result<Waits, Unfillable> => {
		const known = waited.get(key)
		if (known !== undefined) {
			return Result.ok(known)
		}
		const entry = entries.get(key)
		if (entry === undefined) {
			defect(`a column ${key} of ${relation.name} its layout holds`)
		}
		visiting.add(key)
		let waits = entry.own
		for (const read of readsOfRule(relation, entry.rule)) {
			const readKey = columnKey(read)
			const target = entries.get(readKey)
			if (target === undefined) {
				return Result.err(refusal(entry, read, { kind: "unreached" }))
			}
			if (visiting.has(readKey)) {
				return Result.err(
					entry.rule.kind === "generated"
						? refusal(
								defined(reader, `the column reading ${entry.name}, which closes a cycle`),
								entry.column,
								{ kind: "cycle" }
							)
						: refusal(entry, read, { kind: "cycle" })
				)
			}
			const why = readLater(entry.writer, target.writer)
			if (why !== undefined) {
				return Result.err(refusal(entry, read, why))
			}
			const w = waitsOf(readKey, entry)
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
		const waits = waitsOf(key, undefined)
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
			defect("the walk's order of a row's sequences holds no cycle")
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
 * row is written whole, its own count among it, which it knows before its members, but before its own ends: so a column
 * of the family's own fill that waits on its settling, an end or a generated field over one, is filled after them.
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
		return target.waits.settling
			? { kind: "later", later: { kind: "afterMembers" } }
			: { kind: "after", families: [] }
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

/**
 * A cycle of `nesting` below `root`: the families, in nesting order, whose members lead from a relation reached from
 * `root` back to itself; none where every relation below it is nested acyclically.
 */
const cycleBelow = (
	nesting: ReadonlyArray<Family>,
	root: string
): NonEmptyReadonlyArray<Family> | undefined => {
	/** The relations every way below which is walked and holds no cycle. */
	const clear = new Set<string>()
	const walk = (
		at: string,
		path: ReadonlyArray<Family>
	): NonEmptyReadonlyArray<Family> | undefined => {
		const back = path.findIndex((f) => f.owner.name === at)
		if (back >= 0) {
			const [first, ...rest] = path.slice(back)
			return first === undefined ? undefined : [first, ...rest]
		}
		if (clear.has(at)) {
			return undefined
		}
		for (const f of nesting) {
			if (f.owner.name === at) {
				const found = walk(f.member.name, [...path, f])
				if (found !== undefined) {
					return found
				}
			}
		}
		clear.add(at)
		return undefined
	}
	return walk(root, [])
}

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
	/** The families that nest one relation's rows under another's, a tree's own aside: what a unit's delete walks. */
	const nesting = families.filter((f) => !isTreeOf(f, f.member.name))
	const roots = new Set(
		families.flatMap((f) =>
			nesting.some((n) => n.member.name === f.owner.name) ? [] : [f.owner.name]
		)
	)
	for (const root of roots) {
		const cycle = cycleBelow(nesting, root)
		if (cycle !== undefined) {
			return {
				relation: root,
				family: cycle[0],
				cause: { kind: "unitCycle", root, families: cycle.map(named) }
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
			defect(`the law ${law} a family's fill names`)
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
			defect(`the law of the family ${familyKey(f.id)}`)
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
	const draftOf = (relation: string, position: FillPosition): Draft => {
		const draft = drafts.get(layoutKey(relation, position))
		if (draft === undefined) {
			defect(`the layout of ${relation} at a position it stands at`)
		}
		return draft
	}
	const columnAt = (relation: string, position: FillPosition, to: NativeColumn) =>
		draftOf(relation, position).columns.get(columnKey(to))
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
				axis: AxisKind,
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
				source: { relation: source.relation, column: columnKey(source.to) },
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
						const order = before.getOrInsertComputed(at, () => new Map<string, Set<string>>())
						const after = order.getOrInsertComputed(to, () => new Set<string>())
						after.add(from)
					}
				}
			}
			if (rule.kind === "predecessor" || rule.kind === "last") {
				const member = rule.family.member.name
				const at: FillPosition = { kind: "member", family: rule.family }
				const target = columnAt(member, at, rule.to)
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
