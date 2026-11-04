import type { CheckedSchema, DerivedAnalysis } from "#compiler/analysis/schema.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { canonicalEquals, catchRefusal, everyProperty, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty } from "#compiler/core/nonempty.ts"
import { compileBudgets, cteShareMinRefs } from "#compiler/core/policy.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { ChangeSetDesc } from "#compiler/ir/desc.ts"
import type {
	CountRule,
	ParamDecl,
	StatementSpec,
	WriteProgram,
	WriteSlot
} from "#compiler/ir/products.ts"
import type { RelDag, RelNode } from "#compiler/ir/rel.ts"
import type { ReadBack } from "#compiler/ir/write.ts"
import { type CatalogSchema, evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { LawModel } from "#compiler/laws/model/model.ts"
import type { UniqueObject } from "#compiler/laws/model/uniques.ts"
import { WriteParams } from "#compiler/lower/conservative/context.ts"
import {
	flight,
	mapTree,
	type PhysicalNames,
	type WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import { placeDeduplication } from "#compiler/lower/optimize/dedup/place.ts"
import {
	deliveredAsOptimized,
	type FusedStatement,
	type OptimizedDeliveryProgram,
	type OptimizedStatement,
	oneForm,
	optimizedDispatch,
	type RelationChoice,
	ShapeState
} from "#compiler/lower/shapes/index.ts"
import { type ShapeFacts, shapeFactsFromPlan } from "#compiler/lower/shapes/share/physical.ts"
import {
	planStatementShares,
	ShareIndex,
	StatementSharing
} from "#compiler/lower/shapes/share/statements.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { declaredSlotOf, statementSpec, writeSlotOf } from "#compiler/lower/template.ts"
import { withoutSerial } from "#compiler/scalar/compute/types.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import type { EmittedText, SqlStatement } from "#compiler/sql/ast.ts"
import { NameSupply } from "#compiler/sql/naming.ts"
import {
	buildCreateCarrier,
	buildFillCarrier,
	type Carrier,
	carrierColumns,
	memberRows
} from "#compiler/write/carriers/carriers.ts"

import {
	type ConservativeWrite,
	realizeConservative
} from "#compiler/write/conservative/realize.ts"
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

import {
	compileChangeSet,
	type SlotGroup,
	type WriteFrontend,
	type WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import type { EntryClaims } from "#compiler/write/frontend/entry.ts"
import { distinctByEvidence, type WriteInput } from "#compiler/write/insert/input.ts"
import { buildInsert, buildSpanClassify } from "#compiler/write/insert/protocol.ts"
import {
	type DeleteResult,
	type InsertResult,
	type ModifyingStatement,
	namesPast,
	ownStatement,
	StatementShare,
	type WriteContext,
	type WriteNames,
	type WriteStatement,
	writeContext
} from "#compiler/write/insert/statement.ts"
import { readsSerial } from "#compiler/write/insert/unique.ts"
import { withCarrierAnalysis } from "#compiler/write/program/analyze.ts"
import {
	type ArtifactForms,
	byStratum,
	changeTags,
	DependencyTracker,
	type PlacedLarge,
	type PlacedStatement,
	type ReadBackOf,
	readBackSpecs,
	resultHeading,
	singleStatementSpec,
	type SentForm,
	specifiedRun,
	type UniqueAbort,
	type WriteArtifact,
	type WriteStep,
	writeRows,
	writeStatementSpec
} from "#compiler/write/program/artifact.ts"
import {
	type OutcomeContext,
	witnessDecoder,
	writtenOutcome
} from "#compiler/write/program/outcome.ts"
import { freshNames, type SharedPart, singleStatement } from "#compiler/write/program/single.ts"
import { choosePutTargets, chosenIn, type PutChoice } from "#compiler/write/put/choose.ts"
import {
	buildMerge,
	buildUpdateFrom,
	buildUpsert,
	type PutStatement
} from "#compiler/write/put/statement.ts"
import { carriersOf, withDeltaFills } from "#compiler/write/readback/deltas.ts"
import { lowerReadBack } from "#compiler/write/readback/lower.ts"
import {
	type PlanAction,
	type PlannedWrite,
	type PlanStep,
	planWrite,
	type WritePlan
} from "#compiler/write/schedule/plan.ts"
import { buildSequenceAdvance, serialOrder } from "#compiler/write/serial/advance.ts"

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
}

export interface CompiledWrite extends WriteProgram {
	readonly frontend: WriteFrontend
	readonly choices: ReadonlyArray<PutChoice>
	readonly plan: WritePlan
	readonly artifacts: { readonly optimized: WriteArtifact; readonly conservative: WriteArtifact }
	/** The parameters the members and read-backs declare, and the enumerated member slots binding fills. */
	readonly params: ReadonlyArray<ParamDecl>
	readonly slots: ReadonlyArray<SlotGroup>
	readonly outcomeContext: OutcomeContext
}

const unwrap = <A>(r: Result.Result<A, CompileError>): A => {
	if (!r.ok) {
		throw new Refusal(r.error)
	}
	return r.value
}

/** The 23505 and 23P01 violations at a statement into `relation` that abort the apply: a generated addition's at every
 * unique object, which its probe leaves only an occupant its snapshot did not see at an object that reads no serial
 * field, and at one that reads a serial field a stored value the sequence had not passed; a MERGE insert at the primary
 * key its put targets, or at a unique object besides it, which compares every field of that key (`uniqueBesideKey`),
 * so it is the same concurrent commit; and a probed insert's, at every unique object besides its arbiter, which after
 * the probe only an occupant its snapshot did not see raises. */
const uniqueAbortsOf = (
	relation: WrittenRelation,
	kind: "generated" | "merge" | "probed" | "other"
): ReadonlyArray<UniqueAbort> => {
	const aborts = (
		objects: ReadonlyArray<UniqueObject>,
		reason: UniqueAbort["reason"]
	): ReadonlyArray<UniqueAbort> =>
		objects.map((u) => ({ constraint: u.name, relation: relation.name, reason }))
	const { arbiter, others } = relation.uniques
	switch (kind) {
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
				reason: readsSerial(u) ? "GeneratedSerialUnique" : "UnseenOccupant"
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

interface ArtifactBuilder {
	/** Each statement placed so far, a read-back's naming its read-back, with its audited AST for the carriers'
	 * analysis; its length is the position the next statement placed takes. */
	readonly statements: Array<PlacedStatement>
}

const newBuilder = (): ArtifactBuilder => ({ statements: [] })

/** A statement placed at the next position: its step, its spec, its audited AST and its forms. */
const placeSpec = (
	b: ArtifactBuilder,
	step: Extract<WriteStep, { readonly kind: "write" | "advance" | "carrier" | "single" | "check" }>,
	spec: StatementSpec<WriteSlot>,
	ast: SqlStatement,
	nameMap: WriteStatement["sql"]["nameMap"],
	forms: ArtifactForms
): number => {
	const position = b.statements.length
	b.statements.push({
		kind: "own",
		step: Object.freeze(step),
		spec,
		ast,
		forms,
		names: nameMap
	})
	return position
}

/** A statement of one form placed at the next position. */
const place = (
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
		oneForm
	)

/** The form of a built statement as an execution sends it: its text, its placeholders' encoders and its AST. */
const sentOf = (statement: {
	readonly sql: { readonly text: EmittedText }
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly ast: SqlStatement
}): SentForm =>
	Object.freeze({
		sql: statement.sql.text,
		paramSlots: Object.freeze(statement.params.map(writeSlotOf)),
		ast: statement.ast
	})

/** A read-back statement at artifact position `position` with its forms as placed: when its lowering made
 * per-execution choices, its whole-relation form with the executable text and encoders an execution sends. */
const placedRun = (
	statement: OptimizedStatement<RelationChoice, FusedStatement>,
	position: number
): OptimizedStatement<RelationChoice, PlacedLarge> => {
	const forms = statement.forms
	if (forms.kind === "one") {
		return { ...statement, forms }
	}
	const spec = unwrap(statementSpec(forms.large, { kind: "unmetered" }, position, declaredSlotOf))
	return {
		...statement,
		forms: Object.freeze({
			kind: "chosen",
			choices: forms.choices,
			large: Object.freeze({
				statement: forms.large,
				sent: Object.freeze({
					sql: spec.sql,
					paramSlots: spec.paramSlots,
					ast: forms.large.ast
				})
			})
		})
	}
}

/** The statements of the read-back `read`, lowered as `program`, placed after the artifact's statements so far, each
 * naming its read-back and holding the statement it was lowered as, with its whole-relation variant as its large form
 * when the read-back's optimized lowering made a per-execution choice in it. */
const placeReadBack = (
	b: ArtifactBuilder,
	read: ReadBack,
	program: OptimizedDeliveryProgram<RelationChoice, FusedStatement>,
	extraDeps: ReadonlyArray<number>
): void => {
	const offset = b.statements.length
	const placed = mapTree(readBackSpecs(program.roots, offset), ({ statement, spec }, i) => {
		const deps = new Set([...spec.dependsOn, ...extraDeps])
		return {
			statement,
			run: placedRun(statement, offset + i),
			spec: Object.freeze({
				...spec,
				dependsOn: Object.freeze([...deps].toSorted((x, y) => x - y))
			})
		}
	})
	const of: ReadBackOf = Object.freeze({
		name: read.name,
		query: read.query,
		run: Object.freeze({
			delivery: program.delivery,
			roots: mapTree(placed, (p) => specifiedRun(p.run, p.spec))
		})
	})
	for (const { statement, run, spec } of flight(placed)) {
		b.statements.push({
			kind: "readBack",
			of,
			run,
			spec,
			ast: statement.ast,
			names: statement.sql.nameMap
		})
	}
}

/** The text of `sql` charged to the meter as the statement of the program at `path`, which it sends. */
const chargeSent = (
	meter: BudgetMeter,
	sql: string,
	path: ReadonlyArray<string | number>
): void => {
	const charged = meter.chargeSql(sql, SourceLoc("write program", path))
	if (!charged.ok) {
		throw new Refusal(charged.error)
	}
}

/** The artifact, its carriers analyzed before the statements that join them against stored relations, and the text of
 * every statement it sends charged to the meter once: each statement's, and its whole-relation form's beside it. */
const finish = (
	b: ArtifactBuilder,
	carriers: ReadonlyArray<Carrier>,
	meter: BudgetMeter
): WriteArtifact => {
	const artifact = withCarrierAnalysis(b.statements, Object.freeze([...carriers]))
	for (const statement of artifact.statements) {
		chargeSent(meter, statement.spec.sql, ["statements", statement.index])
		if (statement.forms.kind === "chosen") {
			chargeSent(meter, statement.forms.large.sql, ["statements", statement.index, "large"])
		}
	}
	return artifact
}

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
 * result. A statement of two forms is charged to the variants budget. */
const optimizedArtifact = (
	frontend: WriteFrontend,
	plan: WritePlan,
	lowering: Lowering,
	options: CompileWriteOptions
): WriteArtifact => {
	const meter = lowering.w.meter
	const builder = optimizedPlacement(frontend, plan, lowering, options)
	for (const [i, p] of builder.statements.entries()) {
		if (p.kind === "own" && p.forms.kind === "chosen") {
			const charged = meter.charge("variants", 1, SourceLoc("write program", ["variants", i]))
			if (!charged.ok) {
				throw new Refusal(charged.error)
			}
		}
	}
	return finish(builder, plan.carriers, meter)
}

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
	const b = newBuilder()
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
			forms
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
			earlier
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
	for (const step of plan.steps) {
		switch (step.kind) {
			case "createCarrier": {
				const deps = tracker.add([], [`carrier:${step.carrier.name}`])
				placed(
					() => buildCreateCarrier(w, step.carrier),
					deps,
					() => ({
						kind: "carrier",
						carrier: step.carrier.name,
						step: "create",
						stratum: step.stratum
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
						stratum: step.stratum
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
						stratum: step.stratum
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
				/** The parts, each a statement of its own whose names start past the parts before it. */
				const buildSingle = () => {
					let start = ownStatement
					const shares: Array<SharedPart> = []
					for (const share of step.shares) {
						const heading = share.node.heading.map((c) => ({
							name: c.name,
							type: withoutSerial(c.type)
						}))
						/** A shared sub-query's CTE lowers its own copies rather than reading itself. */
						const fill = { ...w, start, cx: w.cx.withDispatch(sharing.filling(share)) }
						const at = `shared sub-query ${share.node.id}`
						const supply = new NameSupply({
							relationStart: start.relation,
							columnStart: start.column
						})
						const placeholders = new WriteParams()
						fill.cx.beginWriteStatement(supply, placeholders)
						const query = memberRows(fill, heading, share.node, at)
						const params = [...placeholders.slots]
						const names = freshNames(namesPast(supply.map()), heading.length)
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
						start = namesPast(statement.sql.nameMap)
						return { step: writeStep(part.planned, statement), statement }
					})
					const single = singleStatement(
						shares,
						mapNonEmpty(writes, (x) => ({
							statement: x.statement,
							width: resultHeading(x.step.result).length
						})),
						start
					)
					return { single, writes }
				}
				const { statement, forms } = formed(buildSingle, (large) => sentOf(large.single))
				const { single, writes } = statement
				/** What the parts read, past the shared sub-queries the statement now carries. */
				const accesses = mapNonEmpty(step.writes, (planned) => writeAccess(planned))
				const deps = tracker.addAfter(
					accesses.flatMap((x) => x[0]),
					accesses.flatMap((x) => x[1]),
					step.writes.flatMap((x) => actionDeps(x.action))
				)
				const position = placeSpec(
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
					forms
				)
				for (const x of step.writes) {
					record(x.action, position)
				}
				break
			}
			case "advance": {
				const spec = { relation: step.relation, input: step.input }
				for (const field of serialOrder(step.relation)) {
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
				const program = lowerReadBack(step.read, plan.deltas, {
					names: options.names,
					reads: options.reads,
					entries: frontend.deltaEntries,
					params: frontend.params,
					schema: frontend,
					meter: w.meter
				})
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
				for (let i = 1; i < flight(program.roots).length; i++) {
					tracker.add(reads, [])
				}
				break
			}
		}
	}
	return b
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
				serial: "complete",
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

/** Which of a write op's unique violations abort the apply (uniqueAbortsOf). */
const abortsOf = (step: PlannedWrite): "generated" | "merge" | "probed" | "other" => {
	switch (step.op) {
		case "insert":
			return step.serial === "generated" ? "generated" : "probed"
		case "putInsert":
		case "upsert":
			return "probed"
		case "merge":
			return "merge"
		case "exactDelete":
		case "anchoredDelete":
		case "displace":
		case "updateFrom":
			return "other"
	}
}

/** The conservative artifact: the conservative realization's steps, every statement after the one before it. */
const conservativeArtifact = (write: ConservativeWrite, meter: BudgetMeter): WriteArtifact => {
	const b = newBuilder()
	for (const step of write.steps) {
		const previous = b.statements.length === 0 ? [] : [b.statements.length - 1]
		switch (step.kind) {
			case "readBack":
				placeReadBack(b, step.read, deliveredAsOptimized(step.program), previous)
				break
			case "carrier": {
				const result = step.statement.result
				place(
					b,
					step.statement,
					{
						kind: "carrier",
						carrier: result.carrier,
						step: result.step,
						stratum: step.stratum
					},
					previous
				)
				break
			}
			case "action": {
				const { statement, stratum, action, relation } = step
				const skip = { skipWhenEmpty: statement.skipWhenEmpty }
				const result = statement.result
				place(
					b,
					statement,
					result.kind === "sequenceAdvance"
						? {
								kind: "advance",
								stratum,
								action,
								relation: relation.name,
								field: result.field,
								...skip
							}
						: {
								kind: "write",
								stratum,
								action,
								relation: relation.name,
								result,
								...skip,
								uniqueAborts: uniqueAbortsOf(
									relation,
									result.kind !== "insert"
										? "other"
										: result.variant === "generated"
											? "generated"
											: "probed"
								)
							},
					previous
				)
				break
			}
			case "check": {
				const { statement } = step
				place(
					b,
					statement,
					{
						kind: "check",
						stratum: step.stratum,
						entry: statement.result.entry,
						skipWhenEmpty: statement.skipWhenEmpty
					},
					previous
				)
				break
			}
		}
	}
	return finish(b, write.carriers, meter)
}

/** The count rules of an artifact: which statement's rows count under which category for which relation, within one
 * stratum. Across strata the counts are netted by fact identity (`interpretRows`). */
const countRulesOf = (artifact: WriteArtifact): ReadonlyArray<CountRule> =>
	artifact.steps.flatMap((step, statement): ReadonlyArray<CountRule> =>
		writeRows(step, []).flatMap(({ step: s }) => {
			const { added, removed } = changeTags(s.result)
			return [
				...(added === undefined
					? []
					: [
							{
								relation: s.relation,
								statement,
								counts: added === "put" ? ("put" as const) : ("added" as const)
							}
						]),
				...(removed === "delete"
					? [{ relation: s.relation, statement, counts: "deleted" as const }]
					: [])
			]
		})
	)

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

/** The compilation charges a fresh meter. */
const compile = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: CompileWriteOptions
): CompiledWrite => {
	const meter = new BudgetMeter(compileBudgets)
	const frontend = unwrap(
		compileChangeSet(schema, desc, {
			meter,
			claims: options.claims,
			laws: options.laws,
			derived: options.derived,
			world: options.world
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
		optimizedDispatch(placed.facts, state),
		cteShareMinRefs
	)
	const lowering: Lowering = {
		state,
		sharing,
		w: writeContext(restated.ir.dag, {
			names: options.names,
			reads: options.reads,
			params: frontend.params,
			meter,
			dispatch: sharing.dispatch,
			share
		})
	}
	const plan = planWrite(restated, chosenIn(chosen, frontend.restate), {
		distinct: (node, relation) => distinctByEvidence(placed.facts, node, relation),
		shares: (members) => unwrap(planStatementShares(sharing.index, members, cteShareMinRefs))
	})
	const optimized = optimizedArtifact(restated, plan, lowering, options)
	const conservative = conservativeArtifact(
		unwrap(
			realizeConservative(frontend, {
				names: options.names,
				reads: options.reads,
				meter,
				share
			})
		),
		meter
	)
	const ir = frontend.ir
	const vector =
		topoOrder(ir.dag).some((n) => n.heading.some((c) => c.type.carrier === "vector")) ||
		frontend.written.some((r) => r.heading.some((c) => c.type.carrier === "vector"))
	const outcomeContext: OutcomeContext = Object.freeze({
		written: frontend.written.map(writtenOutcome),
		/** Every written relation and every witness relation is an ordinary relation of the base, whole entry or not. */
		relations: frontend.schema.definitions().relations
	})
	const reads: Record<string, number> = {}
	for (const r of optimized.readBacks) {
		reads[r.name] = r.statements[0].index
	}
	const program: CompiledWrite = {
		kind: "write",
		context: "transaction",
		optimized: optimized.specs,
		conservative: conservative.specs,
		requirements: {
			schema: frontend.schema.owned.fingerprint,
			extensions: vector ? ["vector"] : [],
			extensionSchemas: vector ? { vector: options.names.vectorSchema } : {}
		},
		certificates: placed.certificates,
		nameMap: optimized.nameMap,
		diagnostics: [],
		ir,
		strata: byStratum(optimized.statements).map((statements) => statements.map((s) => s.spec)),
		carriers: optimized.carriers,
		deltas: optimized.deltas,
		reads,
		outcome: {
			counts: countRulesOf(optimized),
			witness: witnessDecoder(outcomeContext, frontend.laws)
		},
		frontend,
		choices: chosen.choices,
		plan,
		artifacts: { optimized, conservative },
		params: frontend.params,
		slots: frontend.slots,
		outcomeContext
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
 * 3. The schedule: the statements in order, each described member a leading CTE or a carrier, the
 *    delta carriers and read-backs around the strata, and each stratum where one snapshot suffices one single statement.
 * 4. The optimized artifact: each planned statement built by its package (insert/, delete/, serial/, carriers/, put/),
 *    each write statement extended with the CTEs that fill its delta carriers from its RETURNING,
 *    a single statement's writes its parts,
 *    and each read-back lowered over the post-change state. The conservative artifact is the
 *    conservative realization (conservative/), the write oracle's baseline. In both, each carrier is
 *    analyzed after it is filled and before the first statement that joins it against a stored relation.
 * 5. The template: its requirements, and the outcome: count rules, the witness decoder and the constraint-to-law map.
 *
 * A WriteProgram holds no parameter value; binding normalizes and encodes one application's inputs, applies
 * the transport size rule, and says which statements an empty input lets the runtime skip. */
export const compileWrite = (
	schema: CheckedSchema,
	desc: ChangeSetDesc,
	options: CompileWriteOptions
): Result.Result<CompiledWrite, CompileError> => catchRefusal(() => compile(schema, desc, options))
