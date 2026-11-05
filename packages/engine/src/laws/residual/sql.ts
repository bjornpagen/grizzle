import { Refusal } from "#compiler/core/canonical.ts"
import { exactParts } from "#compiler/core/decimal.ts"
import { CompileError, type ProseTag, prose } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { moneyMinorUnits } from "#compiler/ir/carriers.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { DetailCodec, FieldSelector, LawField, LawRelation } from "#compiler/ir/law.ts"
import { baseTypeRef, type PhysicalNames } from "#compiler/ir/physical.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { KeyValue } from "#compiler/laws/families/plugin.ts"
import { detailExpr, withheldDetailExpr } from "#compiler/laws/model/detail.ts"
import type { Expr, FromItem, PlStatement } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	cast,
	col,
	core,
	eq,
	lit,
	objectName,
	or,
	select,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"

/** A law the residual skeleton or a family cannot build refuses with a Refusal, which the skeleton's boundary returns
 * (`catchRefusal`). */
const refuseLaw = (law: LawId, tag: ProseTag, capability: string): never => {
	throw new Refusal(CompileError.make(prose(tag, SourceLoc(`law ${law}`, []), capability)))
}

/** A typed literal of `t`'s base, the type a value of `t` is compared as against a stored column: unrefined, a
 * roster's the enum the naming door mints from its declared name. */
export const literalExpr = (
	literal: TypedLiteral,
	t: ScalarType,
	names: PhysicalNames,
	law: LawId
): Expr => {
	const type = baseTypeRef(names, t)
	switch (literal.kind) {
		case "int":
			return lit.int(literal.value, type)
		case "numeric":
			return lit.decimal(literal.value.parts, type)
		case "float":
			return lit.float(literal.value, type)
		case "floatSpecial":
			return lit.float(
				literal.value === "NaN"
					? Number.NaN
					: literal.value === "Infinity"
						? Number.POSITIVE_INFINITY
						: Number.NEGATIVE_INFINITY,
				type
			)
		case "money":
			return lit.decimal(exactParts(moneyMinorUnits(literal.value), 2), type)
		case "bool":
			return lit.bool(literal.value)
		case "text":
		case "uuid":
			return lit.text(literal.value, type)
		case "enum":
			return lit.text(literal.handle, type)
		case "span":
			return lit.text(`[${literal.start.toString()},${literal.end.toString()})`, type)
		case "vector":
			return refuseLaw(law, "UnsupportedOperation", "a vector literal in a residual law")
	}
}

/** The literal selectors of a side as a predicate over one row (`column(field)` reads the row's field), in declared
 * field order, each literal typed by its field. */
export const selectedBy = (
	law: LawId,
	names: PhysicalNames,
	selection: NonEmptyReadonlyArray<FieldSelector>,
	column: (field: LawField) => Expr
): Expr =>
	and(
		mapNonEmpty(selection, (s) =>
			eq(column(s.field), literalExpr(s.value, s.field.type, names, law))
		)
	)

/** The role the transaction took on, `none` when it took on none. */
const roleSetting: Expr = call("current_setting", [lit.text("role", types.text)])

/** The identity the transaction acts as: the role it took on, or the session user when it took on none, after RESET ROLE
 * and SET SESSION AUTHORIZATION too. */
const actingAs: Expr = {
	kind: "case",
	operand: undefined,
	whens: [
		{
			when: eq(roleSetting, lit.text("none", types.text)),
			result: cast({ kind: "user", name: "SESSION_USER" }, types.text)
		}
	],
	else: roleSetting
}

/** Whether a violation's DETAIL carries its keys (see `raiseViolation`): the identity the transaction acts as when the
 * function runs holds the violating relation whole. It does when it is one of `holders`, the theory roles holding the
 * relation whole, or the function's owner, the migration identity (CURRENT_USER inside the SECURITY DEFINER function),
 * or a superuser (`is_superuser` follows the identity acted as, never the function's owner). A deferred law judges
 * whoever the transaction acts as at COMMIT, and a login holds nothing whole: a world writer that resets its role before
 * COMMIT is withheld the keys, as its role is. Db.open and the drift check refuse a theory role any member but its login
 * and any member of a login, so nothing acts as a theory role without taking it on (`memberDifferences`). */
