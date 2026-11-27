/**
 * A member slot's facts as one relation of the flight: a slot two or more statements of the program read is staged once,
 * at the flight's start, into a carrier of its own, and every statement that reads it reads the carrier.
 *
 * A statement reads a member slot's facts through its arrays, one per column of the slot (insert/input.ts readInput),
 * and binds its own copy of every one of them. A replace reads its additions twice: the exact deletion excepts them
 * (D EXCEPT A, delete/exact.ts) and the insert writes them, so every added fact, a bytes column's whole values among
 * them, travels once per statement that reads it. The program knows, statement by statement, which slots each reads
 * (the member placeholders of its forms), so it decides which travel once: a slot read by two or more statements is
 * staged, and a slot read by one stays that statement's arrays.
 *
 *   SELECT pg_catalog.set_config('grizzle.__carrier_<k>_c1', ...::text, true), ... FROM (SELECT "r1"."c1", "r1"."c2",
 *     ... FROM (SELECT pg_catalog.unnest($1::text[]) AS "c1", ...) AS "r1") AS "r2"(...)   (the carrier filled)
 *   ... every reader, each FROM item of the slot's arrays read from the carrier under its own alias and columns:
 *     (SELECT "r40"."c2", "r40"."c1", ... FROM (SELECT "u"."c1" AS "c1", ... FROM ROWS FROM (pg_catalog.unnest(
 *     pg_catalog.current_setting(...)::text[]), ...) AS "u"("c1", ...)) AS "r40") AS "r8"("c21", "c22", ...)
 *
 * Every reader's FROM item declares the slot's whole heading, one element type, collation and check per field
 * (insert/input.ts inputColumns), and the carrier declares each field's column so, its fill binding the slot's arrays as
 * a reader did, each through its check: the carrier holds exactly the rows each reader's arrays held, the slot's normal
 * facts, a set the host made, which the reader keeps reading as a relation input's (sql/ast.ts RowsProof `input`). A
 * reader's other placeholders are numbered again in order. The carriers are filled first in the flight, before any
 * stratum, and belong to none (write/carriers/carriers.ts carrierStash). A slot of no column, read through its count,
 * carries nothing to stage.
 */
import { appendAll, indices } from "@bjornpagen/grizzle-text/base/array"
import { defect, defined } from "@bjornpagen/grizzle-text/base/invariant"
import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type { ParamId } from "#compiler/core/ids.ts"
import { always } from "#compiler/ir/needs.ts"
import { sameScalarType } from "#compiler/ir/scalar.ts"
import type {
	MemberParamSlot,
	RelationColumn,
	WriteParamSlot
} from "#compiler/lower/conservative/types.ts"
import { oneForm } from "#compiler/runtime/lower/forms.ts"
import type { ArrayCheck, ArrayColumn, Cte, FromSource, SqlStatement } from "#compiler/sql/ast.ts"
import {
	arrays,
	col,
	derived,
	positionalValue,
	provedCore,
	sameTypeRef,
	select,
	target
} from "#compiler/sql/build.ts"
import { emitText } from "#compiler/sql/emit.ts"
import {
	type CarrierDeclaration,
	carrierName,
	freshNames,
	namedQuery,
	type NameMap,
	NameSupply
} from "#compiler/sql/naming.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"
import {
	type CarrierColumn,
	type CarrierDeclaring,
	carrierColumnDef,
	carrierRead,
	carrierStash,
	type WriteCarrier
} from "#compiler/write/carriers/carriers.ts"
import type { CarrierResult, WriteStatement } from "#compiler/write/insert/statement.ts"
import {
	castsNothing,
	type FormText,
	type PlacedStatement,
	type SentForm,
	wholeText,
	writeStatementSpec
} from "#compiler/write/program/artifact.ts"

/**
 * A member slot staged into a carrier: its first reader's placeholder, which names the slot and its relation and
 * declares its fields, and its carrier, a column per field in that declaration's order.
 */
interface StagedSlot {
	readonly first: MemberParamSlot
	readonly columns: NonEmptyReadonlyArray<RelationColumn>
	readonly carrier: WriteCarrier
}

