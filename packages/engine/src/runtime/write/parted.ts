/**
 * A single statement sent by its parts (write/program/single.ts singleStatement): its text as units, each printed by the
 * engine where the write compiles, so a call sends exactly the parts its inputs may give rows, and no other part's
 * text, placeholder or trigger.
 *
 * A single statement is one WITH of sibling CTEs and one UNION ALL of tagged arms:
 *
 *   WITH <a unit's CTEs>,
 *   <the next unit's CTEs>,
 *   ...
 *   <a unit's arm>
 *   UNION ALL
 *   <the next unit's arm>
 *   ...
 *
 * Its units, in that order: its shared sub-queries, sent with every part (`always`, no arm); each write action's part,
 * its CTEs and its arm, sent where the part's needs hold over the call's inputs (`part`, ir/needs.ts); and its riding
 * read-backs' deltas and statements, sent always, with every part whose delta they read, whose needs are then `always`.
 * A call's text is the units it sends, assembled as the printer prints the whole (sql/print.ts withBlock, bodyBlock), so
 * the text of a call that sends every unit is the whole statement's byte for byte, and each unit's text is the whole's
 * in every call. Each arm keeps its tag, the part's index among all the statement's parts, and the whole statement's
 * width, so a call's rows read as the whole statement's do (steps.ts writeRows), a part not sent having none. A unit's
 * placeholders are its own, read by its CTEs and its arms alike (a CTE its arm reads once is printed in the arm,
 * sql/print-once.ts), and number after the placeholders of the units the call sends before it (CutText); a unit whose
 * CTEs are all printed in its arms holds no CTE text, and adds none to the WITH. A call that sends no part and no riding
 * read-back sends no statement (`sentUnits`).
 */
import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { nominal } from "#compiler/core/brand.ts"
import { holds, type NeededInput, type Needs } from "#compiler/ir/needs.ts"
import type { EmittedText } from "#compiler/sql/ast.ts"

/**
 * A unit's text with its placeholders cut out: `head`, then for each hole its placeholder and the text after it, a hole
 * the index of the placeholder among its unit's own (PartedUnit `params`), so the text numbers its placeholders after
 * however many the units sent before it hold.
 */
export interface CutText {
	readonly head: string
	readonly holes: ReadonlyArray<{ readonly hole: number; readonly after: string }>
}

/**
 * One unit of a single statement (see the header): its CTEs' text, its arms and its placeholders, by `Slot`, which the
 * compile, the served file and a loaded write each hold their own form of. A part is sent where its needs hold, any
 * other unit with every statement it is a unit of.
 */
export type PartedUnit<Slot> =
	| {
			readonly kind: "always"
			readonly ctes: CutText
			readonly arms: ReadonlyArray<CutText>
			readonly params: ReadonlyArray<Slot>
	  }
	| {
			readonly kind: "part"
			readonly needs: Needs
			readonly ctes: CutText
			readonly arm: CutText
			readonly params: ReadonlyArray<Slot>
	  }

/** A single statement's text by its units, in the order the whole statement holds them. */
export interface Parted<Slot> {
	readonly units: NonEmptyReadonlyArray<PartedUnit<Slot>>
}

declare const assembledTextBrand: unique symbol

/**
 * A single statement's text for the units a call sends, assembled of the texts the engine printed (`assembled`), minted
 * here alone, so the text a call sends is a served statement's and nothing a caller wrote.
 */
export type AssembledText = string & { readonly [assembledTextBrand]: true }

const mint = nominal<string, AssembledText>()

/** A write statement's text as an execution sends it: printed whole by the engine, or a single statement's assembled
 * of its printed units for the units a call sends. */
export type WriteText = EmittedText | AssembledText

/** `cut` with its placeholders numbered after `before` placeholders of the units before it. */
const placed = (cut: CutText, before: number): string => {
	let text = cut.head
	for (const { hole, after } of cut.holes) {
		text += `$${before + hole + 1}${after}`
	}
	return text
}

/**
 * The units of a call's statement and the key they are memoized by, or none where the call sends no statement: every
 * part whose needs hold where `holdsFact` says which inputs hold a fact, and every other unit, when some part or a
 * riding read-back's arm is sent. The key is the indexes of the units sent.
 */
export const sentUnits = <Slot>(
	parted: Parted<Slot>,
	holdsFact: (input: NeededInput) => boolean
): { readonly key: string; readonly units: ReadonlyArray<PartedUnit<Slot>> } | undefined => {
	const units: Array<PartedUnit<Slot>> = []
	const at: Array<number> = []
	let rows = false
	for (const [i, unit] of parted.units.entries()) {
		if (unit.kind === "part" && !holds(unit.needs, holdsFact)) {
			continue
		}
		units.push(unit)
		at.push(i)
		rows ||= unit.kind === "part" || unit.arms.length > 0
	}
	return rows ? { key: at.join(","), units } : undefined
}

/**
 * The text of `units` and their placeholders in order: their CTEs after one WITH, each unit's placeholders numbered
 * after the units' before it, and their arms joined by UNION ALL, as the printer joins a WITH's CTEs and a set
 * operation's arms (see the header).
 */
export const assembled = <Slot>(
	units: ReadonlyArray<PartedUnit<Slot>>
): { readonly text: AssembledText; readonly params: ReadonlyArray<Slot> } => {
	const ctes: Array<string> = []
	const arms: Array<string> = []
	const params: Array<Slot> = []
	for (const unit of units) {
		const before = params.length
		const text = placed(unit.ctes, before)
		if (text !== "") {
			ctes.push(text)
		}
		for (const arm of unit.kind === "part" ? [unit.arm] : unit.arms) {
			arms.push(placed(arm, before))
		}
		appendAll(params, unit.params)
	}
	const head = ctes.length === 0 ? "" : `WITH ${ctes.join(",\n")}\n`
	return { text: mint(`${head}${arms.join("\nUNION ALL\n")}`), params }
}
