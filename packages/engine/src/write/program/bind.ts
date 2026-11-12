/**
 * The read-flight planner of a write whose family work the host plans from stored rows (`legacyFlights`), which no
 * served file holds, and a write compiled in process as binding runs it (`runnableWrite`).
 */
import { arrayTexts } from "#compiler/codec/recordset.ts"
import type { CompileError, EncodingFailure } from "#compiler/core/errors.ts"
import type { ParamId, StoredRelationName } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import { type ReadonlyTupleMap, TupleMap, TupleSet } from "#compiler/core/tuple-map.ts"
import type { Param, ParamText } from "#compiler/core/wire.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import { type Family, isTreeOf } from "#compiler/ir/family.ts"
import { familyKey, type RelationInfo } from "#compiler/ir/law.ts"
import type { LiteralBound } from "#compiler/ir/products.ts"
import type { StratumAt } from "#compiler/ir/stratum.ts"
import { columnArray } from "#compiler/runtime/write/arrays.ts"
import {
	type Chunks,
	type FamilyRowBound,
	type Flights,
	type FlightsOf,
	type GeneratedRejection,
	type PlanWrites,
	type Raw,
	type ReadStatement,
	type RunnableWrite,
	servedRunnable,
	type StatedFill,
	type StratumFill
} from "#compiler/runtime/write/bind.ts"
import type { MemberKey, Owner, Recount, Row } from "#compiler/runtime/write/draw.ts"
import { fieldKey, type GeneratedNull } from "#compiler/runtime/write/fill.ts"
import { loadWrite } from "#compiler/runtime/write/flight.ts"
import {
	type Fact,
	type FillContext,
	groupOfOwner,
	keyOf,
	type Values
} from "#compiler/runtime/write/keys.ts"
import { type NestedRow, rowOfValues } from "#compiler/runtime/write/nesting.ts"
import { type NormalizedSlot, refilledSlot } from "#compiler/runtime/write/normalize.ts"
import type { Execution } from "#compiler/runtime/write/staged.ts"
import { CompilePatterns } from "#compiler/scalar/regex/patterns.ts"
import { compose, relationDepths, type RelationPlanAt } from "#compiler/write/family/compose.ts"
import { decodeChain, decodeRead } from "#compiler/write/family/decode.ts"
import {
	callerValues,
	countRows,
	type EditedTarget,
	type EditTarget,
	encodedWrite,
	factKey,
	type FilledRow,
	foldRecounts,
	mergeStored,
	ownerGroup,
	ownersOf,
	planEdits,
	type ReadKeys,
	readKeys,
	recountValues,
	refillTree,
	type RelationChanges,
	type StoredFamily
} from "#compiler/write/family/edit.ts"
import {
	type FamilyStatement,
	type OwnerWrite,
	type Phase,
	type Plan,
	planOwners,
	planRead,
	planRelation,
	textsOf,
	type Unsendable
} from "#compiler/write/family/order.ts"
import {
	cascade,
	changedColumns,
	copyState,
	dropRow,
	holdRow,
	rowOf,
	rowsOf,
	type RowState,
	writeRow
} from "#compiler/write/family/state.ts"
import {
	type ChainSql,
	endColumns,
	type ReadShape,
	type RowLayout,
	rowLayout
} from "#compiler/write/family/statements.ts"
import type { EnumeratedInput } from "#compiler/write/frontend/compile.ts"
import type { FamilyNode } from "#compiler/write/frontend/schedule.ts"
import { isCarried } from "#compiler/write/insert/statement.ts"
import type { CompiledWrite, EditProgram, RefillProgram } from "#compiler/write/program/compile.ts"
import { closedTableOf, familyNames, ownerSlots } from "#compiler/write/program/decide.ts"
import { flightOf, servedWrite } from "#compiler/write/program/served.ts"

/** A write compiled in process as binding runs it under the installation's codes (runtime/write/bind.ts
 * RunnableWrite): its served form loaded, every statement in its one flight, or, where it has none, its projection
 * loaded, its flights the planner's over the compiled write (`legacyFlights`). */
export const runnableWrite = (compiled: CompiledWrite, codes: Codebook): RunnableWrite => {
	const served = servedWrite(compiled)
	return served.ok
		? servedRunnable(
				loadWrite(served.value, codes, closedTableOf(compiled.frontend), new CompilePatterns())
			)
		: Object.freeze({ flight: flightOf(compiled, codes), flights: legacyFlights(compiled) })
}

/**
 * The flights of a write the host plans some of whose family work from a read flight (served/unserved.ts
 * UnservedMember), over its compiled front end and what binding found (runtime/write/bind.ts Applied): a read flight
 * first where its changes name a stored member of a family, else its one flight, planned now.
 */
