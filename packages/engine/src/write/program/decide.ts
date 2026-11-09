import type { CheckedEntry } from "#compiler/analysis/schema.ts"
import { contractLaw } from "#compiler/analysis/theory/description.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { LawId, ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type ExprTable, predicateTable } from "#compiler/ir/expr.ts"
import { type Family, isSequence } from "#compiler/ir/family.ts"
import {
	type FillAt,
	type FillColumn,
	type FillOrder,
	type FillPosition,
	type FillRule,
	layoutKey
} from "#compiler/ir/fill.ts"
import { type FamilyId, familyKey, type LawRelation, type RelationInfo } from "#compiler/ir/law.ts"
import {
	baseOf,
	contractOf,
	type PatternSource,
	type ScalarType,
	spanOf
} from "#compiler/ir/scalar.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type {
	Binding,
	CountedFamily,
	FamilyNames,
	FreshOwner,
	FreshStratum,
	JudgedRelation,
	MemberAt,
	NestedAt,
	NestedOwner,
	OwnedColumn
} from "#compiler/runtime/write/binding.ts"
import {
	type ClosedRows,
	type ColumnKey,
	columnKey,
	type Evaluation,
	fieldKey,
	type FillColumnData,
	type FillFamily,
	type FillLayoutData,
	type FillRelation,
	type FillRuleData,
	type HostFill
} from "#compiler/runtime/write/fill.ts"
import type { NestedLayoutData } from "#compiler/runtime/write/nesting.ts"
import type { GroupData, InputData, SlotData } from "#compiler/runtime/write/normalize.ts"
import type {
	CheckTest,
	LawCheckData,
	WitnessAction,
	WitnessData,
	WitnessEntry,
	WitnessField,
	WitnessTable
} from "#compiler/runtime/write/witness.ts"
import { irLiteral } from "#compiler/scalar/compute/literal.ts"
import { tablePatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import { headingData, nestingData } from "#compiler/write/family/nesting.ts"
import { endColumns, laidLayout, rowLayout } from "#compiler/write/family/statements.ts"
import type {
	EnumeratedInput,
	MemberSlot,
	SlotGroup,
	WriteFrontend,
	WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import { type Proposal, proposalOf } from "#compiler/write/insert/statement.ts"

/** Whether a stratum's family statements are its additions and removals, computed in SQL within the call's flight
 * (write/family/additions.ts, removals.ts), rather than planned on the host from a read flight. */
const familyWrittenInFlight = (frontend: WriteFrontend, stratum: StratumAt): boolean =>
	defined(frontend.ir.strata[stratum], "a stratum").family.some(
		({ node }) => node.kind === "additions" || node.kind === "removals"
	)

/** Which facts of a slot of `stratum` the statement that writes them proposes: its action's INSERT's, by the
 * relation and serial class it inserts (insert/statement.ts proposalOf); every one for any other, a put's, a
 * deletion's, or a family member's, which its family's statements write. */
const proposalAt = (frontend: WriteFrontend, stratum: StratumAt, slot: ParamId): Proposal => {
	for (const action of frontend.ir.strata[stratum]?.actions ?? []) {
		if (action.source.kind !== "described" && action.source.slot === slot) {
			return action.op === "insert" ? proposalOf(action.info.relation, action.serial) : "every"
		}
	}
	return "every"
}

/** The slots of an owner relation in a stratum that carry its counts and ends: a plain insert's or an enumerated
 * put's that starts them (frontend/compile.ts EnumeratedInput "single"), and a nested insert's. */
export const ownerSlots = (
	frontend: WriteFrontend,
	stratum: StratumAt,
	relation: string
): ReadonlyArray<ParamId> =>
	frontend.slots
		.filter((g) => g.stratum === stratum && g.relation.name === relation)
		.flatMap((g) =>
			g.inputs.flatMap((input) =>
				(input.kind === "single" && input.act.op !== "delete" && input.starts.length > 0) ||
				input.kind === "nested"
					? [input.slot.slot]
					: []
			)
		)

/** Where the nested writes of `stratum` stand the rows of `relation`: the first that fills them, none where none does. */
const nestedOwner = (
	frontend: WriteFrontend,
	stratum: StratumAt,
	relation: string
): NestedOwner => {
	for (const n of frontend.nested) {
		const at = n.stratum === stratum ? n.nesting.layouts.get(relation) : undefined
		if (at !== undefined) {
			return { kind: "at", position: fillAtOf(at.position) }
		}
	}
	return { kind: "none" }
}

/**
 * Each stratum written in the call's flight (`familyWrittenInFlight`), as its fresh owners are counted (binding.ts
 * FreshStratum): its edits' insert and put slots, every counted family whose member relation those slots or the
 * stratum's nested writes reach, and each of their owners, with the slots that insert it and where its nested rows
 * stand.
 */
const freshStrata = (frontend: WriteFrontend): ReadonlyArray<FreshStratum> => {
	const families = frontend.laws.families
	return strataAt(frontend.ir.strata).flatMap(([stratum]): ReadonlyArray<FreshStratum> => {
		if (!familyWrittenInFlight(frontend, stratum)) {
			return []
		}
		const appended = frontend.edits.flatMap((e) =>
			e.stratum === stratum
				? [e.inserts, e.puts].flatMap((slot) =>
						slot === undefined ? [] : [{ relation: e.relation.name, slot }]
					)
				: []
		)
		const nestedRelations = new Set(
			frontend.nested.flatMap((n) => (n.stratum === stratum ? [...n.nesting.layouts.keys()] : []))
		)
		const reached = families.filter(
			(f) =>
				!isSequence(f) &&
				(appended.some((a) => a.relation === f.member.name) || nestedRelations.has(f.member.name))
		)
		const owners = new Map<string, FreshOwner>()
		for (const { owner } of reached) {
			if (owners.has(owner.name)) {
				continue
			}
			owners.set(owner.name, {
				inserting: families.some((f) => isSequence(f) && f.member.name === owner.name)
					? []
					: ownerSlots(frontend, stratum, owner.name),
				nested: nestedOwner(frontend, stratum, owner.name)
			})
		}
		return [{ stratum, appended, counted: reached.map(countedFamily), owners }]
	})
}

/** Each column of `relation` a counted family it owns draws, its count or an end, the first family that draws it in
 * the law model's order, and its count before its ends. */
const ownedColumns = (
	relation: RelationInfo,
	families: ReadonlyArray<Family>
): ReadonlyMap<ColumnKey, OwnedColumn> => {
	const owned = new Map<ColumnKey, OwnedColumn>()
	const claim = (key: ColumnKey, column: OwnedColumn): void => {
		if (!owned.has(key)) {
			owned.set(key, column)
		}
	}
	for (const family of families) {
		if (family.owner.name !== relation.name || isSequence(family)) {
			continue
		}
		const counted = countedFamily(family)
		claim(fieldKey(family.count.name), { kind: "count", family: counted })
		for (const end of endColumns(family)) {
			if (end.writing.kind === "accumulated") {
				claim(fieldKey(end.name), {
					kind: "end",
					family: counted,
					name: end.name,
					type: end.type,
					start: end.writing.start
				})
			}
		}
	}
	return owned
}

/** Every relation whose stated rows a write judges, by name: each it writes and each its slot groups state. */
const judgedRelations = (frontend: WriteFrontend): ReadonlyMap<string, JudgedRelation> => {
	const families = frontend.laws.families
	const judged = new Map<string, JudgedRelation>()
	for (const relation of [...frontend.written, ...frontend.slots.map((g) => g.relation)]) {
		if (!judged.has(relation.name)) {
			judged.set(relation.name, {
				stated: relation.fields.flatMap((f) =>
					f.writing.kind === "caller" || f.writing.kind === "serial" ? [f.name] : []
				),
				primary: mapNonEmpty(relation.primaryFields, (f) => f.name),
				layout: laidLayout(rowLayout(relation, families)),
				owned: ownedColumns(relation, families)
			})
		}
	}
	return judged
}

/** A family's id as a binding holds it, a record of its owner and count alone. */
const familyIdOf = (id: FamilyId): FamilyId => ({ owner: id.owner, count: id.count })

/** A position as a binding holds it (ir/fill.ts FillAt), its family by its id. */
const fillAtOf = (position: FillPosition): FillAt =>
	position.kind === "top"
		? { kind: "top" }
		: { kind: position.kind, family: { id: familyIdOf(position.family.id) } }

/** A counted family as a binding holds it (binding.ts CountedFamily). */
const countedFamily = (family: Family): CountedFamily => ({
	id: familyIdOf(family.id),
	owner: family.owner.name,
	member: family.member.name,
	count: family.count.name,
	ends: endColumns(family).map((f) => f.name),
	group: mapNonEmpty(family.group, (g) => ({
		member: { name: g.member.name, type: g.member.type },
		owner: { name: g.owner.name, type: g.owner.type }
	}))
})

/** A relation as a fill's data holds it (fold.ts FillRelation). */
const fillRelation = (relation: LawRelation): FillRelation => ({
	name: relation.name,
	fields: relation.fields.map((f) => ({ name: f.name, type: f.type })),
	keys: relation.keyNames.map((k) => mapNonEmpty(k.fields, (f) => f.name))
})

/** A family as a fill's data holds it (fold.ts FillFamily). */
const fillFamily = (family: Family): FillFamily => ({
	id: familyIdOf(family.id),
	count: family.count.name,
	member: family.member.name,
	tree: family.members.kind === "tree" && family.member.name === family.owner.name
})

/** A fill rule as data (fold.ts FillRuleData): a tree root's parent (`self`) is its own column, as `own` is. */
const ruleData = (rule: FillRule): FillRuleData => {
	switch (rule.kind) {
		case "given":
		case "index":
		case "copy":
		case "start":
		case "end":
		case "parentStart":
			return { kind: rule.kind }
		case "owner":
		case "ownerCopy":
			return { kind: rule.kind, to: columnKey(rule.to) }
		case "self":
		case "own":
			return { kind: "own", to: columnKey(rule.to) }
		case "count":
			return { kind: "count", family: familyIdOf(rule.family.id) }
		case "predecessor":
			return { kind: "predecessor", to: columnKey(rule.to), base: rule.base }
		case "last":
			return {
				kind: "last",
				family: familyIdOf(rule.family.id),
				to: columnKey(rule.to),
				base: rule.base
			}
		case "after":
			return {
				kind: "after",
				family: familyIdOf(rule.family.id),
				fold: { monoid: rule.fold.monoid, where: rule.fold.where.map(predicateTable) },
				plane: rule.plane,
				befores: rule.befores.map(columnKey),
				x: rule.x === undefined ? undefined : columnKey(rule.x)
			}
		case "generated":
			return { kind: "generated", expr: predicateTable(rule.expr) }
	}
}

/** A fill column as data (fold.ts FillColumnData). */
const columnData = (c: FillColumn): FillColumnData => ({
	key: columnKey(c.column),
	name: c.name,
	type: c.type,
	rule: ruleData(c.rule),
	stage:
		c.stage.kind === "after"
			? { kind: "after", family: familyIdOf(c.stage.family.id) }
			: { kind: c.stage.kind }
})

/** The position of a row the ChangeSet writes as no family's member. */
const topAt: FillAt = Object.freeze({ kind: "top" })

/** Where a write's walks and fresh fills start their rows: each nested write's start, and each fresh owner where its
 * slots insert it and where the stratum's nested writes stand it. */
const fillStarts = (
	frontend: WriteFrontend,
	fresh: ReadonlyArray<FreshStratum>
): ReadonlyArray<{ readonly relation: string; readonly position: FillAt }> => [
	...frontend.nested.map((n) => ({
		relation: n.nesting.relation.name,
		position: fillAtOf(n.nesting.start)
	})),
	...fresh.flatMap((s) =>
		[...s.owners].flatMap(([relation, owner]) => [
			...(owner.inserting.length > 0 ? [{ relation, position: topAt }] : []),
			...(owner.nested.kind === "at" ? [{ relation, position: owner.nested.position }] : [])
		])
	)
]

/**
 * The slice of the schema's fill order a write's fills meet (runtime/write/fill.ts HostFill): each layout from `starts`, then the
 * layout of every member of each family a met layout's rows own, in the order they are met.
 */
export const hostFillOf = (
	fill: FillOrder,
	starts: ReadonlyArray<{ readonly relation: string; readonly position: FillAt }>
): HostFill => {
	const layouts = new Map<string, FillLayoutData>()
	const relations = new Map<string, FillRelation>()
	const families = new Map<string, FillFamily>()
	const queue = [...starts]
	for (let i = 0; i < queue.length; i += 1) {
		const { relation, position } = defined(queue[i], "a fill start the write meets")
		const key = layoutKey(relation, position)
		if (layouts.has(key)) {
			continue
		}
		const layout = defined(
			fill.layouts.get(key),
			`the layout of ${relation} at a position a write's fill meets`
		)
		layouts.set(key, {
			relation: layout.relation.name,
			columns: layout.columns.map(columnData),
			owns: layout.owns.map((f) => familyIdOf(f.id))
		})
		if (!relations.has(layout.relation.name)) {
			relations.set(layout.relation.name, fillRelation(layout.relation))
		}
		for (const f of layout.owns) {
			if (!families.has(familyKey(f.id))) {
				families.set(familyKey(f.id), fillFamily(f))
			}
			queue.push({ relation: f.member.name, position: { kind: "member", family: f } })
		}
	}
	return Object.freeze({
		relations: [...relations.values()],
		families: [...families.values()],
		layouts
	})
}

/** Every expression table a fill evaluates: its generated fields' and its folds' selections'. */
const fillTables = (fill: HostFill): ReadonlyArray<ExprTable> =>
	[...fill.layouts.values()].flatMap((layout) =>
		layout.columns.flatMap((c) =>
			c.rule.kind === "generated" ? [c.rule.expr] : c.rule.kind === "after" ? c.rule.fold.where : []
		)
	)

/**
 * What a fill's evaluator reads (binding.ts Evaluation): each closed relation one of its expressions reads, as the host
 * reads it (fold.ts ClosedRows), and every admitted pattern they are checked against, each once.
 */
export const evaluationOf = (frontend: WriteFrontend, fill: HostFill): Evaluation =>
	evaluationOver(frontend, fillTables(fill), [])

/** What an evaluator over `tables` reads: each closed relation they read, as the host reads it (fold.ts ClosedRows), and
 * every admitted pattern they and `patterns` hold, each once. */
const evaluationOver = (
	frontend: WriteFrontend,
	tables: ReadonlyArray<ExprTable>,
	patterns: ReadonlyArray<PatternSource>
): Evaluation => {
	const closed = new Map<string, ClosedRows>()
	for (const table of tables) {
		for (const e of Object.values(table.exprs)) {
			if (
				(e.kind === "closedAt" || e.kind === "closedRow" || e.kind === "closedHas") &&
				!closed.has(e.relation)
			) {
				const c = defined(
					frontend.schema.closed.get(e.relation),
					`the closed relation ${e.relation} a fill's expression reads`
				)
				closed.set(e.relation, {
					heading: c.heading.map((h) => ({ name: h.name })),
					key: c.relation.primaryFields.length,
					rows: c.rows
				})
			}
		}
	}
	const distinct = new Map<string, PatternSource>()
	for (const pattern of [...tables.flatMap(tablePatterns), ...patterns]) {
		distinct.set(`${pattern.flags}\u0000${pattern.source}`, {
			source: pattern.source,
			flags: pattern.flags
		})
	}
	return Object.freeze({ closed, patterns: [...distinct.values()] })
}

/** A member slot as a binding holds it (normalize.ts SlotData). */
const slotData = (slot: MemberSlot): SlotData => ({
	slot: slot.slot,
	transport: slot.transport,
	heading: headingData(slot.heading)
})

/** An enumerated input as a binding holds it (normalize.ts InputData). */
const inputData = (input: EnumeratedInput): InputData => {
	switch (input.kind) {
		case "single":
			return {
				kind: "single",
				act: input.act,
				slot: slotData(input.slot),
				members: input.members,
				admitted: headingData(input.admitted),
				starts: input.starts
			}
		case "classed":
			return {
				kind: "classed",
				serial: input.serial,
				complete: slotData(input.complete),
				generated: slotData(input.generated),
				members: input.members
			}
		case "nested":
			return {
				kind: "nested",
				act: input.act,
				slot: slotData(input.slot),
				nesting: nestingData(input.nesting),
				reached: input.reached,
				members: input.members
			}
	}
}

/** A slot group as a binding holds it (normalize.ts GroupData). */
const groupData = (group: SlotGroup): GroupData => ({
	stratum: group.stratum,
	relation: group.relation.name,
	facts: group.facts,
	inputs: mapNonEmpty(group.inputs, inputData)
})

/** Each stratum's nested layouts (binding.ts NestedAt): each relation as the first of the stratum's nested writes that
 * fills it lays it out. */
const nestedAts = (frontend: WriteFrontend): ReadonlyArray<NestedAt> => {
	const byStratum = new Map<StratumAt, Map<string, NestedLayoutData>>()
	for (const n of frontend.nested) {
		const layouts = byStratum.get(n.stratum) ?? new Map<string, NestedLayoutData>()
		for (const [relation, at] of nestingData(n.nesting).layouts) {
			if (!layouts.has(relation)) {
				layouts.set(relation, at)
			}
		}
		byStratum.set(n.stratum, layouts)
	}
	return [...byStratum].map(([stratum, layouts]) => ({ stratum, layouts }))
}

/** A family as a row of it no statement carries is reported by (binding.ts FamilyNames). */
export const familyNames = (family: Family): FamilyNames => ({
	owner: family.owner.name,
	count: family.count.name,
	member: family.member.name
})

/** Each relation a nested write fills, by name, as the first family in the law model's order it is a member of names it
 * (binding.ts FamilyNames). */
const rowFamilies = (frontend: WriteFrontend): ReadonlyMap<string, FamilyNames> => {
	const out = new Map<string, FamilyNames>()
	for (const n of frontend.nested) {
		for (const relation of n.nesting.layouts.keys()) {
			const family = frontend.laws.families.find((f) => f.member.name === relation)
			if (family !== undefined && !out.has(relation)) {
				out.set(relation, familyNames(family))
			}
		}
	}
	return out
}

/** Each array or Stream member of the ChangeSet's Description, in its strata's order (binding.ts MemberAt). */
const membersAt = (frontend: WriteFrontend): ReadonlyArray<MemberAt> =>
	frontend.desc.strata.flatMap((s, stratum) =>
		s.members.flatMap((m): ReadonlyArray<MemberAt> => {
			const source = m.member
			return source.kind === "query"
				? []
				: [{ slot: source.slot, stratum, op: m.op, relation: m.relation, kind: source.kind }]
		})
	)

/** The levels of a type, outermost first: the type, then each contract's base. */
const levels = (t: ScalarType): ReadonlyArray<ScalarType> => {
	const base = contractOf(t)?.base
	return base === undefined ? [t] : [t, ...levels(base)]
}

/** A written relation's field as the witness reads it (witness.ts WitnessField). */
const witnessField = (f: WrittenRelation["fields"][number]): WitnessField => ({
	name: f.name,
	column: f.column,
	type: f.type,
	writing:
		f.writing.kind === "generated"
			? { kind: "generated", expr: predicateTable(f.writing.expr) }
			: { kind: f.writing.kind }
})

/**
 * Every CHECK of `relation`'s table that states laws (witness.ts LawCheckData): its row CHECKs and its containments into
 * closed relations, the law model's, each the native object the model names it by, and its spans' endpoint CHECKs of a
 * contract, which state the contract's law.
 */
const lawChecksOf = (
	frontend: WriteFrontend,
	relation: WrittenRelation
): ReadonlyArray<LawCheckData> => {
	const model = frontend.laws.constraints.flatMap((c): ReadonlyArray<LawCheckData> => {
		if (c.kind !== "constraint" || c.owner !== relation.ident) {
			return []
		}
		const native = defined(
			frontend.laws.natives.find(
				(n) =>
					n.namespace === "constraint" && n.owner === c.owner && identifierOf(n.named) === c.name
			),
			`the native object of the constraint ${c.name}, which the law model names it by`
		)
		if (native.namespace !== "constraint") {
			throw defect(`the constraint ${c.name}, a constraint native of the law model`)
		}
		const object = native.object
		const test = ((): CheckTest | undefined => {
			switch (object.kind) {
				case "TableCheck":
					return { kind: "row", predicate: predicateTable(object.predicate) }
				case "ClosedCheck": {
					const fields = object.pairs.flatMap((pair) =>
						pair.source.kind === "field"
							? [
									{
										source: { name: pair.source.field.name, type: pair.source.field.type },
										target: { name: pair.target.name, type: pair.target.type }
									}
								]
							: []
					)
					return {
						kind: "closed",
						guard: object.guard.map((g) => predicateTable(g.predicate)),
						pairs:
							fields.length === object.pairs.length && isNonEmpty(fields)
								? { kind: "fields", pairs: fields }
								: { kind: "law" },
						side: {
							key: object.side.key,
							payload: object.side.payload,
							rows: [...object.side.rows.values()]
						}
					}
				}
				case "PrimaryKey":
				case "Unique":
				case "WithoutOverlaps":
				case "ForeignKey":
				case "PeriodForeignKey":
					return undefined
			}
		})()
		return test === undefined ? [] : [{ name: c.name, laws: c.laws, test }]
	})
	const endpoints = relation.fields.flatMap((field): ReadonlyArray<LawCheckData> => {
		const span = spanOf(baseOf(field.type))
		if (span === undefined) {
			return []
		}
		return levels(span.endpoint).flatMap((level): ReadonlyArray<LawCheckData> => {
			const contract = contractOf(level)
			const law =
				contract === undefined
					? undefined
					: frontend.laws.natives
							.flatMap((n) =>
								n.namespace === "domain" && n.object.name === contract.name ? n.object.lawIds : []
							)
							.at(0)
			return contract === undefined || law === undefined
				? []
				: [
						{
							name: identifierOf(
								identity.spanCheck(relation.name, field.name, {
									kind: "endpoint",
									contract: contract.name
								})
							),
							laws: [{ law, described: contractLaw(contract.name) }],
							test: { kind: "endpoint", field: field.name, level }
						}
					]
		})
	})
	return [...model, ...endpoints]
}

/** A written relation as the witness judges its rows (witness.ts WitnessTable). */
const witnessTable = (frontend: WriteFrontend, relation: WrittenRelation): WitnessTable => {
	const families = frontend.laws.families
	return {
		name: relation.name,
		ident: relation.ident,
		fields: relation.fields.map(witnessField),
		keys: relation.keyNames.map((k) => mapNonEmpty(k.fields, (f) => f.name)),
		lawColumns: new Map(
			families.some((f) => f.member.name === relation.name)
				? rowLayout(relation, families).columns.flatMap((c) =>
						c.column.kind === "law" ? [[c.key, c.type] as const] : []
					)
				: []
		),
		checks: lawChecksOf(frontend, relation)
	}
}

/** A query entry as the witness reads it (witness.ts WitnessEntry): its head fields and its literal-fixed fields. */
const witnessEntry = (entry: CheckedEntry): WitnessEntry => ({
	entry: entry.entry,
	head: [...entry.head].map(([head, { field }]) => ({ head, field: field.name })),
	fixed: entry.fixed.flatMap((fixed) => {
		if (fixed.value.kind !== "literal") {
			return []
		}
		const carried = irLiteral(fixed.value.value, fixed.field.type)
		return carried.ok
			? [{ field: fixed.field.name, type: fixed.field.type, literal: carried.value.literal }]
			: []
	})
})

/** Each query entry a slot group writes through, by the name its facts are stated under. */
const witnessEntries = (frontend: WriteFrontend): ReadonlyMap<string, WitnessEntry> => {
	const entries = new Map<string, WitnessEntry>()
	const world = frontend.schema.world
	if (world.kind !== "role") {
		return entries
	}
	for (const group of frontend.slots) {
		const name = group.facts.name
		const write = name === group.relation.name ? undefined : world.writes.get(name)
		if (write?.kind === "rows" && !entries.has(name)) {
			entries.set(name, witnessEntry(write.writable))
		}
	}
	return entries
}

/** What the witness's judge evaluates over: every closed relation its expressions read, and every pattern its
 * expressions and its fields' types are checked against. */
const witnessEvaluation = (
	frontend: WriteFrontend,
	tables: ReadonlyArray<WitnessTable>
): Evaluation => {
	const exprs = tables.flatMap((t) => [
		...t.fields.flatMap((f) => (f.writing.kind === "generated" ? [f.writing.expr] : [])),
		...t.checks.flatMap(({ test }) =>
			test.kind === "row" ? [test.predicate] : test.kind === "closed" ? test.guard : []
		)
	])
	return evaluationOver(frontend, exprs, [
		...tables.flatMap((t) => t.fields.flatMap((f) => typePatterns(f.type))),
		...tables.flatMap((t) =>
			t.checks.flatMap(({ test }) => (test.kind === "endpoint" ? typePatterns(test.level) : []))
		)
	])
}

/** What the host judges a write's refused statements by (witness.ts WitnessData). */
const witnessData = (frontend: WriteFrontend): WitnessData => {
	const tables = frontend.written.map((r) => witnessTable(frontend, r))
	const theory = frontend.laws.theory.laws
	const lawOrder = new Map<LawId, number>()
	for (const table of tables) {
		for (const check of table.checks) {
			for (const { law } of check.laws) {
				lawOrder.set(
					law,
					theory.findIndex((l) => l.id === law)
				)
			}
		}
	}
	return Object.freeze({
		tables,
		actions: frontend.ir.strata.map((stratum) =>
			stratum.actions.map((action): WitnessAction => ({
				relation: action.info.relation.name,
				source:
					action.source.kind === "described"
						? { kind: "described" }
						: { kind: "slot", slot: action.source.slot }
			}))
		),
		entries: witnessEntries(frontend),
		lawOrder,
		evaluation: witnessEvaluation(frontend, tables)
	})
}

/**
 * The binding of a compiled write (runtime/write/binding.ts Binding): every judgment binding one application takes from
 * the law model, decided once over the write's front end, and the slice of the schema's fill order and closed relations
 * its fills read.
 */
export const decideBinding = (frontend: WriteFrontend): Binding => {
	const fresh = freshStrata(frontend)
	const fill = hostFillOf(frontend.laws.theory.fill, fillStarts(frontend, fresh))
	return Object.freeze({
		members: membersAt(frontend),
		groups: frontend.slots.map(groupData),
		nested: nestedAts(frontend),
		rowFamilies: rowFamilies(frontend),
		proposals: new Map(
			[...frontend.slotsById].map(
				([slot, at]) => [slot, proposalAt(frontend, at.group.stratum, slot)] as const
			)
		),
		fresh,
		judged: judgedRelations(frontend),
		fill,
		evaluation: evaluationOf(frontend, fill),
		witness: witnessData(frontend)
	})
}
