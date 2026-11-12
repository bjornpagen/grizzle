import type { CheckedSchema, DerivedAnalysis } from "#compiler/analysis/schema.ts"
import { indices, maxOf } from "#compiler/core/array.ts"
import { canonicalEquals, catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { ParamId } from "#compiler/core/ids.ts"
import { defect, defined } from "#compiler/core/invariant.ts"
import type { Isolation } from "#compiler/core/isolation.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { Codebook } from "#compiler/ir/codes.ts"
import type { ChangeSetDesc } from "#compiler/ir/desc.ts"
import { type Family, isSequence, isTreeOf } from "#compiler/ir/family.ts"
import { type FillColumn, layoutKey } from "#compiler/ir/fill.ts"
import { type FamilyId, familyKey, type RelationInfo } from "#compiler/ir/law.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import type { ParamDecl, ProgramArtifacts, StatementSpec } from "#compiler/ir/products.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import { completeClass, type ReadBack, type SerialClass } from "#compiler/ir/write.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { UniqueObject } from "#compiler/laws/model/uniques.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import type { DeclaredParamSlot, WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { isPlainQuery } from "#compiler/lower/delivery.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { partQuery, type TaggedPart } from "#compiler/lower/parts.ts"
import {
	type OptimizedDeliveryProgram,
	optimizedDispatch,
	type RelationChoice,
	type SentStatement,
	ShapeState
} from "#compiler/lower/shapes/index.ts"
import { type ShapeFacts, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import {
	planStatementShares,
	ShareIndex,
	StatementSharing
} from "#compiler/lower/shapes/share/statements.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { sentHeading, sentSpec, specifiedProgram } from "#compiler/lower/template.ts"
import { oneForm } from "#compiler/runtime/lower/forms.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import {
	freshNames as startNames,
	type NameMap,
	NameSupply,
	type NameSupplyStart,
	namesPast
} from "#compiler/sql/naming.ts"
import {
	buildCreateCarrier,
	buildFillCarrier,
	type WriteCarrier,
	carrierColumns,
	memberRows
} from "#compiler/write/carriers/carriers.ts"
import { relationUniques } from "#compiler/write/insert/unique.ts"

import {
	buildAnchoredDelete,
	buildDisplacingDelete,
	buildExactDelete
} from "#compiler/write/delete/exact.ts"

import {
	buildEntryCheck,
	type EntryCheck,
	outsideProbes,
	type WriteWorld
} from "#compiler/write/entry/precheck.ts"

import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { Binding } from "#compiler/runtime/write/binding.ts"
import { sentLayout } from "#compiler/runtime/write/nesting.ts"
import type { FamilyStep, FamilyWriteStep } from "#compiler/runtime/write/steps.ts"
import type { UniqueAbort, WriteStep } from "#compiler/runtime/write/steps.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { unitSql } from "#compiler/write/delete/unit.ts"
import {
	type AppendedMember,
	additionsSql,
	type OwnerRows,
	type PutOwner,
	type RowSource
} from "#compiler/write/family/additions.ts"
import type { EditTarget } from "#compiler/write/family/edit.ts"
import {
	type Deferring,
	type EditedMember,
	familyInputs,
	type RefillRoot,
	removalsSql
} from "#compiler/write/family/removals.ts"
import {
	type ChainSql,
	chainReadSql,
	countStatement,
	type FamilySql,
	memberFamilies,
	type ReadSql,
	type RowLayout,
	readShape,
	rowLayout,
	rowStatement,
	suffixReadSql
} from "#compiler/write/family/statements.ts"
import type { FamilyWriteSql } from "#compiler/write/family/written.ts"
import {
	compileChangeSet,
	type MemberSlot,
	type SlotGroup,
	type StratumEdit,
	type WriteFrontend,
	type WrittenRelation,
	writingSlots
} from "#compiler/write/frontend/compile.ts"
import type { EntryClaims } from "#compiler/write/frontend/entry.ts"
import { plainRefills, type StratumRefill } from "#compiler/write/frontend/refill.ts"
import { type FamilyNode, sameNode } from "#compiler/write/frontend/schedule.ts"
import { distinctByEvidence, type WriteInput } from "#compiler/write/insert/input.ts"
import { buildInsert, buildSpanClassify } from "#compiler/write/insert/protocol.ts"
import {
	type DeleteResult,
	type InsertResult,
	type ModifyingStatement,
	ownStatement,
	StatementShare,
	type WriteContext,
	type WriteNames,
	type WriteStatement,
	writeContext
} from "#compiler/write/insert/statement.ts"
import { readsDrawn } from "#compiler/write/insert/unique.ts"
import { withCarrierAnalysis } from "#compiler/write/program/analyze.ts"
import { castsNothing } from "#compiler/write/program/artifact.ts"
import {
	type ArtifactForms,
	DependencyTracker,
	type PlacedStatement,
	type RidingReadBack,
	resultHeading,
	singleStatementSpec,
	type SentForm,
	type WriteArtifact,
	writeStatementSpec
} from "#compiler/write/program/artifact.ts"
import { decideBinding } from "#compiler/write/program/decide.ts"
import { insertOnly } from "#compiler/write/program/insert-only.ts"
import {
	freshNames,
	noRiding,
	type ReadBackPart,
	type Riding,
	type SharedPart,
	type SingleStatement,
	singleStatement
} from "#compiler/write/program/single.ts"
import { choosePutTargets, chosenIn, type PutChoice } from "#compiler/write/put/choose.ts"
import {
	buildMerge,
	buildUpdateFrom,
	buildUpsert,
	type PutStatement
} from "#compiler/write/put/statement.ts"
import {
	carriersOf,
	type DeltaCteName,
	type DeltaHeld,
	deltaCte,
	deltaCteName,
	deltaIn,
	plannedDelta,
	withDeltaFills
} from "#compiler/write/readback/deltas.ts"
import { type DeltasOf, deltaSourceIn, lowerReadBack } from "#compiler/write/readback/lower.ts"
import {
	type PlanAction,
	type PlannedWrite,
	type PlanStep,
	planWrite,
	type WritePlan
} from "#compiler/write/schedule/plan.ts"
import { buildSequenceAdvance } from "#compiler/write/serial/advance.ts"

export interface CompileWriteOptions {
	/** The installed names the statements write (`InstallNames`, `schemaArtifacts`). */
	readonly names: WriteNames
	/** The names the members and read-backs read their relations under: reality's own, or a role's views
	 * (`SchemaArtifacts.reads`). */
	readonly reads: PhysicalNames
	/** Which contexts the Db holds a fact of. */
	readonly claims: EntryClaims
	/** What the compilation writes as: reality, or a role, whose filter functions its query entries' prechecks call. */
	readonly world: WriteWorld
	/** The schema's law model and its base's derived analysis (`SchemaArtifacts.laws`, `.derived`). */
	readonly laws: LawModel
	readonly derived: DerivedAnalysis
	/** The isolation the write runs at, which decides how its inserts meet stored rows (insert/protocol.ts
	 * Arbitration): a role's level, SERIALIZABLE wherever none is proved. */
	readonly level: Isolation
}

export interface CompiledWrite extends ProgramArtifacts<WriteParamSlot> {
	/** The isolation its statements were built for (CompileWriteOptions `level`), the one it is served and run at. */
	readonly level: Isolation
	readonly frontend: WriteFrontend
	/** Each stratum's edits of a family's member relation, with their reads, built once. */
	readonly edits: ReadonlyArray<EditProgram>
	/** Each stratum's refills, with their reads, built once. */
	readonly refills: ReadonlyArray<RefillProgram>
	readonly choices: ReadonlyArray<PutChoice>
	readonly plan: WritePlan
	/** The optimized artifact, the one an application runs. */
	readonly artifact: WriteArtifact
	/** Where each family statement is placed in its stratum's schedule, which every realization places it by. */
	readonly placements: ReadonlyArray<FamilyPlacement>
	/** The parameters the members and read-backs declare, and the enumerated member slots binding fills. */
	readonly params: ReadonlyArray<ParamDecl>
	readonly slots: ReadonlyArray<SlotGroup>
	/** What binding one application reads besides its values, decided here (decide.ts decideBinding). */
	readonly binding: Binding
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** What decides which of a write op's unique violations abort the apply: a generated addition's class, whose drawn
 * fields tell an unseen occupant from a draw a stored value meets; a MERGE; any other probed statement; or none. */
type AbortKind =
	| {
			readonly kind: "generated"
			readonly serial: Extract<SerialClass, { readonly kind: "generated" }>
	  }
	| { readonly kind: "merge" }
	| { readonly kind: "probed" }
	| { readonly kind: "other" }

/** The 23505 and 23P01 violations at a statement into `relation` that abort the apply: a generated addition's at every
 * unique object, which its probe leaves only an occupant its snapshot did not see at an object that reads no field it
 * draws, and at one that reads a drawn field a stored value the sequence had not passed; a MERGE insert at the primary
 * key its put targets, or at a unique object besides it, which compares every field of that key (`uniqueBesideKey`),
 * so it is the same concurrent commit; and a probed insert's, at every unique object besides its arbiter, which after
 * the probe only an occupant its snapshot did not see raises. */
export const uniqueAbortsOf = (
	relation: WrittenRelation,
	kind: AbortKind
): ReadonlyArray<UniqueAbort> => {
	const aborts = (
		objects: ReadonlyArray<UniqueObject>,
		reason: UniqueAbort["reason"]
	): ReadonlyArray<UniqueAbort> =>
		objects.map((u) => ({ constraint: u.name, relation: relation.name, reason }))
	const { arbiter, others } = relation.uniques
	switch (kind.kind) {
		case "other":
			return []
		case "probed":
			return aborts(others, "UnseenOccupant")
		case "merge":
			return aborts([arbiter, ...others], "PutTargetConflict")
		case "generated":
			return [arbiter, ...others].map((u): UniqueAbort => ({
				constraint: u.name,
				relation: relation.name,
				reason: readsDrawn(u, kind.serial.drawn) ? "GeneratedSerialUnique" : "UnseenOccupant"
			}))
	}
}

/** What a statement's input reads: the carriers it scans and the stored relations a described member reads. */
const inputReads = (inputs: ReadonlyArray<WriteInput>): ReadonlyArray<string> =>
	inputs.flatMap((input) =>
		input.kind === "carrier"
			? [`carrier:${input.carrier.name}`]
			: input.kind === "described"
				? input.node.meta.reads.map((r) => `relation:${r}`)
				: []
	)

/** The delta carriers of a relation a read-back names, none for any other. */
const deltaCarrierNames = (plan: WritePlan, relation: string): ReadonlyArray<string> => {
	const carriers = plan.deltas.carriers.get(relation)
	return carriers === undefined ? [] : carriersOf(carriers).map((c) => `carrier:${c.name}`)
}

export interface ArtifactBuilder {
	/** Each statement placed so far, a read-back's naming its read-back, with its audited AST for the carriers'
	 * analysis; its length is the position the next statement placed takes. */
	readonly statements: Array<PlacedStatement>
	/** The installation's codes, which a read-back's placeholders' encoders write a closed id's and a set's values by. */
	readonly codes: Codebook
}

export const newBuilder = (codes: Codebook): ArtifactBuilder => ({ statements: [], codes })

/** One family statement of a stratum, built once over the installed names (`familyProgram`), which the plan's step of
 * its node places where the stratum's schedule runs it. */
export type FamilyPlacement =
	| {
			readonly kind: "statement"
			readonly stratum: StratumAt
			readonly node: FamilyNode
			readonly step: FamilyStep
			readonly sql: FamilySql
	  }
	| {
			readonly kind: "write"
			readonly stratum: StratumAt
			readonly node: FamilyNode
			readonly step: FamilyWriteStep
			readonly sql: FamilyWriteSql
	  }

/**
 * The columns `family` draws on a row of `relation`, its member, in fill order: its fill layout's at the member's position
 * in the family, a counted family's own fill's, or a sequence's walk's of the family's own rules.
 */
const familyDrawn = (
	frontend: WriteFrontend,
	relation: string,
	family: Family
): ReadonlyArray<FillColumn> =>
	defined(
		frontend.laws.theory.fill.layouts.get(layoutKey(relation, { kind: "member", family })),
		`the fill layout of ${relation} as a member of ${family.id.owner}.${family.id.count}`
	).columns.filter((c) => {
		if (isSequence(family)) {
			const rule = c.rule
			return (
				c.writer.kind === "walk" &&
				(rule.kind === "index" ||
					rule.kind === "copy" ||
					((rule.kind === "ownerCopy" || rule.kind === "predecessor" || rule.kind === "after") &&
						familyKey(rule.family.id) === familyKey(family.id)))
			)
		}
		return c.writer.kind === "counted" && familyKey(c.writer.family.id) === familyKey(family.id)
	})

/** The member slot `slot` names among the front end's slot groups: every edit's slot is one of them. */
const memberSlotOf = (frontend: WriteFrontend, slot: ParamId): MemberSlot =>
	defined(frontend.slotsById.get(slot), `the member slot ${slot}, an edit's`).slot

/** The relations a family placement reads and writes, which orders it against the artifact's other statements. */
const placementRelations = (placement: FamilyPlacement): ReadonlyArray<string> =>
	placement.kind === "statement"
		? [placement.step.relation]
		: [...new Set(placement.step.parts.map((p) => p.relation))]

/** A stratum's edits of one member relation as the program runs them: its slots, its row layout and families, and each
 * family's read, built once (write/family/edit.ts). */
export interface EditProgram {
	readonly edit: StratumEdit
	readonly target: EditTarget
	readonly reads: ReadonlyArray<{ readonly family: Family; readonly sql: ReadSql }>
}

/**
 * A stratum's refills as the program runs them (write/frontend/refill.ts): its refill, each of its reads' statement, and
 * each relation a refill rewrites as an edit's target, its row layout and its families with their reads' shapes.
 */
export interface RefillProgram {
	readonly stratum: StratumAt
	readonly refill: StratumRefill
	readonly reads: ReadonlyArray<ChainSql>
	readonly targets: ReadonlyArray<EditTarget>
}

/** The family statements of a program, by stratum, and its edits and refills with their reads. */
interface FamilyProgram {
	readonly placements: ReadonlyArray<FamilyPlacement>
	readonly edits: ReadonlyArray<EditProgram>
	readonly refills: ReadonlyArray<RefillProgram>
}

/**
 * A program's family statements (write/family/statements.ts), built once over the installed names: each family
 * statement the schedule placed among a stratum's writes (frontend/schedule.ts FamilyNode), the rows of a member
 * relation its nested writes reach or its edits write, or the counts of an edited relation's family. A nested write's
 * owners are inserted by the changeset, so it deletes nothing and counts nothing: a sequence's count rides its owner's
 * own row.
 */
const familyProgram = (frontend: WriteFrontend, w: WriteContext): FamilyProgram => {
	const all = frontend.laws.families
	/** Every stored relation of the schema, beyond the role's world: a family's read and its count statement name its
	 * owner, which a member's writer reads and counts through exactly the columns its installation grants it (the
	 * owner's key, count, ends and copies), whether or not its world holds the owner. */
	const stored: ReadonlyMap<string, RelationInfo> = new Map(
		[...frontend.laws.relations].map(([name, laws]) => [name, laws.relation] as const)
	)
	const layoutOf = (name: string): RowLayout => {
		const info = defined(frontend.schema.relations.get(name), `the family relation ${name}`)
		return rowLayout(info, all)
	}
	/** The strata whose family work is one additions statement, which plans nothing on the host. */
	const added = new Set(
		strataAt(frontend.ir.strata).flatMap(([s, stratum]) =>
			stratum.family.some(({ node }) => node.kind === "additions" || node.kind === "removals")
				? [s]
				: []
		)
	)
	const edits = frontend.edits
		.filter((edit) => !added.has(edit.stratum))
		.map((edit): EditProgram => {
			const layout = layoutOf(edit.relation.name)
			const families = memberFamilies(edit.relation.name, all).filter(
				(f) => !isTreeOf(f, edit.relation.name)
			)
			const reads = families.map((family) => ({
				family,
				sql: unwrap(suffixReadSql(family, layout, w, stored))
			}))
			return Object.freeze({
				edit,
				target: Object.freeze({
					relation: edit.relation,
					layout,
					families: reads.map((r) => ({
						family: r.family,
						shape: r.sql.shape,
						fixed: !r.family.owner.mutable
					}))
				}),
				reads
			})
		})
	const refills = frontend.refills
		.filter(({ stratum }) => !added.has(stratum))
		.map(({ stratum, refill }): RefillProgram =>
			Object.freeze({
				stratum,
				refill,
				reads: refill.reads.map((read) =>
					chainReadSql(read, w, (relation) => rowLayout(relation, all))
				),
				targets: refill.relations.map((name): EditTarget => {
					const relation = defined(stored.get(name), `the refilled relation ${name}`)
					const layout = layoutOf(name)
					return Object.freeze({
						relation,
						layout,
						families: memberFamilies(name, all)
							.filter((f) => !isTreeOf(f, name))
							.map((family) => ({
								family,
								shape: readShape(family, layout),
								fixed: !family.owner.mutable
							}))
					})
				})
			})
		)
	const info = (name: string) => defined(stored.get(name), `the family relation ${name}`)
	const familyOf = (id: FamilyId): Family =>
		defined(
			all.find((f) => familyKey(f.id) === familyKey(id)),
			`the family ${id.owner}.${id.count} a count statement counts`
		)
	const placements = strataAt(frontend.ir.strata).flatMap(([s, stratum]) =>
		stratum.family.map(({ node }): FamilyPlacement => {
			if (node.kind === "unit") {
				const sql = unitSql({ ...w, start: ownStatement }, node.units)
				const step: FamilyWriteStep = {
					kind: "familyWrite",
					stratum: s,
					statement: "unit",
					parts: sql.parts
				}
				return Object.freeze({ kind: "write", stratum: s, node, step: Object.freeze(step), sql })
			}
			if (node.kind === "additions" || node.kind === "removals") {
				const stratumEdits = frontend.edits.filter((edit) => edit.stratum === s)
				/** The families a family write draws its rows of `relation` by: every one it is a member of but its own tree,
				 * whose nodes the host's walk draws (write/family/nesting.ts). */
				const familiesOf = (relation: RelationInfo) =>
					memberFamilies(relation.name, all)
						.filter((f) => !isTreeOf(f, relation.name))
						.map((family) => ({
							family,
							drawn: familyDrawn(frontend, relation.name, family),
							inputs: familyInputs(family, relation)
						}))
				/** The stratum's refills its family statements draw, by member relation (frontend/refill.ts plainRefills). */
				const refilled = new Map(
					frontend.refills.flatMap((r) =>
						r.stratum === s
							? [
									...defined(
										plainRefills(
											r.refill,
											(name) => all.some((f) => f.member.name === name),
											new Set(
												stratumEdits.flatMap((e) =>
													e.puts === undefined && e.deletes === undefined ? [] : [e.relation.name]
												)
											)
										),
										"the refills of a stratum whose family statements draw them"
									)
								]
							: []
					)
				)
				/** The families a removals statement redraws its rows of `relation` by, at least one, each with the ways the
				 * stratum's puts of plain relations reach its members. */
				const removedFamilies = (relation: RelationInfo) => {
					const ways = refilled.get(relation.name) ?? []
					const own = familiesOf(relation).map((f) => ({
						...f,
						refills: (
							ways.find((r) => familyKey(r.family.id) === familyKey(f.family.id))?.ways ?? []
						).flatMap((way) =>
							way.root.kind === "recount" ? [] : [{ root: way.root, hops: way.hops }]
						)
					}))
					if (!isNonEmpty(own)) {
						throw defect(
							`the families of ${relation.name}, which a family removals statement redraws`
						)
					}
					return own
				}
				const slotOf = (slot: ParamId | undefined): MemberSlot | undefined =>
					slot === undefined ? undefined : memberSlotOf(frontend, slot)
				const ownerSlots = (op: "put" | "delete") =>
					frontend.slots.flatMap((group) =>
						group.stratum === s
							? group.inputs.flatMap((input) =>
									input.kind === "single" && input.act.op === op
										? [{ relation: group.relation.name, slot: input.slot }]
										: []
								)
							: []
					)
				const w0 = { ...w, start: ownStatement }
				if (node.kind === "additions") {
					/** The rows the stratum's nested writes fill, by relation, as each sends them (nesting.ts sentLayout). */
					const nestedRows = new Map(
						frontend.nested.flatMap((n) =>
							n.stratum === s
								? [...n.nesting.layouts].map(
										([relation, at]) => [relation, sentLayout(at)] as const
									)
								: []
						)
					)
					/** Each appended relation's row sources: its slots, then its nested rows. */
					const sourced = new Map<string, [RowSource, ...Array<RowSource>]>()
					for (const edit of stratumEdits) {
						const slots = [
							...(edit.inserts === undefined
								? []
								: [{ as: "inserts" as const, slot: memberSlotOf(frontend, edit.inserts) }]),
							...(edit.puts === undefined
								? []
								: [{ as: "puts" as const, slot: memberSlotOf(frontend, edit.puts) }])
						]
						if (isNonEmpty(slots)) {
							sourced.set(edit.relation.name, [{ kind: "slots", slots }])
						}
					}
					for (const [name, layout] of nestedRows) {
						const source: RowSource = { kind: "nestedRows", stratum: s, layout }
						const known = sourced.get(name)
						if (known === undefined) {
							sourced.set(name, [source])
						} else {
							known.push(source)
						}
					}
					const member = node.member
					const appended = [...sourced].flatMap(
						([name, sources]): ReadonlyArray<AppendedMember> => {
							if (name !== member) {
								return []
							}
							const relation = info(name)
							return [
								{
									relation,
									keyLaw: relationUniques(
										defined(frontend.laws.relations.get(name), `the laws of ${name}`)
									).arbiter.law,
									layout: layoutOf(name),
									sources,
									families: familiesOf(relation)
								}
							]
						}
					)
					const putOwners = ownerSlots("put").flatMap(
						({ relation, slot }): ReadonlyArray<PutOwner> => {
							const recounted = all.filter(
								(f) =>
									f.owner.name === relation && f.members.kind !== "tree" && f.member.name === member
							)
							const owner = info(relation)
							return isNonEmpty(recounted) && owner.mutable
								? [{ owner, slot, families: recounted }]
								: []
						}
					)
					const ownerCopies = node.appends === "rows" ? node.ownerCopies : []
					/** The rows of each owner whose copies the statement reads from its parameters (schedule.ts CopySource
					 * `held`): its slots' facts at the stratum and its nested rows. */
					const ownerRows = new Map(
						[...new Set(ownerCopies.flatMap((c) => (c.source === "held" ? [c.owner] : [])))].map(
							(owner) => {
								const fromSlots = frontend.slots.flatMap((group) =>
									group.stratum === s && group.relation.name === owner
										? group.inputs.flatMap((input) =>
												writingSlots(input).map((slot): OwnerRows => ({ kind: "slot", slot }))
											)
										: []
								)
								const layout = nestedRows.get(owner)
								return [
									owner,
									layout === undefined
										? fromSlots
										: [...fromSlots, { kind: "nestedRows" as const, stratum: s, layout }]
								] as const
							}
						)
					)
					const sql = additionsSql(w0, appended, putOwners, ownerCopies, ownerRows, stored)
					const step: FamilyWriteStep = {
						kind: "familyWrite",
						stratum: s,
						statement: "additions",
						parts: sql.parts
					}
					return Object.freeze({ kind: "write", stratum: s, node, step: Object.freeze(step), sql })
				}
				const relation = info(node.member)
				const memberEdit = stratumEdits.find((e) => e.relation.name === node.member)
				const removing: EditedMember = {
					relation,
					layout: layoutOf(relation.name),
					puts: slotOf(memberEdit?.puts),
					deletes: slotOf(memberEdit?.deletes),
					families: removedFamilies(relation)
				}
				const roots = node.refilledFrom.map((root): RefillRoot => ({
					relation: info(root),
					slot: defined(
						ownerSlots("put").find((o) => o.relation === root),
						`the put of ${root} a refill reads`
					).slot
				}))
				const deferring: ReadonlyArray<Deferring> = [
					...stratumEdits.flatMap((edit) => [
						...(edit.inserts === undefined
							? []
							: [
									{
										relation: edit.relation.name,
										slot: memberSlotOf(frontend, edit.inserts),
										as: "inserts" as const
									}
								]),
						...(edit.puts === undefined
							? []
							: [
									{
										relation: edit.relation.name,
										slot: memberSlotOf(frontend, edit.puts),
										as: "puts" as const
									}
								])
					]),
					...[...ownerSlots("put"), ...ownerSlots("delete")].map((o) => ({
						...o,
						as: "owners" as const
					}))
				]
				/** The members the edit's refills rewrite in this statement (FamilyRemovals `riders`). */
				const riders = node.riders.map((name): EditedMember => {
					const rider = info(name)
					return {
						relation: rider,
						layout: layoutOf(name),
						puts: undefined,
						deletes: undefined,
						families: removedFamilies(rider)
					}
				})
				const sql = removalsSql(w0, [removing, ...riders], roots, deferring, stored)
				const step: FamilyWriteStep = {
					kind: "familyWrite",
					stratum: s,
					statement: "removals",
					parts: sql.parts
				}
				return Object.freeze({ kind: "write", stratum: s, node, step: Object.freeze(step), sql })
			}
			const sql: FamilySql =
				node.kind === "owners"
					? unwrap(countStatement(familyOf(node.family), w, stored))
					: unwrap(rowStatement(info(node.relation), layoutOf(node.relation), node.statement, w))
			const step: FamilyStep = {
				kind: "family",
				stratum: s,
				target:
					node.kind === "owners"
						? { kind: "owners", family: node.family }
						: { kind: "rows", relation: node.relation },
				statement: sql.kind,
				relation: sql.result.relation,
				result: sql.result
			}
			return Object.freeze({ kind: "statement", stratum: s, node, step: Object.freeze(step), sql })
		})
	)
	return { placements, edits, refills }
}

/**
 * Places the family statement of `node` in `stratum`, after the statements placed so far and those `deps` gives it.
 */
export const placeFamily = (
	b: ArtifactBuilder,
	placements: ReadonlyArray<FamilyPlacement>,
	stratum: StratumAt,
	node: FamilyNode,
	deps: (placement: FamilyPlacement) => ReadonlyArray<number>
): void => {
	const placement = defined(
		placements.find((p) => p.stratum === stratum && sameNode(p.node, node)),
		"a family statement the schedule placed, built once"
	)
	switch (placement.kind) {
		case "statement": {
			const { step, sql } = placement
			placeSpec(
				b,
				step,
				Object.freeze({
					sql: sql.sql.text,
					paramSlots: Object.freeze([]),
					heading: resultHeading(sql.result),
					role: "member",
					dependsOn: Object.freeze([...deps(placement)])
				}),
				sql.ast,
				sql.sql.nameMap,
				oneForm,
				[]
			)
			return
		}
		case "write": {
			const { step, sql } = placement
			const width = maxOf(
				step.parts.map((p) => p.width),
				0
			)
			placeSpec(
				b,
				step,
				Object.freeze({
					sql: sql.sql.text,
					paramSlots: sql.params,
					heading: [
						{ name: "tag", type: plainType("int4") },
						...indices(width).map((i) => ({ name: `column ${i + 1}`, type: wildcardText }))
					],
					role: "member",
					dependsOn: Object.freeze([...deps(placement)])
				}),
				sql.ast,
				sql.sql.nameMap,
				oneForm,
				[]
			)
		}
	}
}

/** A statement placed at the next position: its step, its spec, its audited AST, its forms and the read-backs riding
 * it. */
const placeSpec = (
	b: ArtifactBuilder,
	step: Extract<
		WriteStep,
		{
			readonly kind: "write" | "advance" | "carrier" | "single" | "check" | "family" | "familyWrite"
		}
	>,
	spec: StatementSpec<WriteParamSlot>,
	ast: SqlStatement,
	nameMap: WriteStatement["sql"]["nameMap"],
	forms: ArtifactForms,
	riders: ReadonlyArray<RidingReadBack>
): number => {
	const position = b.statements.length
	b.statements.push({
		kind: "own",
		step: Object.freeze(step),
		spec,
		ast,
		forms,
		riders,
		names: nameMap
	})
	return position
}

/** A statement of one form placed at the next position. */
export const place = (
	b: ArtifactBuilder,
	statement: WriteStatement | PutStatement,
	step: Extract<WriteStep, { readonly kind: "write" | "advance" | "carrier" | "check" }>,
	dependsOn: ReadonlyArray<number>
): number =>
	placeSpec(
		b,
		step,
		writeStatementSpec(statement, dependsOn),
		statement.ast,
		statement.sql.nameMap,
		oneForm,
		[]
	)

/** The form of a built statement as an execution sends it: its text, its placeholders and its AST. */
const sentOf = (statement: {
	readonly sql: { readonly text: EmittedText }
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly ast: SqlStatement
}): SentForm =>
	Object.freeze({
		sql: statement.sql.text,
		params: statement.params,
		ast: statement.ast
	})

/**
 * The statement of the read-back `read`, lowered as `program`, placed after the artifact's statements so far, naming
 * its read-back and holding the statement it was lowered as, in its forms: its whole-relation variant its large form
 * when the read-back's optimized lowering made a per-execution choice in it.
 */
export const placeReadBack = (
	b: ArtifactBuilder,
	read: ReadBack,
	program: OptimizedDeliveryProgram<RelationChoice>,
	dependsOn: ReadonlyArray<number>
): void => {
	const run = specifiedProgram(program, b.codes)
	const spec = sentSpec(
		program.statement,
		program.parts,
		program.roots,
		(slot: DeclaredParamSlot) => slot
	)
	b.statements.push({
		kind: "readBack",
		of: Object.freeze({ name: read.name, query: read.query, run }),
		run: program.statement,
		spec: Object.freeze({
			...spec,
			role: "readBack",
			dependsOn: Object.freeze([...new Set(dependsOn)].toSorted((x, y) => x - y))
		}),
		ast: program.statement.ast,
		names: program.statement.sql.nameMap
	})
}

/** The artifact, its carriers analyzed before the statements that join them against stored relations. */
export const finish = (b: ArtifactBuilder, carriers: ReadonlyArray<WriteCarrier>): WriteArtifact =>
	withCarrierAnalysis(b.statements, Object.freeze([...carriers]))

/** How the optimized artifact's described members lower: its shape state, whose log holds the choices the statement
 * being lowered made in the per-execution mode it is lowered in, the sharing of sub-queries across its statements, and
 * the context its statements are built in. */
interface Lowering {
	readonly state: ShapeState<RelationInput>
	readonly sharing: StatementSharing
	readonly w: WriteContext
}

/** The optimized artifact: the scheduled statements, each lowered in the small per-execution mode and, when its
 * lowering made a per-execution choice, lowered again in the large mode, its whole-relation form beside its LATERAL form
 * (`StatementForms`), as a query's statements carry their forms: both forms are one placement's, with its step and
 * result. */
const optimizedArtifact = (
	frontend: WriteFrontend,
	plan: WritePlan,
	lowering: Lowering,
	options: CompileWriteOptions
): WriteArtifact => finish(optimizedPlacement(frontend, plan, lowering, options), plan.carriers)

/** The optimized artifact's statements, each with its forms.
 *
 * Every later statement reads the shared sub-query from the carrier just filled.
 *
 * Every later part reads the shared sub-query from its CTE.
 *
 * The read-back's other statements read what its first one reads. */
const optimizedPlacement = (
	frontend: WriteFrontend,
	plan: WritePlan,
	lowering: Lowering,
	options: CompileWriteOptions
): ArtifactBuilder => {
	const { w, sharing, state } = lowering
	const b = newBuilder(w.cx.names.codes)
	/**
	 * A statement in its forms: built by `build` in the small per-execution mode, and, when that build made choices,
	 * built again in the large mode, whose sent form (`sent`) is its large form. Each build begins its statement
	 * afresh, with names and placeholders of its own; both forms are the one placement's.
	 */
	const formed = <S>(
		build: () => S,
		sent: (large: S) => SentForm
	): { readonly statement: S; readonly forms: ArtifactForms } => {
		state.begin("small")
		const statement = build()
		const choices = state.drain().choices
		if (!isNonEmpty(choices)) {
			return { statement, forms: oneForm }
		}
		state.begin("large")
		const large = sent(build())
		return { statement, forms: Object.freeze({ kind: "chosen", choices, large }) }
	}
	/** A single statement's parts built by `build` in the small per-execution mode, and, when that build made choices,
	 * built again in the large mode with those choices (`formed`). */
	const formedParts = (build: () => BuiltParts): FormedParts => {
		state.begin("small")
		const small = build()
		const choices = state.drain().choices
		if (!isNonEmpty(choices)) {
			return { small, large: undefined }
		}
		state.begin("large")
		return { small, large: { built: build(), choices } }
	}
	/** How the read-backs lower: over the installed names, each Delta node read where its program says. */
	const readBackOptions = {
		names: options.names,
		reads: options.reads,
		entries: frontend.deltaEntries,
		params: frontend.params,
		schema: frontend
	}
	/** The statement `build` builds in its forms, placed after `dependsOn` with the step `step` gives of it. */
	const placed = <S extends WriteStatement | PutStatement>(
		build: () => S,
		dependsOn: ReadonlyArray<number>,
		step: (
			statement: S
		) => Extract<WriteStep, { readonly kind: "write" | "advance" | "carrier" | "check" }>
	): number => {
		const { statement, forms } = formed(build, sentOf)
		return placeSpec(
			b,
			step(statement),
			writeStatementSpec(statement, dependsOn),
			statement.ast,
			statement.sql.nameMap,
			forms,
			[]
		)
	}
	const tracker = new DependencyTracker()
	/** Each statement placed for an action so far, a membership check's under the addition it checks, with its position. */
	const recorded: Array<{ readonly action: PlanAction; readonly position: number }> = []
	const record = (action: PlanAction, position: number) => {
		recorded.push({ action, position })
	}
	/** The shared carriers a described member's statement reads. */
	const sharedReads = (node: RelNode): ReadonlyArray<string> =>
		sharing.carriersRead(node).map((carrier) => `carrier:${carrier}`)
	const describedReads = (inputs: ReadonlyArray<WriteInput>): ReadonlyArray<string> =>
		inputs.flatMap((input) => (input.kind === "described" ? sharedReads(input.node) : []))
	/** The statements an action's next statement follows: its own so far and those of the actions it depends on. */
	const actionDeps = (action: PlanAction): ReadonlyArray<number> =>
		recorded.flatMap((r) =>
			r.action.stratum === action.stratum &&
			(r.action.index === action.index || action.dependsOn.includes(r.action.index))
				? [r.position]
				: []
		)
	/** The relations an earlier write statement of this artifact wrote, in plan order, which is R's statements' order. */
	const writtenRelations = new Set<string>()
	/** Whether an earlier write statement of this artifact wrote `relation`, the next one writing it: a netted relation's
	 * write statements after its first net against the pending sets. */
	const writtenBefore = (relation: string): boolean => {
		const earlier = writtenRelations.has(relation)
		writtenRelations.add(relation)
		return earlier
	}
	/** A planned write's statement in `context` with the CTEs that fill its delta carriers, netted against the pending
	 * sets when `earlier` (writtenBefore). */
	const writeOf = (
		context: WriteContext,
		step: PlannedWrite,
		earlier: boolean
	): ModifyingStatement<InsertResult> | ModifyingStatement<DeleteResult> | PutStatement =>
		withDeltaFills(
			buildWriteOp(context, step),
			plan.deltas.carriers.get(step.relation.name),
			earlier,
			context.names
		)
	/** A planned write's step, of its statement `filled`. */
	const writeStep = (
		step: PlannedWrite,
		filled: ModifyingStatement<InsertResult> | ModifyingStatement<DeleteResult> | PutStatement
	): Extract<WriteStep, { readonly kind: "write" }> => ({
		kind: "write",
		stratum: step.action.stratum,
		action: step.action.index,
		relation: step.relation.name,
		result: filled.result,
		skipWhenEmpty: filled.skipWhenEmpty,
		uniqueAborts: uniqueAbortsOf(step.relation, abortsOf(step))
	})
	/** What a planned write reads and writes after which actions, for the dependency tracker. */
	const writeAccess = (
		step: PlannedWrite
	): readonly [ReadonlyArray<string>, ReadonlyArray<string>, ReadonlyArray<number>] => {
		const inputs = [step.input, ...(step.op === "exactDelete" ? step.except : [])]
		return [
			[...inputReads(inputs), ...describedReads(inputs), `relation:${step.relation.name}`],
			[`relation:${step.relation.name}`, ...deltaCarrierNames(plan, step.relation.name)],
			actionDeps(step.action)
		]
	}
	/** The family statements, each placed where its stratum's schedule runs it (plan step `family`). */
	const families = familyProgram(frontend, w).placements
	const familyDeps = (placement: FamilyPlacement): ReadonlyArray<number> => {
		const relations = placementRelations(placement).map((r) => `relation:${r}`)
		return tracker.add(
			placement.kind === "write" || placement.step.target.kind === "owners" ? relations : [],
			relations
		)
	}
	for (const step of plan.steps) {
		switch (step.kind) {
			case "family":
				placeFamily(b, families, step.stratum, step.node, familyDeps)
				break
			case "createCarrier": {
				const deps = tracker.add([], [`carrier:${step.carrier.name}`])
				placed(
					() => buildCreateCarrier(w, step.carrier),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "create",
						stratum: step.stratum,
						casts: castsNothing
					})
				)
				break
			}
			case "fillMember": {
				const reads = [
					...step.node.meta.reads.map((r) => `relation:${r}`),
					...sharedReads(step.node)
				]
				const deps = tracker.add(reads, [`carrier:${step.carrier.name}`])
				placed(
					() => buildFillCarrier(w, step.carrier, { kind: "member", node: step.node }),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "fill",
						stratum: step.stratum,
						casts: { kind: "member", relation: step.relation, stratum: step.stratum }
					})
				)
				break
			}
			case "fillShare": {
				const { share } = step
				const reads = share.node.meta.reads.map((r) => `relation:${r}`)
				const deps = tracker.add(reads, [`carrier:${step.carrier.name}`])
				/** A shared sub-query's fill lowers its own copies rather than reading the carrier it fills. */
				const fill = { ...w, cx: w.cx.withDispatch(sharing.filling(share)) }
				placed(
					() => buildFillCarrier(fill, step.carrier, { kind: "member", node: share.node }),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "fill",
						stratum: step.stratum,
						casts: castsNothing
					})
				)
				sharing.carry(share, {
					kind: "carrier",
					carrier: step.carrier.name,
					columns: carrierColumns(step.carrier)
				})
				break
			}
			case "write": {
				const earlier = writtenBefore(step.relation.name)
				const position = placed(
					() => writeOf(w, step, earlier),
					tracker.addAfter(...writeAccess(step)),
					(filled) => writeStep(step, filled)
				)
				record(step.action, position)
				break
			}
			case "single": {
				const parts = mapNonEmpty(step.writes, (planned) => ({
					planned,
					earlier: writtenBefore(planned.relation.name)
				}))
				/** The shared sub-queries and the writes, each a statement of its own whose names start past the parts
				 * before it, and where the names after them start. */
				const buildParts = (): BuiltParts => {
					let start = ownStatement
					const shares: Array<SharedPart> = []
					for (const share of step.shares) {
						const heading = share.node.heading.map((c) => ({
							name: c.name,
							type: c.type
						}))
						/** A shared sub-query's CTE lowers its own copies rather than reading itself. */
						const fill = { ...w, start, cx: w.cx.withDispatch(sharing.filling(share)) }
						const at = `shared sub-query ${share.node.id}`
						const supply = new NameSupply(start)
						const placeholders = new WriteParams()
						fill.cx.beginWriteStatement(supply, placeholders)
						const query = memberRows(fill, heading, share.node, at)
						const params = [...placeholders.slots]
						const names = freshNames(namesPast(supply.map(), ownStatement), heading.length)
						start = names.next
						shares.push({
							name: names.relation,
							columns: names.columns,
							query,
							params,
							nameMap: [...supply.map(), ...names.nameMap]
						})
						sharing.carry(share, {
							kind: "enclosing",
							name: names.relation,
							columns: names.columns
						})
					}
					const writes = mapNonEmpty(parts, (part) => {
						const statement = writeOf({ ...w, start }, part.planned, part.earlier)
						start = namesPast(statement.sql.nameMap, ownStatement)
						return { step: writeStep(part.planned, statement), statement }
					})
					return { shares, writes, start }
				}
				const position = b.statements.length
				const { single, writes, forms, riders } = isNonEmpty(step.readBacks)
					? ridingSingle(step.readBacks, formedParts(buildParts), {
							frontend,
							deltas: plan.deltas,
							lower: (read, deltas, start) => lowerReadBack(read, deltas, start, readBackOptions)
						})
					: (() => {
							const plain = formed(
								() => {
									const built = buildParts()
									return { single: singleOf(built, noRiding), writes: built.writes }
								},
								(large) => sentOf(large.single)
							)
							return { ...plain.statement, forms: plain.forms, riders: [] }
						})()
				/** What the parts read, past the shared sub-queries the statement now carries, and what its riding
				 * read-backs read. */
				const accesses = mapNonEmpty(step.writes, (planned) => writeAccess(planned))
				const deps = tracker.addAfter(
					[
						...accesses.flatMap((x) => x[0]),
						...step.readBacks.flatMap((read) => read.node.meta.reads.map((r) => `relation:${r}`))
					],
					accesses.flatMap((x) => x[1]),
					step.writes.flatMap((x) => actionDeps(x.action))
				)
				placeSpec(
					b,
					{
						kind: "single",
						stratum: step.stratum,
						parts: mapNonEmpty(writes, (x) => ({
							step: x.step,
							width: resultHeading(x.step.result).length
						})),
						uniqueAborts: writes.flatMap((x) => x.step.uniqueAborts)
					},
					singleStatementSpec(single, deps),
					single.ast,
					single.sql.nameMap,
					forms,
					riders
				)
				for (const x of step.writes) {
					record(x.action, position)
				}
				break
			}
			case "advance": {
				const spec = { relation: step.relation, input: step.input }
				for (const field of step.fields) {
					const deps = tracker.addAfter(
						[...inputReads([step.input]), ...describedReads([step.input])],
						[`sequence:${step.relation.name}.${field.name}`],
						actionDeps(step.action)
					)
					const position = placed(
						() => buildSequenceAdvance(w, spec, field),
						deps,
						(statement) => ({
							kind: "advance",
							stratum: step.action.stratum,
							action: step.action.index,
							relation: step.relation.name,
							field: field.name,
							skipWhenEmpty: statement.skipWhenEmpty
						})
					)
					record(step.action, position)
				}
				break
			}
			case "classify": {
				/** The classification after an insert into a span primary key reads the relation the insert wrote and
				 * the same input, so it follows the insert. */
				const deps = tracker.addAfter(
					[
						...inputReads([step.input]),
						...describedReads([step.input]),
						`relation:${step.relation.name}`
					],
					[],
					actionDeps(step.action)
				)
				const position = placed(
					() =>
						buildSpanClassify(
							w,
							{
								relation: step.relation,
								serial: step.serial,
								input: step.input,
								of: step.of
							},
							step.span
						),
					deps,
					(statement) => ({
						kind: "write",
						stratum: step.action.stratum,
						action: step.action.index,
						relation: step.relation.name,
						result: statement.result,
						skipWhenEmpty: statement.skipWhenEmpty,
						uniqueAborts: []
					})
				)
				record(step.action, position)
				break
			}
			case "check": {
				const deps = tracker.addAfter(
					[...inputReads([step.input]), ...describedReads([step.input]), ...checkReads(step)],
					[],
					step.check.kind === "membership" ? actionDeps(step.check.action) : []
				)
				const position = placed(
					() => buildEntryCheck(w, step.input, entryCheckOf(step, frontend)),
					deps,
					(statement) => ({
						kind: "check",
						stratum: step.stratum,
						entry: statement.result.entry,
						skipWhenEmpty: statement.skipWhenEmpty
					})
				)
				if (step.check.kind === "membership") {
					record(step.check.action, position)
				}
				break
			}
			case "readBack": {
				const deltas: DeltasOf = (relation, side) =>
					deltaSourceIn(relation, frontend.deltaEntries, (target) =>
						plannedDelta(plan.deltas, target, side)
					)
				const program = lowerReadBack(step.read, deltas, startNames, readBackOptions)
				const reads = [
					...step.read.node.meta.reads.map((r) => `relation:${r}`),
					...step.read.deltas.flatMap((d) =>
						deltaCarrierNames(
							plan,
							frontend.deltaEntries.get(d.relation)?.target.name ?? d.relation
						)
					)
				]
				placeReadBack(b, step.read, program, tracker.add(reads, []))
				break
			}
		}
	}
	return b
}

