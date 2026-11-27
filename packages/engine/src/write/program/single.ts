import { appendAll, maxOf } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	concatNonEmpty,
	extendNonEmpty,
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { always, type Needs } from "#compiler/ir/needs.ts"
import type { WriteParamSlot } from "#compiler/lower/conservative/types.ts"
import { shiftedPart, taggedArms } from "#compiler/lower/parts.ts"
import type { CutText, Parted, PartedUnit } from "#compiler/runtime/write/parted.ts"
import type {
	Cte,
	EmittedSql,
	OperandBody,
	Select,
	SetArm,
	SqlStatement,
	Target,
	UnprintedSql
} from "#compiler/sql/ast.ts"
import {
	col,
	cteRef,
	lit,
	provedCore,
	select,
	target,
	types,
	unionAll
} from "#compiler/sql/build.ts"
import { emitSelect, emitText, type Emitting } from "#compiler/sql/emit.ts"
import { lexemesOf } from "#compiler/sql/lexer.ts"
import {
	namedBody,
	type NameMap,
	namesPast,
	NameSupply,
	type NameSupplyStart
} from "#compiler/sql/naming.ts"
import { inPlaceSites, printedOnce } from "#compiler/sql/print-once.ts"
import { printArmBlock, printCteBlock } from "#compiler/sql/print.ts"
import { inertVisitor, visitSelect } from "#compiler/sql/transform.ts"
import type { FamilyWriteSql } from "#compiler/write/family/written.ts"
import {
	type DeleteResult,
	type InsertResult,
	type ModifyingStatement,
	ownStatement
} from "#compiler/write/insert/statement.ts"
import type { PutStatement } from "#compiler/write/put/statement.ts"

/** A sub-query several parts of a single statement read, a CTE under `name`. */
export interface SharedPart {
	readonly name: string
	readonly columns: ReadonlyArray<string>
	readonly query: Select
	readonly params: ReadonlyArray<WriteParamSlot>
	/** The generated names its query and its CTE's own name and columns define. */
	readonly nameMap: NameMap
}

/** One action's write statement as a part of a single statement, with the width of its rows. */
export interface WritePart {
	readonly statement:
		| ModifyingStatement<InsertResult, UnprintedSql>
		| ModifyingStatement<DeleteResult, UnprintedSql>
		| PutStatement<UnprintedSql>
	readonly width: number
}

/**
 * A sent statement of a read-back riding a single statement, a part of it: its executable query, whose WITH, recursive
 * or not, stays its own inside the part, its placeholders, every one a declared parameter's, the generated names it
 * defines, all past every name the statement's writes and deltas define, and the width of its rows, a numbered part's
 * row number among them (lower/parts.ts TaggedPart).
 */
export interface ReadBackPart {
	readonly query: Select
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly nameMap: NameMap
	readonly width: number
}

/** What rides a single statement: the CTEs holding the deltas its riding read-backs read or its carriers hold, over its
 * writes' RETURNING (write/readback/deltas.ts deltaCte), with the names they define and the writes, by their index among
 * the statement's, whose RETURNING they read, and each riding read-back's sent statements, in order, then each carried
 * side's fill, a part of no row (write/readback/deltas.ts carriedStash). */
export interface Riding {
	readonly deltas: ReadonlyArray<Cte>
	readonly read: ReadonlyArray<number>
	readonly nameMap: NameMap
	readonly parts: ReadonlyArray<ReadBackPart>
}

/** A single statement no read-back rides and no side is carried out of. */
export const noRiding: Riding = Object.freeze({
	deltas: [],
	read: [],
	nameMap: [],
	parts: []
})

/**
 * A unit of a single statement (runtime/write/parted.ts), as many of its WITH's CTEs and of its body's arms as it holds,
 * in order: its shared sub-queries, every call's, with no arm; a write action's part, its CTEs and its one arm, sent
 * where its needs hold; its riding read-backs' deltas and statements, every call's, and their arms.
 */
export type UnitShape =
	| { readonly kind: "always"; readonly ctes: number; readonly arms: number }
	| { readonly kind: "part"; readonly needs: Needs; readonly ctes: number }

