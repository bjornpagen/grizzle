import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { isNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { StoredRelationName } from "#compiler/core/ids.ts"
import { fieldReads } from "#compiler/ir/expr.ts"
import { generationOf, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import type { Action, PutAction } from "#compiler/ir/write.ts"
import { type PrimaryKeyObject, readFields } from "#compiler/laws/model/uniques.ts"
import {
	type ActionInfo,
	type Counterpart,
	infoIn,
	type MemberCheck,
	type MemberSlot,
	type OutsideWrite,
	outsideIn,
	sourceIn,
	type WriteFrontend,
	type WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import type { FamilyAt } from "#compiler/write/frontend/schedule.ts"
import { type Payload, payloadOf, primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import { existingKeysProofOver } from "#compiler/write/put/proof.ts"

/** Why a put is the DELETE-then-insert pair (see `choosePutTargets`). */
type PairReason =
	| "entry"
	| "immutable"
	| "pureSet"
	| "removedRead"
	| "netting"
	| "candidateKey"
	| "spanKey"
	| "unproved"

/** What an update in place may assume of its relation, proved where its choice is made: the payload its UPDATE sets,
 * every field outside the primary key, at least one (the relation is no pure set). */
export interface InPlace {
	readonly payload: NonEmptyReadonlyArray<LawField>
}

/** A primary key compared for equality, which an ON CONFLICT DO UPDATE's arbiter is: never a span key, an exclusion
 * constraint it takes not (see `choosePutTargets`). */
export type KeyArbiter = Extract<PrimaryKeyObject, { readonly kind: "key" }>

/** The statement chosen for one put, with what it was proved over: an ON CONFLICT DO UPDATE of the enumerated slot it
 * reads or an UPDATE ... FROM, each in place; the split of a put whose rows may move a unique value (uniqueSplit); or the
 * DELETE-then-insert pair, for a reason. */
export type PutChoice = {
	readonly stratum: StratumAt
	readonly action: number
	readonly relation: string
} & (
	| { readonly target: "deleteThenInsert"; readonly reason: PairReason }
	| {
			readonly target: "onConflictDoUpdate"
			readonly reason: "enumerated"
			readonly inPlace: InPlace
			readonly arbiter: KeyArbiter
			readonly slot: MemberSlot
	  }
	| { readonly target: "updateFrom"; readonly reason: "existingKeys"; readonly inPlace: InPlace }
	| {
			readonly target: "uniqueSplit"
			readonly reason: "candidateKey"
			readonly inPlace: InPlace
			/** The payload fields that decide a unique object's value outside the key (`movingFields`), each one a
			 * fact carries: a row whose value differs at one moves it. */
			readonly moved: NonEmptyReadonlyArray<LawField>
	  }
	| {
			readonly target: "ownerPut"
			readonly reason: "owner"
			/** The payload its UPDATE sets, none for an owner whose facts carry nothing outside its key. */
			readonly inPlace: InPlace | undefined
	  }
)

/**
 * The fields a stored occupant a put's fact collides with at the primary key may differ from it in, which the put's
 * displacing deletion compares (write/delete/exact.ts): a key's span, at which the fact collides with every occupant of
 * its scalars whose span overlaps its own, then the payload (`payloadOf`); none for a pure set keyed by scalars alone,
 * whose one colliding occupant is the fact itself, so its put displaces nothing.
 */
export const differingOf = (
	relation: RelationInfo
): NonEmptyReadonlyArray<LawField> | undefined => {
	const key = primaryKeyShape(relation)
	const payload = payloadOf(relation)
	const fields = [
		...(key.kind === "span" ? [key.span] : []),
		...(payload.kind === "keyed" ? payload.fields : [])
	]
	return isNonEmpty(fields) ? fields : undefined
}

/** Whether a relation owns a family, whose count and ends grizzle draws on the owner's row. */
const ownsFamily = (frontend: WriteFrontend, relation: string): boolean =>
	frontend.laws.families.some((f) => f.owner.name === relation)

/** An action of a stratum as its statements are planned: the front end's action with its information, and for a put the
 * statement chosen for it. */
export type ChosenAction =
	| Exclude<Action<ActionInfo>, PutAction<ActionInfo>>
	| (PutAction<ActionInfo> & { readonly choice: PutChoice })

/** A stratum of the WriteIR as its statements are planned: its actions in order, each put with its choice, the
 * additions it refuses outright, and the prechecks of the facts only its family statements write. */
export interface ChosenStratum {
	readonly actions: ReadonlyArray<ChosenAction>
	readonly outside: ReadonlyArray<OutsideWrite>
	readonly checks: ReadonlyArray<MemberCheck>
	/** Where each of the stratum's family statements runs among its actions (frontend/schedule.ts FamilyAt). */
	readonly family: ReadonlyArray<FamilyAt>
}

export interface ChosenTargets {
	/** Every stratum of the WriteIR, in order. */
	readonly strata: ReadonlyArray<ChosenStratum>
	/** Every put's choice, in stratum and action order. */
	readonly choices: ReadonlyArray<PutChoice>
}

/** The fields of the payload `payload`, those an update in place sets, that decide a value of a non-deferrable unique
 * object of the relation outside its primary key, in payload order: each such field the object reads, and each a
 * generated field it reads is computed from (law.ts generationOf, fieldReads), which PostgreSQL computes again from the
 * row the update leaves. An update in place that changed one could move a unique value from one fact to another, or,
 * through a partial index's predicate, move one fact into the index while another of the same compared values still
 * occupies it; a field the update leaves as it stands, a key field or one grizzle draws, accumulates or stamps, moves
 * none. Each is a field a fact carries, so the split's displacing deletion compares a fact at its input's column. */
const movingFields = (
	relation: WrittenRelation,
	payload: NonEmptyReadonlyArray<LawField>
): ReadonlyArray<LawField> => {
	const decided = new Set(
		relation.uniques.others.flatMap((u) =>
			readFields(u).flatMap((f) => {
				const generation = generationOf(f)
				return generation === undefined ? [f.name] : fieldReads([generation])
			})
		)
	)
	return payload.filter((f) => decided.has(f.name))
}

/** The fields an owner's put sets in place: those its facts carry outside its key (`payloadOf`), and through a query
 * entry only its free head fields (schema/entry.ts HeadStanding), the ones the role holds column UPDATE on: a fixed or
 * claim-fixed field holds the entry's value in every row the role sees, so it never differs there. */
export const inPlaceOf = (info: ActionInfo, payload: Payload): ReadonlyArray<LawField> => {
	if (payload.kind === "pureSet") {
		return []
	}
	if (info.entry.kind === "whole") {
		return payload.fields
	}
	const free = [...info.entry.entry.head.values()].flatMap((h) =>
		h.kind === "free" ? [h.field] : []
	)
	return payload.fields.filter((f) => free.includes(f))
}

/** Choosing each put's statement.
 *
 * The write front end records what each put does (`PutAction`); this module chooses the statement that
 * realizes it, with what only the whole ChangeSet and its DAG can show, and returns every action of every stratum with
 * each put's choice beside it. These rules are where a put's target is decided, once. None of these targets is
 * exposed.
 *
 * A put of a mutable relation that owns a family is ownerPut: an UPDATE ... FROM of the fields its
 * facts carry (`payloadOf`), none for an owner whose facts carry nothing outside its key, then the insert protocol's
 * put half for every fact no row holds, its counts at 0 and its ends at their starts (insert/statement.ts startOf).
 * Its families are left as they are, so it is never the pair, whose deletion of a stored owner would trip every
 * member's owner axis, whatever its key's kind, a WITHOUT OVERLAPS key included, through a role's query entry too: its
 * UPDATE sets only the entry's free head fields (`inPlaceOf`), and its precheck runs before it, so a fact outside the
 * entry or at the key of a fact outside it is refused as the pair's is, before the UPDATE meets the policy. The front end
 * refuses a put of an immutable owner.
 *
 * The pair's deletion displaces every occupant the put's fact collides with at the primary key and differs from
 * (`differingOf`, write/delete/exact.ts): at a scalar key the occupant at its key, at a key holding a span each occupant
 * of its scalars whose span overlaps its own, which the key's WITHOUT OVERLAPS refuses beside it, so a put of a span key
 * holds its fact over every point of its span, as a put of a scalar key holds its fact at its key.
 *
 * Any other put lowers to the DELETE-then-insert pair (deleteThenInsert) when:
 *
 * - it writes a role's query entry: its relation is under row security for the role, the
 *   displacing deletion removes only the occupants inside the entry, and an occupant outside it, which the role cannot
 *   see, is refused on the key's law at the submitted keys by the entry's precheck before the insert half, or, committed
 *   after the transaction's snapshot, fails the insert half with 40001 (insert/protocol.ts buildInsert). An
 *   UPDATE ... FROM would skip such a key, an ON CONFLICT DO UPDATE would raise 42501 where no insert half's witness
 *   explains it. The pair is
 *   lawful in passing: a plain foreign key into a relation with a field outside the referenced columns is DEFERRABLE
 *   INITIALLY DEFERRED, so deleting a referenced occupant before inserting its replacement breaks
 *   no reference before COMMIT, and a pure set's put displaces nothing. The pair updates nothing in place, so it never
 *   sets a head field the role holds no UPDATE on: a key field or a claim-fixed one (schema/entry.ts HeadStanding);
 * - its relation is immutable, the pinned default: no role holds UPDATE there;
 * - its relation is a mutable pure set, which has no payload for an update to set;
 * - a read-back names delta.removed of its relation and the put would be an ON CONFLICT DO UPDATE, whose inserted rows
 *   have no old version;
 * - another stratum of the ChangeSet also writes its relation and the put would be an ON CONFLICT DO UPDATE. Deltas and
 *   counts are netted across strata by fact identity: a fact one stratum adds and a later put displaces cancels, and so
 *   does a displaced fact a later stratum restores, so the netting needs every fact a put displaced, and an ON CONFLICT
 *   DO UPDATE returns no old version of a row it updates. UPDATE ... FROM
 *   returns it (RETURNING old) and stays admissible;
 * - its relation carries a non-deferrable UNIQUE constraint or index with a field outside the primary key, and the put
 *   would be updated in place: a declared candidate key, a key over a selected side, or a WITHOUT OVERLAPS or temporal
 *   uniqueness. Such an object is checked at
 *   each row of an UPDATE, so one statement that moves a unique value from one fact to another, such as two puts
 *   swapping two codes or two workers, raises 23505 although the final state is lawful, where the pair deletes every
 *   displaced occupant before inserting any replacement. The law model, not the declared keys alone, says which objects
 *   are installed. An object whose columns all lie in the primary key never conflicts on a swap of its values: two
 *   facts it could collide on share their primary key. A key over a selected side whose selection reads a field outside
 *   the primary key still reaches outside it, even when every field it compares lies in the key: at most one active
 *   Duty per worker, key(on(select(Duty, active), worker)) over the primary key (worker, task), meets the update that
 *   makes (w, 1) active while (w, 2), made inactive by the same statement, is still active. Only a row whose value
 *   differs at a payload field that decides such an object's value outside the key, one it reads or one a generated
 *   field it reads is computed from (`movingFields`), can move one, so the pair is
 *   that row's alone: where the key is scalars, the put is split by it (uniqueSplit), its displacing deletion removing
 *   each occupant whose such field differs from its fact's, then UPDATE ... FROM updating in place every occupant that
 *   stays, and the insert half inserting each fact no row holds, the moved rows' and the new keys'. A row that keeps its
 *   unique values takes no part in a swap, and a swap or a true collision lies among the moved rows, which the pair
 *   handles as it does any. Where existingKeysProof proves every row carries a stored fact's key and, from that same
 *   fact, every such field, a described put in a stratum that deletes nothing of the relation, no value moves and the
 *   put is the UPDATE ... FROM alone, a put of a test by its own name; a span key keeps the pair (candidateKey), and so
 *   does a put of a relation a read-back reads a delta of: the split's delta is its statements', the update's and the
 *   insert half's added rows, the displacing deletion's and the update's removed, and a read-back reads the rows of
 *   one statement (write/schedule/plan.ts ReadBackCrossesStatements), as the pair's added rows are its insert's;
 * - it is described and nothing below proves a better target;
 * - its relation's primary key contains a span field and the put would be an ON CONFLICT DO UPDATE: the key is an
 *   exclusion constraint, which no ON CONFLICT DO UPDATE accepts as its arbiter (42P10 for the inferred form, and only
 *   DO NOTHING by name). UPDATE ... FROM inserts nothing and stays admissible.
 *
 * A put beside a deletion of its relation's facts in a scope whose keys its input lacks, a scoped replace, is no target
 * of its own: the deletion is its own statement, a keyed read of the scope (write/delete/exact.ts), and the put is the
 * statement the rules here choose, a pair or an upsert, so the replace reads the scope's rows and the input's keys,
 * O((|input| + |scope|) log n), never every row of the relation, which one MERGE whose WHEN NOT MATCHED BY SOURCE
 * absorbed the deletion read whole, PostgreSQL planning it as a FULL join.
 *
 * Otherwise, on a mutable relation:
 *
 * - ON CONFLICT DO UPDATE, for an enumerated put, an array or a Stream;
 * - UPDATE ... FROM, for a described put that existingKeysProof proves reads only existing keys, when the
 *   stratum deletes nothing of the relation: an earlier deletion of a key in the same stratum would leave the UPDATE
 *   no row to update, where the put's definition inserts its member (S' = (S \ D) ∪ A). */
export const choosePutTargets = (frontend: WriteFrontend): ChosenTargets => {
	const { ir } = frontend
	const existingKeysProof = existingKeysProofOver(frontend)
	const removedOf = new Set(
		frontend.deltas.flatMap((d) =>
			d.kind !== "relation" || !d.sides.has("removed") ? [] : [d.relation.name]
		)
	)
	/** The relations a read-back reads a delta of, either side, whose put is no split (uniqueSplit). */
	const deltaRead = new Set(
		frontend.deltas.flatMap((d) => (d.kind === "relation" ? [d.relation.name] : []))
	)
	const writtenIn = ir.strata.map((stratum) => new Set(stratum.actions.map((a) => a.relation)))
	/** Whether the actions of more than one stratum write the relation. */
	const severalStrata = (relation: StoredRelationName): boolean =>
		writtenIn.filter((written) => written.has(relation)).length > 1
	const strata = strataAt(ir.strata).map(([s, stratum]): ChosenStratum =>
		Object.freeze({
			outside: stratum.outside,
			checks: stratum.checks,
			family: stratum.family,
			actions: Object.freeze(
				stratum.actions.map((action, a): ChosenAction => {
					if (action.op !== "put") {
						return action
					}
					const { info } = action
					const relation = info.relation
					const place = { stratum: s, action: a, relation: action.relation }
					const chosen = (choice: PutChoice): ChosenAction => Object.freeze({ ...action, choice })
					const pair = (reason: PairReason): ChosenAction =>
						chosen({ ...place, target: "deleteThenInsert", reason })
					const payload = payloadOf(relation)
					if (relation.mutable && ownsFamily(frontend, relation.name)) {
						const set = inPlaceOf(info, payload)
						return chosen({
							...place,
							target: "ownerPut",
							reason: "owner",
							inPlace: isNonEmpty(set) ? Object.freeze({ payload: set }) : undefined
						})
					}
					if (info.entry.kind === "entry") {
						return pair("entry")
					}
					if (!relation.mutable) {
						return pair("immutable")
					}
					if (payload.kind === "pureSet") {
						return pair("pureSet")
					}
					const inPlace: InPlace = Object.freeze({ payload: payload.fields })
					const primary = relation.uniques.arbiter
					/** The form that returns no old version of an updated row: ON CONFLICT DO UPDATE. */
					const noOldVersion: "removedRead" | "netting" | undefined = removedOf.has(action.relation)
						? "removedRead"
						: severalStrata(action.relation)
							? "netting"
							: undefined
					const others = stratum.actions.flatMap((b, j) =>
						j !== a && b.relation === action.relation ? [{ index: j, action: b }] : []
					)
					const deletions = others.flatMap((o) => (o.action.op === "delete" ? [o] : []))
					const reads = info.reads
					const moved = movingFields(relation, inPlace.payload)
					const kept = moved.map((f) => f.name)
					if (
						isNonEmpty(moved) &&
						(reads.kind === "slot" ||
							deletions.length > 0 ||
							!existingKeysProof(reads.node, relation, kept))
					) {
						return primary.kind === "key" && !deltaRead.has(action.relation)
							? chosen({ ...place, target: "uniqueSplit", reason: "candidateKey", inPlace, moved })
							: pair("candidateKey")
					}
					if (reads.kind === "slot") {
						return noOldVersion !== undefined
							? pair(noOldVersion)
							: primary.kind === "key"
								? chosen({
										...place,
										target: "onConflictDoUpdate",
										reason: "enumerated",
										inPlace,
										arbiter: primary,
										slot: reads.slot
									})
								: pair("spanKey")
					}
					if (deletions.length === 0 && existingKeysProof(reads.node, relation, kept)) {
						return chosen({ ...place, target: "updateFrom", reason: "existingKeys", inPlace })
					}
					return pair("unproved")
				})
			)
		})
	)
	const choices = strata.flatMap((stratum) =>
		stratum.actions.flatMap((a) => (a.op === "put" ? [a.choice] : []))
	)
	return { strata: Object.freeze(strata), choices: Object.freeze(choices) }
}

/**
 * The chosen targets over another form of the write DAG (`WriteFrontend.restated`): each action and refused addition
 * with the nodes it names read in `restate` (`WriteFrontend.restate`), which holds every node the frontend's queries
 * name, each choice as it was made. A choice names no node.
 */
export const chosenIn = (
	chosen: ChosenTargets,
	restate: ReadonlyMap<RelNode, RelNode>
): ChosenTargets => {
	const at: Counterpart = (node) => defined(restate.get(node), "a node the write's queries name")
	return {
		strata: Object.freeze(
			chosen.strata.map((stratum): ChosenStratum =>
				Object.freeze({
					actions: Object.freeze(
						stratum.actions.map((action): ChosenAction =>
							Object.freeze({
								...action,
								source: sourceIn(action.source, at),
								info: infoIn(action.info, at)
							})
						)
					),
					outside: Object.freeze(stratum.outside.map((write) => outsideIn(write, at))),
					checks: stratum.checks,
					family: stratum.family
				})
			)
		),
		choices: chosen.choices
	}
}
