import { Array as Arr, Effect, Formatter, Option, Record as Rec, Result } from "effect"
import { appendAll } from "#compiler/core/array.ts"
import { conversionOf } from "#compiler/core/identity.ts"
import type { ConstraintName, DomainName } from "#compiler/core/ids.ts"
import { type FieldDesc, fieldTypes } from "#compiler/ir/desc.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { compiledPattern } from "#test/support/regex.ts"

/** What the server answered a probe: admitted, or refused with a SQLSTATE and the constraint it named. */
export type Verdict =
	| { readonly kind: "admitted" }
	| {
			readonly kind: "refused"
			readonly code: string
			readonly constraint: Option.Option<ConstraintName>
	  }

/**
 * Runs `sql` with `params` under a savepoint of the pinned session's open transaction, rolled back to when the server
 * refuses it. A connection failure is the case's defect, not a verdict.
 */
export const probe = (
	pinned: PgConnection,
	sql: string,
	params: ReadonlyArray<unknown>
): Effect.Effect<Verdict, SqlError> =>
	Effect.gen(function* () {
		yield* pinned.query("SAVEPOINT probe", [])
		const ran = yield* Effect.result(pinned.query(sql, params))
		if (Result.isSuccess(ran)) {
			yield* pinned.query("RELEASE SAVEPOINT probe", [])
			return { kind: "admitted" } satisfies Verdict
		}
		const reason = ran.failure.reason
		if (reason._tag !== "ServerError") {
			return yield* ran.failure
		}
		yield* pinned.query("ROLLBACK TO SAVEPOINT probe", [])
		return {
			kind: "refused",
			code: reason.fields.code,
			constraint: Option.fromUndefinedOr(reason.fields.constraint)
		} satisfies Verdict
	})

/**
 * The physical oracle's model of the predicate CHECKs: each installed CHECK judged by what it admits, never by its
 * text.
 *
 * The oracle's minimal installer (test/support/oracle/install/plan.ts) installs no predicate CHECK: a text refinement's
 * pattern, a contract's predicate, a span endpoint's contract predicate, a row check and a finite check all need the
 * compiler's own predicate lowering, so the minimal installer could only restate it. The physical oracle instead states
 * what each declaration means on the host, independently of src, and asks PostgreSQL whether the real installation
 * admits each probe value:
 *
 * - a text refinement: the declared regex source and flags read by the JavaScript engine, over the probe text. The
 *   probe texts hold no line terminator but the line feed, the only one the refinement's `.` (without `s`) and
 *   JavaScript's disagree on otherwise, so the two readings of every generated pattern coincide on them;
 * - a contract's predicate, a span endpoint's and a row check's: a threshold the case draws, compared on the host;
 * - a finite check: membership of the tuple among the closed relation's facts, by native equality of integers.
 *
 * A probe runs inside the case's transaction under a savepoint, so a refusal aborts only the probe. PostgreSQL must
 * admit a probe exactly when the host meaning holds, and refuse every other with 23514 naming the CHECK the declaration
 * installs, as the naming door names it (test/support/kernel/naming.ts). A wrong or missing CHECK of any class is a
 * probe the server judges otherwise.
 *
 * The problem a verdict poses against the host meaning (`holds`) and the CHECK the declaration installs, or none.
 */
export const judged = (
	what: string,
	holds: boolean,
	verdict: Verdict,
	check: ConstraintName
): ReadonlyArray<string> => {
	if (verdict.kind === "admitted") {
		return holds ? [] : [`${what}: the declaration refuses it (${check}), the server admitted it`]
	}
	const named = Option.match(verdict.constraint, {
		onNone: () => "naming no constraint",
		onSome: (c) => `naming ${c}`
	})
	if (holds) {
		return [`${what}: the declaration admits it, the server refused it (${verdict.code} ${named})`]
	}
	return verdict.code === "23514" && Option.contains(verdict.constraint, check)
		? []
		: [`${what}: refused with ${verdict.code} ${named}, not 23514 ${check}`]
}