/** A single statement's parts as one build in one per-execution mode makes them: its shared sub-queries, its writes,
 * each with its step, and where the names after them start (singleStatement `start`). */
interface BuiltParts {
	readonly shares: ReadonlyArray<SharedPart>
	readonly writes: NonEmptyReadonlyArray<{
		readonly step: Extract<WriteStep, { readonly kind: "write" }>
		readonly statement:
			| ModifyingStatement<InsertResult>
			| ModifyingStatement<DeleteResult>
			| PutStatement
	}>
	readonly start: NameSupplyStart
}

/** A single statement's parts in their forms: built in the small mode, and in the large mode with the choices the small
 * build made, where it made any. */
interface FormedParts {
	readonly small: BuiltParts
	readonly large:
		| { readonly built: BuiltParts; readonly choices: NonEmptyReadonlyArray<RelationChoice> }
		| undefined
}

/** The single statement of `built`'s parts, `riding` riding it. */
const singleOf = (built: BuiltParts, riding: Riding): SingleStatement =>
	singleStatement(
		built.shares,
		mapNonEmpty(built.writes, (x) => ({
			statement: x.statement,
			width: resultHeading(x.step.result).length
		})),
		riding,
		built.start
	)

/** Where the names of the single statement of `built`'s parts end: past its parts' names and each write part's own CTE
 * (single.ts singleStatement). */
