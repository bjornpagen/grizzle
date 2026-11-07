import type { QueryRead } from "#compiler/check/checker.ts"
import { fail } from "#compiler/check/fail.ts"
import { entries } from "#compiler/check/scan.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import type * as Result from "#compiler/core/result.ts"
import type {
	ExprDesc,
	HeadTermDesc,
	QueryDesc,
	QueryStageDesc,
	RuleDesc,
	SourceDesc
} from "#compiler/ir/desc.ts"

export interface StructureOptions {
	/**
	 * How the query is read (checker.ts QueryRead): a read-back's delta sources are in scope, a membership's row, and a
	 * page's parent variables the checker refuses as AttachedPage rather than as malformed.
	 */
	readonly read: QueryRead
}

interface Context {
	readonly recursiveStep: boolean
	readonly attachment: boolean
}

class Structure {
	readonly options: StructureOptions

	constructor(options: StructureOptions) {
		this.options = options
	}

	query(q: QueryDesc, cx: Context): void {
		this.stage(q.stage, cx)
	}

	stage(s: QueryStageDesc, cx: Context): void {
		switch (s.kind) {
			case "rules":
				for (const r of s.arms) {
					this.rule(r, cx)
				}
				return
			case "recursive":
				for (const r of s.recursive.base) {
					this.rule(r, { ...cx, recursiveStep: false })
				}
				for (const r of s.recursive.rec) {
					this.rule(r, { ...cx, recursiveStep: true })
				}
				return
			case "union":
				this.stage(s.input, cx)
				for (const r of s.arms) {
					this.rule(r, cx)
				}
				return
			case "attach":
				this.stage(s.input, cx)
				this.query(s.attach.child, { recursiveStep: false, attachment: true })
				return
			case "named":
			case "order":
			case "take":
			case "approx":
				this.stage(s.input, cx)
				return
		}
	}

	rule(r: RuleDesc, cx: Context): void {
		const vars = new Set(r.vars.map((v) => v.id))
		const interiors = new Set(r.interiors.map((i) => i.id))
		const expr = (e: ExprDesc, at: SourceLoc): void => {
			this.expr(e, vars, interiors, cx, at)
		}
		for (const m of r.matches) {
			this.source(m.source, vars, interiors, cx, m.loc)
			for (const [column, e] of entries(m.bindings)) {
				expr(e, childLoc(childLoc(m.loc, "bindings"), column))
			}
		}
		for (const [i, e] of r.where.entries()) {
			expr(e, childLoc(childLoc(r.loc, "where"), i))
		}
		for (const [key, h] of entries(r.head)) {
			this.head(h, vars, interiors, cx, childLoc(childLoc(r.loc, "head"), key))
		}
		for (const interior of r.interiors) {
			for (const arm of interior.arms) {
				this.rule(arm, { recursiveStep: false, attachment: false })
			}
		}
		for (const a of r.attach) {
			this.query(a.child, { recursiveStep: false, attachment: true })
		}
	}

	head(
		h: HeadTermDesc,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		if (h.kind === "aggregate") {
			if (h.fn !== "count") {
				this.expr(h.arg, vars, interiors, cx, loc)
			}
			return
		}
		if (h.kind === "producer") {
			for (const [i, a] of h.args.entries()) {
				this.expr(a, vars, interiors, cx, childLoc(loc, i))
			}
			return
		}
		this.expr(h, vars, interiors, cx, loc)
	}

	/**
	 * An imported query is its own scope; only its bind map reads the importing rule.
	 */
	source(
		s: SourceDesc,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		switch (s.kind) {
			case "query":
				this.query(s.query, { recursiveStep: false, attachment: false })
				for (const [param, e] of entries(s.bind)) {
					if (e.kind !== "relationParam") {
						this.expr(e, vars, interiors, cx, childLoc(childLoc(loc, "bind"), param))
					}
				}
				return
			case "interior":
				if (!interiors.has(s.id)) {
					fail(
						"MalformedDescription",
						loc,
						`an interior stage of this rule; ${JSON.stringify(s.id)} is not one`
					)
				}
				return
			case "self":
				if (!cx.recursiveStep) {
					fail("MalformedDescription", loc, "a self source inside a recursive step only")
				}
				return
			case "delta":
				if (this.options.read !== "readBack") {
					fail(
						"MalformedDescription",
						loc,
						`a delta source inside a ChangeSet read-back only; delta.${s.side}(${s.relation}) reads a change`
					)
				}
				return
			case "row":
				if (this.options.read !== "membership") {
					fail(
						"MalformedDescription",
						loc,
						"a row source inside a write filter's membership only; a query reads no row"
					)
				}
				return
			case "relation":
			case "param":
			case "paramOf":
			case "context":
				return
		}
	}

