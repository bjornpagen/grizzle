import type { ParamId } from "#compiler/core/ids.ts"
import { defined } from "#compiler/core/invariant.ts"
import { type Family, isSequence } from "#compiler/ir/family.ts"
import type { RelationInfo } from "#compiler/ir/law.ts"
import { type StratumAt, strataAt } from "#compiler/ir/stratum.ts"
import { type ColumnKey, fieldKey } from "#compiler/write/family/fold.ts"
import { endColumns, rowLayout } from "#compiler/write/family/statements.ts"
import type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
import { type Proposal, proposalOf } from "#compiler/write/insert/statement.ts"
import type {
	Binding,
	FreshOwner,
	FreshStratum,
	JudgedRelation,
	NestedOwner,
	OwnedColumn
} from "#compiler/write/program/binding.ts"

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
			return { kind: "at", position: at.position }
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
		const counted = families.filter(
			(f) =>
				!isSequence(f) &&
				(appended.some((a) => a.relation === f.member.name) || nestedRelations.has(f.member.name))
		)
		const owners = new Map<string, FreshOwner>()
		for (const { owner } of counted) {
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
		return [{ stratum, appended, counted, owners }]
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
		claim(fieldKey(family.count.name), { kind: "count", family })
		for (const end of endColumns(family)) {
			if (end.writing.kind === "accumulated") {
				claim(fieldKey(end.name), {
					kind: "end",
					family,
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
				layout: rowLayout(relation, families),
				owned: ownedColumns(relation, families)
			})
		}
	}
	return judged
}

/**
 * The binding of a compiled write (write/program/binding.ts Binding): every judgment binding one application takes from
 * the law model, decided once over the write's front end.
 */
export const decideBinding = (frontend: WriteFrontend): Binding =>
	Object.freeze({
		proposals: new Map(
			[...frontend.slotsById].map(
				([slot, at]) => [slot, proposalAt(frontend, at.group.stratum, slot)] as const
			)
		),
		fresh: freshStrata(frontend),
		judged: judgedRelations(frontend)
	})