/** A program's statements with its slots staged (see the header), and every carrier the program names. */
export interface StagedSlots {
	readonly statements: ReadonlyArray<PlacedStatement>
	readonly carriers: ReadonlyArray<WriteCarrier>
}

/** A placed statement of the program's own. */
type OwnPlaced = Extract<PlacedStatement, { readonly kind: "own" }>

/** A form of an own statement as the pass reads and rewrites it: its AST and its placeholders. */
interface Formed {
	readonly ast: SqlStatement
	readonly params: ReadonlyArray<WriteParamSlot>
}

/** Every form of an own statement: its spec's, and its whole-relation form where an execution chooses between them. */
const formsOf = (p: OwnPlaced): ReadonlyArray<Formed> => [
	{ ast: p.ast, params: p.spec.paramSlots },
	...(p.forms.kind === "chosen" ? [{ ast: p.forms.large.ast, params: p.forms.large.params }] : [])
]

const sameCheck = (a: ArrayCheck, b: ArrayCheck): boolean =>
	a.kind === "base" ? b.kind === "base" : b.kind === "domain" && sameTypeRef(a.domain, b.domain)

/** Whether two readers declare a slot's field alike: one type, one element type and collation, one check. */
const sameColumn = (a: RelationColumn, b: RelationColumn): boolean =>
	a.name === b.name &&
	sameScalarType(a.type, b.type) &&
	sameTypeRef(a.definition.type, b.definition.type) &&
	(a.definition.collation === undefined) === (b.definition.collation === undefined) &&
	sameCheck(a.check, b.check)

/** Whether two placeholders of one slot declare its heading alike, field by field in any order. */
const sameHeading = (a: MemberParamSlot, b: MemberParamSlot): boolean =>
	a.columns.length === b.columns.length &&
	b.columns.every((c) => a.columns.some((k) => sameColumn(k, c)))

/**
 * The slots the statements `placed` read, in the order the program first reads them, each with its first reader's
 * placeholder and the positions of the statements that read it. Every reader declares the slot's heading alike
 * (`sameHeading`), so one carrier holds what each reads.
 */
const slotReaders = (
	placed: ReadonlyArray<PlacedStatement>
): ReadonlyArray<{ readonly first: MemberParamSlot; readonly readers: ReadonlySet<number> }> => {
	const found = new Map<
		ParamId,
		{ readonly first: MemberParamSlot; readonly readers: Set<number> }
	>()
	for (const [position, p] of placed.entries()) {
		if (p.kind !== "own") {
			continue
		}
		for (const form of formsOf(p)) {
			for (const slot of form.params) {
				if (slot.kind !== "member") {
					continue
				}
				const known = found.get(slot.slot)
				if (known === undefined) {
					found.set(slot.slot, { first: slot, readers: new Set([position]) })
				} else if (sameHeading(known.first, slot)) {
					known.readers.add(position)
				} else {
					defect(`every statement that reads member slot ${slot.slot} declares its heading alike`)
				}
			}
		}
	}
	return [...found.values()]
}

/** The slots the program stages, those of a column at least that two statements or more read, each with its carrier,
 * numbered after the program's `known` carriers. */
const stagedSlots = (
	placed: ReadonlyArray<PlacedStatement>,
	known: number,
	declaring: CarrierDeclaring
): ReadonlyArray<StagedSlot> => {
	const staged: Array<StagedSlot> = []
	for (const { first, readers } of slotReaders(placed)) {
		const columns = first.columns
		if (readers.size < 2 || !isNonEmpty(columns)) {
			continue
		}
		const declaration: CarrierDeclaration = Object.freeze({
			columns: Object.freeze(
				columns.map((c, i) =>
					Object.freeze(carrierColumnDef(`c${i + 1}`, declaring.typing(c.type)))
				)
			)
		})
		staged.push(
			Object.freeze({
				first,
				columns,
				carrier: Object.freeze({
					name: carrierName(known + staged.length + 1),
					heading: Object.freeze(
						columns.map((c, i): CarrierColumn =>
							Object.freeze({ name: c.name, type: c.type, column: `c${i + 1}` })
						)
					),
					declaration,
					bound: "held",
					rows: "a member slot's facts"
				})
			})
		)
	}
	return staged
}

