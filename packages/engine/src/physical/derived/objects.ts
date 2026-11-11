import type { DerivedRelationAnalysis } from "#compiler/analysis/derived/analyze.ts"
import type { CatalogKey } from "#compiler/analysis/physical/evidence.ts"
import {
	type CheckedSchema,
	type DerivedAnalysis,
	derivedAnalysis
} from "#compiler/analysis/schema.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import { appendAll } from "#compiler/core/array.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	compareIdentities,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { Premise } from "#compiler/ir/evidence.ts"
import { fieldNames } from "#compiler/ir/law.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { storedKeyPremise } from "#compiler/logical/props.ts"
import type { InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import {
	emptyUse,
	structuralRegex,
	type TextColumnUse,
	useColumns,
	usedNodes
} from "#compiler/physical/ddl/domains.ts"
import { lowerDefinition } from "#compiler/physical/derived/definition.ts"
import type { InstallOptions } from "#compiler/physical/install/compile.ts"
import {
	type InstallContribution,
	type InstallExtension,
	noCarriers,
	noCertificates,
	noContribution
} from "#compiler/physical/install/extension.ts"

import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type {
	CreateIndex,
	CreateMaterializedView,
	ObjectName,
	Refresh,
	Revoke
} from "#compiler/sql/ast.ts"
import { columnKey } from "#compiler/sql/build.ts"

const unwrapResult = <A>(result: Result.Result<A, CompileError>): A => {
	if (!result.ok) {
		throw new Refusal(result.error)
	}
	return result.value
}

/**
 * The laws a derived key's proof rests on, by their identities and each once: a stored relation's key law for each declared key
 * premise, the constraint the naming door names for it, and for a lower view's unique index the laws its own key's proof
 * rests on. A key resting on no law (a group key, the whole heading of a set) rests on none. The snapshot records them,
 * so dropping a law names the proofs it breaks.
 */
const premiseLaws = (
	theory: Theory,
	analysis: DerivedAnalysis,
	premises: ReadonlyArray<Premise>
): ReadonlyArray<LawId> => {
	const laws = new Map<LawId, Identity<"law">>()
	const visit = (ps: ReadonlyArray<Premise>): void => {
		for (const p of ps) {
			if (p.kind !== "constraint") {
				continue
			}
			if (p.constraintKind === "uniqueIndex") {
				const lower = Object.values(analysis.relations)
					.flatMap((r) => r.keys)
					.find((k) => k.index === p.constraint)
				if (lower !== undefined) {
					visit(lower.proof.premises)
				}
				continue
			}
			for (const law of theory.laws) {
				if (law.detail.kind !== "key") {
					continue
				}
				const premise = storedKeyPremise(
					law.detail.relation,
					fieldNames(law.detail.key.fields),
					law.detail.key.primary
				)
				if (premise.kind === "constraint" && premise.constraint === p.constraint) {
					laws.set(law.id, law.named)
				}
			}
		}
	}
	visit(premises)
	return [...laws].toSorted(([, a], [, b]) => compareIdentities(a, b)).map(([id]) => id)
}

/** The view and unique indexes of one derived relation. `lowerKeys` are the inherited keys of the lower levels, each
 * the unique index already planned for it. */
const viewObjects = (
	b: InstallBuilder,
	analysis: DerivedAnalysis,
	a: DerivedRelationAnalysis,
	lowerKeys: ReadonlyArray<CatalogKey>
): ReadonlyArray<CatalogKey> => {
	const name = a.name
	const view = b.names.relation(name)
	const columns = mapNonEmpty(a.heading, (c) => b.name(identity.column(c.name)))
	/** Each field an index or statistics object on the view may name. */
	const fields: Array<readonly [string, TargetField]> = []
	for (const c of a.heading) {
		fields.push([c.name, { desc: c.desc, type: c.type }])
	}

	/** The schema's installed keys and containments, as every compilation sees them, with the
	 * lower levels' inherited keys, the definition's only views. The definition's transaction evidence context admits
	 * only the containments that hold at every statement: a deferred foreign key or a residual law proves nothing in
	 * it. */
	const catalog = evidenceCatalog({ laws: b.model, views: lowerKeys })
	const lowered = unwrapResult(
		lowerDefinition(name, a.query, {
			names: b.names,
			catalog
		})
	)
	const create: CreateMaterializedView = {
		kind: "createMaterializedView",
		name: view,
		columns,
		query: lowered.query
	}
	const revoke: Revoke = {
		kind: "revoke",
		privileges: ["ALL"],
		on: { kind: "TABLE", names: [view] },
		from: [{ kind: "PUBLIC" }]
	}
	const use = emptyUse()
	useColumns(b, a.heading, use)
	const viewObject = b.add(
		{
			kind: "materializedView",
			ident: b.qualifiedOf("materializedView", name, b.names.relationNamed(name)),
			ddl: [create, revoke],
			reasons: [enforcement(`derived relation ${name}`)],
			phase: "structure"
		},
		[
			b.levelNode(name),
			...a.reads.flatMap((read) => {
				const from = b.readObject(read)
				return from === undefined ? [] : [from]
			}),
			...usedNodes(use),
			...b.constantNodes([create])
		]
	)

	const keys: Array<{ readonly key: CatalogKey; readonly object: Node<"structure"> }> = []
	for (const [i, k] of a.keys.entries()) {
		/** The one name every evidence catalog gives the view's key (`derivedKeyConstraints`), which
		 * the derived analysis names. */
		const named = identity.derivedKey(name, k.fields)
		const index = b.name(named)
		const statement: CreateIndex = {
			kind: "createIndex",
			name: index,
			table: view,
			unique: true,
			method: "btree",
			keys: mapNonEmpty(k.fields, (f) => columnKey(b.names.column(name, f))),
			concurrently: false,
			include: [],
			where: undefined
		}
		const object = b.add(
			{
				kind: "uniqueIndex",
				ident: b.qualifiedOf("index", name, named),
				ddl: [statement],
				reasons: [
					{ kind: "proof", premises: premiseLaws(b.model.theory, analysis, k.proof.premises) }
				],
				phase: "structure"
			},
			[viewObject]
		)
		keys.push({
			key: { relation: name, fields: k.fields, spans: [], primary: i === 0, constraint: index },
			object
		})
	}
	b.addIndexedView({
		relation: name,
		object: viewObject,
		fields: new Map(fields),
		uniqueIndexes: keys.map((k) => ({
			object: k.object,
			name: k.key.constraint,
			columns: k.key.fields
		}))
	})
	return keys.map((k) => k.key)
}

/** Every view column a regex refinement types, as a use of its structural text domain: a
 * literal or a min of refined text keeps its pattern, which may be one no stored column carries, and the view column
 * is cast to that pattern's domain, so the domain must exist. */
const textColumnUses = (analysis: DerivedAnalysis): ReadonlyArray<TextColumnUse> => {
	const uses: Array<TextColumnUse> = []
	for (const a of analysis.order) {
		appendAll(
			uses,
			a.heading.flatMap((c): ReadonlyArray<TextColumnUse> => {
				const regex = structuralRegex(c.type)
				if (regex === undefined) {
					return []
				}
				return [{ regex, table: a.ident, column: identifierOf(identity.column(c.name)) }]
			})
		)
	}
	return uses
}

/** The installer extension that adds every derived relation's view and unique indexes to the obligation graph
 * and claims the relation, so the installation does not report it deferred. Its view columns' patterns join the
 * structural text domains before any name is chosen (textDomainUses), each over the installation's checked schema.
 *
 * Each derived relation lowers to exactly these objects of the one obligation graph, through the installer's
 * extensions, so they share its install order, manifest and determinism with every native object:
 *
 * - the materialized view `materializedView:<schema>.<view>`, in Structure: `CREATE MATERIALIZED VIEW
 *   <schema>.<view> (<columns>) AS <definition> WITH NO DATA`, the definition being the compiler's ordinary lowering
 *   of the query (`lowerDefinition`), then `REVOKE ALL ON TABLE <view> FROM PUBLIC` at once, so PUBLIC never holds a
 *   privilege on it. It is created after the tables, roster domains, constants and lower views its definition reads
 *   and after the domains its columns are typed by; a lower view joins the graph with this extension's
 *   contribution. WITH NO DATA makes creation cost nothing; the view is
 *   unpopulated, and unreadable, until its first `db.refresh`;
 * - one unique index per inherited key, in Structure beside its view: `CREATE UNIQUE INDEX <key> ON <schema>.<view>
 *   USING btree (<cols>)`, plain columns, no expression and no predicate, the index REFRESH MATERIALIZED VIEW
 *   CONCURRENTLY requires, over the full heading when no narrower key is proven, named at the naming door
 *   (identity.derivedKey), as every evidence catalog names the view's key; the unique index compares a key's spans as values. The keys and their
 *   representability are the derived analysis's;
 * - the workload's indexes on the view, in Indexes like any relation's: the view registers its fields and unique indexes with the builder (addIndexedView), and the one index engine
 *   plans the workload requests on it with every other request; its unique indexes serve a request as a table's key
 *   indexes do.
 *
 * A role reads a derived relation it holds whole through its own view of it and refreshes one with MAINTAIN on the
 * materialized view, both granted with the role's other privileges. No role holds INSERT,
 * UPDATE, DELETE or TRUNCATE on a materialized view, and PostgreSQL runs the definition with the view owner's
 * privileges.
 *
 * Each object's reason is the enforcement of its declaration: the derived relation or its inherited key. No law names
 * a derived relation, so none carries a law reason. */
const derivedRelationExtension = (): InstallExtension => {
	const extension = (b: InstallBuilder): Result.Result<InstallContribution, CompileError> =>
		catchRefusal(() => {
			const analysis = derivedAnalysis(b.checked)
			const keys: Array<CatalogKey> = []
			for (const a of analysis.order) {
				appendAll(keys, viewObjects(b, analysis, a, keys))
			}
			const out: InstallContribution = {
				...noContribution,
				derivedRelations: analysis.order.map((a) => a.name)
			}
			return out
		})
	return {
		contribute: extension,
		textDomainUses: (checked: CheckedSchema) => Result.ok(textColumnUses(derivedAnalysis(checked))),
		certifies: noCertificates,
		carriers: noCarriers
	}
}

/** Installer options with the derived relation extension after any extension the caller already listed. */
export const withDerivedRelations = (options: InstallOptions): InstallOptions => ({
	...options,
	extensions: [...options.extensions, derivedRelationExtension()]
})

/** REFRESH MATERIALIZED VIEW, plain for a view's first population and CONCURRENTLY after it, because the concurrent
 * form needs a populated view; the runtime decides which from pg_class.relispopulated.
 * Which views a db.refresh call refreshes, and in which order, is the runtime's: level of
 * schema extension, then declared order, which the owned schema's canonical Description does not keep. */
export const refreshStatement = (view: ObjectName, concurrently: boolean): Refresh => ({
	kind: "refresh",
	view,
	concurrently
})