const builtEnd = (built: BuiltParts): NameSupplyStart =>
	built.writes.reduce(
		(at, x) => freshNames(at, resultHeading(x.step.result).length).next,
		built.start
	)

/** The numbering past every name `a` and `b` are each past. */
const laterStart = (a: NameSupplyStart, b: NameSupplyStart): NameSupplyStart => ({
	relationStart: Math.max(a.relationStart, b.relationStart),
	columnStart: Math.max(a.columnStart, b.columnStart)
})

/**
 * A read-back's statement as a part of the statement it rides, the names its part adds drawn from `supply`, and the
 * part as the runtime reads it: one part's executable query numbered where it orders (lower/parts.ts partQuery); a
 * statement of tagged parts whole, its cells after the outer tag its own tag and cells, which the runtime divides
 * again (shapes/index.ts StatementParts).
 */
const ridingPartOf = (
	statement: SentStatement,
	width: number,
	supply: NameSupply
): { readonly part: ReadBackPart; readonly shape: TaggedPart } => {
	const nameMap = (): NameMap => [...statement.sql.nameMap, ...supply.map()]
	if (!isPlainQuery(statement.ast)) {
		return {
			part: { query: statement.ast, params: statement.params, nameMap: nameMap(), width },
			shape: { kind: "rows", width }
		}
	}
	const { query, columns, shape } = partQuery(statement.ast, supply)
	return {
		part: { query, params: statement.params, nameMap: nameMap(), width: columns.length },
		shape
	}
}