	expr(
		e: ExprDesc,
		vars: ReadonlySet<string>,
		interiors: ReadonlySet<string>,
		cx: Context,
		loc: SourceLoc
	): void {
		const sub = (x: ExprDesc, segment: string | number): void => {
			this.expr(x, vars, interiors, cx, childLoc(loc, segment))
		}
		switch (e.kind) {
			case "var":
				if (!vars.has(e.var)) {
					fail(
						"MalformedDescription",
						loc,
						`a variable this rule declares; ${JSON.stringify(e.var)} is another scope's or no one's`
					)
				}
				return
			case "parent":
				if (!cx.attachment && this.options.read !== "page") {
					fail(
						"MalformedDescription",
						loc,
						`a parent variable inside an attachment's own rules; ${e.column} is read outside one`
					)
				}
				return
			case "field":
			case "value":
				return fail(
					"MalformedDescription",
					loc,
					`a rule variable, parameter or literal; a ${e.kind} reference belongs to a row check or a contract predicate`
				)
			case "param":
			case "literal":
				return
			case "compute":
				for (const [i, a] of e.args.entries()) {
					sub(a, i)
				}
				return
			case "cast":
			case "base":
			case "not":
			case "in":
				sub(e.arg, "arg")
				return
			case "cond":
				sub(e.pred, "pred")
				sub(e.onTrue, "onTrue")
				sub(e.onFalse, "onFalse")
				return
			case "when":
				sub(e.subject, "subject")
				sub(e.proved, "proved")
				sub(e.otherwise, "otherwise")
				return
			case "compare":
				sub(e.left, "left")
				sub(e.right, "right")
				return
			case "between":
				sub(e.arg, "arg")
				sub(e.low, "low")
				sub(e.high, "high")
				return
			case "and":
			case "or":
				for (const [i, a] of e.args.entries()) {
					sub(a, i)
				}
				return
			case "allen":
				sub(e.left, "left")
				sub(e.right, "right")
				return
			case "pointIn":
				sub(e.point, "point")
				sub(e.span, "span")
				return
			case "absent":
				this.source(e.source, vars, interiors, cx, loc)
				for (const [column, b] of entries(e.bindings)) {
					this.expr(b, vars, interiors, cx, childLoc(childLoc(loc, "bindings"), column))
				}
				return
			case "closedAt":
			case "closedRow":
			case "closedHas":
				for (const [i, a] of e.args.entries()) {
					sub(a, i)
				}
				return
		}
	}
}

/**
 * Structural validation of a query description.
 *
 * The checker reads a query description that may come from anywhere: a JavaScript caller, another process, a
 * hand-edited payload. Its shapes are decoded by the IR's codec (ir/desc.ts decodeDesc), which refuses any value of
 * the wrong shape. What a shape cannot see is scope, and this module checks it without the schema, so a description
 * is refused before any name is resolved:
 *
 * - every variable a rule reads is one the rule itself declares: variables are lexical per rule, so a variable of
 *   another rule, an imported query or an attachment's parent query is never in scope;
 * - an interior source names an interior stage of its own rule;
 * - a `self` source appears only in a recursive step, a `parent` variable only in an attachment's own
 *   rules, and a delta source only in a ChangeSet read-back;
 * - a `field` or `value` reference, which belongs to a row check or a contract predicate, never appears in a query.
 *
 * Every refusal is MalformedDescription, located as the checker locates the same value: at the decoded location of the
 * node it is in (a rule, a match, a stage; a builder's call site, or the decoder's path for a node its author left
 * unlocated), and below it by the path the checker reads it at. Name resolution, typing and every semantic diagnostic
 * are the checker's (checker.ts).
 *
 * The structural scope check of a decoded query description.
 */
export const validateQueryStructure = (
	desc: QueryDesc,
	options: StructureOptions
): Result.Result<QueryDesc, CompileError> =>
	catchRefusal(() => {
		new Structure(options).query(desc, { recursiveStep: false, attachment: false })
		return desc
	})