/**
 * The fill of a staged slot's carrier (write/carriers/carriers.ts carrierStash): the slot's arrays, one placeholder per
 * carrier column from $1 in the carrier's order, each declared and checked as every reader declares it, read whole.
 */
const fillOf = (staged: StagedSlot): WriteStatement<CarrierResult> => {
	const { first, carrier } = staged
	const supply = new NameSupply(freshNames)
	const origin = { kind: "param", param: first.slot } as const
	const alias = supply.relation(origin)
	const columns = mapNonEmpty(staged.columns, (c): RelationColumn => ({
		...c,
		definition: {
			name: supply.column(origin),
			type: c.definition.type,
			collation: c.definition.collation
		}
	}))
	const read = mapNonEmpty(columns, (c, i): ArrayColumn => ({
		definition: c.definition,
		array: positionalValue(i + 1),
		check: c.check
	}))
	const rows = select(
		provedCore(
			"input",
			columns.map((c) => target(col(alias, c.definition.name))),
			[arrays({ kind: "columns", columns: read, ordinal: undefined }, alias)],
			undefined
		)
	)
	const stash = { kind: "internal", purpose: "staged slot fill" } as const
	const ast = carrierStash(carrier, rows, {
		alias: supply.relation(stash),
		columns: carrier.heading.map(() => supply.column(stash))
	})
	return Object.freeze({
		role: "carrier" as const,
		ast,
		sql: emitText(ast, supply.map()),
		params: Object.freeze(
			columns.map((_, index): MemberParamSlot => ({
				kind: "member",
				placeholder: "value",
				number: index + 1,
				slot: first.slot,
				relation: first.relation,
				columns,
				part: { kind: "column", index }
			}))
		),
		result: Object.freeze({ kind: "carrier" as const, carrier: carrier.name }),
		needs: always
	})
}

/** The relation names a FROM source defines. */
const sourceNames = (source: FromSource): ReadonlyArray<string> => {
	switch (source.kind) {
		case "probe":
		case "met":
			return [source.inner, source.alias]
		case "metRows":
			return [source.scan, source.returned, source.sides, source.marked, source.alias]
		case "cte":
			return source.alias === undefined ? [] : [source.alias]
		case "table":
		case "read":
		case "enclosing":
		case "derived":
		case "function":
		case "arrays":
		case "values":
		case "context":
		case "transition":
			return [source.alias]
	}
}

/** The relation names a WITH's CTEs define: each CTE's own, and a data-modifying CTE's target alias. */
const cteNames = (ctes: ReadonlyArray<Cte>): ReadonlyArray<string> =>
	ctes.flatMap((c) =>
		c.query.kind === "select" || c.query.alias === undefined ? [c.name] : [c.name, c.query.alias]
	)

/** The relation names `ast` defines anywhere (sql/naming.ts: r<n>, each once per statement). */
const relationNames = (ast: SqlStatement): ReadonlyArray<string> => {
	const names: Array<string> = []
	if (
		ast.kind === "insert" ||
		ast.kind === "update" ||
		ast.kind === "delete" ||
		ast.kind === "merge"
	) {
		appendAll(names, cteNames(ast.with?.ctes ?? []))
		if (ast.alias !== undefined) {
			names.push(ast.alias)
		}
	}
	transformStatement(ast, {
		...identityHooks,
		fromSource: (source) => {
			appendAll(names, sourceNames(source))
			return source
		},
		select: (s) => {
			appendAll(names, cteNames(s.with?.ctes ?? []))
			return s
		}
	})
	return names
}

/** The number of a generated relation name r<n>, none for any other name. */
const relationNumber = (name: string): number | undefined => {
	const n = Number(name.slice(1))
	return name.startsWith("r") && String(n) === name.slice(1) ? n : undefined
}

/** The first relation number past every r<n> `ast` defines, as a NameSupply starts a statement that continues it. */
export const relationsPast = (ast: SqlStatement): number =>
	relationNames(ast).reduce((next, name) => {
		const n = relationNumber(name)
		return n === undefined ? next : Math.max(next, n + 1)
	}, freshNames.relationStart)

