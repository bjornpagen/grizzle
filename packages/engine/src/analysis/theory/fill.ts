/**
 * The fill order of a schema's families (ir/fill.ts), built once when the schema compiles, and every column no write
 * can fill refused there, so a schema `grizzle generate` accepts is one every write of fills.
 *
 * Each relation a family reaches is laid out at every position a row of it can stand at: written by the ChangeSet
 * itself, a tree's root, or a family's member. Each column grizzle writes there gets its rule (how it is filled), the
 * columns of its own row it reads, its writer (the nested walk, or a counted family's own fill) and its stage, the
 * latest of its own and its reads': a copy along a sequence's last axis, a fold's end over it among them, is filled on
 * leaving the row, after its members; a counted family's end on settling it, after the counted family's own members;
 * every other column on entering it. A tree's interval is drawn on entering, its end its start plus its subtree's size,
 * which the nesting's shape gives before any member is filled.
 *
 * Refused, as UnfillableField, a column that reads a source its write fills after it:
 * - along a sequence's owner axis, an owner's column filled on leaving it: the walk fills a sequence's members between
 *   their owner's entering and leaving;
 * - along a counted family's owner axis, the owner's end of that family's own fold: a counted family's members are
 *   filled after their owner's row is written whole, but before their own family's ends;
 * - anywhere, a column a counted family fills (its count and its ends) read by the walk or by another family's fill:
 *   each counted family fills on its own, from its owner's row as the walk left it, and only its own members, its own
 *   copies of its count and its own ends read what it fills;
 * - a column whose row's own columns read it back in a cycle, or that reads a column no fill that writes it reaches.
 *
 * Refused, as UnwritableRelation, a relation no write fills: a counted family's member that is also a sequence's
 * member, a tree's or its owner, since a sequence's members are written nested and a counted family's are rows of their
 * own; and sequences that nest each other in a cycle, an ordered family over its own relation among them, so no row of
 * the cycle is written first. A tree's own recursion is no cycle: each of its nodes is nested under its parent.
 */
import { familyKey } from "#compiler/analysis/theory/families.ts"
import type { TheoryLaw } from "#compiler/analysis/theory/laws.ts"
import type { FamilyName, FilledLater, FillAxis, UnwritableCause } from "#compiler/core/causes.ts"
import { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { defect } from "#compiler/core/invariant.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	baseLiteral,
	type Family,
	familyColumnType,
	isCopy,
	isSequence,
	isTreeOf
} from "#compiler/ir/family.ts"
import type {
	FillColumn,
	FillLayout,
	FillOrder,
	FillPosition,
	FillRule,
	FillStage,
	FillWriter
} from "#compiler/ir/fill.ts"
import type { LawField, LawRelation, NativeColumn } from "#compiler/ir/law.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"

