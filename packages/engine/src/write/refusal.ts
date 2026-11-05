import { resultTextCasts } from "#compiler/codec/scalar.ts"
import type { TransientReason } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { ConstraintName, LawId } from "#compiler/core/ids.ts"
import { jsonStrings } from "#compiler/core/json-strings.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Sqlstate, sqlstates } from "#compiler/core/sqlstate.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { BreachGuard, DeliveredBreach } from "#compiler/lower/conservative/types.ts"
import type {
	CreateFunction,
	Cte,
	Expr,
	FromItem,
	FunctionName,
	FunctionParam,
	Revoke,
	Select,
	SelectCore
} from "#compiler/sql/ast.ts"

import {
	asc,
	binary,
	call,
	cast,
	col,
	core,
	cte,
	cteRef,
	lit,
	notExists,
	qualifiedCall,
	select,
	setOp,
	simpleSelect,
	tableCol,
	target,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import type { NameSupply } from "#compiler/sql/naming.ts"

/** The installed refusal function of a schema, `<schema>.<refuse>(text, text, text) RETURNS boolean`: a function every
 * role that writes or reads a context executes, a write statement's refusals and a context source's (sql/print.ts
 * contextClaims). It raises its arguments, the SQLSTATE, the constraint name and the DETAIL, and never returns; it
 * reads and writes nothing, so its header, the one every installed function has (`CreateFunction`), confers nothing,
 * and it is PARALLEL SAFE, so a statement that reads the claims still plans in parallel. Like a law function, it has
 * one name and is replaced in place when its body changes. */
export const refusalFunctionName: string = identifierOf(identity.refusal())
const refusalParams: ReadonlyArray<FunctionParam> = [
	{ name: "state", type: types.text },
	{ name: "constraint_name", type: types.text },
	{ name: "detail", type: types.text }
]

export const refusalFunction = (schema: string): FunctionName => ({
	schema,
	name: refusalFunctionName,
	args: refusalParams.map((p) => p.type)
})

const arg = (name: string): Expr => ({ kind: "plVar", name })

/** The refusal function's DDL: its CREATE FUNCTION, then the REVOKE EXECUTE ... FROM PUBLIC that follows it at once, so
 * PUBLIC never holds EXECUTE, as a law function's. */
export const refusalFunctionDdl = (schema: string): readonly [CreateFunction, Revoke] => {
	const fn = refusalFunction(schema)
	return [
		{
			kind: "createFunction",
			language: "plpgsql",
			name: { schema, name: refusalFunctionName },
			params: refusalParams,
			returns: "boolean",
			volatility: "VOLATILE",
			parallel: "SAFE",
			security: "DEFINER",
			planCacheMode: "force_custom_plan",
			body: {
				declare: [],
				body: [
					{
						kind: "raise",
						message: "grizzle refused the statement",
						using: [
							{ option: "ERRCODE", value: arg("state") },
							{ option: "CONSTRAINT", value: arg("constraint_name") },
							{ option: "DETAIL", value: arg("detail") }
						]
					}
				]
			}
		},
		{
			kind: "revoke",
			privileges: ["EXECUTE"],
			on: { kind: "FUNCTION", names: [fn] },
			from: [{ kind: "PUBLIC" }]
		}
	]
}

/** The refusal a query entry's precheck raises for a fact outside the entry: SQLSTATE 42Z01, of
 * class 42 (access rule violation) and outside every code PostgreSQL defines, the entry's name as the constraint name,
 * and the DETAIL `o["<entry>"]`, which names it again under its own tag. It carries no value of the refused fact. */
export const outsideDetail = (entry: string): string => `o${JSON.stringify([entry])}`

/** A call of the installation's refusal function raising `state` with constant arguments. */
export const refusalCall = (
	schema: string,
	state: Sqlstate,
	constraint: string,
	detail: string
): Expr =>
	qualifiedCall(schema, refusalFunctionName, [
		lit.text(state, types.text),
		lit.text(constraint, types.text),
		lit.text(detail, types.text)
	])

/** The TransientFailure reasons a write statement detects itself. */
export type ConcurrentChange = Extract<
	TransientReason,
	{ readonly _tag: "PutTargetConflict" | "SpanKeyChange" }
>
const concurrentChanges = ["PutTargetConflict", "SpanKeyChange"] as const
export type ConcurrentChangeTag = (typeof concurrentChanges)[number]

/** One value of a refusal's key: an expression of a verdict row and its field's type. */
export interface RefusedValue {
	readonly field: string
	readonly expr: Expr
	readonly type: ScalarType
}

/** What one arm of a statement's refusal raises. */
export type ArmRefusal =
	| {
			readonly kind: "law"
			readonly law: LawId
			readonly relation: string
			readonly key: ReadonlyArray<RefusedValue>
	  }
	| {
			readonly kind: "change"
			readonly reason: ConcurrentChangeTag
			readonly relation: string
			readonly constraint: ConstraintName
			readonly key: ReadonlyArray<RefusedValue>
	  }
	| {
			readonly kind: "breach"
			readonly delivered: "one" | "option"
			readonly key: ReadonlyArray<RefusedValue>
	  }
	| { readonly kind: "outside"; readonly entry: string }

/** The arms' precedence (see `refusalGuard`). A breach is a read-back's, alone among its statement's arms; a fact outside a
 * query entry and a key a fact outside it holds are its precheck's, alone among theirs. */
export const refusalRank = {
	sameKey: 0,
	uniqueWithin: 1,
	uniqueStored: 2,
	conflict: 3,
	change: 4,
	breach: 5,
	outside: 6,
	heldOutside: 7
} as const

/** One arm of a write statement: the verdict rows `when` holds of raise `refusal`. */
export interface RefusalArm {
	readonly rank: (typeof refusalRank)[keyof typeof refusalRank]
	readonly when: Expr
	readonly refusal: ArmRefusal
}

/** One arm as the refusal CTE reads it: the rows of `from` that `when` holds of. */
interface SourcedArm extends RefusalArm {
	readonly from: FromItem
}

const keyTag = "k"
const changeTag = "a"
const breachTag = "d"

/** A value as the JSON string of the text its column's codec decodes: money through numeric (codec resultTextCasts). */
const valueText = (v: RefusedValue): Expr => {
	const text = resultTextCasts(v.type).reduce<Expr>(
		(acc, t) => cast(acc, t === "numeric" ? types.numeric : types.text),
		v.expr
	)
	return cast(call("to_jsonb", [text]), types.text)
}

const concat = (parts: ReadonlyArray<Expr>): Expr => {
	const [head, ...rest] = parts
	if (head === undefined) {
		return lit.text("", types.text)
	}
	return rest.reduce<Expr>((left, right) => binary("||", left, right), head)
}

/** `<tag>[<components...>,[<field>,...],[<text>,...]]` with the leading components and the fields constant. */
const detailExpr = (
	tag: string,
	leading: ReadonlyArray<string>,
	key: ReadonlyArray<RefusedValue>
): Expr => {
	const head = `${tag}${JSON.stringify([...leading, key.map((v) => v.field)]).slice(0, -1)},[`
	const parts: Array<Expr> = []
	let pending = head
	for (const v of key) {
		parts.push(lit.text(pending, types.text))
		parts.push(valueText(v))
		pending = ","
	}
	parts.push(lit.text(key.length === 0 ? `${head}]]` : "]]", types.text))
	return concat(parts)
}

/** The delivered type a breach arm raises as its constraint field: no constraint name, a type the attachment delivers. */
type BreachDelivered = Extract<ArmRefusal, { readonly kind: "breach" }>["delivered"]

/** What an arm raises as its constraint field: a law's or a change's constraint name, a breach's delivered type, or the
 * query entry a fact is outside of. */
type RaisedConstraint =
	| { readonly kind: "constraint"; readonly name: ConstraintName }
	| { readonly kind: "breach"; readonly delivered: BreachDelivered }
	| { readonly kind: "entry"; readonly entry: string }

/** The constraint field's text. */
const constraintText = (raised: RaisedConstraint): string => {
	switch (raised.kind) {
		case "constraint":
			return raised.name
		case "breach":
			return raised.delivered
		case "entry":
			return raised.entry
	}
}

/** The SQLSTATE, constraint field and DETAIL one arm raises. */
const raised = (
	refusal: ArmRefusal
): { readonly state: Sqlstate; readonly constraint: RaisedConstraint; readonly detail: Expr } => {
	switch (refusal.kind) {
		case "law":
			return {
				state: sqlstates.integrityConstraintViolation,
				constraint: { kind: "constraint", name: refusal.law },
				detail: detailExpr(keyTag, [refusal.relation], refusal.key)
			}
		case "change":
			return {
				state: sqlstates.grizzleConcurrentChange,
				constraint: { kind: "constraint", name: refusal.constraint },
				detail: detailExpr(changeTag, [refusal.reason, refusal.relation], refusal.key)
			}
		case "breach":
			return {
				state: sqlstates.grizzleDeliveredType,
				constraint: { kind: "breach", delivered: refusal.delivered },
				detail: detailExpr(breachTag, [], refusal.key)
			}
		case "outside":
			return {
				state: sqlstates.grizzleOutsideWorld,
				constraint: { kind: "entry", entry: refusal.entry },
				detail: lit.text(outsideDetail(refusal.entry), types.text)
			}
	}
}

/** The DETAIL expression one arm raises (see `refusalGuard`), for the audits of the encoding. */
export const refusalDetailExpr = (refusal: ArmRefusal): Expr => raised(refusal).detail

interface RefusalGuardInput {
	readonly supply: NameSupply
	readonly schema: string
	/** The verdict CTE the arms read. */
	readonly verdicts: string
	readonly arms: NonEmptyReadonlyArray<RefusalArm>
}

/** The refusal CTE over a statement's verdict rows and the guard of its outer SELECT (see `refusalGuard`).
 *
 * Write refusals, raised inside the statement that detects them.
 *
 * A write statement that can refuse computes its verdict rows in a MATERIALIZED CTE: the facts it changed, and the
 * rows that refuse the write (a conflict witness, a same-key pair, a unique object's refusal, an occupant gone at a span
 * key). Its outer SELECT delivers the changed facts only when no refusal row
 * exists; otherwise it calls the installation's refusal function with the refusal of highest precedence, and the
 * function raises. PostgreSQL then aborts the statement and the transaction with it: nothing after it runs and nothing
 * commits, whatever the client sends next, COMMIT included. The client never reads a refusal from rows and never
 * chooses between COMMIT and ROLLBACK.
 *
 *   "rv"("c4", "c5", "c7", "c9") AS MATERIALIZED (<the verdict rows>),
 *   "rw"("c12", "c13", "c14", "c15") AS (
 *     SELECT 0, '23000', 'task.task__pk', <key DETAIL> FROM "rv" WHERE "rv"."c9"
 *     UNION ALL SELECT 3, '23000', 'task.task__pk', <key DETAIL> FROM "rv" WHERE NOT "rv"."c7" AND NOT "rv"."c9"
 *     ORDER BY "c12", "c15" LIMIT 1
 *   )
 *   SELECT "rv"."c4"::text AS "c4", "rv"."c5"::text AS "c5" FROM "rv"
 *   WHERE NOT EXISTS (SELECT 1 FROM "rw" WHERE "s"."<refuse>"("rw"."c13", "rw"."c14", "rw"."c15"))
 *
 * - Each arm reads exactly the verdict rows of one refusal, and its rank is that refusal's precedence: a same-key pair
 *   within the input, then a unique object's pair within the input, then its visible occupant, then a conflict witness,
 *   then a concurrent change (an occupant gone at a span key). So the refusal reported does
 *   not depend on the order the rows arrive in; among the rows of one rank the least DETAIL is raised, so the witness
 *   does not depend on the plan either.
 * - The sort reads every verdict row before the function is called, so the data-modifying CTE has run to completion
 *   first: a native error any of its rows raises (a unique violation from an unseen occupant) is the statement's
 *   failure, never a refusal an earlier row carried.
 * - The guard reads the verdict CTE, which holds a row whenever a refusal does, so the refusal is raised wherever the
 *   plan evaluates the guard: once before the scan, or at the first row.
 *
 * The channel is the one a residual law function raises through (packages/grizzle/src/adapter/witness), and it carries
 * fields grizzle controls only:
 *
 * - a law's refusal: SQLSTATE 23000 (integrity_constraint_violation), the law's stable identity as the constraint name,
 *   and the DETAIL `k["<relation>",["<field>",...],["<text>",...]]`: the refused fact's relation and its values at the
 *   law's key fields, each its column's result text, which the column's codec decodes. The fields travel with the
 *   values, so a DETAIL decodes without knowing which object of the law refused, and the `k` tag keeps it apart from a
 *   law function's DetailCodec DETAIL (`w`), which one law can raise too: a capacity of at most one is a partial
 *   unique index the statement probes and a residual existence law;
 * - a concurrent change the statement met: SQLSTATE 40Z01, of class 40 (transaction rollback) and outside every code
 *   PostgreSQL defines, the relation's primary key constraint as the constraint name, where the change was met, and the
 *   DETAIL `a["<reason>","<relation>",["<field>",...],["<text>",...]]`: the TransientFailure reason, the relation and
 *   the key the change was met at. The key is no part of the reason, which carries names only; it orders the arm's
 *   rows and tells a reader of the server log where the change was met.
 *
 * - a breach of an attachment's delivered type a read-back statement met: SQLSTATE 21Z01, of class 21 (cardinality
 *   violation) and outside every code PostgreSQL defines, the delivered type, `one` or `option`, as the constraint
 *   name, and the DETAIL `d[["<field>",...],["<text>",...]]`: the parent key the count of children broke the type at.
 *   It means the evidence that proved the type is wrong, never a law's refusal. A read-back's rows are decoded only
 *   after its write committed, so its statement checks the type itself (breachGuard): the breach aborts the write, and
 *   the shell reports it as an ExecutionFailure carrying the server's report instead of surfacing it after the commit.
 * - a fact a query entry's precheck found outside the entry: SQLSTATE 42Z01, of class 42
 *   (access rule violation) and outside every code PostgreSQL defines, the entry's name as the constraint name, and
 *   the DETAIL `o["<entry>"]` (outsideDetail), which carries no value of the fact.
 * - a claims setting a context source cannot read, raised by the source itself (sql/print.ts contextClaims), never by a
 *   write statement's guard: SQLSTATE 22P02 (invalid_text_representation), `grizzle.claims` as the constraint name, and
 *   the DETAIL `c[]` for a setting that is no claims document, or `c["<Context>"]` for a context's member holding other
 *   keys than its fields, which carry no claim value. Only a direct writer's hand-set claims meet it: a Db's setting is
 *   a claims document by construction (adapter/db/claims.ts).
 *
 * Each DETAIL is composed from builtin operators alone: the constant prefix, then `to_jsonb(<value>::text)::text` per
 * value. JSON string escaping is the escape, as in DetailCodec. readLawDetail and readChangeDetail
 * convert a DETAIL without a check, each under the SQLSTATE that raises it: the runtime reads one only under grizzle's
 * own SQLSTATEs, from grizzle's own statements and law functions, so the text is this encoding's. */
export const refusalGuard = (
	input: RefusalGuardInput
): { readonly cte: Cte; readonly guard: Expr } => {
	const from = cteRef(input.verdicts)
	return sourcedGuard(
		input.supply,
		input.schema,
		mapNonEmpty(input.arms, (a) => ({ ...a, from }))
	)
}

const breachArm = (b: DeliveredBreach): SourcedArm => ({
	rank: refusalRank.breach,
	from: b.from,
	when: b.when,
	refusal: { kind: "breach", delivered: b.delivered, key: b.key }
})

/** The guard a read-back statement raises a breach of an attachment's delivered type through, inside itself
 * (`BreachGuard`): each breach an arm of rank breach, raised by the refusal function of
 * `schema`. */
export const breachGuard =
	(schema: string): BreachGuard =>
	(supply, [first, ...rest]) =>
		sourcedGuard(supply, schema, [breachArm(first), ...rest.map(breachArm)])

const internal = (purpose: string) => ({ kind: "internal", purpose }) as const

/** The refusal CTE of `arms` and the guard that raises its first row (see `refusalGuard`). */
const sourcedGuard = (
	supply: NameSupply,
	schema: string,
	[first, ...rest]: readonly [SourcedArm, ...ReadonlyArray<SourcedArm>]
): { readonly cte: Cte; readonly guard: Expr } => {
	const rw = supply.relation(internal("refusal"))
	const rank = supply.column(internal("refusal rank"))
	const state = supply.column(internal("refusal SQLSTATE"))
	const constraint = supply.column(internal("refusal constraint"))
	const detail = supply.column(internal("refusal DETAIL"))
	const arm = (a: SourcedArm): SelectCore => {
		const r = raised(a.refusal)
		return core(
			[
				targetAs(lit.int(a.rank, types.integer), rank),
				targetAs(lit.text(r.state, types.text), state),
				targetAs(lit.text(constraintText(r.constraint), types.text), constraint),
				targetAs(r.detail, detail)
			],
			[a.from],
			a.when
		)
	}
	/** One arm sorts by its DETAIL, which holds the key, so the sort is never a constant one the planner drops; several
	 * sort by rank, then DETAIL. */
	const query: Select =
		rest.length === 0
			? {
					...select(arm(first)),
					orderBy: [asc(raised(first.refusal).detail)],
					limit: lit.int(1, types.integer)
				}
			: {
					...select(setOp("UNION ALL", [arm(first), ...rest.map(arm)])),
					orderBy: [asc(tableCol(rank)), asc(tableCol(detail))],
					limit: lit.int(1, types.integer)
				}
	const refuse = qualifiedCall(schema, refusalFunctionName, [
		col(rw, state),
		col(rw, constraint),
		col(rw, detail)
	])
	return {
		cte: cte(rw, [rank, state, constraint, detail], query),
		guard: notExists(simpleSelect([target(lit.int(1, types.integer))], [cteRef(rw)], refuse))
	}
}

/** What a DETAIL raised under SQLSTATE 23000 says, read by its tag: a write statement's refusal of a law, or, under any
 * other tag, a residual law function's DetailCodec DETAIL, which its reader converts through
 * that law's own codec. */
export type LawDetail =
	| {
			readonly kind: "law"
			readonly relation: string
			readonly key: ReadonlyArray<{ readonly field: string; readonly text: string }>
	  }
	| { readonly kind: "lawFunction" }

/** What a DETAIL raised under SQLSTATE 40Z01 says: the concurrent change a write statement met. */
export interface ChangeDetail {
	readonly reason: ConcurrentChangeTag
	readonly relation: string
}

/** The strings of a law refusal's DETAIL JSON text, `["<relation>",["<field>",...],["<text>",...]]` after the tag, as
 * PostgreSQL's escape_json wrote them: the relation, then the two arrays'.
 * The structure is the encoding's own, so the reader only walks it. */
const detailStrings = (
	text: string
): {
	readonly relation: string
	readonly fields: ReadonlyArray<string>
	readonly texts: ReadonlyArray<string>
} => {
	/** The tag and the opening bracket. */
	let i = 2
	const string = (): string => {
		let value = ""
		let start = i + 1
		for (;;) {
			const quote = text.indexOf('"', start)
			const backslash = text.indexOf("\\", start)
			if (backslash < 0 || backslash > quote) {
				i = quote + 1
				return value + text.slice(start, quote)
			}
			const code = text.charCodeAt(backslash + 1)
			value += text.slice(start, backslash)
			if (code === 0x75) {
				value += String.fromCharCode(Number.parseInt(text.slice(backslash + 2, backslash + 6), 16))
				start = backslash + 6
			} else {
				value += escaped(code)
				start = backslash + 2
			}
		}
	}
	/** The next array of strings: only structure lies between the cursor and its bracket. */
	const array = (): ReadonlyArray<string> => {
		const out: Array<string> = []
		i = text.indexOf("[", i) + 1
		while (text.charCodeAt(i) === 0x22) {
			out.push(string())
			i += 1
		}
		return out
	}
	const relation = string()
	i += 1
	const fields = array()
	const texts = array()
	return { relation, fields, texts }
}

/** The character a two-character JSON escape stands for, by the character after the backslash. */
const escaped = (code: number): string => {
	switch (code) {
		case 0x62:
			return "\b"
		case 0x66:
			return "\f"
		case 0x6e:
			return "\n"
		case 0x72:
			return "\r"
		case 0x74:
			return "\t"
		default:
			return String.fromCharCode(code)
	}
}

/** The refusal a 23000 DETAIL text says, converted without a check (see `refusalGuard`): a write statement's refusal of a
 * law under its tag, a law function's DETAIL otherwise. */
export const readLawDetail = (text: string): LawDetail => {
	if (!text.startsWith(`${keyTag}[`)) {
		return { kind: "lawFunction" }
	}
	const { relation, fields, texts } = detailStrings(text)
	return {
		kind: "law",
		relation,
		key: fields.flatMap((field, i) => {
			const fieldText = texts[i]
			return fieldText === undefined ? [] : [{ field, text: fieldText }]
		})
	}
}

/** The concurrent change a 40Z01 DETAIL text says (see `refusalGuard`), or undefined when the text names no reason a
 * write statement raises: the server's answer, which the caller reports as it does any statement it cannot classify. */
export const readChangeDetail = (text: string): ChangeDetail | undefined => {
	const next = jsonStrings(text)
	const read = next()
	const reason = concurrentChanges.find((c) => c === read)
	return reason === undefined ? undefined : { reason, relation: next() }
}

/** The DETAIL text an arm raises for constant values, as its SQL expression computes it: the encoding the unit tests
 * round-trip through readLawDetail and readChangeDetail. */
export const encodeRefusalDetail = (
	refusal:
		| { readonly kind: "law"; readonly relation: string }
		| { readonly kind: "change"; readonly reason: ConcurrentChangeTag; readonly relation: string },
	key: ReadonlyArray<{ readonly field: string; readonly text: string }>
): string => {
	const leading = refusal.kind === "law" ? [refusal.relation] : [refusal.reason, refusal.relation]
	const tag = refusal.kind === "law" ? keyTag : changeTag
	return `${tag}${JSON.stringify([...leading, key.map((k) => k.field), key.map((k) => k.text)])}`
}
