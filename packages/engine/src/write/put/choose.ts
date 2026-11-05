import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import type { LawField } from "#compiler/ir/law.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import type { Action, PutAction } from "#compiler/ir/write.ts"
import { type PrimaryKeyObject, readFields } from "#compiler/laws/model/uniques.ts"
import { only } from "#compiler/write/defined.ts"
import {
	type ActionInfo,
	type Counterpart,
	infoIn,
	type MemberSlot,
	type OutsideWrite,
	outsideIn,
	sourceIn,
	type WriteFrontend,
	type WrittenRelation
} from "#compiler/write/frontend/compile.ts"
import { payloadOf, serialOutsideKey } from "#compiler/write/frontend/targets.ts"
import { existingKeysProof, type MergeScope, mergeScopeProof } from "#compiler/write/put/proof.ts"

/** Why a put is the DELETE-then-insert pair (see `choosePutTargets`). */
type PairReason =
	| "entry"
	| "immutable"
	| "pureSet"
	| "serialOutsideKey"
	| "removedRead"
	| "netting"
	| "candidateKey"
	| "mergeUnique"
	| "spanKey"
	| "unproved"

/** What an update in place may assume of its relation, proved where its choice is made: the payload its UPDATE sets,
 * every field outside the primary key, none of them serial (no serial field lies outside the key), at least one (the
 * relation is no pure set). */
export interface InPlace {
	readonly payload: NonEmptyReadonlyArray<LawField>
}

/** A primary key compared for equality, which an ON CONFLICT DO UPDATE's arbiter and a MERGE's match are: never a span
 * key, an exclusion constraint neither takes (see `choosePutTargets`). */
export type KeyArbiter = Extract<PrimaryKeyObject, { readonly kind: "key" }>

/** The statement chosen for one put, with what it was proved over: an ON CONFLICT DO UPDATE of the enumerated slot it
 * reads, an UPDATE ... FROM, or a MERGE with the deletion action of the stratum it absorbs, by its position in the
 * stratum, and its scope, each in place; or the DELETE-then-insert pair, for a reason. */
export type PutChoice = {
	readonly stratum: number
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
			readonly target: "merge"
			readonly reason: "scopedMerge"
			readonly inPlace: InPlace
			readonly arbiter: KeyArbiter
			readonly merge: { readonly deletion: number; readonly scope: MergeScope }
	  }
)

/** An action of a stratum as its statements are planned: the front end's action with its information, and for a put the
 * statement chosen for it. */
export type ChosenAction =
	| Exclude<Action<ActionInfo>, PutAction<ActionInfo>>
	| (PutAction<ActionInfo> & { readonly choice: PutChoice })

/** A stratum of the WriteIR as its statements are planned: its actions in order, each put with its choice, and the
 * additions it refuses outright. */
export interface ChosenStratum {
	readonly actions: ReadonlyArray<ChosenAction>
	readonly outside: ReadonlyArray<OutsideWrite>
}

export interface ChosenTargets {
	/** Every stratum of the WriteIR, in order. */
	readonly strata: ReadonlyArray<ChosenStratum>
	/** Every put's choice, in stratum and action order. */
	readonly choices: ReadonlyArray<PutChoice>
}

/** Whether a non-deferrable unique object of the relation reads a field outside its primary key, so an update in place
 * can move one of its values from one fact to another, or, through a partial index's predicate, move one fact into the
 * index while another of the same compared values still occupies it. */
const uniqueOutsideKey = (relation: WrittenRelation): boolean => {
	const key: ReadonlyArray<LawField> = relation.primaryFields
	return relation.uniques.others.some((u) => readFields(u).some((f) => !key.includes(f)))
}

/** Whether a non-deferrable unique object of the relation can hold apart two facts of different primary keys: one whose
 * equal fields miss a field of the primary key, even when every field it compares lies in the primary key, such as
 * key(c) beside the primary key (b, c). An object that compares every field of the primary key for equality never
 * fires, since two facts it could hold apart share their primary key. Such an object forbids a MERGE that absorbs a
 * deletion (see `choosePutTargets`). */
const uniqueBesideKey = (relation: WrittenRelation): boolean =>
	relation.uniques.others.some((u) => !relation.primaryFields.every((f) => u.equal.includes(f)))

const describedNode = (action: Action<ActionInfo>): RelNode | undefined =>
	action.source.kind === "described" ? action.source.node : undefined