/**
 * The numbering of a statement's placeholders `$1` to `$count` once the `moved` ones are gone, each other numbered again
 * in order: a defect for a moved one, which the FROM item that read it no longer does once it is replaced.
 */
const renumbering = (count: number, moved: ReadonlySet<number>): ((number: number) => number) => {
	const kept = indices(count).flatMap((i) => (moved.has(i + 1) ? [] : [i + 1]))
	const numbered = new Map(kept.map((number, i) => [number, i + 1] as const))
	return (number) =>
		defined(numbered.get(number), `placeholder $${number}, which a replaced FROM item carries`)
}

/**
 * `ast` with each FROM item `replace` replaces, and every placeholder of the rest, a value's and an arrays FROM item's
 * count's and columns', numbered by `renumbered` (`renumbering`, or the admission's shift, write/program/admission.ts).
 */
export const renumberedStatement = (
	ast: SqlStatement,
	renumbered: (number: number) => number,
	replace: (source: FromSource) => FromSource | undefined
): SqlStatement =>
	transformStatement(ast, {
		...identityHooks,
		replaceSource: replace,
		expr: (e) =>
			e.kind === "param" ? { ...e, slot: positionalValue(renumbered(e.slot.number)) } : e,
		fromSource: (source) => {
			if (source.kind !== "arrays") {
				return source
			}
			const read = source.source
			switch (read.kind) {
				case "count":
					return {
						...source,
						source: { ...read, count: positionalValue(renumbered(read.count.number)) }
					}
				case "columns":
					return {
						...source,
						source: {
							...read,
							columns: mapNonEmpty(read.columns, (c) => ({
								...c,
								array: positionalValue(renumbered(c.array.number))
							}))
						}
					}
				case "carried":
				case "setting":
					return source
			}
		}
	})

/**
 * A form read through the carriers of the slots `staged` holds: each FROM item of a staged slot's arrays replaced by the
 * carrier's columns under the item's alias and column names, read through a fresh alias of its own, and every other
 * placeholder numbered again in order; and the names the replacement defines. A placeholder of a staged slot anywhere
 * but the FROM item of its arrays, or one FROM item over another slot's arrays besides, is a defect: a statement reads a
 * slot as one source.
 */
const restaged = (
	form: Formed,
	staged: ReadonlyMap<ParamId, StagedSlot>
): { readonly form: Formed; readonly names: NameMap; readonly reads: ReadonlyArray<ParamId> } => {
	const slotAt = (number: number): WriteParamSlot | undefined => form.params[number - 1]
	const stagedAt = (number: number): StagedSlot | undefined => {
		const slot = slotAt(number)
		return slot?.kind === "member" ? staged.get(slot.slot) : undefined
	}
	const moved = new Set(
		form.params.flatMap((s) => (stagedAt(s.number) === undefined ? [] : [s.number]))
	)
	if (moved.size === 0) {
		return { form, names: [], reads: [] }
	}
	if (!form.params.every((s, i) => s.number === i + 1)) {
		defect("a statement's placeholder $n is its n-th slot")
	}
	const supply = new NameSupply({ relationStart: relationsPast(form.ast), columnStart: 1 })
	const reads = new Set<ParamId>()
	const kept = form.params.filter((s) => !moved.has(s.number))
	const renumbered = renumbering(form.params.length, moved)
	const carried = (source: FromSource): FromSource | undefined => {
		if (source.kind !== "arrays" || source.source.kind !== "columns") {
			return undefined
		}
		const columns = source.source.columns
		const of = columns.map((c) => stagedAt(c.array.number))
		const [head] = of
		if (head === undefined) {
			if (of.some((s) => s !== undefined)) {
				defect("a FROM item of a staged slot's arrays reads that slot's arrays alone")
			}
			return undefined
		}
		if (!of.every((s) => s === head) || source.source.ordinal !== undefined) {
			defect("a FROM item of a staged slot's arrays reads that slot's arrays alone, unordered")
		}
		reads.add(head.first.slot)
		const scan = supply.relation({ kind: "internal", purpose: "staged slot scan" })
		const fieldOf = (number: number): string => {
			const slot = slotAt(number)
			if (slot?.kind !== "member" || slot.part.kind !== "column") {
				defect("a staged slot's array placeholder of one of its columns")
			}
			return defined(slot.columns[slot.part.index], "the column of a member placeholder's part")
				.name
		}
		return derived(
			namedQuery(
				select(
					provedCore(
						"input",
						columns.map((c) =>
							target(
								col(
									scan,
									defined(
										head.carrier.heading.find((h) => h.name === fieldOf(c.array.number)),
										`a field of member slot ${head.first.slot}, a column of its carrier`
									).column
								)
							)
						),
						[carrierRead(head.carrier, scan)],
						undefined
					)
				),
				columns.map((c) => c.definition.name)
			),
			source.alias,
			false
		)
	}
	const ast = renumberedStatement(form.ast, renumbered, carried)
	return {
		form: {
			ast,
			params: Object.freeze(kept.map((s) => ({ ...s, number: renumbered(s.number) })))
		},
		names: supply.map(),
		reads: [...reads]
	}
}