/** What riding a single statement reads beside its parts: the write's front end, its delta plan, and how a read-back
 * lowers over the deltas and naming start it is given. */
interface RidingContext {
	readonly frontend: WriteFrontend
	readonly deltas: WritePlan["deltas"]
	readonly lower: (read: ReadBack, deltas: DeltasOf, start: NameSupplyStart) => OptimizedProgram
}

/**
 * The single statement of `formed`'s parts with the read-backs `readBacks` riding it (write/schedule/plan.ts
 * placeReadBacks), in its forms, its writes as the small build made them, and each riding read-back with where its rows
 * stand among the statement's.
 *
 * Every delta a riding read-back names of a relation the statement writes is one CTE of the statement over that
 * write's RETURNING (write/readback/deltas.ts deltaCte), named once past every name either form's parts define, so it
 * has one name in both forms; a delta of a relation no statement writes is the empty relation. Each read-back is
 * lowered over those deltas, its statement named past them and past every earlier read-back's
 * (lower/conservative/types.ts ReadBackLowering start), and its statement is one part of the statement after the writes'
 * parts, in order, the names its part adds past all of those (`ridingPartOf`). The statement's
 * large form, where its writes or a read-back's statement made a per-execution choice, holds each part's large form,
 * a part of one form its own, and its choices are all of theirs.
 */