export const legacyFlights =
	(compiled: CompiledWrite): FlightsOf =>
	(applied) => {
		const { frontend } = compiled
		const unplanned: StatedFill = Object.freeze({ kind: "unplanned" })
		const { factsOf, fresh, form, statedRowsOf, generatedRejection, statementChunks } = applied
		const noRows: ReadonlyMap<
			StoredRelationName,
			ReadonlyTupleMap<MemberKey, NestedRow>
		> = new Map()
		/** Each relation's depth among the families, which orders a stratum's relations' statements. */
		const depthOf = relationDepths(frontend.laws.families)
		/** A member relation's row no statement carries even alone, as the first family it is a member of names it. */
		const rowBound = (relation: StoredRelationName, row: Unsendable): FamilyRowBound => ({
			_tag: "FamilyRowBound",
			family: familyNames(
				defined(
					frontend.laws.families.find((f) => f.member.name === relation),
					`a family whose member is ${relation}, which a family write writes`
				)
			),
			row
		})
		/** A stratum's nested rows planned, by relation: the rows its nested writes insert, each owner's counts and ends
		 * as its counted families' appends in the stratum left them, each row in its relation's row layout. */
		const nestedPlans = (
			stratum: StratumAt,
			nested: ReadonlyMap<StoredRelationName, ReadonlyTupleMap<MemberKey, NestedRow>>
		): Result.Result<ReadonlyArray<RelationPlanAt>, FamilyRowBound> => {
			const relations: Array<RelationPlanAt> = []
			for (const [relation, rows] of nested) {
				const layout = nestedLayout(stratum, relation)
				const inserts = new TupleMap<MemberKey, Row>()
				for (const [key, r] of rows) {
					inserts.set(key, rowOfValues(planning.codes, layout, r.values))
				}
				const planned = planRelation(
					{
						relation,
						deletes: new TupleSet<MemberKey>(),
						refills: new TupleMap<MemberKey, Row>(),
						updates: new TupleMap<MemberKey, Row>(),
						inserts
					},
					applied.transport
				)
				if (!planned.ok) {
					return Result.err(rowBound(relation, planned.error))
				}
				relations.push({ depth: depthOf(relation), plan: planned.value })
			}
			return Result.ok(relations)
		}
		const planning: FillContext = { codes: applied.codes, evaluate: frontend.evaluate }
		const factsAt = (slot: ParamId | undefined): ReadonlyArray<Fact> =>
			slot === undefined ? [] : factsOf(slot).facts
		/** The facts a stratum may insert of `relation`, by every slot of its that inserts (`insertSlots`) but a generated
		 * addition's, whose key does not exist yet, so no member names it, and every row of it a nested write of the
		 * stratum fills, a tree's nodes and a sequence's members, with every column the walk drew. An owner among them is
		 * fresh only where the read finds none stored at its key (write/family/edit.ts planEdits). */
		const insertedOf = (stratum: StratumAt, relation: StoredRelationName): ReadonlyArray<Fact> => [
			...frontend.slots
				.filter((g) => g.stratum === stratum && g.relation.name === relation)
				.flatMap((g) => g.inputs.flatMap(insertSlots))
				.flatMap((slot) => factsOf(slot).facts),
			...[...(applied.nested.get(stratum)?.get(relation)?.values() ?? [])].map((r) => r.fact)
		]
		/** An edit as one application binds it: its changes, its families' inserted owners, and each family's reads, by
		 * their positions in the read flight. */
		interface BoundEdit {
			readonly program: EditProgram
			readonly changes: RelationChanges
			readonly owners: (family: Family) => ReadonlyTupleMap<Owner, Values>
			readonly reads: ReadonlyArray<{
				readonly family: Family
				readonly shape: ReadShape
				readonly at: ReadonlyArray<number>
			}>
		}
		const reads: Array<ReadStatement> = []
		const edits: Array<BoundEdit> = []
		/** A read no statement carries even alone: the application cannot be sent, which every family step reports. */
		let unreadable: FamilyRowBound | undefined
		for (const editProgram of compiled.edits) {
			const { edit, target } = editProgram
			/** A member fact as the family planner reads it: the fields its caller states, never the counts and ends its slot
			 * carries for an owner the stratum's additions write in the flight, which the planner draws itself. */
			const stated = (fact: Fact): Fact =>
				Object.freeze(
					Object.fromEntries(
						Object.entries(fact).filter(([name]) =>
							target.relation.fields.some((f) => f.name === name && isCarried(f))
						)
					)
				)
			const changes: RelationChanges = {
				inserts: factsAt(edit.inserts).map(stated),
				puts: factsAt(edit.puts).map(stated),
				deletes: factsAt(edit.deletes),
				nested: [
					...(applied.nested.get(edit.stratum)?.get(target.relation.name)?.values() ?? [])
				].map((r) => r.values)
			}
			const known = new Map<string, ReadonlyTupleMap<Owner, Values>>()
			const owners = (family: Family): ReadonlyTupleMap<Owner, Values> => {
				const id = familyKey(family.id)
				const had = known.get(id)
				if (had !== undefined) {
					return had
				}
				const found = ownersOf(planning, family, insertedOf(edit.stratum, family.owner.name))
				known.set(id, found)
				return found
			}
			const familyReads: Array<BoundEdit["reads"][number]> = []
			for (const read of editProgram.reads) {
				const touched = readKeys(planning, target, read.family, changes)
				const at: Array<number> = []
				if (touched !== undefined) {
					const parts = planRead(
						touched.keys,
						touched.groups,
						{ key: target.layout.key.length, group: read.family.group.length },
						applied.transport
					)
					if (!parts.ok) {
						unreadable ??= rowBound(target.relation.name, parts.error)
					} else {
						for (const part of parts.value) {
							at.push(reads.length)
							reads.push({
								family: read.family.id,
								text: read.sql.text,
								params: [
									...readLiterals(target.relation.name, part.keys, target.layout.key.length),
									...readLiterals(target.relation.name, part.groups, read.family.group.length)
								]
							})
						}
					}
				}
				familyReads.push({ family: read.family, shape: read.sql.shape, at })
			}
			edits.push({ program: editProgram, changes, owners, reads: familyReads })
		}
		/** A refill as one application binds it: its program, and each of its reads with its positions in the read flight. */
		interface BoundRefill {
			readonly program: RefillProgram
			readonly reads: ReadonlyArray<{ readonly sql: ChainSql; readonly at: ReadonlyArray<number> }>
		}
		const refills: Array<BoundRefill> = []
		for (const refillProgram of compiled.refills) {
			const chainReads: Array<BoundRefill["reads"][number]> = []
			for (const [i, sql] of refillProgram.reads.entries()) {
				const read = defined(refillProgram.refill.reads[i], "a refill's read of each chain")
				const root = sql.root
				const keyed = ((): ReadKeys | undefined => {
					if (root.kind === "put") {
						const layout = rowLayout(root.relation, frontend.laws.families)
						const keys = factsOf(root.slot).facts.map((fact) => factKey(planning, layout, fact))
						return keys.length === 0 ? undefined : { keys, groups: [] }
					}
					const bound = edits.find(
						(e) =>
							e.program.edit.stratum === refillProgram.stratum &&
							e.program.target.relation.name === root.family.member.name
					)
					return bound === undefined
						? undefined
						: readKeys(planning, bound.program.target, root.family, bound.changes)
				})()
				const widths =
					root.kind === "put"
						? { key: root.relation.primaryFields.length, group: 0 }
						: { key: root.family.member.primaryFields.length, group: root.family.group.length }
				const relation = root.kind === "put" ? root.relation.name : root.family.member.name
				const at: Array<number> = []
				if (keyed !== undefined) {
					const parts = planRead(keyed.keys, keyed.groups, widths, applied.transport)
					if (!parts.ok) {
						unreadable ??= rowBound(relation, parts.error)
					} else {
						for (const part of parts.value) {
							at.push(reads.length)
							reads.push({
								family: read.kind === "groups" ? read.groups.family.id : read.family.id,
								text: sql.text,
								params:
									root.kind === "put"
										? readLiterals(relation, part.keys, widths.key)
										: [
												...readLiterals(relation, part.keys, widths.key),
												...readLiterals(relation, part.groups, widths.group)
											]
							})
						}
					}
				}
				chainReads.push({ sql, at })
			}
			refills.push({ program: refillProgram, reads: chainReads })
		}
		/**
		 * A stratum's owner writes with every count of an owner the stratum inserts carried by the owner's own insert row
		 * instead of a count statement: a fresh owner's stored suffix is empty, so the filler knows its
		 * every member, and its insert row then states its final count and ends, which an immediate CHECK over them judges
		 * and every member's axes reference. `refilled` gathers each such owner's insert slot with its facts' counts and
		 * ends replaced (normalize.ts refilledSlot), and `nested` each such owner a nested write of the stratum fills, a
		 * tree's node or a sequence's member, its row's counts and ends replaced; an owner whose insert slot carries no
		 * counts keeps its count statement.
		 */
		const carried = (
			stratum: StratumAt,
			target: EditTarget,
			owners: ReadonlyArray<OwnerWrite>,
			refilled: Map<ParamId, NormalizedSlot>,
			nested: Map<StoredRelationName, TupleMap<MemberKey, NestedRow>>
		): ReadonlyArray<OwnerWrite> =>
			owners.flatMap((write) => {
				const family = defined(
					target.families.find((f) => familyKey(f.family.id) === familyKey(write.family)),
					"an edited relation's family"
				).family
				/** A refill keeps the slot's key check true only while no key reads the fields it draws: a count or an end a
				 * key holds keeps its count statement, which the key law judges at the statement. */
				const drawnFields = [family.count.name, ...endColumns(family).map((f) => f.name)]
				const keyed = family.owner.keyNames.some((k) =>
					k.fields.some((f) => drawnFields.includes(f.name))
				)
				const slots = keyed ? [] : ownerSlots(frontend, stratum, family.owner.name)
				const kept = new TupleMap<Owner, Recount>()
				for (const [group, recount] of write.recounts) {
					kept.set(group, recount)
				}
				for (const slot of slots) {
					const current = refilled.get(slot) ?? factsOf(slot)
					const inserted = ownersOf(planning, family, current.facts)
					const byGroup = new TupleMap<Owner, ReadonlyMap<string, unknown>>()
					for (const [group, recount] of write.recounts) {
						if (!write.stored.has(group) && inserted.has(group)) {
							byGroup.set(group, recountValues(family, recount))
							kept.delete(group)
						}
					}
					if (byGroup.size > 0) {
						refilled.set(
							slot,
							refilledSlot(current, (fact) => {
								const drawnValues = byGroup.get(ownerGroup(planning, family, fact))
								return drawnValues === undefined
									? fact
									: Object.fromEntries([...Object.entries(fact), ...drawnValues])
							})
						)
					}
				}
				const rows = keyed ? undefined : nested.get(family.owner.name)
				if (rows !== undefined) {
					for (const [key, row] of rows) {
						const group = ownerGroup(planning, family, row.fact)
						const recount = kept.get(group)
						if (recount !== undefined && !write.stored.has(group)) {
							rows.set(key, recountedRow(family, row, recount))
							kept.delete(group)
						}
					}
				}
				return kept.size > 0 ? [{ family: write.family, recounts: kept, stored: write.stored }] : []
			})
		/** The row layout of `relation`, whose rows a nested write of the stratum fills. */
		const nestedLayout = (stratum: StratumAt, relation: StoredRelationName): RowLayout => {
			for (const n of frontend.nested) {
				const at = n.stratum === stratum ? n.nesting.layouts.get(relation) : undefined
				if (at !== undefined) {
					return at.layout
				}
			}
			throw defect(`the row layout of ${relation}, a relation a nested write of the stratum fills`)
		}
		/** A nested owner's row with its count and ends of `family` replaced by its recount's. */
		const recountedRow = (family: Family, row: NestedRow, recount: Recount): NestedRow => {
			const recounted = recountValues(family, recount)
			const rowValues = new Map(row.values)
			for (const [name, value] of recounted) {
				rowValues.set(fieldKey(name), value)
			}
			const fact = Object.freeze(
				Object.fromEntries(
					Object.entries(row.fact).map(([name, v]) => [
						name,
						recounted.has(name) ? recounted.get(name) : v
					])
				)
			)
			return { identity: row.identity, key: row.key, values: rowValues, fact }
		}
		/** A plan's refusal as its write's: a generated field with no value as `generatedRejection`, any other as itself. */
		const planRefusal = (
			stratum: StratumAt,
			error: EncodingFailure | CompileError | GeneratedNull
		): EncodingFailure | CompileError | GeneratedRejection =>
			error._tag === "GeneratedNull" ? generatedRejection(stratum, error) : error
		/**
		 * Each stratum's plan from the reads' rows, one array of rows per read in order: its nested rows, and the rows of
		 * every relation its edits write or its refills rewrite, composed by depth with their counts.
		 *
		 * The stratum's rows are planned over one state (family/state.ts): every row its reads found, and the same rows as
		 * its changes leave them, a put's caller fields, every edit's and refill's rows and recounts, each owner axis's
		 * cascade. Each relation's edits and refills are planned against the state the others leave (edit.ts planEdits), a
		 * tree's refill draws its trees again (edit.ts refillTree), and the plan runs again over the state each plan leaves,
		 * once more than the relations and trees it plans, so every value drawn from another plan's is drawn from its final
		 * one: the changes reach one another only along the schema's families, which close no cycle a refill could not order
		 * (analysis/theory/refill.ts).
		 *
		 * Every planned statement is one the stratum's schedule placed a family statement for, which sends it: one the
		 * schedule did not place is a defect, never a statement left unsent.
		 */
		const planned = (
			rows: ReadonlyArray<Raw>
		): Result.Result<
			Planned,
			EncodingFailure | FamilyRowBound | CompileError | GeneratedRejection
		> => {
			const strata = [
				...new Set([
					...frontend.nested.flatMap((n) =>
						applied.binding.fresh.some((f) => f.stratum === n.stratum) ? [] : [n.stratum]
					),
					...edits.map((e) => e.program.edit.stratum),
					...refills.map((r) => r.program.stratum)
				])
			]
			const out = new Map<StratumAt, Plan>()
			const refilled = new Map<ParamId, NormalizedSlot>()
			const fills = new Map<StratumAt, StratumFill>()
			const families = frontend.laws.families
			for (const stratum of strata) {
				/** The stratum's nested rows but those an edit of their relation plans with its own changes. */
				const editedHere = new Set(
					edits
						.filter((e) => e.program.edit.stratum === stratum)
						.map((e) => e.program.target.relation.name)
				)
				const nested = new Map(
					[...(applied.nested.get(stratum) ?? noRows)].flatMap(([relation, relationRows]) => {
						if (editedHere.has(relation)) {
							return []
						}
						const copy = new TupleMap<MemberKey, NestedRow>()
						for (const [key, row] of relationRows) {
							copy.set(key, row)
						}
						return [[relation, copy] as const]
					})
				)
				const refill = refills.find((r) => r.program.stratum === stratum)
				/** Every row the stratum's reads found, by relation and key. */
				const stored: RowState = new Map()
				/** Each family's stored suffixes, by family key, every read of it as one set. */
				const suffixes = new Map<string, StoredFamily>()
				/** An owner's key texts in its row layout's key order, from its group texts in the family's group order. */
				const ownerKey = (family: Family, owner: Owner): MemberKey =>
					mapNonEmpty(rowLayout(family.owner, families).key, (c) =>
						defined(
							owner[family.group.findIndex((g) => fieldKey(g.owner.name) === c.key)],
							`the owner's key field ${c.key} in its group`
						)
					)
				const holdFamily = (family: Family, read: StoredFamily): void => {
					suffixes.set(familyKey(family.id), mergeStored(suffixes.get(familyKey(family.id)), read))
					for (const g of read.groups.values()) {
						holdRow(
							stored,
							family.owner.name,
							keyOf(planning, rowLayout(family.owner, families), g.owner),
							g.owner
						)
					}
					for (const m of read.members.values()) {
						holdRow(stored, family.member.name, m.key, m.values)
					}
				}
				const reading = edits.filter((e) => e.program.edit.stratum === stratum)
				for (const bound of reading) {
					for (const read of bound.reads) {
						const decoded = decodeRead(
							planning,
							bound.program.target,
							read.family,
							read.shape,
							read.at.map((i) => defined(rows[i], `the rows of read ${i}`))
						)
						if (!decoded.ok) {
							return decoded
						}
						holdFamily(read.family, decoded.value)
					}
				}
				/** Each refilled tree's nodes its reads found whole, by family key. */
				const treeNodes = new Map<string, TupleSet<MemberKey>>()
				for (const read of refill?.reads ?? []) {
					const decoded = decodeChain(
						planning,
						read.sql.shape,
						read.at.map((i) => defined(rows[i], `the rows of read ${i}`))
					)
					if (!decoded.ok) {
						return decoded
					}
					for (const row of decoded.value.rows) {
						holdRow(stored, row.relation, row.key, row.values)
					}
					const end = decoded.value.end
					switch (end.kind) {
						case "suffix":
							holdFamily(end.family, end.stored)
							break
						case "tree": {
							const keys = treeNodes.get(familyKey(end.family.id)) ?? new TupleSet<MemberKey>()
							for (const key of end.keys) {
								keys.add(key)
							}
							treeNodes.set(familyKey(end.family.id), keys)
							break
						}
						case "rows":
							break
					}
				}
				const refilledFamilies = new Set(
					(refill?.program.refill.closure.refills ?? []).map((l) => familyKey(l.id))
				)
				const trees = (refill?.program.refill.closure.refills ?? []).filter((l) =>
					isTreeOf(l, l.member.name)
				)
				/** Each relation the stratum edits or refills, as an edit's target, with its edit where it has one. */
				const units = [
					...reading.map((bound) => ({ target: bound.program.target, bound })),
					...(refill?.program.targets ?? [])
						.filter((target) => !editedHere.has(target.relation.name))
						.map((target) => ({ target, bound: undefined }))
				].toSorted((a, b) => depthOf(b.target.relation.name) - depthOf(a.target.relation.name))
				const current = copyState(stored)
				for (const read of refill?.program.reads ?? []) {
					const root = read.root
					if (root.kind === "put" && !families.some((f) => f.member.name === root.relation.name)) {
						const layout = rowLayout(root.relation, families)
						for (const fact of factsOf(root.slot).facts) {
							writeRow(
								current,
								root.relation,
								factKey(planning, layout, fact),
								callerValues(root.relation, fact)
							)
						}
					}
				}
				const noChange: RelationChanges = { inserts: [], puts: [], deletes: [], nested: [] }
				/** The owners of `family` the stratum changes, by group texts, each with the columns it changes of it. */
				const changedOwners = (family: Family): ReadonlyTupleMap<Owner, Values> => {
					const layout = rowLayout(family.owner, families)
					const changed = new TupleMap<Owner, Values>()
					for (const [key, row] of rowsOf(current, family.owner.name)) {
						const was = rowOf(stored, family.owner.name, key)
						const delta = was === undefined ? new Map() : changedColumns(planning, layout, was, row)
						if (delta.size > 0) {
							changed.set(groupOfOwner(planning, family, row), delta)
						}
					}
					return changed
				}
				/** Each pass draws from what the one before left, so each unit's values are final one pass after every value it
				 * draws from is: the units and trees close no cycle a refill could not order (analysis/theory/refill.ts). */
				const passes = units.length + trees.length + 1
				let plannedUnits: ReadonlyArray<EditedTarget> = []
				for (let pass = 0; pass < passes; pass += 1) {
					cascade(planning, families, depthOf, stored, current)
					const done: Array<EditedTarget> = []
					for (const { target, bound } of units) {
						const relation = target.relation
						const refreshed = target.families.some((f) =>
							refilledFamilies.has(familyKey(f.family.id))
						)
						const storedOf = new Map(
							target.families.flatMap(({ family }) => {
								const read = suffixes.get(familyKey(family.id))
								return read === undefined ? [] : [[familyKey(family.id), read] as const]
							})
						)
						const edited = planEdits(
							planning,
							target,
							bound?.changes ?? noChange,
							storedOf,
							(family) => ({
								stated:
									bound?.owners(family) ??
									ownersOf(planning, family, insertedOf(stratum, family.owner.name)),
								plain: !families.some((f) => f.member.name === family.owner.name),
								recounted: changedOwners(family)
							}),
							{
								current: refreshed
									? rowsOf(current, relation.name)
									: new TupleMap<MemberKey, Values>(),
								refilled: (family) => refilledFamilies.has(familyKey(family.id))
							}
						)
						if (!edited.ok) {
							return Result.err(planRefusal(stratum, edited.error))
						}
						done.push({ target, edited: edited.value })
						const written = edited.value.rows
						for (const key of written.deletes) {
							dropRow(current, relation.name, key)
						}
						for (const row of [
							...written.refills.values(),
							...written.updates.values(),
							...written.inserts.values()
						]) {
							holdRow(current, relation.name, row.key, row.values)
						}
						for (const write of edited.value.owners) {
							const family = defined(
								target.families.find((f) => familyKey(f.family.id) === familyKey(write.family)),
								"a planned relation's family"
							).family
							for (const recount of write.recounts.values()) {
								writeRow(
									current,
									family.owner,
									ownerKey(family, recount.owner),
									new Map(
										[...recountValues(family, recount)].map(
											([name, v]) => [fieldKey(name), v] as const
										)
									)
								)
							}
						}
					}
					for (const tree of trees) {
						const keys = [...(treeNodes.get(familyKey(tree.id)) ?? [])]
						const nodesOf = (state: RowState): ReadonlyTupleMap<MemberKey, Values> => {
							const nodes = new TupleMap<MemberKey, Values>()
							for (const key of keys) {
								const row = rowOf(state, tree.member.name, key)
								if (row !== undefined) {
									nodes.set(key, row)
								}
							}
							return nodes
						}
						const drawn = refillTree(planning, tree, nodesOf(stored), nodesOf(current))
						if (!drawn.ok) {
							return Result.err(planRefusal(stratum, drawn.error))
						}
						for (const [key, node] of drawn.value) {
							holdRow(current, tree.member.name, key, node)
						}
					}
					plannedUnits = done
				}
				/** The rows of each relation a refill rewrites, by relation and key, each with every value as the stratum
				 * leaves it: an owner's count and ends among them, which its count statement then leaves out. A tree's nodes are
				 * every node whose values its refill changes. */
				const refillRows = new Map<string, TupleMap<MemberKey, FilledRow>>()
				for (const tree of trees) {
					const name = tree.member.name
					const layout = rowLayout(tree.member, families)
					const nodes = refillRows.get(name) ?? new TupleMap<MemberKey, FilledRow>()
					for (const key of treeNodes.get(familyKey(tree.id)) ?? []) {
						const was = rowOf(stored, name, key)
						const now = rowOf(current, name, key)
						if (
							was === undefined ||
							now === undefined ||
							changedColumns(planning, layout, was, now).size === 0
						) {
							continue
						}
						nodes.set(key, { key: keyOf(planning, layout, now), values: now })
					}
					refillRows.set(name, nodes)
				}
				const rewritten = plannedUnits.map(({ target, edited }): EditedTarget => {
					const name = target.relation.name
					const rewrites = new TupleMap<MemberKey, FilledRow>()
					for (const [key, row] of refillRows.get(name) ?? []) {
						rewrites.set(key, row)
					}
					for (const [key, row] of edited.rows.refills) {
						rewrites.set(key, {
							key: row.key,
							values: defined(
								rowOf(current, name, key),
								"a refilled row its plan holds in the state"
							)
						})
					}
					refillRows.set(name, rewrites)
					return { target, edited: { ...edited, rows: { ...edited.rows, refills: rewrites } } }
				})
				const recounts = new Map<string, TupleMap<Owner, Recount>>()
				for (const { edited } of rewritten) {
					for (const write of edited.owners) {
						const into = recounts.get(familyKey(write.family)) ?? new TupleMap<Owner, Recount>()
						for (const [group, recount] of write.recounts) {
							into.set(group, recount)
						}
						recounts.set(familyKey(write.family), into)
					}
				}
				fills.set(stratum, { recounts, found: stored, rows: current })
				const editedPlans: Array<RelationPlanAt> = []
				const counts: Array<Phase<"count">> = []
				const planRows = (
					relation: RelationInfo,
					layout: RowLayout,
					write: Parameters<typeof encodedWrite>[2]
				): Result.Result<void, FamilyRowBound> => {
					const rowsPlan = planRelation(encodedWrite(planning, layout, write), applied.transport)
					if (!rowsPlan.ok) {
						return Result.err(rowBound(relation.name, rowsPlan.error))
					}
					editedPlans.push({ depth: depthOf(relation.name), plan: rowsPlan.value })
					return Result.ok(undefined)
				}
				for (const [i, edited] of foldRecounts(rewritten).entries()) {
					const { target } = defined(rewritten[i], "a planned edit")
					const rowsPlanned = planRows(target.relation, target.layout, edited.rows)
					if (!rowsPlanned.ok) {
						return rowsPlanned
					}
					for (const owner of carried(stratum, target, edited.owners, refilled, nested)) {
						const family = defined(
							target.families.find((f) => familyKey(f.family.id) === familyKey(owner.family)),
							"an edited relation's family"
						).family
						const carriedByRefill =
							refillRows.get(family.owner.name) ?? new TupleMap<MemberKey, FilledRow>()
						const recounted = [...owner.recounts.values()].filter(
							(r) => !carriedByRefill.has(ownerKey(family, r.owner))
						)
						if (recounted.length === 0) {
							continue
						}
						const phase = planOwners(
							owner.family,
							countRows(planning, family, recounted),
							applied.transport
						)
						if (!phase.ok) {
							return Result.err(rowBound(target.relation.name, phase.error))
						}
						counts.push(phase.value)
					}
				}
				for (const tree of trees) {
					const nodes = refillRows.get(tree.member.name) ?? new TupleMap<MemberKey, FilledRow>()
					if (nodes.size === 0 || units.some((u) => u.target.relation.name === tree.member.name)) {
						continue
					}
					const rowsPlanned = planRows(tree.member, rowLayout(tree.member, families), {
						relation: tree.member.name,
						deletes: new TupleSet<MemberKey>(),
						refills: nodes,
						updates: new TupleMap<MemberKey, FilledRow>(),
						inserts: new TupleMap<MemberKey, FilledRow>()
					})
					if (!rowsPlanned.ok) {
						return rowsPlanned
					}
				}
				const relations = nestedPlans(stratum, nested)
				if (!relations.ok) {
					return relations
				}
				const plan = compose([...relations.value, ...editedPlans], counts)
				const placed = defined(frontend.ir.strata[stratum], "a planned stratum").family
				const unsent = plan.flat().find((s) => !placed.some(({ node }) => placedFor(node, s)))
				if (unsent !== undefined) {
					throw defect(
						`a planned ${unsent.kind} of ${unsent.kind === "count" ? `${unsent.family.owner}.${unsent.family.count}` : unsent.relation} in stratum ${stratum}, which no family statement the schedule placed sends`
					)
				}
				out.set(stratum, plan)
			}
			return Result.ok({ plans: out, slots: refilled, fills })
		}
		/**
		 * A planned statement's arrays: its rows' cells, column by column (order.ts columnArray), each literal within the
		 * longest string, each bytes value copied once into its column's binary array, a value its caller changed since
		 * admission refused there.
		 */
		const arraysOf = (
			relation: string,
			statement: FamilyStatement
		): Result.Result<ReadonlyArray<Param>, LiteralBound | EncodingFailure> => {
			const rows = textsOf(statement)
			const width = rows[0]?.length ?? 0
			const arrays: Array<Param> = []
			for (let i = 0; i < width; i += 1) {
				const array = columnArray(
					relation,
					`column ${i + 1}`,
					rows.map((row) => defined(row[i], "a family statement's row holds each of its columns"))
				)
				if (!array.ok) {
					return array
				}
				arrays.push(array.value)
			}
			return Result.ok(arrays)
		}
		/** The chunks of the artifact's statements under the strata's plans: a family step's, one execution per planned
		 * statement of its kind and target; any other's, its one execution. */
		const chunksOf = (
			plans: Result.Result<Planned, EncodingFailure | FamilyRowBound | CompileError>
		): Chunks => {
			const slotFacts = (slot: ParamId): NormalizedSlot =>
				plans.ok
					? (plans.value.slots.get(slot) ?? fresh.get(slot) ?? factsOf(slot))
					: (fresh.get(slot) ?? factsOf(slot))
			return (statement, transport) => {
				const step = statement.step
				if (step.kind !== "family") {
					return statementChunks(statement, transport, slotFacts)
				}
				if (!plans.ok) {
					return plans
				}
				const sent = form(statement)
				const target = step.target
				const ofStep: ReadonlyArray<FamilyStatement> = defined(
					plans.value.plans.get(step.stratum),
					`the plan of stratum ${step.stratum}, which a family statement the schedule placed sends`
				)
					.flat()
					.filter(
						(s) =>
							s.kind === step.statement &&
							(s.kind === "count"
								? target.kind === "owners" && familyKey(s.family) === familyKey(target.family)
								: target.kind === "rows" && s.relation === target.relation)
					)
				const out: Array<Execution> = []
				for (const s of ofStep) {
					const arrays = arraysOf(step.relation, s)
					if (!arrays.ok) {
						return arrays
					}
					out.push({ text: sent.text, params: arrays.value, part: "statement" })
				}
				return Result.ok(out)
			}
		}
		/** The write statements under a plan: their chunks, and the stated rows as the plan fills them, none where it is
		 * refused, which sends no write statement. */
		const writtenOf = (
			plans: Result.Result<Planned, EncodingFailure | FamilyRowBound | CompileError>
		): PlanWrites => ({
			chunks: chunksOf(plans),
			stated: statedRowsOf(
				plans.ok
					? {
							kind: "planned",
							strata: plans.value.fills,
							drawn: (slot) => plans.value.slots.get(slot) ?? fresh.get(slot)
						}
					: unplanned
			)
		})
		/** The flights of a write that reads nothing, planned now: refused where its plan fills a generated field with no
		 * value, before any statement. */
		const unreadFlights = (): Result.Result<Flights, GeneratedRejection> => {
			const plans = planned([])
			if (plans.ok) {
				return Result.ok({ kind: "write", ...writtenOf(plans) })
			}
			if (plans.error._tag === "GeneratedRejection") {
				return Result.err(plans.error)
			}
			return Result.ok({ kind: "write", ...writtenOf(Result.err(plans.error)) })
		}
		return unreadable !== undefined
			? Result.ok({ kind: "write", ...writtenOf(Result.err(unreadable)) })
			: isNonEmpty(reads)
				? Result.ok({
						kind: "read",
						reads,
						writes: (rows) => {
							const plans = planned(rows)
							return plans.ok ? Result.ok(writtenOf(plans)) : plans
						}
					})
				: unreadFlights()
	}

