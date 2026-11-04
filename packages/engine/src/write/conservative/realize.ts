import type { BudgetMeter } from "#compiler/core/budget.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import { completeAddition, type ReadBack, type SerialClass } from "#compiler/ir/write.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { dispatchNode } from "#compiler/lower/conservative/dispatch.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import type {
	ConservativeProgram,
	DeltaSource,
	PhysicalNames
} from "#compiler/lower/conservative/types.ts"

import {
	buildCreateCarrier,
	buildFillCarrier,
	type Carrier,
	CarrierSupply,
	relationCarrier
} from "#compiler/write/carriers/carriers.ts"
import { buildDisplacingDelete, buildExactDelete } from "#compiler/write/delete/exact.ts"
import { buildEntryCheck, type EntryCheck, outsideProbes } from "#compiler/write/entry/precheck.ts"
import type { WriteFrontend, WrittenRelation } from "#compiler/write/frontend/compile.ts"
import { payloadOf } from "#compiler/write/frontend/targets.ts"
import { type RereadInput, unproved, type WriteInput } from "#compiler/write/insert/input.ts"
import { buildInsert, buildSpanClassify, insertShape } from "#compiler/write/insert/protocol.ts"
import {
	type CarrierResult,
	compareHeading,
	type DeleteResult,
	type EntryCheckResult,
	factHeading,
	type InsertOf,
	type InsertResult,
	keyFirst,
	type SequenceAdvanceResult,
	type SpanClassifyResult,
	type StatementShare,
	type WriteContext,
	type WriteNames,
	type WriteStatement,
	writeContext
} from "#compiler/write/insert/statement.ts"
import { deltaSourceIn } from "#compiler/write/readback/lower.ts"
import { breachGuard } from "#compiler/write/refusal.ts"
import { buildSequenceAdvances, carriesSerial } from "#compiler/write/serial/advance.ts"

/** One step of the conservative realization:
 * - `carrier`, a carrier's creation or fill: a member's, at the start of its stratum, or, with no stratum, a snapshot
 *   or a delta around the strata;
 * - `action`, a statement of an action of a stratum, `action` its index there (ir.strata[stratum].actions): its insert
 *   or deletion, whose rows are its changes (`changeTags`), the classification after an insert into a span primary key,
 *   or a sequence advance after explicit serial values;
 * - `readBack`, a read-back's conservative lowering;
 * - `check`, a query entry's check of an addition's facts. */
type ConservativeStep =
	| {
			readonly kind: "carrier"
			readonly statement: WriteStatement<CarrierResult>
			readonly stratum: number | undefined
	  }
	| {
			readonly kind: "action"
			readonly statement: WriteStatement<
				InsertResult | DeleteResult | SpanClassifyResult | SequenceAdvanceResult
			>
			readonly relation: WrittenRelation
			readonly stratum: number
			readonly action: number
	  }
	| { readonly kind: "readBack"; readonly read: ReadBack; readonly program: ConservativeProgram }
	| {
			readonly kind: "check"
			readonly statement: WriteStatement<EntryCheckResult>
			readonly stratum: number
	  }

/** A delta's two sides: a relation's by state comparison, or a world relation's empty delta, created and never filled. */
interface DeltaCarriers {
	readonly added: Carrier
	readonly removed: Carrier
}

export interface ConservativeWrite {
	/** Every step in execution order, all inside the write's one transaction. */
	readonly steps: ReadonlyArray<ConservativeStep>
	readonly carriers: ReadonlyArray<Carrier>
	readonly deltas: Readonly<Record<string, DeltaCarriers>>
}

interface ConservativeWriteOptions {
	/** The installed names of the relations the statements write. */
	readonly names: WriteNames
	/** The names the members and read-backs read their relations under: reality's own, or a role's views. */
	readonly reads: PhysicalNames
	/** The compilation's meter, which every lowered node and emitted text is charged to. */
	readonly meter: BudgetMeter
	/** The statements the compilation's optimized artifact built, which an equal request shares. */
	readonly share: StatementShare
}