const ridingSingle = (
	readBacks: NonEmptyReadonlyArray<ReadBack>,
	formed: FormedParts,
	context: RidingContext
): {
	readonly single: SingleStatement
	readonly writes: BuiltParts["writes"]
	readonly forms: ArtifactForms
	readonly riders: ReadonlyArray<RidingReadBack>
} => {
	const { small, large } = formed
	const { frontend } = context
	const start =
		large === undefined ? builtEnd(small) : laterStart(builtEnd(small), builtEnd(large.built))
	const named = new Map(
		frontend.deltas.flatMap((d) => (d.kind === "relation" ? [[d.relation.name, d] as const] : []))
	)
	const targetOf = (relation: string): string =>
		frontend.deltaEntries.get(relation)?.target.name ?? relation
	const supply = new NameSupply(start)
	/** Each delta a riding read-back names of a relation the statement writes, by relation and side, in the order of
	 * the statement's writes. */
	const names = new Map<string, Map<"added" | "removed", DeltaCteName>>()
	for (const x of small.writes) {
		const relation = x.step.relation
		const delta = named.get(relation)
		const sides = new Set(
			readBacks.flatMap((read) =>
				read.deltas.flatMap((d) => (targetOf(d.relation) === relation ? [d.side] : []))
			)
		)
		if (delta === undefined || sides.size === 0) {
			continue
		}
		const own = new Map<"added" | "removed", DeltaCteName>()
		for (const side of (["added", "removed"] as const).filter((s) => sides.has(s))) {
			own.set(side, deltaCteName(delta.relation, side, supply))
		}
		names.set(relation, own)
	}
	const deltaNames: NameMap = supply.map()
	const statementOf = (built: BuiltParts, relation: string) =>
		defined(
			built.writes.find((x) => x.step.relation === relation),
			`the write of ${relation} in the statement a read-back rides`
		).statement
	const held = (target: string, side: "added" | "removed"): DeltaHeld | undefined => {
		const cte = names.get(target)?.get(side)
		return cte === undefined
			? plannedDelta(context.deltas, target, side)
			: deltaIn(statementOf(small, target), cte)
	}
	const deltas: DeltasOf = (relation, side) =>
		deltaSourceIn(relation, frontend.deltaEntries, (target) => held(target, side))
	let cursor = namesPast(deltaNames, start)
	const placed = readBacks.map((read, at) => {
		const program = context.lower(read, deltas, cursor)
		const statement = program.statement
		cursor = namesPast(statement.sql.nameMap, cursor)
		if (statement.forms.kind === "chosen") {
			cursor = namesPast(statement.forms.large.sql.nameMap, cursor)
		}
		const width = sentHeading(program.parts, program.roots).length
		const own = ridingPartOf(statement, width, new NameSupply(cursor))
		cursor = namesPast(own.part.nameMap, cursor)
		const big =
			statement.forms.kind === "one"
				? undefined
				: ridingPartOf(statement.forms.large, width, new NameSupply(cursor))
		if (big !== undefined) {
			cursor = namesPast(big.part.nameMap, cursor)
		}
		const rider: RidingReadBack = Object.freeze({
			name: read.name,
			query: read.query,
			run: Object.freeze({
				delivery: program.delivery,
				parts: program.parts,
				roots: program.roots
			}),
			tag: small.writes.length + at,
			part: own.shape
		})
		return {
			rider,
			small: own.part,
			large: big?.part ?? own.part,
			choices: statement.forms.kind === "one" ? [] : statement.forms.choices
		}
	})
	const parts = placed
	const ridingIn = (built: BuiltParts, form: "small" | "large"): Riding => ({
		deltas: [...names].flatMap(([relation, sides]) =>
			[...sides.values()].flatMap((cte) => {
				const one = deltaCte(statementOf(built, relation), cte)
				return one === undefined ? [] : [one]
			})
		),
		nameMap: deltaNames,
		parts: parts.map((p) => p[form])
	})
	const single = singleOf(small, ridingIn(small, "small"))
	const choices = [...(large?.choices ?? []), ...parts.flatMap((p) => p.choices)]
	const riders = placed.map((p) => p.rider)
	if (!isNonEmpty(choices)) {
		return { single, writes: small.writes, forms: oneForm, riders }
	}
	const built = large?.built ?? small
	const largeSingle = singleOf(built, ridingIn(built, "large"))
	return {
		single,
		writes: small.writes,
		forms: Object.freeze({ kind: "chosen", choices, large: sentOf(largeSingle) }),
		riders
	}
}