/** Choosing each put's statement.
 *
 * The write front end records what each put does (`PutAction`); this module chooses the statement that
 * realizes it, with what only the whole ChangeSet and its DAG can show, and returns every action of every stratum with
 * each put's choice beside it. These rules are where a put's target is decided, once. None of these targets is
 * exposed.
 *
 * A put lowers to the DELETE-then-insert pair (deleteThenInsert) when:
 *
 * - it writes a role's query entry: its relation is under row security for the role, the
 *   displacing deletion removes only the occupants inside the entry, and an occupant outside it, which the role cannot
 *   see, meets the insert half's arbiter, which PostgreSQL refuses with 42501, the key law at the submitted keys. An
 *   UPDATE ... FROM would skip such a key, an ON CONFLICT DO UPDATE would raise 42501 where no insert half's witness
 *   explains it, and a MERGE insert at it would raise a unique violation no abort rule reads as that law. The pair is
 *   lawful in passing: a plain foreign key into a relation with a field outside the referenced columns is DEFERRABLE
 *   INITIALLY DEFERRED, so deleting a referenced occupant before inserting its replacement breaks
 *   no reference before COMMIT, and a pure set's put displaces nothing. The pair updates nothing in place, so it never
 *   sets a head field the role holds no UPDATE on: a key field or a claim-fixed one (schema/entry.ts HeadStanding);
 * - its relation is immutable, the pinned default: no role holds UPDATE there;
 * - its relation is a mutable pure set, which has no payload for an update to set;
 * - its relation has a serial field outside the primary key, which no UPDATE may assign;
 * - a read-back names delta.removed of its relation and the put would be an ON CONFLICT DO UPDATE or a MERGE, whose
 *   inserted rows have no old version;
 * - another stratum of the ChangeSet also writes its relation and the put would be an ON CONFLICT DO UPDATE or a
 *   MERGE. Deltas and counts are netted across strata by fact identity: a fact one stratum
 *   adds and a later put displaces cancels, and so does a displaced fact a later stratum restores, so the netting
 *   needs every fact a put displaced, and neither form returns the old version of a row it updates. UPDATE ... FROM
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
 *   makes (w, 1) active while (w, 2), made inactive by the same statement, is still active;
 * - it is described and nothing below proves a better target;
 * - its relation's primary key contains a span field and the put would be an ON CONFLICT DO UPDATE or a MERGE: the key
 *   is an exclusion constraint, which no ON CONFLICT DO UPDATE accepts as its arbiter (42P10 for the inferred form,
 *   and only DO NOTHING by name), and a MERGE's insert at a key a concurrent commit overlaps raises 23P01, which no
 *   abort rule reads as the put-target commit it is, where the pair's insert half is the named-arbiter insert
 *  . UPDATE ... FROM inserts nothing and stays admissible.
 *
 * Otherwise, on a mutable relation:
 *
 * - MERGE, when the stratum's only other action on the relation is one deletion that mergeScopeProof proves is
 *   `R where <scope> and key not in put input`. The deletion is absorbed into the MERGE's NOT MATCHED BY
 *   SOURCE action. Any other addition to the relation in the stratum keeps the separate statements, because the
 *   deletion's own statement reads D EXCEPT A over the stratum's additions and the MERGE could delete a
 *   fact another member re-adds. And the relation must carry no non-deferrable unique object besides its primary key
 *   that two facts of different primary keys can share (uniqueBesideKey), even one whose columns all lie in the
 *   primary key, such as key(c) beside the primary key (b, c): a MERGE runs its actions in the join's row order, which
 *   the plan, and so the table's statistics, choose, and checks each action at its row, so an insert of (1, 3) can
 *   meet the c = 3 of an occupant (3, 3) that the same statement's NOT MATCHED BY SOURCE action deletes only later.
 *   That raises 23505 on a lawful final state, and only under some plans: a hash full join that hashes the relation
 *   emits its unmatched rows, the deletions, after every insert. The separate statements delete before they insert,
 *   so such a put is the pair (mergeUnique), as an unproved described put beside a deletion is;
 * - ON CONFLICT DO UPDATE, for an enumerated put, an array or a Stream;
 * - UPDATE ... FROM, for a described put that existingKeysProof proves reads only existing keys, when the
 *   stratum deletes nothing of the relation: an earlier deletion of a key in the same stratum would leave the UPDATE
 *   no row to update, where the put's definition inserts its member (S' = (S \ D) ∪ A). */
export const choosePutTargets = (frontend: WriteFrontend): ChosenTargets => {
	const { ir } = frontend
	const removedOf = new Set(
		frontend.deltas.flatMap((d) =>
			d.kind !== "relation" || d.sides === "added" ? [] : [d.relation.name]
		)
	)
	const writtenIn = ir.strata.map((stratum) => new Set(stratum.actions.map((a) => a.relation)))
	/** Whether the actions of more than one stratum write the relation. */
	const severalStrata = (relation: string): boolean =>
		writtenIn.filter((written) => written.has(relation)).length > 1
	const strata = ir.strata.map((stratum, s): ChosenStratum =>
		Object.freeze({
			outside: stratum.outside,
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
					if (info.entry.kind === "entry") {
						return pair("entry")
					}
					if (!relation.mutable) {
						return pair("immutable")
					}
					const payload = payloadOf(relation)
					if (payload.kind === "pureSet") {
						return pair("pureSet")
					}
					if (serialOutsideKey(relation)) {
						return pair("serialOutsideKey")
					}
					if (uniqueOutsideKey(relation)) {
						return pair("candidateKey")
					}
					const inPlace: InPlace = Object.freeze({ payload: payload.fields })
					const primary = relation.uniques.arbiter
					/** The forms that return no old version of an updated row: ON CONFLICT DO UPDATE and MERGE. */
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
					const single = only(deletions)
					if (
						noOldVersion === undefined &&
						reads.kind === "described" &&
						others.length === 1 &&
						single !== undefined
					) {
						const deletionNode = describedNode(single.action)
						const scope =
							deletionNode === undefined
								? undefined
								: mergeScopeProof(deletionNode, reads.node, relation)
						if (scope !== undefined) {
							return uniqueBesideKey(relation)
								? pair("mergeUnique")
								: primary.kind === "key"
									? chosen({
											...place,
											target: "merge",
											reason: "scopedMerge",
											inPlace,
											arbiter: primary,
											merge: { deletion: single.index, scope }
										})
									: pair("spanKey")
						}
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
					if (deletions.length === 0 && existingKeysProof(reads.node, relation)) {
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
 * with the nodes it names read through `at` (`WriteFrontend.restate`), each choice as it was made. A choice names no
 * node: a MERGE's scope names labels, which every form of the DAG keeps, and its absorbed deletion is a position in its
 * stratum.
 */
export const chosenIn = (chosen: ChosenTargets, at: Counterpart): ChosenTargets => ({
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
				outside: Object.freeze(stratum.outside.map((write) => outsideIn(write, at)))
			})
		)
	),
	choices: chosen.choices
})
