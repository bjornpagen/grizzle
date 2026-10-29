import { fail } from "#compiler/check/fail.ts"
import { ParamId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings, mapInput } from "#compiler/core/order.ts"
import {
	type AttachDesc,
	type BindingsDesc,
	type ExprDesc,
	type HeadTermDesc,
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
import { commonType, compatible, withoutSerial } from "#compiler/scalar/compute/types.ts"

/**
 * A parameter is of one kind once a use types it: a scalar of the type its uses adopt, or a relation of the heading
 * every use declares. Until then it is untyped.
 */
type Entry =
	| { readonly kind: "untyped" }
	| { readonly kind: "scalar"; readonly type: ScalarType; readonly loc: SourceLoc }
	| { readonly kind: "relation"; readonly heading: Heading; readonly loc: SourceLoc }

const untyped: Entry = { kind: "untyped" }

const sameHeading = (a: Heading, b: Heading): boolean =>
	a.length === b.length &&
	a.every((c, i) => {
		const d = b[i]
		return d !== undefined && c.name === d.name && compatible(c.type, d.type)
	})

/**
 * One parameter of a namespace the checker's walk resolves (resolveQuery): one of the query's own, typed by its uses,
 * or one of an imported query's, which its import's bind map replaces at every use, so nothing types it.
 *
 * `r.param("name")` is typed from its uses, and compatible uses of one parameter unify within a query. A scalar
 * parameter takes the type of the term it meets: a comparison against a contract field types it by the contract, so its
 * host type carries the brand, and against a regex-refined field by the refinement, while the placeholder is bound as
 * the base type, plain text for regex text. Two uses must be compatible (scalar/compute/types.ts compatible); where they
 * differ only in a numeric typmod or a text refinement, the declared type widens to their common type, as PostgreSQL's
 * own common-type rule does. A relation parameter has a declared heading, and every use declares the same one. One
 * parameter is never both a scalar and a relation parameter. `take("batch")` joins the parameters as pg.integer.
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

	/** The type the parameter has so far as a scalar, if any use has fixed it. */
	typeOf(): ScalarType | undefined {
		return this.#entry.kind === "scalar" ? this.#entry.type : undefined
	}

	/** Records a use of the parameter as a scalar at `type`, the type it adopts. */
	use(type: ScalarType, loc: SourceLoc): ParamId {
		const prior = this.#entry
		const adopted = withoutSerial(type)
		switch (prior.kind) {
			case "relation":
				return fail(
					"MalformedDescription",
					loc,
					`parameter ${this.name} as one kind: it is also a relation parameter`
				)
			case "untyped":
				this.#entry = { kind: "scalar", type: adopted, loc }
				return this.id
			case "scalar":
				if (!compatible(prior.type, adopted)) {
					fail(
						"MalformedDescription",
						loc,
						`compatible uses of parameter ${this.name}: it is used as ${typeLabel(prior.type)} and as ${typeLabel(adopted)}`
					)
				}
				this.#entry = { kind: "scalar", type: commonType(prior.type, adopted), loc: prior.loc }
				return this.id
		}
	}

	/** Records a use of the parameter as a relation with its declared heading. */
	useRelation(heading: Heading, loc: SourceLoc): ParamId {
		const prior = this.#entry
		switch (prior.kind) {
			case "scalar":
				return fail(
					"MalformedDescription",
					loc,
					`parameter ${this.name} as one kind: it is also a scalar parameter`
				)
			case "untyped":
				this.#entry = { kind: "relation", heading, loc }
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
					`a type for parameter ${this.name}: no comparison, member field or bound types it`
				)
		}
	}

	/** Where a use first typed the parameter, undefined while it is untyped. */
	firstUse(): SourceLoc | undefined {
		return this.#entry.kind === "untyped" ? undefined : this.#entry.loc
	}
}

/**
 * A parameter an imported query's bind map binds, which the checker itself writes: the state and parent parameters of
 * a factored recursive step's transitions (recursion/factor.ts).
 */
export const boundParam = (name: string): ParamCell => new ParamCell(name, untyped)

/** A description's references once the checker resolves them: each parameter reference carries its cell. */
export type Resolved = ParamsAs<{ readonly cell: ParamCell }>

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

	scalarTypes(): ReadonlyMap<string, ScalarType> {
		return new Map(
			this.#cells.flatMap((c) => {
				const type = c.typeOf()
				return type === undefined ? [] : [[c.name, type] as const]
			})
		)
	}

	/**
	 * The declared parameters of a final pass, in name order, refused at `loc` for a parameter no use typed (a pass that
	 * leaves a head parameter untyped is run again or refused first, check/index.ts).
	 */
	decls(loc: SourceLoc): ReadonlyArray<ParamDecl> {
		return this.#cells.map((c) => c.decl(loc))
	}

	/**
	 * Where each typed parameter was first used, in name order, so a budget overrun is located at the use of the
	 * parameter that crossed it.
	 */
	firstUses(): ReadonlyArray<SourceLoc> {
		return this.#cells.flatMap((c) => {
			const at = c.firstUse()
			return at === undefined ? [] : [at]
		})
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
 * A query description resolved for one checker pass, in the one walk over its parameters (ir/desc.ts mapQueryParams):
 * each parameter reference carries its cell, and the table holds the query's own. `seed` types the head parameters a
 * previous pass learned (check/index.ts); empty on the first pass.
 */
export const resolveQuery = (
	q: QueryDesc,
	seed: ReadonlyMap<string, ScalarType>
): { readonly query: ResolvedQuery; readonly params: ParamTable } => {
	const own = new Map<string, ParamCell>()
	const seeded = (name: string): ParamCell => {
		const type = seed.get(name)
		return new ParamCell(
			name,
			type === undefined
				? untyped
				: { kind: "scalar", type, loc: SourceLoc("parameter", ["parameters", name]) }
		)
	}
	const query = mapQueryParams(q, {
		param: (name) => ({ cell: cellIn(own, name, () => seeded(name)) }),
		imported: importedNamespace
	})
	return { query, params: new ParamTable([...own.values()]) }
}
