import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	appendNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { factEq, factNe } from "#compiler/ir/compare.ts"
import { fieldNames, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import type { Needs } from "#compiler/ir/needs.ts"
import { needsOf } from "#compiler/logical/needs.ts"
import { emptyEnv, extendEnv } from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { regionParts } from "#compiler/lower/conservative/match-region/index.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Cte, Delete, Expr, FromItem, OperandSelect } from "#compiler/sql/ast.ts"
import {
	and,
	binary,
	col,
	conjunction,
	cte,
	cteRef,
	operandSelect,
	provedCore,
	select,
	setOp,
	target,
	targetAs
} from "#compiler/sql/build.ts"
import { namedBody, type NameSupply } from "#compiler/sql/naming.ts"
import { type FieldColumns, fieldColumns } from "#compiler/write/defined.ts"
import type { DeleteAnchor } from "#compiler/write/delete/anchor.ts"
import { statedKey } from "#compiler/write/family/keyset.ts"
import { primaryKeyShape } from "#compiler/write/frontend/targets.ts"
import {
	inputNeeds,
	inputSharing,
	readOperand,
	uncarriedKeyGenerations,
	type WriteInput
} from "#compiler/write/insert/input.ts"
import { placeReleases } from "#compiler/write/insert/stamp.ts"
import { type HeldKey, joinedAtKey, keyedAmong } from "#compiler/write/probe.ts"

import {
	buildStatement,
	type DeleteResult,
	isCarried,
	keyFirst,
	type ModifyingStatement,
	ownBuild,
	requestedValue,
	type ResultColumn,
	returnedColumn,
	returnedRows,
	rowType,
	type WriteContext
} from "#compiler/write/insert/statement.ts"

interface DeleteSpec {
	readonly relation: RelationInfo
	readonly input: WriteInput
}

/** An exact deletion's spec: also the stratum's additions to the relation, complete facts all, which it reads
 * D EXCEPT A over. */
interface ExactDeleteSpec extends DeleteSpec {
	readonly except: ReadonlyArray<WriteInput>
}

/** A put's displacing deletion's spec: also the fields an occupant a requested fact collides with may differ from it
 * in (write/put/choose.ts differingOf). */
interface DisplacingDeleteSpec extends DeleteSpec {
	readonly differing: NonEmptyReadonlyArray<LawField>
}

/** How a deletion matches stored facts: an exact deletion, a requested fact at every field, its stratum's additions
 * excepted; a displacing deletion, each occupant a requested fact collides with at the primary key that differs from it. */
type DeleteMode =
	| { readonly kind: "exact"; readonly except: ReadonlyArray<WriteInput> }
	| { readonly kind: "displacing"; readonly differing: NonEmptyReadonlyArray<LawField> }

/** An anchored deletion's spec: the occurrence its member is anchored on. */
interface AnchoredDeleteSpec {
	readonly relation: RelationInfo
	readonly anchor: DeleteAnchor
}

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The DELETE's matching part and the CTEs it reads, under its target alias `r3`: the statement around it (deletion)
 * returns the complete facts it removed, which delta.removed and the netting across strata read. */
interface DeleteMatch {
	readonly leading: ReadonlyArray<Cte>
	readonly using: ReadonlyArray<FromItem>
	/** The conjuncts of its WHERE; none deletes every fact of the relation. */
	readonly where: ReadonlyArray<Expr>
}

/** The deletion statement: the DELETE of `relation` under alias `r3` as the data-modifying CTE `r2`, after the CTEs
 * it reads, returning the complete facts it removed into `returned`, the heads of the place groups it removed deleted
 * beside it, and the outer SELECT of their result texts. */
const deletion = (
	w: WriteContext,
	supply: NameSupply,
	relation: RelationInfo,
	mode: DeleteResult["mode"],
	names: { readonly r2: string; readonly r3: string; readonly returned: FieldColumns<string> },
	match: DeleteMatch,
	needs: Needs
) => {
	const { r2, r3, returned } = names
	const outFields = keyFirst(relation)
	const stored = (f: LawField): Expr => col(r3, w.names.column(relation.name, f.name))
	const del: Delete = {
		kind: "delete",
		with: undefined,
		table: w.names.relation(relation.name),
		alias: r3,
		using: match.using,
		where: conjunction(match.where),
		returning: returned.pairs.map((p) => targetAs(stored(p.field), p.column))
	}
	const columns: ReadonlyArray<ResultColumn> = outFields.map((f) => ({
		name: f.name,
		type: rowType(f)
	}))
	const outer = returnedRows(
		"keyed",
		returned.pairs.map((p) => returnedColumn(col(r2, p.column), rowType(p.field), p.column)),
		[cteRef(r2)],
		undefined
	)
	const result: DeleteResult = {
		kind: "delete",
		relation: relation.name,
		mode,
		columns,
		fields: fieldNames(outFields),
		key: relation.primaryKey
	}
	/** The heads of the place groups it removed, which go with them (write/insert/stamp.ts placeReleases). */
	const releases = placeReleases(w, supply, relation, {
		cte: r2,
		column: (f) => returned.of(f)
	})
	const [first, ...rest] = appendNonEmpty(match.leading, cte(r2, del))
	const ctes: NonEmptyReadonlyArray<Cte> = [first, ...rest, ...releases]
	return {
		ast: {
			...outer,
			with: {
				recursive: false,
				ctes
			}
		},
		role: "member" as const,
		result,
		needs,
		returning: { cte: r2, kind: "removed" as const, removed: { columns: returned, conditions: [] } }
	}
}

const buildDelete = (
	w: WriteContext,
	spec: DeleteSpec,
	mode: DeleteMode
): ModifyingStatement<DeleteResult> => {
	const { relation, input } = spec
	const at = `${mode.kind === "exact" ? "delete" : "put deletion"} ${relation.name}`
	const all = keyFirst(relation)
	const pk = relation.primaryFields
	/** The fields a deletion matches facts at, which its input and every addition it excepts are read at: the ones a fact
	 * carries (insert/statement.ts isCarried), one heading per relation (rule 0), and each instant of the primary key,
	 * which the deletion's target is reached by and every deletion's and put's facts state (write/frontend/instants.ts
	 * `unstated`). A generated field is a function of them, and an owner's drawn count and accumulated ends are
	 * grizzle's, so neither decides a match. */
	const [first, ...rest] = all
	const matched = [
		first,
		...rest.filter((f) => isCarried(f) || (f.writing.kind === "instant" && pk.includes(f)))
	].filter((f) => f.writing.kind !== "keyGenerated")
	if (!isNonEmpty(matched)) {
		throw defect(`a deletion of ${relation.name} that matches no field`)
	}
	const compared: NonEmptyReadonlyArray<LawField> = matched
	/** Its primary key's fields a fact states, which the target is reached at (`keys`). */
	const reached = statedKey(relation)
	/** The key generations of its primary key, which no fact carries, a function of the fields it does: each computed
	 * over them where the deletion reaches its target at its key (input.ts keyGeneratedRead). */
	const generations = uncarriedKeyGenerations(relation, compared)
	const except = mode.kind === "exact" ? mode.except : []
	const sharing = inputSharing(
		w.share.deletions,
		[input, ...except],
		[relation, mode.kind, input, except.length, ...except]
	)
	return buildStatement(w, sharing, (supply) => {
		const scan = supply.relation(internal("input scan"))
		const r1 = supply.relation(internal("input"))
		const r2 = supply.relation(internal("delete"))
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const inputs = fieldColumns([...compared, ...generations], () =>
			supply.column(internal("input column"))
		)
		const comparedInputs = fieldColumns(compared, (f) => inputs.of(f))
		const returned = fieldColumns(all, () => supply.column(internal("returned column")))
		/** Both D and A read as the relation's facts, cast into its column types (`into`), so the exact
		 * identity, the displacing key and payload comparisons and EXCEPT compare written facts. The cast
		 * is into each column's base type with its typmod: a value outside a domain matches no stored fact. */
		const into = { as: "compare" } as const
		/** D EXCEPT A compares the written facts as facts, a float's -0 and +0 two of them: a deletion of one beside an
		 * addition of the other deletes it, as the host nets two enumerated members by their identity. */
		const facts = except.length === 0 ? "rows" : "facts"
		const read = readOperand(
			w,
			input,
			{ kind: "input", fields: compared, alias: scan, keys: comparedInputs, into },
			facts,
			at
		)
		const body = setOp("EXCEPT", [
			read.body,
			...except.map(
				(addition) =>
					readOperand(w, addition, { kind: "except", fields: compared, into }, facts, at).body
			)
		])
		const signs = Array.from({ length: read.signs }, () =>
			supply.column(internal("input zero sign"))
		)
		const inCol = (f: LawField): Expr => col(r1, inputs.of(f))
		const stored = (f: LawField): Expr => col(r3, w.names.column(relation.name, f.name))
		/** Each comparison is at its fields' types: a row holding a vector is spelled column by column through the
		 * extension's qualified operator, which a row comparison would resolve through the search_path. */
		const typeOf = rowType
		/** The target reached at the input's keys by their index whatever the input's estimate (write/probe.ts): its
		 * primary key's fields but a place, which no fact carries and a delete of a place's relation leaves unread, since it
		 * removes whole groups, each named by the fields before the place (write/frontend/instants.ts Removal). */
		const keys = mapNonEmpty(reached, (field) => ({ field, column: inputs.of(field) }))
		const where =
			mode.kind === "exact"
				? and([
						factEq({ fields: compared, typeOf, left: stored, right: inCol }, w.names),
						...keyedAmong(w, supply, relation.name, r3, r1, keys)
					])
				: and(
						appendNonEmpty(
							collidingAtKey(w, supply, relation, r3, r1, keys),
							factNe({ fields: mode.differing, typeOf, left: stored, right: inCol }, w.names)
						)
					)
		return deletion(
			w,
			supply,
			relation,
			mode.kind,
			{ r2, r3, returned },
			{
				leading: isNonEmpty(generations)
					? keyGeneratedLeading(w, supply, relation, {
							body: operandSelect(body),
							compared: comparedInputs,
							signs,
							name: r1,
							columns: inputs
						})
					: [cte(r1, namedBody(operandSelect(body), [...inputs.columns, ...signs]))],
				using: [cteRef(r1)],
				where: [where]
			},
			inputNeeds(input)
		)
	})
}

/**
 * The stored rows, read through `stored`, a fact of the held rows collides with at the relation's primary key: equal at
 * every key field (write/probe.ts joinedAtKey), or, at a key holding a span, equal at its scalar fields and overlapping at
 * its span (`&&`), the comparison its WITHOUT OVERLAPS makes, so the occupants a put's fact displaces are those its key's
 * law would refuse beside it. A primary key WITHOUT OVERLAPS holds a scalar field before its span (42601), so the scalars
 * reach the rows by the key's index.
 */
const collidingAtKey = (
	w: WriteContext,
	supply: NameSupply,
	relation: RelationInfo,
	storedAt: string,
	held: string,
	keys: NonEmptyReadonlyArray<HeldKey>
): NonEmptyReadonlyArray<Expr> => {
	const shape = primaryKeyShape(relation)
	const heldAt = { name: held, at: held }
	if (shape.kind === "scalar") {
		return joinedAtKey(w, supply, relation.name, storedAt, heldAt, keys)
	}
	const scalars = keys.filter((k) => k.field.name !== shape.span.name)
	const span = keys.find((k) => k.field.name === shape.span.name)
	if (!isNonEmpty(scalars) || span === undefined) {
		throw defect(
			`a span key of ${relation.name} without a scalar field before its span, or without its span`
		)
	}
	return appendNonEmpty(
		joinedAtKey(w, supply, relation.name, storedAt, heldAt, scalars),
		binary(
			"&&",
			col(storedAt, w.names.column(relation.name, span.field.name)),
			col(held, span.column)
		)
	)
}

/**
 * A deletion's input with the key generations its facts leave out (input.ts uncarriedKeyGenerations), as two CTEs: the
 * read `body` under a name of its own, its compared columns then its zero signs, and `name` reading it again beside each
 * key generation over the compared fields it reads (insert/statement.ts requestedValue), so the deletion reaches its
 * target at its whole primary key. The second reads the first's every column, a set's whole heading, so it is keyed.
 */
const keyGeneratedLeading = (
	w: WriteContext,
	supply: NameSupply,
	relation: RelationInfo,
	read: {
		readonly body: OperandSelect
		readonly compared: FieldColumns<string>
		readonly signs: ReadonlyArray<string>
		readonly name: string
		readonly columns: FieldColumns<string>
	}
): ReadonlyArray<Cte> => {
	const scanned = supply.relation(internal("compared input"))
	const value = requestedValue(
		w,
		relation,
		read.compared.pairs.map((p) => p.field),
		(f) => col(scanned, read.compared.of(f))
	)
	return [
		cte(scanned, namedBody(read.body, [...read.compared.columns, ...read.signs])),
		cte(
			read.name,
			namedBody(
				select(
					provedCore(
						"keyed",
						[
							...read.columns.pairs.map((p) => target(value(p.field))),
							...read.signs.map((c) => target(col(scanned, c)))
						],
						[cteRef(scanned)],
						undefined
					)
				),
				[...read.columns.columns, ...read.signs]
			)
		)
	]
}

/** Exact deletions and the deletion a put implies.
 *
 * "A deletion is exact fact identity over every column: DELETE FROM r USING (input) AS q WHERE (r.cols) = (q.cols)
 * RETURNING r.key, where the input is the arrays, the carrier, or the described member. A duplicate input row
 * matches its fact once. `deleted` is the count of returned keys". Within a stratum additions win: when
 * the stratum also adds to the relation and the deletions or the additions are described or a carrier, the input is
 * D EXCEPT A, so a fact both added and deleted is neither deleted nor counted, and the insert protocol then finds it
 * a repeat or inserts it; the host nets two enumerated members the same way. The statement is the
 * deletion as a data-modifying CTE in one statement chain:
 *
 *   WITH "r1"("c1", "c2", "c3") AS (SELECT "r0"."c1", ... FROM (SELECT pg_catalog.unnest($1::...[]) ...) AS "r0"
 *                                   [EXCEPT SELECT ... FROM <addition>]),
 *   "r2" AS (DELETE FROM "work"."task" AS "r3" USING "r1"
 *            WHERE ("r3"."id", "r3"."account", "r3"."kind") = ("r1"."c1", "r1"."c2", "r1"."c3")
 *            RETURNING "r3"."id" AS "c4")
 *   SELECT "r2"."c4"::text AS "c4" FROM "r2"
 *
 * The deletion a put implies removes every current occupant a member collides with at the primary key that differs from
 * it, and the insert protocol follows as a later statement, because a same-key deletion and addition cannot share one
 * statement's snapshot: DELETE FROM r USING (input) AS q WHERE (r.key) = (q.key) AND (r.payload) <> (q.payload). At a
 * key holding a span a member collides with each occupant of its scalars whose span overlaps its own, which the key's
 * WITHOUT OVERLAPS would refuse beside it, so the member displaces all of them, its span compared with theirs beside its
 * payload: WHERE (r.scalars) = (q.scalars) AND r.span && q.span AND (r.span, r.payload) <> (q.span, q.payload)
 * (`collidingAtKey`). An occupant equal to its member stays, so an identical put deletes nothing and its insert is an
 * exact repeat. A pure set keyed by scalars alone has no field an occupant at a member's key can differ in, so its put
 * displaces nothing and has no deletion (write/put/choose.ts differingOf).
 *
 * A deletion whose member is anchored on an occurrence of its relation, with no addition of its stratum to except, is
 * the anchored deletion instead: the DELETE's target plays that occurrence, so the relation is read once.
 *
 * Every returned row is a fact the statement made absent; the outer SELECT returns its complete fact, which
 * delta.removed and the netting across strata need. */
export const buildExactDelete = (
	w: WriteContext,
	spec: ExactDeleteSpec
): ModifyingStatement<DeleteResult> => buildDelete(w, spec, { kind: "exact", except: spec.except })

/** A displacing deletion excepts nothing: the put's own facts are what it displaces occupants for. */
export const buildDisplacingDelete = (
	w: WriteContext,
	spec: DisplacingDeleteSpec
): ModifyingStatement<DeleteResult> =>
	buildDelete(w, spec, { kind: "displacing", differing: spec.differing })

/** The anchored deletion: the DELETE's target plays the member's anchoring occurrence, so the relation is
 * read once. The rest of the region is lowered without that occurrence: its other occurrences are the USING list and
 * its conditions the WHERE, beside an equality between the target's column and the column of each variable the
 * occurrence shares with another occurrence, each of the occurrence's constants over the target's column, and the
 * Filters' predicates over the region's variables, the ones the occurrence alone binds read from the target. The
 * region's head is not read: the deleted facts are the target's own rows.
 *
 *   WITH "r1" AS (DELETE FROM "q"."wanted" AS "r0"
 *                 USING (SELECT "r2"."c1", ... FROM "__carrier_1" AS "r2") AS "r3"("c4", ...)
 *                 WHERE "r0"."key" = "r3"."c6"
 *                 RETURNING "r0"."key" AS "c1", ...)
 *   SELECT "r1"."c1"::text AS "c1", ... FROM "r1"
 *
 * Each column the occurrence binds equals its variable's value: another occurrence's column for a shared
 * variable; for a variable the occurrence alone binds, the first target column bound to it, which the variable
 * then reads. */
export const buildAnchoredDelete = (
	w: WriteContext,
	spec: AnchoredDeleteSpec
): ModifyingStatement<DeleteResult> => {
	const { relation, anchor } = spec
	return buildStatement(w, ownBuild, (supply: NameSupply) => {
		const r3 = supply.relation(internal(`target ${relation.name}`))
		const r2 = supply.relation(internal("delete"))
		const returned = fieldColumns(keyFirst(relation), () =>
			supply.column(internal("returned column"))
		)
		const { region, occurrence } = anchor
		const stored = (column: string): Expr => col(r3, w.names.column(relation.name, column))
		const others = region.occurrences.filter((o) => o.id !== occurrence.id)
		const elsewhere = new Set(others.flatMap((o) => o.bindings.map((b) => b.var)))
		/** The variables the occurrence alone binds, by name: no other occurrence gives them a value. */
		const alone = new Set(
			occurrence.bindings.flatMap((b) => (elsewhere.has(b.var) ? [] : [b.var.name]))
		)
		/** The region without the occurrence: its heading the variables that keep a value. */
		const rest = {
			...region,
			occurrences: others,
			heading: region.heading.filter((c) => !alone.has(c.name))
		}
		const parts = regionParts(rest, w.cx, emptyEnv)
		/** The region's columns as the Filters and the constants read them: the rest's from its parts, and each variable
		 * the occurrence alone binds from the stored column its first binding names. */
		const columns = new Map<string, Expr>(parts.columns.map((c) => [c.column.name, c.value]))
		const conditions: Array<Expr> = [...parts.conditions]
		for (const b of occurrence.bindings) {
			const value = columns.get(b.var.name)
			if (value === undefined) {
				columns.set(b.var.name, stored(b.column))
			} else {
				conditions.push(w.cx.equal(b.var.type, stored(b.column), value))
			}
		}
		const scope = extendEnv(emptyEnv, [
			[region.id, columns],
			...anchor.filters.map((f) => [f.id, columns] as const)
		])
		for (const c of occurrence.constants) {
			conditions.push(
				w.cx.equal(
					columnType(occurrence.source.heading, c.column),
					stored(c.column),
					lowerExpr(w.cx, c.expr, scope)
				)
			)
		}
		for (const f of anchor.filters) {
			conditions.push(lowerExpr(w.cx, f.pred, scope))
		}
		return deletion(
			w,
			supply,
			relation,
			"exact",
			{ r2, r3, returned },
			{ leading: [], using: parts.from, where: conditions },
			needsOf(region)
		)
	})
}
