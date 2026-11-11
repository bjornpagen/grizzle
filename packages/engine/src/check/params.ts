import { fail } from "#compiler/check/fail.ts"
import { ParamId } from "#compiler/core/ids.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import {
	type AttachDesc,
	type BindingsDesc,
	type BindTermDesc,
	type ExprDesc,
	type FieldDesc,
	type HeadTermDesc,
	type InferredFieldDesc,
	type Inferred,
	type InteriorDesc,
	type Located,
	type MatchDesc,
	mapQueryParams,
	type ParamSpelling,
	type ParamsAs,
	type QueryDesc,
	type QueryStageDesc,
	type RecursiveDesc,
	type RuleDesc,
	type SourceDesc,
	type TakeDesc
} from "#compiler/ir/desc.ts"
import type { ParamDecl } from "#compiler/ir/products.ts"
import type { Heading } from "#compiler/ir/rel.ts"
import { type ScalarType, typeLabel } from "#compiler/ir/scalar.ts"
import { commonType, compatible } from "#compiler/scalar/compute/types.ts"
import { storedOnly } from "#compiler/scalar/registry.ts"

/**
 * A parameter is of one kind once a use types it: a scalar of the type its uses declare, or a relation of the heading
 * every use declares. Until its first use is checked it is untyped.
 */
type Entry =
	| { readonly kind: "untyped" }
	| { readonly kind: "scalar"; readonly type: ScalarType }
	| { readonly kind: "relation"; readonly heading: Heading }

const untyped: Entry = { kind: "untyped" }

const sameHeading = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	a.every((c, i) => {
		const d = b[i]
		return d !== undefined && c.name === d.name && compatible(c.type, d.type)
	})

/**
 * One parameter of a namespace the checker's walk resolves (resolveQuery): one of the query's own, typed by the
 * declarations of its uses, or one of an imported query's, which its import's bind map replaces at every use, so
 * nothing types it.
 *
 * `r.param(name, descriptor)` declares a scalar parameter of the descriptor's type at each of its uses, and the
 * declarations of one parameter unify within a query: they must be compatible (scalar/compute/types.ts compatible), and
 * where they differ only in a numeric typmod or a text refinement, the parameter widens to their common type, as
 * PostgreSQL's own common-type rule does. Its placeholder is bound as the base type, plain text for regex text. A
 * relation parameter has a declared heading, and every use declares the same one. One parameter is never both a
 * scalar and a relation parameter, and no parameter is bytes or holds a bytes field. `take("batch")` joins the
 * parameters as pg.integer.
 */
export class ParamCell {
	readonly name: string
	readonly id: ParamId
	#entry: Entry

	constructor(name: string, entry: Entry) {
		this.name = name
		this.id = ParamId(name)
		this.#entry = entry
	}

	/**
	 * Records a use of the parameter as a scalar at `type`, the type the use declares; a stored-only type
	 * (scalar/registry.ts storedOnly), as bytes is, which no parameter carries, is refused.
	 */
	use(type: ScalarType, loc: SourceLoc): ParamId {
		if (storedOnly(type)) {
			return fail(
				"UnsupportedOperation",
				loc,
				`storage: parameter ${this.name} of ${typeLabel(type)}, which is stored only and never a parameter`
			)
		}
		const prior = this.#entry
		switch (prior.kind) {
			case "relation":
				return fail(
					"MalformedDescription",
					loc,
					`parameter ${this.name} as one kind: it is also a relation parameter`
				)
			case "untyped":
				this.#entry = { kind: "scalar", type }
				return this.id
			case "scalar":
				if (!compatible(prior.type, type)) {
					fail(
						"MalformedDescription",
						loc,
						`compatible uses of parameter ${this.name}: it is used as ${typeLabel(prior.type)} and as ${typeLabel(type)}`
					)
				}
				this.#entry = { kind: "scalar", type: commonType(prior.type, type) }
				return this.id
		}
	}

	/**
	 * Records a use of the parameter as a relation with its declared heading; a heading of a stored-only field, which no
	 * parameter carries, is refused.
	 */
	useRelation(heading: Heading, loc: SourceLoc): ParamId {
		const stored = heading.find((c) => storedOnly(c.type))
		if (stored !== undefined) {
			return fail(
				"UnsupportedOperation",
				loc,
				`storage: relation parameter ${this.name}'s field ${stored.name} of ${typeLabel(stored.type)}, which is stored only and never a parameter`
			)
		}
		const prior = this.#entry
		switch (prior.kind) {
			case "scalar":
				return fail(
					"MalformedDescription",
					loc,
					`parameter ${this.name} as one kind: it is also a scalar parameter`
				)
			case "untyped":
				this.#entry = { kind: "relation", heading }
				return this.id
			case "relation":
				if (!sameHeading(prior.heading, heading)) {
					fail(
						"MalformedDescription",
						loc,
						`one heading for relation parameter ${this.name}: every use declares the same heading`
					)
				}
				return this.id
		}
	}