export const witnessShown = (holders: ReadonlyArray<string>): Expr =>
	or([
		eq(call("current_setting", [lit.text("is_superuser", types.text)]), lit.text("on", types.text)),
		{
			kind: "inList",
			expr: actingAs,
			list: [
				cast({ kind: "user", name: "CURRENT_USER" }, types.text),
				...holders.map((r) => lit.text(r, types.text))
			],
			not: false
		}
	])

/** Step 3's refusal: 23000 with the law's identity as the constraint name and the violating
 * fact's key columns, `value(key, i)` the value of the codec's i-th key field, as the DetailCodec DETAIL when `shown`
 * holds, the withheld DETAIL otherwise. A money key is passed as numeric text, the form the codecs decode.
 *
 * The pieces every residual law function is built from. The skeleton owns step 1 of the three-step protocol and the DDL
 * around it; a family owns steps 2 and 3 for one affected anchor key (`FamilyPlugin`). Both build their PL/pgSQL from these helpers, so every function
 * spells its identifiers, literals, reads and violations the same way:
 *
 * - identifiers: a relation's table and a field's column are the identifiers ownership registered, read off the law's
 *   resolved handles (ir/law.ts LawRelation, LawField), and a roster's enum type the naming door's from the roster's
 *   declared name, as ownership mints its closed relation's;
 * - types: a value compared with a stored column is typed by the column's base: a contract's base, plain
 *   text for a regex refinement, a roster's enum in the schema, or the builtin with its typmod, never a domain;
 * - step 2, the anchor read, is one statement reading the anchor row at the affected key (readAnchor);
 * - step 3 raises 23000 with constraint name `<law-id>` and a DetailCodec DETAIL of the violating facts' key
 *   columns only, which it withholds from an identity that does not hold the violating relation whole: the DETAIL
 *   carries the keys only when the identity the transaction acts as, the role it took on or with none its session user,
 *   is a theory role holding the relation whole, the function's owner or a superuser (witnessShown). A law function runs
 *   as its owner, SECURITY DEFINER, and the role, the session user and `is_superuser` are still the caller's there.
 *
 * Every statement a law function runs reads the transaction's snapshot, and the transaction is SERIALIZABLE: every
 * table carries the isolation guard, which refuses a write below it before the statement runs. So a law function is an ordinary reader under SSI. A concurrent transaction that writes
 * what it read, and one this transaction's writes would change, commit together only in a serial order; otherwise
 * PostgreSQL fails one of them with 40001. The function takes no row lock. */
export const raiseViolation = (
	law: LawId,
	codec: DetailCodec,
	value: (key: LawField, i: number) => Expr,
	shown: Expr
): PlStatement => ({
	kind: "raise",
	message: `law ${law} violated`,
	using: [
		{ option: "ERRCODE", value: lit.text("integrity_constraint_violation", types.text) },
		{ option: "CONSTRAINT", value: lit.text(law, types.text) },
		{
			option: "DETAIL",
			value: {
				kind: "case",
				operand: undefined,
				whens: [
					{
						when: shown,
						result: detailExpr({ relation: codec.relation.name, keys: codec.keys }, (key, i) => {
							const v = value(key, i)
							return baseOf(key.type).carrier === "money" ? cast(v, types.numeric) : v
						})
					}
				],
				else: withheldDetailExpr(codec.relation.name)
			}
		}
	]
})

/** The row a present anchor's read binds to `variable`: the fields it reads, each once, in the order first asked (the
 * read's `c1..cn`), and the value of each in the record. */
export interface AnchorRow<A> {
	readonly variable: string
	readonly read: NonEmptyReadonlyArray<LawField>
	/** What the family built over the row's fields. */
	readonly built: A
}