/**
 * The texts every text refinement domain is probed with: around the generated patterns' lengths and alphabets
 * (gen/domain.ts), with code points of one, two and four UTF-8 bytes, a decomposed accent and the line feed.
 */
export const textProbes: ReadonlyArray<string> = [
	"",
	"a",
	"b",
	"c",
	"ab",
	"ca",
	"cc",
	"abc",
	"d",
	"é",
	"é",
	"😀",
	"a😀",
	"😀😀😀",
	"\n",
	"a\n",
	"ab\nc"
]

/** The declared text refinement of a field, along a contract's chain to its text base, or none. */
type DeclaredText =
	| { readonly kind: "none" }
	| { readonly kind: "text"; readonly source: string; readonly flags: string }

const declaredText = (field: FieldDesc): DeclaredText => {
	switch (field.kind) {
		case "text":
			return { kind: "text", source: field.source, flags: field.flags }
		case "contract":
			return declaredText(field.base)
		case "pg":
		case "numeric":
		case "bytes":
		case "uuid":
		case "span":
		case "closedId":
		case "bits":
		case "vector":
			return { kind: "none" }
	}
}

/** One text refinement domain of an installation with the pattern its declaration states. */
interface TextDomainModel {
	readonly domain: DomainName
	readonly check: ConstraintName
	readonly pattern: RegExp
}

/**
 * The text refinement domains of `installation`, each with the pattern of the field it types first (its uses are its
 * columns), read from the declaring description, never from src. A domain whose uses name no declared text field is a
 * defect of the case.
 */
const textDomainModels = (
	installation: Installation,
	desc: SchemaDesc
): ReadonlyArray<TextDomainModel> =>
	Arr.map(installation.textDomains, (d) => {
		/**
		 * A stored relation's fields, each a column of its table, and a closed relation's, which has no table, each a use
		 * by the relation's conversion and the field's column, as the closed facts' validation casts it.
		 */
		const fields = Arr.flatMap(desc.relations, (r) => {
			const declaredFields =
				r.kind === "relation" ? fieldTypes(r.fields) : r.kind === "closedRelation" ? r.fields : {}
			const table =
				r.kind === "relation"
					? installation.names.relation(r.name).name
					: conversionOf(parsedName(r.name))
			return Arr.flatMap(Rec.toEntries(declaredFields), ([field, f]) =>
				Arr.some(
					d.uses,
					(u) => u.table === table && u.column === installation.names.column(r.name, field)
				)
					? [declaredText(f)]
					: []
			)
		})
		const [text] = Arr.flatMap(fields, (t) => (t.kind === "text" ? [t] : []))
		if (text === undefined) {
			throw new Error(`the text domain ${d.name} types no declared text field`)
		}
		return {
			domain: d.name,
			check: d.constraint,
			pattern: compiledPattern(text.source, text.flags)
		}
	})

/**
 * Every text refinement domain of `installation` probed with every probe text (a cast into the domain runs its CHECK),
 * inside the pinned session's open transaction: the problems, and whether some probe was admitted and some refused.
 */
export const probeTextDomains = (
	pinned: PgConnection,
	installation: Installation,
	desc: SchemaDesc
): Effect.Effect<
	{
		readonly problems: ReadonlyArray<string>
		readonly admitted: boolean
		readonly refused: boolean
	},
	SqlError
> =>
	Effect.gen(function* () {
		const problems: Array<string> = []
		let admitted = false
		let refused = false
		const schema = quoteIdent(installation.names.schema)
		for (const model of textDomainModels(installation, desc)) {
			for (const text of textProbes) {
				const holds = model.pattern.test(text)
				const verdict = yield* probe(
					pinned,
					`SELECT $1::text::${schema}.${quoteIdent(model.domain)}`,
					[text]
				)
				appendAll(
					problems,
					judged(`${Formatter.format(text)} as ${model.domain}`, holds, verdict, model.check)
				)
				admitted ||= holds
				refused ||= !holds
			}
		}
		return { problems, admitted, refused }
	})