const realize = (frontend: WriteFrontend, options: ConservativeWriteOptions): ConservativeWrite => {
	const { ir } = frontend
	const w: WriteContext = writeContext(ir.dag, {
		names: options.names,
		reads: options.reads,
		params: frontend.params,
		meter: options.meter,
		/** The conservative realization lowers every described member by the conservative baseline. */
		dispatch: dispatchNode,
		share: options.share
	})
	const supply = new CarrierSupply()
	const steps: Array<ConservativeStep> = []
	const carry = (
		carrier: Carrier,
		source: Parameters<typeof buildFillCarrier>[2],
		stratum: number | undefined
	) => {
		steps.push(
			Object.freeze({ kind: "carrier", statement: buildCreateCarrier(w, carrier), stratum })
		)
		steps.push(
			Object.freeze({ kind: "carrier", statement: buildFillCarrier(w, carrier, source), stratum })
		)
	}

	/** 1. The state snapshots of the relations whose deltas a read-back names, each read as the role reads it: through
	 * the role's view of a whole entry, or, for a relation it writes through a query entry, its table under the role's
	 * row security, which shows exactly the entry's rows, so the comparison is the entry's own change. */
	const snapshots = frontend.deltas.flatMap((named) => {
		if (named.kind === "empty") {
			return []
		}
		const { relation, via } = named
		const snapshot = relationCarrier(supply, relation)
		const names = via.kind === "entry" ? options.names : options.reads
		carry(snapshot, { kind: "relation", relation, names }, undefined)
		return [{ relation, snapshot, names }]
	})

	for (const [s, { actions, outside }] of ir.strata.entries()) {
		const check = (input: WriteInput, entryCheck: EntryCheck) =>
			steps.push(
				Object.freeze({
					kind: "check",
					statement: buildEntryCheck(w, input, entryCheck),
					stratum: s
				})
			)
		for (const refused of outside) {
			const reads = refused.reads
			check(
				reads.kind === "slot"
					? {
							kind: "relation",
							slot: reads.slot.slot,
							relation: refused.entry,
							heading: reads.slot.heading
						}
					: { kind: "described", node: reads.node, proof: unproved },
				{ kind: "outside", entry: refused.entry }
			)
		}
		/** Each action with its input, every member carried before any action's statement. */
		const placed = actions.map((action) => {
			const { info } = action
			const reads = info.reads
			if (reads.kind === "described") {
				/** Typed by the relation's columns, not the member's heading, so the fill casts each value into its
				 * column's type and the carrier holds the facts as they are written: a member column typed only
				 * compatibly, such as numeric(12,4) into numeric(10,2), changes value under that cast.
				 * A deletion writes nothing, so its member is carried as it is compared, each column of its field's
				 * base type with the typmod and no contract or refinement domain (`CastInto` "compare"):
				 * a member value outside the field's domain then matches no fact, as it does when the deletion reads
				 * the member directly, instead of raising the domain's check at the fill. */
				const fields = keyFirst(info.relation).filter((f) =>
					info.heading.some((c) => c.name === f.name)
				)
				const heading = action.op === "delete" ? compareHeading(fields) : factHeading(fields)
				const carrier = supply.next(heading)
				carry(carrier, { kind: "member", node: reads.node }, s)
				const input: RereadInput = { kind: "carrier", carrier, proof: unproved }
				return { action, input }
			}
			return { action, input: reads.slot.input }
		})
		for (const [i, { action, input }] of placed.entries()) {
			const relation = action.info.relation
			const statement = (
				built: WriteStatement<
					InsertResult | DeleteResult | SpanClassifyResult | SequenceAdvanceResult
				>
			) =>
				steps.push(
					Object.freeze({ kind: "action", statement: built, relation, stratum: s, action: i })
				)
			/** The insert protocol for an insertion or a put's insert half, then, into a span primary key, the
			 * classification of each requested fact it did not insert, and the sequence advance after explicit serial
			 * values. */
			const add = (serial: SerialClass, of: InsertOf) => {
				const spec = { relation, serial, input, of } as const
				const entry = action.info.entry
				if (entry.kind === "entry") {
					check(input, {
						kind: "membership",
						entry: entry.entry,
						relation,
						probes: outsideProbes(relation, serial),
						base: frontend.schema.definitions(),
						catalog: evidenceCatalog(frontend),
						world: entry.names
					})
				}
				statement(buildInsert(w, spec))
				const shape = insertShape(relation, serial)
				if (shape.variant === "spanKey") {
					statement(buildSpanClassify(w, spec, shape.span))
				}
				if (carriesSerial(relation, serial)) {
					for (const advance of buildSequenceAdvances(w, { relation, input })) {
						statement(advance)
					}
				}
			}
			switch (action.op) {
				case "delete": {
					const additions = placed.flatMap((b) =>
						b.action.relation === action.relation && completeAddition(b.action) ? [b.input] : []
					)
					statement(buildExactDelete(w, { relation, input, except: additions }))
					break
				}
				case "insert":
					add(action.serial, "insert")
					break
				case "put": {
					const payload = payloadOf(relation)
					if (payload.kind === "keyed") {
						statement(buildDisplacingDelete(w, { relation, input, payload: payload.fields }))
					}
					add("complete", "put")
					break
				}
			}
		}
	}

	/** 3. The deltas by state comparison. */
	const deltas: Record<string, DeltaCarriers> = {}
	for (const { relation, snapshot, names } of snapshots) {
		const added = relationCarrier(supply, relation)
		carry(added, { kind: "difference", side: "added", relation, names, snapshot }, undefined)
		const removed = relationCarrier(supply, relation)
		carry(removed, { kind: "difference", side: "removed", relation, names, snapshot }, undefined)
		deltas[relation.name] = Object.freeze({ added, removed })
	}
	for (const named of frontend.deltas) {
		if (named.kind !== "empty") {
			continue
		}
		const create = (): Carrier => {
			const carrier = supply.next(named.heading)
			steps.push(
				Object.freeze({
					kind: "carrier",
					statement: buildCreateCarrier(w, carrier),
					stratum: undefined
				})
			)
			return carrier
		}
		const added = create()
		deltas[named.name] = Object.freeze({ added, removed: create() })
	}

	/** 4. The read-backs over the post-change state. */
	const deltaSource = (relation: string, side: "added" | "removed"): DeltaSource | undefined =>
		deltaSourceIn(relation, frontend.deltaEntries, (target) => {
			const d = deltas[target]
			return d === undefined ? undefined : side === "added" ? d.added : d.removed
		})
	for (const read of ir.reads) {
		const program = lowerConservative(
			{ dag: ir.dag, root: read.node },
			{
				names: options.reads,
				params: frontend.params,
				subject: {
					kind: "readBack",
					deltas: deltaSource,
					breach: breachGuard(options.names.schema)
				},
				meter: options.meter
			}
		)
		if (!program.ok) {
			throw new Refusal(program.error)
		}
		steps.push(Object.freeze({ kind: "readBack", read, program: program.value }))
	}

	return Object.freeze({
		steps: Object.freeze(steps),
		carriers: Object.freeze(supply.all()),
		deltas: Object.freeze(deltas)
	})
}