/** The field names an expression reads of its row. */
export const readsOf = (expr: ScalarExpr): ReadonlyArray<string> => {
	const table = predicateTable(expr)
	return [
		...new Set(
			Object.values(table.exprs).flatMap((e) => (e.kind === "column" ? [e.column.name] : []))
		)
	]
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

/** The key of a relation's layout at a position in a FillOrder (FillOrder.layouts). */
export const layoutKey = (relation: string, position: FillPosition): string =>
	position.kind === "top"
		? `${relation}\u0000top`
		: `${relation}\u0000${position.kind}\u0000${familyKey(position.family.id)}`

/** Every position a row of `relation` stands at: a tree's root, a family's member, or the ChangeSet's own when it is
 * no family's member. */
const positionsOf = (
	families: ReadonlyArray<Family>,
	relation: string
): ReadonlyArray<FillPosition> => {
	const tree = families.find((f) => isTreeOf(f, relation))
	const memberOf = families.filter((f) => f.member.name === relation)
	return [
		...(tree === undefined ? [] : [{ kind: "root", family: tree } as const]),
		...memberOf.map((family) => ({ kind: "member", family }) as const),
		...(memberOf.length === 0 ? [{ kind: "top" } as const] : [])
	]
}

/** The order of the stages a row is filled in. */
const stageRank: { readonly [S in FillStage]: number } = { entering: 0, leaving: 1, settling: 2 }

const latest = (a: FillStage, b: FillStage): FillStage => (stageRank[a] >= stageRank[b] ? a : b)

/** A column as the layout first lays it out: its stage before its reads are known. */
interface Entry {
	readonly column: NativeColumn
	readonly name: string
	readonly type: ScalarType
	readonly rule: FillRule
	readonly writer: FillWriter
	/** Its stage by its rule alone: leaving for a sequence's last copy, settling for a counted family's, else entering. */
	readonly own: FillStage
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
		const own: FillStage =
			rule.kind === "last" ? (isSequence(rule.family) ? "leaving" : "settling") : "entering"
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
				familyColumnType(f, plane.after) ?? plane.end.type,
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

/** One relation's layout at one position: its columns' stages, or the first refusal its own row gives. */
const layoutAt = (
	families: ReadonlyArray<Family>,
	relation: LawRelation,
	position: FillPosition
): Result.Result<FillLayout, Unfillable> => {
	const entries = entriesAt(families, relation, position)
	const stages = new Map<string, FillStage>()
	const visiting = new Set<string>()
	const refusal = (entry: Entry, read: NativeColumn, why: FilledLater): Unfillable => ({
		relation: relation.name,
		field: entry.name,
		...lawAndFamily(entry.rule, position),
		axis: "row",
		source: { relation: relation.name, column: nameOf(read) },
		later: why
	})
	const stageOf = (key: string): Result.Result<FillStage, Unfillable> => {
		const known = stages.get(key)
		if (known !== undefined) {
			return Result.ok(known)
		}
		const entry = entries.get(key)
		if (entry === undefined) {
			throw defect(`a column ${key} of ${relation.name} its layout holds`)
		}
		visiting.add(key)
		let stage = entry.own
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
			const s = stageOf(readKey)
			if (!s.ok) {
				return s
			}
			stage = latest(stage, s.value)
		}
		visiting.delete(key)
		stages.set(key, stage)
		return Result.ok(stage)
	}
	const columns: Array<FillColumn> = []
	for (const [key, entry] of entries) {
		const stage = stageOf(key)
		if (!stage.ok) {
			return stage
		}
		columns.push(
			Object.freeze({
				column: entry.column,
				name: entry.name,
				type: entry.type,
				rule: entry.rule,
				reads: readsOfRule(relation, entry.rule),
				stage: stage.value,
				writer: entry.writer
			})
		)
	}
	const owned = families.filter((f) => f.owner.name === relation.name)
	return Result.ok(
		Object.freeze({
			relation,
			position,
			columns: Object.freeze(columns),
			owns: Object.freeze([...owned.filter(isSequence), ...owned.filter((f) => !isSequence(f))])
		})
	)
}

/**
 * Why a member's copy along `family`'s owner axis may not read its owner's column `target`: none when it may. A
 * sequence's members are filled on entering their owner, after its entering columns; a counted family's after its
 * owner's row is written whole, and its own count, which it knows before its members, but before its own ends.
 */
const ownerLater = (family: Family, target: FillColumn): FilledLater | undefined => {
	if (target.writer.kind === "counted") {
		if (!sameFamily(target.writer.family, family)) {
			return { kind: "countedFill", family: named(target.writer.family) }
		}
		return target.rule.kind === "count" ? undefined : { kind: "afterMembers" }
	}
	return isSequence(family) && target.stage !== "entering" ? { kind: "afterMembers" } : undefined
}

/** Whether a read across rows of a column `target` fills is one a column of `family`'s fill may make. */
const acrossLater = (family: Family, target: FillColumn): FilledLater | undefined =>
	readLater(isSequence(family) ? { kind: "walk" } : { kind: "counted", family }, target.writer)

/** The first relation, by the order families are stated in, that no write fills: see the module's header. */
const unwritable = (
	families: ReadonlyArray<Family>
):
	| { readonly relation: string; readonly family: Family; readonly cause: UnwritableCause }
	| undefined => {
	for (const c of families.filter((f) => !isSequence(f))) {
		const member = families.find((s) => isSequence(s) && s.member.name === c.member.name)
		if (member !== undefined) {
			return {
				relation: c.member.name,
				family: c,
				cause: {
					kind: "countedAndSequence",
					counted: named(c),
					sequence: named(member),
					role: "member"
				}
			}
		}
		const owner = families.find((s) => isSequence(s) && s.owner.name === c.member.name)
		if (owner !== undefined) {
			return {
				relation: c.member.name,
				family: c,
				cause: {
					kind: "countedAndSequence",
					counted: named(c),
					sequence: named(owner),
					role: "owner"
				}
			}
		}
	}
	const nests = families.filter((f) => isSequence(f) && !isTreeOf(f, f.owner.name))
	/** The sequence a relation's rows are nested in, its tree's aside: a relation is a member of at most one. */
	const nestedIn = (relation: string): Family | undefined =>
		nests.find((f) => f.member.name === relation)
	for (const start of nests) {
		const cycle: Array<Family> = [start]
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
		const closed = cycle.at(-1)?.owner.name === start.member.name
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
	const relations = new Map<string, LawRelation>()
	for (const f of families) {
		relations.set(f.owner.name, f.owner)
		relations.set(f.member.name, f.member)
	}
	const layouts = new Map<string, FillLayout>()
	for (const [name, relation] of relations) {
		for (const position of positionsOf(families, name)) {
			const built = layoutAt(families, relation, position)
			if (!built.ok) {
				return refused(built.error)
			}
			layouts.set(layoutKey(name, position), built.value)
		}
	}
	const columnAt = (relation: string, position: FillPosition, to: NativeColumn) => {
		const layout = layouts.get(layoutKey(relation, position))
		if (layout === undefined) {
			throw defect(`the layout of ${relation} at a position it stands at`)
		}
		return layout.columns.find((c) => keyOf(c.column) === keyOf(to))
	}
	for (const layout of layouts.values()) {
		for (const c of layout.columns) {
			const rule = c.rule
			const across = (
				axis: "owner" | "predecessor" | "last",
				family: Family,
				law: LawId,
				source: { readonly relation: string; readonly position: FillPosition },
				to: NativeColumn,
				why: (target: FillColumn) => FilledLater | undefined
			): Result.Result<void, Unfillable> => {
				const target = columnAt(source.relation, source.position, to)
				const filled = target === undefined ? { kind: "unreached" as const } : why(target)
				return filled === undefined
					? Result.ok(undefined)
					: Result.err({
							relation: layout.relation.name,
							field: c.name,
							law,
							axis,
							family,
							source: { relation: source.relation, column: nameOf(to) },
							later: filled
						})
			}
			const checks: ReadonlyArray<Result.Result<void, Unfillable>> =
				rule.kind === "ownerCopy"
					? positionsOf(families, rule.family.owner.name).map((position) =>
							across(
								"owner",
								rule.family,
								rule.law,
								{ relation: rule.family.owner.name, position },
								rule.to,
								(target) => ownerLater(rule.family, target)
							)
						)
					: rule.kind === "predecessor" || rule.kind === "last"
						? [
								across(
									rule.kind,
									rule.family,
									rule.law,
									{
										relation: rule.family.member.name,
										position: { kind: "member", family: rule.family }
									},
									rule.to,
									(target) => acrossLater(rule.family, target)
								)
							]
						: []
			for (const check of checks) {
				if (!check.ok) {
					return refused(check.error)
				}
			}
		}
	}
	return Result.ok(Object.freeze({ families, layouts }))
}