/** The statement of one planned write op. */
const buildWriteOp = (
	w: WriteContext,
	step: PlannedWrite
): ModifyingStatement<InsertResult> | ModifyingStatement<DeleteResult> | PutStatement => {
	const { relation, input } = step
	switch (step.op) {
		case "insert":
			return buildInsert(w, {
				relation,
				serial: step.serial,
				input,
				of: "insert"
			})
		case "exactDelete":
			return buildExactDelete(w, { relation, input, except: step.except })
		case "anchoredDelete":
			return buildAnchoredDelete(w, { relation, anchor: step.anchor })
		case "displace":
			return buildDisplacingDelete(w, { relation, input, payload: step.payload })
		case "putInsert":
			return buildInsert(w, {
				relation,
				serial: completeClass,
				input,
				of: "put"
			})
		case "upsert":
			return buildUpsert(w, {
				relation,
				input: step.input,
				inPlace: step.inPlace,
				arbiter: step.arbiter
			})
		case "updateFrom":
			return buildUpdateFrom(w, { relation, input, inPlace: step.inPlace })
		case "merge":
			return buildMerge(w, {
				relation,
				input,
				inPlace: step.inPlace,
				arbiter: step.arbiter,
				scope: step.scope
			})
	}
}

/** Which of an insert's unique violations abort the apply, by the class it inserts. */
export const insertAborts = (serial: SerialClass): AbortKind =>
	serial.kind === "generated" ? { kind: "generated", serial } : { kind: "probed" }

