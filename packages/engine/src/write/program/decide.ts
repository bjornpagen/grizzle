import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { contractLaw } from "#compiler/analysis/theory/description.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { type ExprTable, predicateTable } from "#compiler/ir/expr.ts"
import { type Family, isSequence } from "#compiler/ir/family.ts"
import {
	type FillAt,
	type FillColumn,
	type FillOrder,
	type FillPosition,
	type FillRule,
	familyDrawn,
	layoutKey
} from "#compiler/ir/fill.ts"
import {
	type FamilyId,
	familyKey,
	type RelationInfo,
	type TableRelation,
	type ColumnKey,
	columnKey,
	columnKeyOf
} from "#compiler/ir/law.ts"
import { baseOf, type ScalarType, spanOf } from "#compiler/ir/scalar.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import { witnessFields } from "#compiler/laws/model/uniques.ts"
import { recordedLaw } from "#compiler/runtime/law-entry.ts"
import {
	type Binding,
	type ComputedFields,
	type CountedFamily,
	drawableShape,
	type FamilyShares,
	type FreshOwner,
	type FreshStratum,
	type JudgedRelation,
	type MemberAt,
	type NestedAt,
	type NestedOwner,
	type OwnedColumn
} from "#compiler/runtime/write/binding.ts"
import type {
	Evaluation,
	FillColumnData,
	FillFamily,
	FillLayoutData,
	FillRelation,
	FillRuleData,
	HostFill
} from "#compiler/runtime/write/fill.ts"
import type { LaidColumn, LaidLayout } from "#compiler/runtime/write/nesting.ts"
import type { GroupData, InputData, SlotData } from "#compiler/runtime/write/normalize.ts"
import type {
	CheckTest,
	LawCheckData,
	WitnessAction,
	WitnessData,
	WitnessField,
	WitnessTable,
	WitnessUnique
} from "#compiler/runtime/write/witness.ts"
import { tablePatterns, typePatterns } from "#compiler/scalar/regex/patterns.ts"
import { derivedStatement } from "#compiler/schema/declared-entries.ts"
import {
	headingData,
	type Nesting,
	nestedLayoutData,
	nestingData
} from "#compiler/write/family/nesting.ts"
import { endColumns, laidLayout, rowLayout } from "#compiler/write/family/statements.ts"
import {
	type EnumeratedInput,
	type MemberSlot,
	type SlotGroup,
	stratumLayouts,
	type WriteFrontend,
	type WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import { type Proposal, proposalOf } from "#compiler/write/insert/statement.ts"

/** Whether a stratum writes its family members' rows, by its additions and removals (write/family/additions.ts,
 * removals.ts), beside a unit delete or with none. */
const familyWrittenInFlight = (frontend: WriteFrontend, stratum: StratumAt): boolean =>
	defined(frontend.ir.strata[stratum], "a stratum").family.some(
		({ node }) => node.kind === "additions" || node.kind === "removals"
	)

/** Which facts of a slot of `stratum` the statement that writes them proposes: its action's INSERT's, by the relation it
 * inserts (insert/statement.ts proposalOf); every one for any other, a put's, a deletion's, or a family member's, which
 * its family's statements write. */
const proposalAt = (frontend: WriteFrontend, stratum: StratumAt, slot: ParamId): Proposal => {
	for (const action of frontend.ir.strata[stratum]?.actions ?? []) {
		if (action.source.kind !== "described" && action.source.slot === slot) {
			return action.op === "insert" ? proposalOf(action.info.relation) : "every"
		}
	}
	return "every"
}

/** The slots of an owner relation in a stratum that carry its counts and ends: a plain insert's or an enumerated
 * put's that starts them (frontend/compile.ts EnumeratedInput "single"), and a nested insert's. */
const ownerSlots = (
	frontend: WriteFrontend,
	stratum: StratumAt,
	relation: StoredRelationName
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

/** Where the nested writes of `stratum` stand the rows of `relation`: where the one nesting that fills them lays them
 * out (frontend/compile.ts stratumLayouts), none where none does. */
const nestedOwner = (
	frontend: WriteFrontend,
	stratum: StratumAt,
	relation: StoredRelationName
): NestedOwner => {
	const at = stratumLayouts(frontend.nested, stratum).get(relation)
	return at === undefined
		? { kind: "none" }
		: { kind: "at", position: fillAtOf(at.layout.position) }
}

/** Each field of a relation the facts of a slot hold at one field of their top level, by the relation's field. */
type HeldFields = ReadonlyMap<string, string>

/** The fields `a` and `b` both hold at one field, the same one. */
const heldInBoth = (a: HeldFields, b: HeldFields): HeldFields =>
	new Map([...a].filter(([field, at]) => b.get(field) === at))

/**
 * The fields of each relation a nesting's facts hold rows of that every such row holds at one field of the fact's top
 * level, the nesting's own heading (runtime/write/read-call.ts nestedReads, `field`): its own relation's own fields at
 * the fact's own row, and each family's member's group fields at their owner's, along every family it reaches, shallowest
 * first, a tree's among them, to a fixpoint, so a field held at one place a relation's rows stand but not at another is
 * not held: a tree's every node holds its root fields at its root's, and none of its root's own fields beside them.
 */
const nestingHeld = (nesting: Nesting): ReadonlyMap<StoredRelationName, HeldFields> => {
	const held = new Map<StoredRelationName, HeldFields>([
		[nesting.relation.name, new Map(nesting.own.map((c) => [c.name, c.name] as const))]
	])
	const families = [
		...(nesting.root.kind === "tree" ? [nesting.root.family] : []),
		...nesting.reached.map((r) => r.family)
	]
	for (let changed = true; changed;) {
		changed = false
		for (const family of families) {
			const owner = held.get(family.owner.name)
			if (owner === undefined) {
				continue
			}
			const through = new Map(
				family.group.flatMap((g) => {
					const at = owner.get(g.owner.name)
					return at === undefined ? [] : [[g.member.name, at] as const]
				})
			)
			const known = held.get(family.member.name)
			const next = known === undefined ? through : heldInBoth(known, through)
			if (known === undefined || next.size !== known.size) {
				held.set(family.member.name, next)
				changed = true
			}
		}
	}
	return held
}

/**
 * The fields of `relation` the facts of one input of a slot group hold at one field of their top level (HeldFields),
 * none where they hold no row of it: a single input's of its own relation, each field its facts state, by the head
 * field a query entry's facts state it at; a nested input's, its nesting's (`nestingHeld`); a deletion's none.
 */
const inputHeld = (
	group: SlotGroup,
	input: EnumeratedInput,
	relation: StoredRelationName
): HeldFields | undefined => {
	switch (input.kind) {
		case "nested":
			return nestingHeld(input.nesting).get(relation)
		case "single": {
			if (group.relation.name !== relation || input.act.op === "delete") {
				return undefined
			}
			const stated = group.facts.stated
			return new Map(
				input.admitted.flatMap((c): ReadonlyArray<readonly [string, string]> => {
					if (stated.kind === "relation") {
						return [[c.name, c.name]]
					}
					const field = stated.entry.head.get(c.name)
					return field === undefined ? [] : [[field, c.name]]
				})
			)
		}
	}
}

/**
 * A counted family's groups as the facts of a stratum name them (binding.ts FamilyShares): every member slot of the
 * stratum whose facts hold rows of its owner or of its member, each with the fields its facts hold of the group's pairs
 * every such slot's facts hold (`inputHeld`), the owner's field of each at an owner's slot and the member's at a
 * member's, so an owner's facts and its members' meet at one key.
 */
const familyShares = (
	frontend: WriteFrontend,
	stratum: StratumAt,
	family: Family
): FamilyShares => {
	const holdersOf = (relation: StoredRelationName) =>
		frontend.slots.flatMap((group) =>
			group.stratum !== stratum
				? []
				: group.inputs.flatMap((input) => {
						const held = inputHeld(group, input, relation)
						return held === undefined ? [] : input.members.map((slot) => ({ slot, held }))
					})
		)
	const owners = holdersOf(family.owner.name)
	const members = holdersOf(family.member.name)
	const pairs = family.group.filter(
		(g) =>
			owners.every((h) => h.held.has(g.owner.name)) &&
			members.every((h) => h.held.has(g.member.name))
	)
	/** The fields a holder's facts hold the kept pairs at, at the pairs' `side`. */
	const fieldsOf = (held: HeldFields, side: "owner" | "member"): ReadonlyArray<string> =>
		pairs.map((g) => defined(held.get(g[side].name), "a pair every holder holds"))
	return {
		owners: owners.map((h) => ({ slot: h.slot, fields: fieldsOf(h.held, "owner") })),
		members: members.map((h) => ({ slot: h.slot, fields: fieldsOf(h.held, "member") }))
	}
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
				? e.slots.flatMap((s) =>
						s.as === "deletes" ? [] : [{ relation: e.relation.name, slot: s.slot }]
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
		const owners = new Map<StoredRelationName, FreshOwner>()
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
		const left = defined(frontend.fresh.get(stratum), `the fresh fill of stratum ${stratum}`).left
		return [
			{
				stratum,
				appended,
				counted: reached.map(countedFamily),
				fresh: new Map(
					reached.map((f) => [familyKey(f.id), freshLayoutOf(frontend, f, stratum)] as const)
				),
				shares: new Map(
					reached.map((f) => [familyKey(f.id), familyShares(frontend, stratum, f)] as const)
				),
				owners,
				left: new Map([...left].map(([relation, pending]) => [relation, { pending }] as const))
			}
		]
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
		owned.getOrInsert(key, column)
	}
	for (const family of families) {
		if (family.owner.name !== relation.name || isSequence(family)) {
			continue
		}
		const counted = countedFamily(family)
		claim(columnKeyOf(family.count.name), { kind: "count", family: counted })
		for (const end of endColumns(family)) {
			if (end.writing.kind === "accumulated") {
				claim(columnKeyOf(end.name), {
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
const judgedRelations = (
	frontend: WriteFrontend
): ReadonlyMap<StoredRelationName, JudgedRelation> => {
	const families = frontend.laws.families
	const judged = new Map<StoredRelationName, JudgedRelation>()
	for (const relation of [...frontend.written, ...frontend.slots.map((g) => g.relation)]) {
		if (!judged.has(relation.name)) {
			judged.set(relation.name, {
				stated: relation.fields.flatMap((f) =>
					f.writing.kind === "caller" || f.writing.kind === "keyGenerated" ? [f.name] : []
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

/**
 * The fresh layout of a counted family's members in `stratum` (ir/products.ts FilledRows `fresh`): each member's primary
 * key, then its group's fields its key leaves out, the owner's key it names, then every column the family draws on it
 * (`familyDrawn`), as the host draws a fresh group whole (runtime/write/bind.ts freshOwners) and the family's additions
 * statement reads the members it drew (write/family/additions.ts HostDrawn), the one layout both build their arrays by;
 * but the fields of its key and group a stamp fills, the call's one value of each, which no row the host holds holds
 * and the statement fills (write/frontend/compile.ts FreshFill `stamps`). A member's key and its group are its caller's,
 * never a column the family draws.
 */
export const freshLayoutOf = (
	frontend: WriteFrontend,
	family: Family,
	stratum: StratumAt
): LaidLayout => {
	const member = family.member
	const stamped = new Set(
		(
			defined(frontend.fresh.get(stratum), `the fresh fill of stratum ${stratum}`).stamps.get(
				member.name
			) ?? []
		).map((st) => st.field.name)
	)
	const keyNames = new Set(member.primaryFields.map((f) => f.name))
	const fieldColumn = (name: string, type: LaidColumn["type"]): LaidColumn => ({
		key: columnKeyOf(name),
		type,
		column: { kind: "field", field: { name } }
	})
	const [first, ...rest] = member.primaryFields.filter((f) => !stamped.has(f.name))
	if (first === undefined) {
		defect(`the key of ${member.name} beyond its stamps, which its fresh members are sent by`)
	}
	return Object.freeze({
		relation: member.name,
		key: mapNonEmpty([first, ...rest], (f) => fieldColumn(f.name, f.type)),
		columns: [
			...family.group.flatMap((g) =>
				keyNames.has(g.member.name) || stamped.has(g.member.name)
					? []
					: [fieldColumn(g.member.name, g.member.type)]
			),
			...familyDrawn(frontend.laws.theory.fill, member.name, family).map((c): LaidColumn =>
				c.column.kind === "field"
					? fieldColumn(c.column.field.name, c.type)
					: {
							key: columnKey(c.column),
							type: c.type,
							column: { kind: "law", column: c.column.column }
						}
			)
		]
	})
}

/** A relation as a fill's data holds it (fold.ts FillRelation). */
const fillRelation = (relation: TableRelation): FillRelation => ({
	name: relation.name,
	fields: relation.fields.map((f) => ({ name: f.name, type: f.type })),
	keys: relation.keyNames.map((k) => mapNonEmpty(k.fields, (f) => f.name))
})

/** A family as a fill's data holds it (fold.ts FillFamily). */
const fillFamily = (family: Family): FillFamily => ({
	id: familyIdOf(family.id),
	count: family.count.name,
	member: family.member.name,
	tree: family.shape.kind === "tree" && family.member.name === family.owner.name
})

/** A fill rule as data (runtime/write/fill.ts FillRuleData). */
const ruleData = (rule: FillRule): FillRuleData => {
	switch (rule.kind) {
		case "given":
		case "index":
		case "next":
		case "start":
		case "end":
			return { kind: rule.kind }
		case "owner":
		case "ownerCopy":
			return { kind: rule.kind, to: columnKey(rule.to) }
		case "self":
			return { kind: "self", to: columnKey(rule.to) }
		case "base":
			return { kind: "base", base: rule.base }
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
				step:
					rule.step.kind === "one" ? { kind: "one" } : { kind: "value", x: columnKey(rule.step.x) }
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
): ReadonlyArray<{ readonly relation: StoredRelationName; readonly position: FillAt }> => [
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
	starts: ReadonlyArray<{ readonly relation: StoredRelationName; readonly position: FillAt }>
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
		relations.getOrInsertComputed(layout.relation.name, () => fillRelation(layout.relation))
		for (const f of layout.owns) {
			families.getOrInsertComputed(familyKey(f.id), () => fillFamily(f))
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

/** The generation of each key generation a slot group's facts are filled with (write/normalize/normalize.ts
 * keyGenerations), the one list the host fills its facts' values by before it compares or sends them. */
const keyGenerationTables = (frontend: WriteFrontend): ReadonlyArray<ExprTable> =>
	frontend.slots.flatMap(({ facts }) => facts.generations.map((g) => g.generation))

/**
 * Each stratum's computed fields of each relation it inserts computing some (binding.ts ComputedFields): every field of
 * its computed record with its term lowered as the host evaluator reads it (ir/expr.ts predicateTable), and what
 * supplies its value where the host does not evaluate it: the database's clock where the term reads a parameter its
 * member binds to the clock (ir/products.ts ClockParamDecl), the statement's evaluation of the term otherwise.
 */
const computedFieldsOf = (frontend: WriteFrontend): ReadonlyArray<ComputedFields> => {
	const clocks = new Set(frontend.params.flatMap((p) => (p.kind === "clock" ? [p.id] : [])))
	return frontend.computed.map(({ stratum, relation, record }) =>
		Object.freeze({
			stratum,
			relation: defined(
				frontend.written.find((r) => r.name === relation),
				`the relation ${relation} whose rows the call computes fields of`
			).name,
			fields: record.fields.map(({ field, expr }) => {
				const term = predicateTable(expr)
				return Object.freeze({
					name: field.name,
					type: field.type,
					term,
					source: Object.values(term.exprs).some((e) => e.kind === "param" && clocks.has(e.param))
						? ("clock" as const)
						: ("call" as const)
				})
			})
		})
	)
}

/**
 * What a write's evaluator reads (binding.ts Evaluation): the name of each closed relation one of its expressions reads,
 * its fill's, its key generations' and then its computed fields' terms, and every admitted pattern they are checked
 * against, each once.
 */
export const evaluationOf = (
	frontend: WriteFrontend,
	fill: HostFill,
	computed: ReadonlyArray<ComputedFields>
): Evaluation =>
	evaluationOver(
		frontend,
		[
			...fillTables(fill),
			...keyGenerationTables(frontend),
			...computed.flatMap((c) => c.fields.map((f) => f.term))
		],
		[]
	)

/** What an evaluator over `tables` reads: the name of each closed relation they read, in the order they first read it,
 * and every admitted pattern they and `patterns` hold, each once. */
const evaluationOver = (
	frontend: WriteFrontend,
	tables: ReadonlyArray<ExprTable>,
	patterns: ReadonlyArray<PatternSource>
): Evaluation => {
	const closed = new Set<string>()
	for (const table of tables) {
		for (const e of Object.values(table.exprs)) {
			if (e.kind === "closedAt" || e.kind === "closedRow" || e.kind === "closedHas") {
				if (!frontend.schema.closed.has(e.relation)) {
					defect(`the schema holds the closed relation ${e.relation} a fill's expression reads`)
				}
				closed.add(e.relation)
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
	return Object.freeze({ closed: [...closed], patterns: [...distinct.values()] })
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

/**
 * The soundness of a write whose facts may be drawn in shares (binding.ts drawableShape), checked where its binding is
 * decided, or an internal compiler error: every law its host judges a share's facts by either reads one drawn group or
 * is refused across shares by an object the server holds. The host judges a share's facts by its same-key checks
 * (frontend/compile.ts SlotFacts `host`), by its generated fields, each one fact's, and by its counted families' fresh
 * groups, which drawShares draws whole (adapter/apply/shares.ts, the binding's own FreshStratum and CountedFamily); a
 * same-key check compares facts of two groups, so each must be a unique or span object of its relation (laws/model/
 * uniques.ts), which the later share's insert meets as stored, arbitrates or probes, and refuses as the host would. A
 * key the host alone compares would let a shared call commit two facts at one key, which the whole call refuses.
 */
export const sharedChecksBacked = (
	members: ReadonlyArray<MemberAt>,
	params: ReadonlyArray<{ readonly kind: string }>,
	slots: ReadonlyArray<Pick<SlotGroup, "relation" | "facts">>
): void => {
	if (!drawableShape(members, params)) {
		return
	}
	for (const slot of slots) {
		const uniques = slot.relation.uniques
		const objects = new Set([
			...uniques.keys.map((o) => o.law),
			...uniques.others.map((o) => o.law),
			...uniques.checks.map((c) => c.object.law)
		])
		for (const check of [...slot.facts.host.keys, ...slot.facts.host.spans]) {
			if (!objects.has(check.law)) {
				defect(
					`a write drawn in shares judges law ${check.law} of ${slot.relation.name} on the host alone: no unique or span object of the relation refuses it across shares`
				)
			}
		}
	}
}

/** Each stratum's nested layouts (binding.ts NestedAt), in the order its nested writes are first met: each relation as
 * the one nesting of the stratum that fills it lays it out (frontend/compile.ts stratumLayouts). */
const nestedAts = (frontend: WriteFrontend): ReadonlyArray<NestedAt> =>
	[...new Set(frontend.nested.map((n) => n.stratum))].map((stratum) => ({
		stratum,
		layouts: new Map(
			[...stratumLayouts(frontend.nested, stratum)].map(
				([relation, at]) => [relation, nestedLayoutData(at.layout)] as const
			)
		)
	}))

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
	const base = t.contract?.base
	return base === undefined ? [t] : [t, ...levels(base)]
}

/** A written relation's field as the witness reads it (witness.ts WitnessField): a generated field and a key generation
 * by their generations, which the judge computes, a key generation's value being its generation's, which its key's
 * CHECK proves, and which a stated row of the write also holds, the host having filled it (witness.ts hostField). */
export const witnessField = (f: RelationInfo["fields"][number]): WitnessField => ({
	name: f.name,
	column: f.column,
	type: f.type,
	writing: witnessWriting(f.writing)
})

const witnessWriting = (w: RelationInfo["fields"][number]["writing"]): WitnessField["writing"] => {
	switch (w.kind) {
		case "generated":
		case "keyGenerated":
			return { kind: w.kind, expr: predicateTable(w.expr) }
		case "caller":
		case "drawn":
		case "accumulated":
		case "instant":
		case "place":
			return { kind: w.kind }
	}
}

/**
 * Every CHECK of `relation`'s table that states laws (witness.ts LawCheckData): its row CHECKs and its containments into
 * closed relations, the law model's `laws`, each the native object the model names it by, and its spans' endpoint
 * CHECKs of a contract, which state the contract's law. The one reading of a stored relation's CHECKs, a write's
 * witness's and a public row evaluation's (program/evaluate.ts).
 */
export const lawChecksOf = (
	laws: LawModel,
	relation: Pick<RelationInfo, "ident" | "name" | "fields">
): ReadonlyArray<LawCheckData> => {
	const model = laws.constraints.flatMap((c): ReadonlyArray<LawCheckData> => {
		if (c.kind !== "constraint" || c.owner !== relation.ident) {
			return []
		}
		const native = defined(
			laws.natives.find(
				(n) =>
					n.namespace === "constraint" && n.owner === c.owner && identifierOf(n.named) === c.name
			),
			`the native object of the constraint ${c.name}, which the law model names it by`
		)
		if (native.namespace !== "constraint") {
			defect(`the constraint ${c.name}, a constraint native of the law model`)
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
			const { contract } = level
			const law =
				contract === undefined
					? undefined
					: laws.natives
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
							laws: [
								{
									law,
									described: recordedLaw(
										contractLaw(contract.name),
										laws.owned.declared.contracts.get(contract.name) ?? derivedStatement
									)
								}
							],
							test: { kind: "endpoint", field: field.name, level }
						}
					]
		})
	})
	return [...model, ...endpoints]
}

/** Every unique and exclusion object of a written relation a 23505 or 23P01 can name, each once, by its installed name:
 * its declared keys, the primary key first, and every other object (witness.ts WitnessUnique). */
const witnessUniques = (relation: WrittenRelation): ReadonlyArray<WitnessUnique> => {
	const out: Array<WitnessUnique> = []
	for (const u of [...relation.uniques.keys, ...relation.uniques.others]) {
		const fields = witnessFields(u)
		if (isNonEmpty(fields) && !out.some((o) => o.name === u.name)) {
			out.push({ name: u.name, fields: mapNonEmpty(fields, (f) => f.name) })
		}
	}
	return out
}

/** A written relation as the witness judges its rows (witness.ts WitnessTable). */
const witnessTable = (frontend: WriteFrontend, relation: WrittenRelation): WitnessTable => {
	const families = frontend.laws.families
	return {
		name: relation.name,
		ident: relation.ident,
		fields: relation.fields.map(witnessField),
		keys: relation.keyNames.map((k) => mapNonEmpty(k.fields, (f) => f.name)),
		uniques: witnessUniques(relation),
		lawColumns: new Map(
			families.some((f) => f.member.name === relation.name)
				? rowLayout(relation, families).columns.flatMap((c) =>
						c.column.kind === "law" ? [[c.key, c.type] as const] : []
					)
				: []
		),
		checks: lawChecksOf(frontend.laws, relation)
	}
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
		evaluation: witnessEvaluation(frontend, tables)
	})
}

/**
 * The binding of a compiled write (runtime/write/binding.ts Binding): every judgment binding one application takes from
 * the law model, decided once over the write's front end, and the slice of the schema's fill order and closed relations
 * its fills read.
 */
export const decideBinding = (frontend: WriteFrontend): Binding => {
	const members = membersAt(frontend)
	sharedChecksBacked(members, frontend.params, frontend.slots)
	const fresh = freshStrata(frontend)
	const fill = hostFillOf(frontend.laws.theory.fill, fillStarts(frontend, fresh))
	const computed = computedFieldsOf(frontend)
	return Object.freeze({
		members,
		groups: frontend.slots.map(groupData),
		nested: nestedAts(frontend),
		proposals: new Map(
			[...frontend.slotsById].map(
				([slot, at]) => [slot, proposalAt(frontend, at.group.stratum, slot)] as const
			)
		),
		fresh,
		judged: judgedRelations(frontend),
		computed,
		fill,
		evaluation: evaluationOf(frontend, fill, computed),
		witness: witnessData(frontend)
	})
}