	/** The parameter's declaration, refused at `loc` when no use typed it. */
	decl(loc: SourceLoc): ParamDecl {
		const e = this.#entry
		switch (e.kind) {
			case "scalar":
				return { id: this.id, name: this.name, kind: "scalar", type: e.type }
			case "relation":
				return { id: this.id, name: this.name, kind: "relation", heading: e.heading }
			case "untyped":
				return fail(
					"MalformedDescription",
					loc,
					`a use of parameter ${this.name}: the query names it where none of its uses is checked`
				)
		}
	}
}

/**
 * A parameter an imported query's bind map binds, which the checker itself writes: the state and parent parameters of
 * a factored recursive step's transitions (recursion/factor.ts).
 */
export const boundParam = (name: string): ParamCell => new ParamCell(name, untyped)

/**
 * What a resolved scalar parameter reference states of its type: the field descriptor the Description declares, or,
 * for a parameter the checker itself writes (recursion/factor.ts), a channel, which its import's bind map binds to a
 * column whose type it has.
 */
export type ParamTyping = FieldDesc | { readonly kind: "channel" }

/**
 * A description's references once the checker resolves them: each parameter reference carries its cell, and a typed
 * literal states an inferred field's descriptor, as a Description grizzle writes itself may (ir/desc.ts Inferred).
 */
export type Resolved = ParamsAs<{ readonly cell: ParamCell }, ParamTyping, InferredFieldDesc>

export type ResolvedQuery = QueryDesc<Located, Resolved>
export type ResolvedStage = QueryStageDesc<Located, Resolved>
export type ResolvedRecursive = RecursiveDesc<Located, Resolved>
export type ResolvedTake = TakeDesc<Resolved>
export type ResolvedAttach = AttachDesc<Located, Resolved>
export type ResolvedInterior = InteriorDesc<Located, Resolved>
export type ResolvedRule = RuleDesc<Located, Resolved>
export type ResolvedMatch = MatchDesc<Located, Resolved>
export type ResolvedSource = SourceDesc<Located, Resolved>
export type ResolvedBindings = BindingsDesc<Located, Resolved>
export type ResolvedBound = BindTermDesc<Located, Resolved>
export type ResolvedHead = HeadTermDesc<Located, Resolved>
export type ResolvedExpr = ExprDesc<Located, Resolved>

/**
 * The parameters of one query, its attachments and interiors included: the cells the walk minted for the query's own
 * namespace (ir/desc.ts mapQueryParams), which queryParamNames reads too, so the declared parameters are exactly the
 * description's.
 */
export class ParamTable {
	readonly #cells: ReadonlyArray<ParamCell>
	readonly size: number

	constructor(cells: ReadonlyArray<ParamCell>) {
		this.#cells = cells.toSorted(mapInput(compareStrings, (c: ParamCell) => c.name))
		this.size = cells.length
	}

	/** The declared parameters, in name order, refused at `loc` for a parameter no checked use typed. */
	decls(loc: SourceLoc): ReadonlyArray<ParamDecl> {
		return this.#cells.map((c) => c.decl(loc))
	}
}

/** The cell of `name` in a namespace, minted at its first reference. */
const cellIn = (cells: Map<string, ParamCell>, name: string, mint: () => ParamCell): ParamCell => {
	const known = cells.get(name)
	if (known !== undefined) {
		return known
	}
	const cell = mint()
	cells.set(name, cell)
	return cell
}

/** An imported query's namespace: its own cells, which its bind map replaces. */
const importedNamespace = (): ParamSpelling<Resolved["param"]> => {
	const cells = new Map<string, ParamCell>()
	return {
		param: (name) => ({ cell: cellIn(cells, name, () => boundParam(name)) }),
		imported: importedNamespace
	}
}

/**
 * A query description resolved for the checker, in the one walk over its parameters (ir/desc.ts mapQueryParams): each
 * parameter reference carries its cell, and the table holds the query's own.
 */
export const resolveQuery = (
	q: QueryDesc<Located, Inferred>
): { readonly query: ResolvedQuery; readonly params: ParamTable } => {
	const own = new Map<string, ParamCell>()
	const query = mapQueryParams<{ readonly cell: ParamCell }, InferredFieldDesc>(q, {
		param: (name) => ({ cell: cellIn(own, name, () => new ParamCell(name, untyped)) }),
		imported: importedNamespace
	})
	return { query, params: new ParamTable([...own.values()]) }
}