/** Which of a write op's unique violations abort the apply (uniqueAbortsOf). */
const abortsOf = (step: PlannedWrite): AbortKind => {
	switch (step.op) {
		case "insert":
			return insertAborts(step.serial)
		case "putInsert":
		case "upsert":
			return { kind: "probed" }
		case "merge":
			return { kind: "merge" }
		case "exactDelete":
		case "anchoredDelete":
		case "displace":
		case "updateFrom":
			return { kind: "other" }
	}
}

/** The duplicate-elimination placement the optimized artifact lowers its described members under, and the shape facts
 * it gives. No root of the write DAG observes repeats, because each consumer of a
 * member decides its own set boundary: a write statement reads it through SELECT DISTINCT unless distinctByEvidence
 * proves it distinct, a deletion and a sequence advance ignore repeats, and a read-back is lowered on its own.
 * So the placement places a DISTINCT only where a node inside a member observes repeats, a fold, a
 * bound or a set form, and elides every other boundary the conservative realization emits, each elision under its
 * certificate. The conservative artifact keeps every boundary, and the write oracle compares the two. Its proofs
 * resolve keys through the schema's catalog: its constraints and its views' unique indexes,
 * named as the installation installs them. */
const writeFacts = (
	dag: RelDag,
	schema: CatalogSchema
): { readonly facts: ShapeFacts; readonly certificates: ReadonlyArray<Certificate> } => {
	const placement = unwrap(
		placeDeduplication(dag, {
			context: "transaction",
			/** A write program records no constraint premise: its statements run in the transaction they prove for. */
			catalog: evidenceCatalog(schema),
			roots: "ignored"
		})
	)
	const certificates: Array<Certificate> = [...placement.certificates]
	const facts = shapeFactsFromPlan(placement, {
		derivedDefinition: false,
		certify: (certificate) => {
			if (!certificates.some((c) => canonicalEquals(c, certificate, everyProperty))) {
				certificates.push(certificate)
			}
		}
	})
	return { facts, certificates }
}