/**
 * The row an anchor read binds to `variable`, as a family builds over it: the read's fields are `fields`, each once in
 * the order first listed (a field is one by its name, its relation's), and `build` reads any field of the row through
 * `field`, which gives the value the read returns for it. A field `build` asks that `fields` did not list is read
 * after them, so every field the family reads is one the read returns. The read is final once `build` returns, before
 * any statement over it is emitted.
 */
export const anchorRow = <A>(
	variable: string,
	fields: NonEmptyReadonlyArray<LawField>,
	build: (field: (f: LawField) => Expr) => A
): AnchorRow<A> => {
	const [first, ...others] = fields
	const more: Array<LawField> = []
	const values = new Map<string, Expr>([[first.name, recordField(variable, "c1")]])
	const field = (f: LawField): Expr => {
		const known = values.get(f.name)
		if (known !== undefined) {
			return known
		}
		more.push(f)
		const value = recordField(variable, `c${more.length + 1}`)
		values.set(f.name, value)
		return value
	}
	for (const f of others) {
		field(f)
	}
	const built = build(field)
	return { variable, read: [first, ...more], built }
}

/** What an anchor obliges at one affected key, the family's absent-anchor rule as data: a present anchor runs `body`
 * once with its row bound to the variable of `row` (`anchorRow`); an absent one runs `body` alone. An obligation of
 * the other case is none. */
type AnchorObligation =
	| { readonly when: "present"; readonly row: AnchorRow<ReadonlyArray<PlStatement>> }
	| { readonly when: "absent"; readonly body: NonEmptyReadonlyArray<PlStatement> }

interface AnchorRead {
	readonly schema: string
	/** The anchor relation; `key` is the affected key, each component at its anchor-key field. */
	readonly relation: LawRelation
	readonly key: NonEmptyReadonlyArray<KeyValue>
	readonly obligation: AnchorObligation
}

/** Step 2 for an anchor keyed by `key`, which identifies at most one row. A present anchor's obligation reads the row
 * and runs its body in the loop, at most once:
 *
 *   FOR <variable> IN SELECT r1.<read1> AS c1, ... FROM <anchor> AS r1 WHERE r1.<k1> = <v1> AND ... LOOP
 *     <body>
 *   END LOOP;
 *
 * An absent anchor's obligation probes for the row and runs its body when the key holds none, one statement
 * (`whenAbsent`):
 *
 *   PERFORM 1 FROM <anchor> AS r1 WHERE r1.<k1> = <v1> AND ...;
 *   IF NOT FOUND THEN <body> END IF;
 *
 * Both read the transaction's snapshot, which is SERIALIZABLE, as the family's step 3 does after them, so the anchor and
 * the probe are one consistent state. */
export const readAnchor = (a: AnchorRead): ReadonlyArray<PlStatement> => {
	const at = and(mapNonEmpty(a.key, (k) => eq(col("r1", k.pair.anchor.column), k.value)))
	const anchor: FromItem = {
		kind: "table",
		table: objectName(a.schema, a.relation.ident),
		alias: "r1"
	}
	const o = a.obligation
	switch (o.when) {
		case "present":
			return [
				{
					kind: "forQuery",
					variable: o.row.variable,
					query: select(
						core(
							o.row.read.map((f, i) => targetAs(col("r1", f.column), `c${i + 1}`)),
							[anchor],
							at
						)
					),
					body: o.row.built
				}
			]
		case "absent":
			return [
				{
					kind: "whenAbsent",
					probe: {
						body: core([target(lit.int(1, types.integer))], [anchor], at),
						orderBy: [],
						limit: undefined,
						offset: undefined
					},
					body: o.body
				}
			]
	}
}

/** A field of a PL/pgSQL record variable. */
export const recordField = (variable: string, field: string): Expr => ({
	kind: "field",
	record: { kind: "plVar", name: variable },
	field
})

/** A field of a trigger row image, NEW or OLD. */
export const imageField = (side: "old" | "new", field: LawField): Expr => ({
	kind: "field",
	record: { kind: "plSpecial", name: side === "new" ? "NEW" : "OLD" },
	field: field.column
})