/**
 * The statements `placed` with every member slot two or more of them read staged into a carrier (see the header), the
 * carriers numbered after the program's own, `carriers`: each carrier filled first in the flight, every position moved
 * past them, and every reader depending on the fills of the slots it reads.
 */
export const withStagedSlots = (
	placed: ReadonlyArray<PlacedStatement>,
	carriers: ReadonlyArray<WriteCarrier>,
	declaring: CarrierDeclaring
): StagedSlots => {
	const staged = stagedSlots(placed, carriers.length, declaring)
	if (!isNonEmpty(staged)) {
		return { statements: placed, carriers }
	}
	const bySlot = new Map(staged.map((s) => [s.first.slot, s] as const))
	const inserted = staged.length
	const move = (position: number): number => position + inserted
	const fillAt = new Map(staged.map((s, i) => [s.first.slot, i] as const))
	const carrierSteps = staged.map((s): PlacedStatement => {
		const fill = fillOf(s)
		return {
			kind: "own",
			step: Object.freeze({
				kind: "carrier",
				carrier: s.carrier.name,
				stratum: undefined,
				casts: castsNothing
			}),
			spec: writeStatementSpec(fill, []),
			ast: fill.ast,
			text: wholeText,
			forms: oneForm,
			names: fill.sql.nameMap,
			riders: []
		}
	})
	const moved = placed.map((p): PlacedStatement => {
		if (p.kind !== "own") {
			return { ...p, spec: Object.freeze({ ...p.spec, dependsOn: p.spec.dependsOn.map(move) }) }
		}
		const own = restaged({ ast: p.ast, params: p.spec.paramSlots }, bySlot)
		const large =
			p.forms.kind === "chosen"
				? restaged({ ast: p.forms.large.ast, params: p.forms.large.params }, bySlot)
				: undefined
		const names: NameMap = [...p.names, ...own.names]
		const fills = [...own.reads, ...(large?.reads ?? [])].map((slot) =>
			defined(fillAt.get(slot), `the fill of member slot ${slot}`)
		)
		const dependsOn = Object.freeze(
			[...new Set([...p.spec.dependsOn.map(move), ...fills])].toSorted((x, y) => x - y)
		)
		/** The large form read through the carriers, its text sent as the form it replaces sends its own. */
		const largeForm = (form: Formed, text: FormText): SentForm =>
			Object.freeze({ sql: emitText(form.ast, []).text, params: form.params, ast: form.ast, text })
		return {
			...p,
			ast: own.form.ast,
			names,
			spec: Object.freeze({
				...p.spec,
				sql: own.reads.length === 0 ? p.spec.sql : emitText(own.form.ast, names).text,
				paramSlots: own.form.params,
				dependsOn
			}),
			forms:
				p.forms.kind === "chosen" && large !== undefined && large.reads.length > 0
					? Object.freeze({ ...p.forms, large: largeForm(large.form, p.forms.large.text) })
					: p.forms
		}
	})
	return {
		statements: [...carrierSteps, ...moved],
		carriers: [...carriers, ...staged.map((s) => s.carrier)]
	}
}