/** The check a planned check of a query entry builds: its membership against the base, under
 * the role's names, or the refusal of a whole addition. A membership check exists only in a role's compilation, whose
 * frontend wrote a query entry. */
const entryCheckOf = (
	step: Extract<PlanStep, { readonly kind: "check" }>,
	frontend: WriteFrontend
): EntryCheck => {
	const check = step.check
	if (check.kind === "outside") {
		return check
	}
	const { relation } = check
	return {
		kind: "membership",
		entry: check.entry,
		relation,
		probes: outsideProbes(relation, check.serial),
		base: frontend.schema.definitions(),
		catalog: evidenceCatalog(frontend),
		world: check.names
	}
}

/** The relations a check of a query entry reads beside its input: the entry's target and every relation its filter
 * reads. */
const checkReads = (step: Extract<PlanStep, { readonly kind: "check" }>): ReadonlyArray<string> => {
	const check = step.check
	if (check.kind === "outside") {
		return []
	}
	const filter = check.entry.filter
	const read = filter.kind === "none" ? [] : [...queryUses(filter.query).relations]
	return [check.entry.target.name, ...read].map((r) => `relation:${r}`)
}

const compile = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: CompileWriteOptions
): CompiledWrite => {
	const frontend = unwrap(
		compileChangeSet(schema, desc, {
			claims: options.claims,
			laws: options.laws,
			derived: options.derived,
			world: options.world,
			codes: options.names.codes
		})
	)
	const chosen = choosePutTargets(frontend)
	/** The optimized artifact lowers the restated write DAG (`WriteFrontend.restated`), its actions and read-backs each
	 * the restated node standing in its place, and each put its choice; the conservative realization lowers the checked
	 * one. */
	const restated: WriteFrontend = Object.freeze({ ...frontend, ...frontend.restated })
	const placed = writeFacts(restated.ir.dag, frontend)
	/** The statements every lowering below builds, shared where their requests are equal. */
	const share = new StatementShare()
	/** A write's described members lower statement by statement in each per-execution mode, and no CTE policy shares
	 * their stages. */
	const state = new ShapeState<RelationInput>("small", emptyCtePlan)
	const sharing = new StatementSharing(
		new ShareIndex(restated.ir.dag),
		optimizedDispatch(placed.facts, state)
	)
	const lowering: Lowering = {
		state,
		sharing,
		w: writeContext(restated.ir.dag, {
			names: options.names,
			reads: options.reads,
			params: frontend.params,
			dispatch: sharing.dispatch,
			share,
			level: options.level
		})
	}
	const plan = planWrite(restated, chosenIn(chosen, frontend.restate), {
		level: options.level,
		distinct: (node, relation) => distinctByEvidence(placed.facts, node, relation),
		shares: (members) => unwrap(planStatementShares(sharing.index, members)),
		carrierTyping: (t, at) => lowering.w.cx.typeRef(t, at)
	})
	const optimized = optimizedArtifact(restated, plan, lowering, options)
	unwrap(insertOnly(schema, optimized.statements, options.names, options.laws))
	const family = familyProgram(restated, lowering.w)
	const program: CompiledWrite = {
		level: options.level,
		edits: family.edits,
		refills: family.refills,
		kind: "write",
		context: "transaction",
		optimized: optimized.specs,
		certificates: placed.certificates,
		frontend,
		choices: chosen.choices,
		plan,
		artifact: optimized,
		placements: family.placements,
		params: frontend.params,
		slots: frontend.slots,
		binding: decideBinding(frontend)
	}
	return program
}

/** The WriteProgram of a ChangeSet's Description against a checked schema.
 *
 * Compiling a ChangeSet into its WriteProgram.
 *
 * "WriteProgram: a ChangeSet's compiled artifacts: per stratum, the insert, delete, and put statements chosen per
 * relation, their RETURNING channels that form delta.added and delta.removed, netted across strata (added minus
 * later-removed, removed minus later-added), the read-back statements over the post-change state, the outcome decoders
 * for counts, reads, and witnesses. Reusable across sessions".
 * compileWrite builds it in five steps:
 *
 * 1. The write front end: the ChangeSetDesc checked against the schema and grouped into the WriteIR's actions
 *    (frontend/).
 * 2. The put targets: each put's statement, chosen with the proofs the whole ChangeSet and its DAG
 *    give.
 * 3. The schedule: the statements in order, each described member a leading CTE or a carrier, each read-back riding
 *    the one statement that writes its deltas or after the strata with the delta carriers its rows cross statements
 *    in, and each stratum where one snapshot suffices one single statement.
 * 4. The optimized artifact: each planned statement built by its package (insert/, delete/, serial/, carriers/, put/),
 *    each write statement extended with the CTEs that fill its delta carriers from its RETURNING,
 *    a single statement's writes its parts,
 *    and each read-back lowered over the post-change state. Each carrier is analyzed after it is filled and before
 *    the first statement that joins it against a stored relation. The conservative realization, the write oracle's
 *    baseline, is no part of it (test/support/conservative.ts conservativeWrite).
 * 5. The template: its requirements, and the outcome: count rules, the witness decoder and the constraint-to-law map.
 *
 * A WriteProgram holds no parameter value; binding normalizes and encodes one application's inputs as their arrays,
 * and says which statements an empty input lets the runtime skip. */
export const compileWrite = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: CompileWriteOptions
): Result.Result<CompiledWrite, CompileError> => catchRefusal(() => compile(schema, desc, options))