/** A read's keys as its placeholders carry them: one array literal per key field, each within the longest string. The
 * read was cut to its transport (order.ts planRead), so every literal fits. */
const readLiterals = (
	relation: string,
	keys: ReadonlyArray<ReadonlyArray<ParamText>>,
	width: number
): ReadonlyArray<ParamText> => {
	const literals = arrayTexts(
		relation,
		Array.from({ length: width }, (_, i) => `key ${i + 1}`),
		keys,
		maxStringLength.value
	)
	if (!literals.ok) {
		throw defect("a read cut to its transport carries every literal it writes")
	}
	return literals.value
}

/** The slots of an enumerated input whose facts may insert their keys: an insert's, a put's (whose insert half inserts
 * each fact no row holds the key of), a nested insert's, and a classed insert's complete one. */
const insertSlots = (input: EnumeratedInput): ReadonlyArray<ParamId> => {
	switch (input.kind) {
		case "single":
			return input.act.op === "delete" ? [] : [input.slot.slot]
		case "nested":
			return [input.slot.slot]
		case "classed":
			return [input.complete.slot]
	}
}

/** Whether a family statement the schedule placed sends a planned one: the count of its family, or the statement of its
 * kind of its member relation. */
const placedFor = (node: FamilyNode, statement: FamilyStatement): boolean =>
	statement.kind === "count"
		? node.kind === "owners" && familyKey(node.family) === familyKey(statement.family)
		: node.kind === "rows" &&
			node.statement === statement.kind &&
			node.relation === statement.relation

/** Each stratum's plan, each owner insert slot whose facts carry the counts and ends its members' appends draw, and
 * what each stratum's plan leaves (`StratumFill`). */
interface Planned {
	readonly plans: ReadonlyMap<StratumAt, Plan>
	readonly slots: ReadonlyMap<ParamId, NormalizedSlot>
	readonly fills: ReadonlyMap<StratumAt, StratumFill>
}