/** The conservative realization of a compiled ChangeSet: the write oracle's baseline. It deduplicates at every set
 * boundary, uses no rewrite certificate, realizes every put as its definition (a described deletion of the current
 * occupants followed by the insert protocol), and computes every read-back delta by comparing the states before and
 * after the change. The write oracle compares db.apply against it and against the brute-force add-wins result, and
 * every mutable put target must agree with it in final state, counts and deltas. It runs in the write's one
 * transaction.
 *
 * Every statement is sequential, one per physical step, so each sees the writes before it and nothing relies on
 * sibling CTEs sharing a snapshot:
 *
 * 1. A state snapshot of every relation a read-back's delta names, each copied into a carrier before the first
 *    stratum. A relation the ChangeSet does not write has an empty delta the same way.
 * 2. For each stratum in order, every described member is evaluated against the state before the stratum's writes and
 *    kept in a carrier filled by INSERT ... SELECT, because sequential statements consume it; an insert's or a put's
 *    carrier has the relation's column types, so it holds the member's facts as they are written, and a deletion's has
 *    each field's base type with its typmod, so it holds the member as the deletion compares it; an enumerated member
 *    is its relation parameter, which never changes. Then each action in the front end's dependency order:
 *    - a deletion is the exact deletion of its member, D EXCEPT A over the stratum's complete additions to the
 *      relation, so additions win whatever the host normalized;
 *    - an insertion is the insert protocol for its relation and member shape, SELECT DISTINCT and the same-key check
 *      included for every carrier, since the baseline relies on no evidence, followed, into a span primary key, by the
 *      classification of every requested fact it did not insert, and by the sequence advances when it carries
 *      explicit serial values; a generated class of no field reads the unit input and assigns no column, so every
 *      column takes its identity;
 *    - a put is its definition whatever its relation's mutability: the deletion of the occupants at its members' keys
 *      whose payload differs, then the insert protocol as its insert half, then the sequence advances. An occupant
 *      equal to its member is not displaced, so an identical put deletes nothing and inserts an exact repeat and is
 *      no-change; a pure set's put displaces nothing.
 *    A role's query entry adds its checks: an addition the Db's claims leave outside the world is a check of its
 *    member at the start of its stratum, and an addition into an entry is checked against the entry's membership
 *    right before its insert protocol.
 * 3. After the last stratum, each named relation's delta.added and delta.removed are the differences of its final
 *    state and its snapshot, S' \ S and S \ S', kept in carriers.
 * 4. Each read-back is lowered by the conservative query lowering over the post-change state, its Delta nodes reading
 *    those carriers, each attachment it delivers bare or as an option checking that type in its own statement
 *    (`breachGuard`).
 *
 * Every write statement returns complete facts, so the runtime can net each stratum's changes and counts across
 * strata by fact identity; each step records the change its rows are: facts an insert or a put made present, facts a
 * delete member removed, or occupants a put displaced. */
export const realizeConservative = (
	frontend: WriteFrontend,
	options: ConservativeWriteOptions
): Result.Result<ConservativeWrite, CompileError> => catchRefusal(() => realize(frontend, options))
