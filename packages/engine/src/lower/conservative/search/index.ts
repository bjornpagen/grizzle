import type { SourceLoc } from "#compiler/core/loc.ts"
import { describeOp, type ScalarExpr } from "#compiler/ir/expr.ts"
import { baseOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { isTextSearchWeight, type TextQueryParser } from "#compiler/ir/search.ts"
import { refuseAt } from "#compiler/lower/conservative/context.ts"
import { admitsArity, nativeOp, type TextSearchRead } from "#compiler/scalar/compute/registry.ts"
import type { Expr } from "#compiler/sql/ast.ts"
import { binary, call, lit, types } from "#compiler/sql/build.ts"

/**
 * PostgreSQL's full text search in the conservative lowering, for a generated column and a query alike: every scalar
 * operation whose operands or result are a search document (ir/search.ts). Each reads its configuration off a
 * document's type, never off an operand, and names it as a regconfig literal qualified by pg_catalog,
 * `'pg_catalog.english'::pg_catalog.regconfig`, which PostgreSQL reads into the configuration's oid where it parses the
 * statement, so no search_path changes which configuration a document or a query is parsed under, and a generated
 * column's expression holds a constant:
 *
 * - a document's part is `setweight(to_tsvector(<configuration>, x), '<w>'::"char")`, its configuration the part's own
 *   type's and its weight the literal its second operand is;
 * - two parts are concatenated by tsvector's `||`, which shifts the right one's positions past the left's;
 * - a match is `d @@ websearch_to_tsquery(<configuration>, q)` or plainto_tsquery's, and a rank is `ts_rank(d, …)` or
 *   `ts_rank_cd(d, …)` of the same query, the configuration the document's. A query's text is parsed in each node that
 *   reads it, a match and a rank of one text each parsing it, which are one value, since the parse is IMMUTABLE.
 */
export const lowerSearchOp = (
	expr: ScalarExpr & { readonly kind: "op" },
	args: ReadonlyArray<Expr>,
	at: SourceLoc
): Expr => {
	const native = nativeOp(expr.op)
	if (native === undefined || !admitsArity(native.operands, args.length)) {
		return refuseAt(
			"UnsupportedOperation",
			at,
			`a full text search operation of the scalar catalogue; ${describeOp(expr.op)} is not one`
		)
	}
	const [first, second] = args
	if (first === undefined || second === undefined) {
		return refuseAt("MalformedDescription", at, `the operands of ${describeOp(expr.op)}`)
	}
	const sql = native.sql
	switch (sql.kind) {
		case "searchPart": {
			const configuration = configurationOf(expr.type, at)
			const weight = expr.args[1]
			if (
				weight?.kind !== "literal" ||
				weight.value.kind !== "text" ||
				!isTextSearchWeight(weight.value.value)
			) {
				return refuseAt(
					"MalformedDescription",
					at,
					"a search document's part weighted by a literal weight label, A, B, C or D"
				)
			}
			return call("setweight", [
				call("to_tsvector", [configuration, first]),
				lit.text(weight.value.value, types.char)
			])
		}
		case "infix":
			return sql.op === "||" && sql.owner === "catalog"
				? binary("||", first, second)
				: refuseAt("UnsupportedOperation", at, `the tsvector operator ${sql.op}`)
		case "textSearch": {
			const document = expr.args[0]
			const configuration = configurationOf(
				document === undefined
					? refuseAt("MalformedDescription", at, `the document of ${describeOp(expr.op)}`)
					: document.type,
				at
			)
			return searchRead(sql.read, first, call(queryParsers[sql.parser], [configuration, second]))
		}
		case "prefix":
		case "function":
		case "cast":
		case "between":
		case "in":
		case "least":
		case "greatest":
		case "and":
		case "or":
		case "not":
		case "difference":
		case "subset":
		case "disjoint":
		case "adjoin":
		case "endsWith":
		case "contains":
		case "parseFloat8":
		case "parseNumeric":
		case "collapse":
		case "lowerAscii":
		case "utf16Length":
		case "floatBits":
		case "library":
		case "zoneLibrary":
		case "epochDay":
		case "dateOfEpochDay":
		case "canonical":
			return refuseAt(
				"UnsupportedOperation",
				at,
				`a full text search operation over a search document; ${describeOp(expr.op)} is none`
			)
	}
}

/** The function each query parser reads a query's text by, under a configuration (ir/search.ts TextQueryParser). */
const queryParsers = {
	websearch: "websearch_to_tsquery",
	plain: "plainto_tsquery"
} as const satisfies { readonly [P in TextQueryParser]: string }

/** What a text search node reads of a document and a parsed query (registry.ts TextSearchRead). */
const searchRead = (read: TextSearchRead, document: Expr, query: Expr): Expr => {
	switch (read) {
		case "match":
			return binary("@@", document, query)
		case "rank":
			return call("ts_rank", [document, query])
		case "rankCd":
			return call("ts_rank_cd", [document, query])
	}
}

/** The regconfig literal of a search document's configuration, qualified by pg_catalog, where its configurations live. */
const configurationOf = (type: ScalarType, at: SourceLoc): Expr => {
	const base = baseOf(type)
	return base.carrier === "tsvector"
		? lit.text(`pg_catalog.${base.configuration}`, types.regconfig)
		: refuseAt("MalformedDescription", at, "a search document of a text search configuration")
}