export interface SingleStatement {
	readonly ast: Select
	readonly sql: EmittedSql
	/** The statement as it was bound (sql/bind.ts), which `sql` prints and its units are cut from (`partedOf`). */
	readonly bound: Select
	readonly params: ReadonlyArray<WriteParamSlot>
	/** The widest part's columns, which every row carries after its tag. */
	readonly width: number
	/** Its units (UnitShape), in the order its WITH and its arms hold them. */
	readonly units: NonEmptyReadonlyArray<UnitShape>
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** Fresh names at `start`: `count` columns and, first, one relation; and the start past them. */
export const freshNames = (
	start: NameSupplyStart,
	count: number
): {
	readonly relation: string
	readonly columns: ReadonlyArray<string>
	readonly nameMap: NameMap
	readonly next: NameSupplyStart
} => {
	const supply = new NameSupply(start)
	const relation = supply.relation(internal("single statement part"))
	const columns = Array.from({ length: count }, () =>
		supply.column(internal("single statement column"))
	)
	return { relation, columns, nameMap: supply.map(), next: namesPast(supply.map(), ownStatement) }
}

/** The single statement of the shared sub-queries `shares` and the write parts `writes`, whose generated names start at
 * `start`, past every part's: a stratum's write actions as one statement, the single-statement realization.
 * Where one snapshot suffices, the stratum's statements are writes of distinct relations whose members all read the
 * stratum's starting state, so they need not be sequential: each is a part of one statement, its CTEs siblings of the
 * others' under one WITH, every member read at the statement's snapshot, which is that starting state. Each part is
 * built as a statement of its own whose generated names start past every name an earlier part used, so no name is
 * defined twice, and whose placeholders number from $1; the statement renumbers each part's placeholders past the
 * earlier parts' and concatenates their encoders. A sub-query several parts read is one CTE of the statement, read by
 * each part in place of the carrier the sequential realization fills, and PostgreSQL evaluates a CTE that several
 * references read once.
 *
 * Each part's outer SELECT becomes a CTE of its own, and the statement's rows are each part's rows behind its tag, its
 * index among the parts, padded with empty texts to the widest part:
 *
 *   WITH "r40"("c90", ...) AS MATERIALIZED (<shared sub-query>),
 *        <part 0's CTEs>, "r50"("c100", "c101") AS (<part 0's outer SELECT>),
 *        <part 1's CTEs>, "r60"("c110", "c111", "c112") AS (<part 1's outer SELECT>)
 *   SELECT 0, "r50"."c100", "r50"."c101", ''::text FROM "r50"
 *   UNION ALL SELECT 1, "r60"."c110", "r60"."c111", "r60"."c112" FROM "r60"
 *
 * The outcome reads each part's rows as its write step's (`writeRows`). Every data-modifying CTE runs to completion
 * whether or not the outer SELECT reads it, and PostgreSQL checks the immediate foreign keys at the end of the
 * statement, after every part, which the schedule's order between the parts only ever had to keep at its own end.
 *
 * A read-back rides the statement (`riding`) where the statement writes every delta it reads and nothing at or after
 * it changes what it reads (write/schedule/plan.ts placeReadBacks). Its deltas are CTEs over the writes' RETURNING,
 * after the writes' parts, and each of its sent statements is a part after them, its own query whole as one CTE, its
 * rows behind its tag after the writes' tags, padded as theirs are; the runtime reads them as that read-back's
 * statements' rows. No arm orders its rows: an ordered part's rows carry their row number in the part's order, which
 * the runtime reads them back in (lower/parts.ts TaggedPart). A side carried out of the statement for a read-back after
 * the last stratum is a delta CTE too, and its carrier's fill a part after the read-backs' that delivers no row
 * (write/carriers/carriers.ts ridingStash), whose arm PostgreSQL reads to its end all the same. A write whose RETURNING a
 * delta reads is sent whatever its needs. */
export const singleStatement = (
	shares: ReadonlyArray<SharedPart>,
	writes: NonEmptyReadonlyArray<WritePart>,
	riding: Riding,
	start: NameSupplyStart,
	binding: Emitting
): SingleStatement => {
	const shareCtes: Array<Cte> = []
	const params: Array<WriteParamSlot> = []
	const nameMap: Array<NameMap[number]> = []
	let next = start
	for (const part of shares) {
		const shift = shiftedPart(part.query, part.params, params.length)
		shareCtes.push({
			name: part.name,
			materialized: "MATERIALIZED",
			query: namedBody(shift.query, part.columns)
		})
		appendAll(params, shift.params)
		appendAll(nameMap, part.nameMap)
	}
	const outs = mapNonEmpty(writes, (part) => {
		const statement = part.statement
		/** The statement's WITH, renumbered as its body is: transformSelect keeps a WITH it is given. */
		const { query: body, params: partParams } = shiftedPart(
			statement.ast,
			statement.params,
			params.length
		)
		appendAll(params, partParams)
		appendAll(nameMap, statement.sql.nameMap)
		const out = freshNames(next, part.width)
		next = out.next
		appendAll(nameMap, out.nameMap)
		const own: Cte = {
			name: out.relation,
			materialized: undefined,
			query: namedBody({ ...body, with: undefined }, out.columns)
		}
		return {
			name: out.relation,
			columns: out.columns,
			ctes: appendNonEmpty(body.with === undefined ? [] : body.with.ctes, own),
			needs: statement.needs
		}
	})
	appendAll(nameMap, riding.nameMap)
	const ridden = riding.parts.map((part) => {
		const shift = shiftedPart(part.query, part.params, params.length)
		appendAll(params, shift.params)
		appendAll(nameMap, part.nameMap)
		return { query: shift.query, width: part.width }
	})
	next = namesPast(nameMap, next)
	const rides = ridden.map((part) => {
		const out = freshNames(next, part.width)
		next = out.next
		appendAll(nameMap, out.nameMap)
		const own: Cte = {
			name: out.relation,
			materialized: undefined,
			query: namedBody(part.query, out.columns)
		}
		const ctes: NonEmptyReadonlyArray<Cte> = [own]
		return { name: out.relation, columns: out.columns, ctes }
	})
	const rideCtes = [...riding.deltas, ...rides.flatMap((r) => r.ctes)]
	const ctes = concatNonEmpty(
		shareCtes,
		extendNonEmpty(
			flatMapNonEmpty(outs, (o) => o.ctes),
			rideCtes
		)
	)
	const { arms, width } = taggedArms(extendNonEmpty(outs, rides), 0)
	const ast: Select = { ...select(unionAll("disjoint", arms)), with: { recursive: false, ctes } }
	const read = new Set(riding.read)
	const parts = mapNonEmpty(outs, (o, at): UnitShape => ({
		kind: "part",
		needs: read.has(at) ? always : o.needs,
		ctes: o.ctes.length
	}))
	const units = concatNonEmpty(
		isNonEmpty(shareCtes) ? [{ kind: "always" as const, ctes: shareCtes.length, arms: 0 }] : [],
		extendNonEmpty(
			parts,
			isNonEmpty(rideCtes)
				? [{ kind: "always" as const, ctes: rideCtes.length, arms: rides.length }]
				: []
		)
	)
	const emitted = emitSelect(ast, nameMap, binding)
	return { ast, sql: emitted.sql, bound: emitted.ast, params, width, units }
}

/**
 * A single statement as it is printed (sql/print-once.ts printedOnce), every CTE PostgreSQL would inline printed in
 * place, and its units with the CTEs each still prints: a CTE printed in place leaves its unit's CTEs, and its text goes
 * where its one reference stands, which is in its own unit, since a part reads only its own CTEs and the shared ones,
 * which are MATERIALIZED, and a riding read-back reads only its own and the writes' RETURNING, which write.
 */
const printedUnits = (
	ast: Select,
	units: NonEmptyReadonlyArray<UnitShape>
): { readonly printed: SqlStatement; readonly units: NonEmptyReadonlyArray<UnitShape> } => {
	const ctes = ast.with?.ctes ?? []
	const unitOfCte: Array<number> = []
	const unitOfArm: Array<number> = []
	units.forEach((unit, at) => {
		for (let i = 0; i < unit.ctes; i += 1) {
			unitOfCte.push(at)
		}
		for (let i = 0; i < (unit.kind === "part" ? 1 : unit.arms); i += 1) {
			unitOfArm.push(at)
		}
	})
	const sites = inPlaceSites(ast)
	const arms = ast.body.kind === "setOp" ? ast.body.arms : [ast.body]
	for (const [name, site] of sites) {
		const at = ctes.findIndex((c) => c.name === name)
		const reader =
			site.kind === "cte"
				? unitOfCte[site.at]
				: unitOfArm[arms.findIndex((arm) => readsCte(arm, name))]
		if (reader !== unitOfCte[at]) {
			defect(`a single statement's CTE ${name}, printed in place, is read in another unit`)
		}
	}
	const printed = printedOnce(ast)
	const kept = new Set(
		(printed.kind === "select" ? printed.with?.ctes : undefined)?.map((c) => c.name)
	)
	const counts = units.map(
		(_, unit) => ctes.filter((c, at) => kept.has(c.name) && unitOfCte[at] === unit).length
	)
	return {
		printed,
		units: mapNonEmpty(units, (unit, at) => ({
			...unit,
			ctes: defined(counts[at], "a unit's count")
		}))
	}
}

/** Whether a single statement's arm reads the CTE `name`. */
const readsCte = (arm: OperandBody, name: string): boolean => {
	let reads = false
	visitSelect(
		{
			kind: "select",
			with: undefined,
			body: arm,
			orderBy: [],
			limit: undefined,
			offset: undefined
		},
		{
			...inertVisitor,
			fromItem: (item) => {
				reads ||= item.kind === "cte" && item.name === name
			}
		}
	)
	return reads
}

/**
 * A single statement's text by its units (runtime/write/parted.ts Parted), read off its `ast` as the statement holds it,
 * placeholders `params` and all, after every rewrite of its forms (write/program/slot-carriers.ts), and cut from
 * `bound`, that AST as it was bound (sql/bind.ts), which keeps each CTE and each arm the AST printed once keeps, in
 * order: each unit's CTEs and arms as the printer prints them in the whole (sql/print.ts printCteBlock,
 * printArmBlock), its placeholders cut out as PostgreSQL's scanner reads the text (sql/lexer.ts), so no `$` inside a
 * literal or a quoted identifier is one. A unit's placeholders are a block of the statement's, after the blocks of the
 * units before it: each part was built as a statement of its own, its placeholders numbered past the earlier parts'
 * (`singleStatement`), and a rewrite numbers the placeholders it keeps again in order.
 */
export const partedOf = <Slot>(
	ast: SqlStatement,
	bound: Select,
	params: ReadonlyArray<Slot>,
	units: NonEmptyReadonlyArray<UnitShape>
): Parted<Slot> => {
	if (ast.kind !== "select" || ast.with === undefined) {
		defect("a single statement is a SELECT under a WITH")
	}
	const { printed, units: own } = printedUnits(ast, units)
	if (printed.kind !== "select" || printed.with === undefined) {
		defect("a single statement printed once is a SELECT under a WITH: its units' arms read CTEs")
	}
	const armsOf = (q: Select) => (q.body.kind === "setOp" ? q.body.arms.length : 1)
	if (
		bound.with === undefined ||
		bound.with.ctes.length !== printed.with.ctes.length ||
		armsOf(bound) !== armsOf(printed)
	) {
		defect("a single statement bound keeps each CTE and each arm it keeps printed once")
	}
	const ctes = bound.with.ctes
	const body = bound.body
	const arms = body.kind === "setOp" ? body.arms : [body]
	let cte = 0
	let arm = 0
	let placed = 0
	/**
	 * A unit's CTEs' text and its arms' texts, `armCount` of them, each with its placeholders cut out: they are one block
	 * of the statement's, after the blocks of the units before it, read by its CTEs and its arms alike, since a CTE a
	 * part reads once is printed in its arm (sql/print-once.ts).
	 */
	const unitTexts = (
		cteCount: number,
		armCount: number
	): {
		readonly ctes: CutText
		readonly arms: ReadonlyArray<CutText>
		readonly params: ReadonlyArray<Slot>
	} => {
		const cteText = ctes
			.slice(cte, cte + cteCount)
			.map(printCteBlock)
			.join(",\n")
		cte += cteCount
		const armTexts = arms.slice(arm, arm + armCount).map((a) => {
			if (a.kind !== "core") {
				defect("a single statement's arm is a core")
			}
			return printArmBlock(a)
		})
		arm += armCount
		const from = placed
		const cut = cutTexts([cteText, ...armTexts], from)
		placed = from + cut.count
		const [cteCut, ...armCuts] = cut.texts
		return {
			ctes: defined(cteCut, "a unit's CTEs' text"),
			arms: armCuts,
			params: params.slice(from, placed)
		}
	}
	const parted = mapNonEmpty(own, (unit): PartedUnit<Slot> => {
		switch (unit.kind) {
			case "always": {
				const texts = unitTexts(unit.ctes, unit.arms)
				return { kind: "always", ctes: texts.ctes, arms: texts.arms, params: texts.params }
			}
			case "part": {
				const texts = unitTexts(unit.ctes, 1)
				return {
					kind: "part",
					needs: unit.needs,
					ctes: texts.ctes,
					arm: defined(texts.arms[0], "a part's one arm"),
					params: texts.params
				}
			}
		}
	})
	if (cte !== ctes.length || arm !== arms.length || placed !== params.length) {
		defect("a single statement's units hold its every CTE, arm and placeholder")
	}
	return { units: parted }
}

/**
 * The texts of a unit, its CTEs' and its arms', whose placeholders follow the statement's first `from`, with those cut
 * out (CutText): each hole its placeholder's index among the unit's, and how many the unit holds, its placeholders, read
 * by any of its texts, being the next block of the statement's.
 */
const cutTexts = (
	texts: ReadonlyArray<string>,
	from: number
): { readonly texts: ReadonlyArray<CutText>; readonly count: number } => {
	const numbers = new Set<number>()
	const cut = texts.map((text): CutText => {
		const holes: Array<{ readonly hole: number; readonly after: string }> = []
		let end = text.length
		for (const l of lexemesOf(text).lexemes.toReversed()) {
			if (l.kind !== "param") {
				continue
			}
			if (l.index <= from) {
				defect(`a placeholder $${l.index} of a single statement's unit after $${from}`)
			}
			numbers.add(l.index)
			holes.push({
				hole: l.index - from - 1,
				after: text.slice(l.start + `$${l.index}`.length, end)
			})
			end = l.start
		}
		return { head: text.slice(0, end), holes: holes.toReversed() }
	})
	const count = maxOf([...numbers], from) - from
	if (numbers.size !== count) {
		defect(`the placeholders of a single statement's unit after $${from} are a block`)
	}
	return { texts: cut, count }
}

/**
 * The family statement `family` with read-backs riding it or sides carried out of it (write/program/compile.ts
 * placeFamily): `deltas`, each added side a rider reads or a carrier holds, CTEs over the statement's inserts' RETURNING,
 * named by `deltaNames`, after its own CTEs; then each rider's statement, a carried side's fill among them, whole as one
 * CTE, its placeholders numbered past the statement's and every earlier rider's, its
 * names past `cursor`; and its rows behind `tag`, an arm after the family's, every arm padded with empty texts to the
 * widest, the family's tags and its riders' integers alike, as a single statement's riders ride it (`singleStatement`).
 */
export const ridingFamilyStatement = (
	family: FamilyWriteSql,
	deltas: ReadonlyArray<Cte>,
	deltaNames: NameMap,
	riders: ReadonlyArray<{ readonly part: ReadBackPart; readonly tag: number }>,
	cursor: NameSupplyStart,
	binding: Emitting
): {
	readonly ast: Select
	readonly sql: EmittedSql
	readonly params: ReadonlyArray<WriteParamSlot>
	readonly width: number
} => {
	const width = maxOf([family.width, ...riders.map((r) => r.part.width)], 0)
	const params: Array<WriteParamSlot> = [...family.params]
	const nameMap: Array<NameMap[number]> = [...family.sql.nameMap, ...deltaNames]
	let next = cursor
	const pad = (count: number): ReadonlyArray<Target> =>
		Array.from({ length: count }, () => target(lit.text("", types.text)))
	const rides = riders.map(({ part, tag }) => {
		const shifted = shiftedPart(part.query, part.params, params.length)
		appendAll(params, shifted.params)
		appendAll(nameMap, part.nameMap)
		next = namesPast(nameMap, next)
		const out = freshNames(next, part.width)
		next = out.next
		appendAll(nameMap, out.nameMap)
		const own: Cte = {
			name: out.relation,
			materialized: undefined,
			query: namedBody(shifted.query, out.columns)
		}
		const arm: SetArm = provedCore(
			"keyed",
			[
				target(lit.int(tag, types.integer)),
				...out.columns.map((c) => target(col(out.relation, c))),
				...pad(width - out.columns.length)
			],
			[cteRef(out.relation)],
			undefined
		)
		return { own, arm }
	})
	/** The family's own arm, padded to the riders' width. */
	const padded = (arm: SetArm): SetArm => {
		if (arm.kind !== "core") {
			return arm
		}
		return arm.distinct === false
			? { ...arm, targets: [...arm.targets, ...pad(width - family.width)] }
			: { ...arm, targets: extendNonEmpty(arm.targets, pad(width - family.width)) }
	}
	const ast: Select = {
		...select(
			unionAll(
				"disjoint",
				extendNonEmpty(
					mapNonEmpty(family.arms, padded),
					rides.map((r) => r.arm)
				)
			)
		),
		with: {
			recursive: false,
			ctes: extendNonEmpty(family.ctes, [...deltas, ...rides.map((r) => r.own)])
		}
	}
	return { ast, sql: emitText(ast, nameMap, binding), params, width }
}
