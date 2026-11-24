import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { DerivedRelationAnalysis } from "#compiler/analysis/derived/analyze.ts"
import { storedPrimaryKey, storedSecondaryKeys } from "#compiler/analysis/derived/storage.ts"
import type { CatalogKey } from "#compiler/analysis/physical/evidence.ts"
import { type DerivedAnalysis, derivedAnalysis } from "#compiler/analysis/schema.ts"
import type { Theory } from "#compiler/analysis/theory/theory.ts"
import { catchRefusal, unwrap } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	compareIdentities,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import type { LawId } from "#compiler/core/ids.ts"
import { noneWritten } from "#compiler/ir/derived.ts"
import type { Premise } from "#compiler/ir/evidence.ts"
import { fieldNames, type StoredDerivedRelation } from "#compiler/ir/law.ts"
import { fieldColumnType } from "#compiler/ir/physical.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import { storedKeyPremise } from "#compiler/logical/props.ts"
import type { InstallBuilder, TargetField } from "#compiler/physical/ddl/context.ts"
import { columnDomains, emptyUse, usedNodes } from "#compiler/physical/ddl/domains.ts"
import { lowerRow } from "#compiler/physical/ddl/expr.ts"
import { lowerDefinition } from "#compiler/physical/derived/definition.ts"
import {
	type InstallContribution,
	type InstallExtension,
	noCarriers,
	noCalls,
	noCertificates,
	noContribution,
	noFences,
	servesNoParams
} from "#compiler/physical/install/extension.ts"

import { noLive } from "#compiler/live/notify.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type {
	AlterTable,
	CreateIndex,
	CreateStoredTable,
	FillStored,
	PrimaryKey,
	Revoke
} from "#compiler/sql/ast.ts"
import { columnKey } from "#compiler/sql/build.ts"

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

/** A stored derived relation as the theory reads it (ir/law.ts StoredDerivedRelation), its primary key among it. */
const storedOf = (b: InstallBuilder, name: string): StoredDerivedRelation => {
	const r = b.model.theory.relations[name]
	if (r?.kind !== "stored") {
		throw defect(`the stored derived relation ${name}, a relation of the theory`)
	}
	return r
}

/** The stored table, primary key and unique indexes of one derived relation, then the natives the law model planned on
 * it (laws/model/plan.ts storedKey, a check over it): a UNIQUE over a proven key is that key's index, any other a unique
 * index by its law's name, a CHECK its own ALTER TABLE ... ADD CONSTRAINT, each refusing at phase A's insert of a row that
 * breaks it, the table's one writer. `lowerKeys` are the inherited keys of the lower levels, each the unique index
 * already planned for it. */
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
	const lowered = unwrap(
		lowerDefinition(name, a.query, {
			names: b.names,
			catalog,
			/** Its upkeep runs in level order at COMMIT, so a lower level's table is current when it reads it. */
			rows: b.checked.rows(noneWritten)
		})
	)
	const create: CreateStoredTable = {
		kind: "createStoredTable",
		name: view,
		columns,
		query: lowered.query
	}
	const stored = storedOf(b, name)
	/** Its primary key, led by its unit, as its holding chose it (analysis/derived/storage.ts storedPrimaryKey), and every
	 * other proven key, each a unique index of its own. */
	const primary = storedPrimaryKey(a.keys, stored.unit.kind === "unit" ? stored.unit.fields : [])
	const secondary = storedSecondaryKeys(a.keys, primary)
	const keyFields = stored.primaryKey
	/** The name the primary key is minted by at the naming door, whose index PostgreSQL names after it: a proven key's,
	 * the one name every evidence catalog gives that key's index (`derivedKeyConstraints`, its `index`), or the
	 * superkey's. */
	const primaryName = b.name(identity.derivedKey(name, primary.named))
	const primaryKey: PrimaryKey = {
		kind: "primaryKey",
		name: primaryName,
		columns: mapNonEmpty(keyFields, (f) => ({
			column: b.names.column(name, f),
			withoutOverlaps: false
		}))
	}
	const keyed: AlterTable = {
		kind: "alterTable",
		table: view,
		actions: [{ kind: "addConstraint", constraint: primaryKey, notValid: false }]
	}
	const revoke: Revoke = {
		kind: "revoke",
		privileges: ["ALL"],
		on: { kind: "TABLE", names: [view] },
		from: [{ kind: "PUBLIC" }]
	}
	const use = emptyUse()
	columnDomains(b, a.heading, use)
	b.storedColumns(
		view,
		a.heading.map((c) => ({
			name: b.names.column(name, c.name),
			type: fieldColumnType(b.names, c.type).type
		}))
	)
	const viewObject = b.add(
		{
			kind: "storedTable",
			ident: b.qualifiedOf("table", name, b.names.relationNamed(name)),
			ddl: [create, keyed, revoke],
			reasons: [
				enforcement(`derived relation ${name}`),
				{
					kind: "proof",
					premises: premiseLaws(
						b.model.theory,
						analysis,
						(primary.kind === "proven" ? primary.key : primary.of).proof.premises
					)
				}
			],
			phase: "structure"
		},
		[
			b.levelNode(name),
			...a.reads.flatMap((read) => {
				const from = b.readObject(read)
				return from === undefined ? [] : [from]
			}),
			...usedNodes(use)
		]
	)

	/** Each key with the object that installs its index and that index's columns, in their order. */
	const keys: Array<{
		readonly key: CatalogKey
		readonly object: Node<"structure">
		readonly columns: NonEmptyReadonlyArray<string>
	}> = [
		{
			key: {
				relation: name,
				fields: primary.named,
				spans: [],
				kind: "uniqueIndex",
				constraint: primary.kind === "proven" ? primary.key.index : primaryName
			},
			object: viewObject,
			columns: keyFields
		}
	]
	for (const k of secondary) {
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
			key: { relation: name, fields: k.fields, spans: [], kind: "uniqueIndex", constraint: index },
			object,
			columns: k.fields
		})
	}
	for (const n of b.natives) {
		const o = n.object
		if (
			n.namespace !== "constraint" ||
			(o.kind !== "Unique" && o.kind !== "TableCheck") ||
			o.relation.kind !== "stored" ||
			o.relation.name !== name
		) {
			continue
		}
		const constraint = identifierOf(n.named)
		if (o.kind === "TableCheck") {
			b.name(n.named)
			b.add(
				{
					kind: "check",
					ident: b.constraintOf(name, n.named),
					ddl: [
						{
							kind: "alterTable",
							table: view,
							actions: [
								{
									kind: "addConstraint",
									constraint: {
										kind: "check",
										name: constraint,
										predicate: lowerRow(b, stored, o.predicate, `check ${constraint}`)
									},
									notValid: false
								}
							]
						}
					],
					reasons: o.lawIds.map((law) => ({ kind: "law", law })),
					phase: "structure"
				},
				[viewObject]
			)
			continue
		}
		if (keys.some((k) => k.key.constraint === constraint)) {
			continue
		}
		b.name(n.named)
		const indexed = mapNonEmpty(o.columns, (c) => {
			if (c.kind !== "field") {
				throw defect(
					`a key over the stored relation ${name} over its fields (laws/model/plan.ts storedKey)`
				)
			}
			return c.field.name
		})
		const object = b.add(
			{
				kind: "uniqueIndex",
				ident: b.qualifiedOf("index", name, n.named),
				ddl: [
					{
						kind: "createIndex",
						name: constraint,
						table: view,
						unique: true,
						method: "btree",
						keys: mapNonEmpty(indexed, (f) => columnKey(b.names.column(name, f))),
						concurrently: false,
						include: [],
						where: undefined
					}
				],
				reasons: o.lawIds.map((law) => ({ kind: "law", law })),
				phase: "structure"
			},
			[viewObject]
		)
		keys.push({
			key: { relation: name, fields: indexed, spans: [], kind: "uniqueIndex", constraint },
			object,
			columns: indexed
		})
	}
	b.addIndexedView({
		relation: name,
		object: viewObject,
		primaryKey: keyFields,
		fields: new Map(fields),
		uniqueIndexes: keys.map((k) => ({
			object: k.object,
			name: k.key.constraint,
			columns: k.columns
		}))
	})
	return keys.map((k) => k.key)
}

/** The installer extension every installation runs last, after its caller's (physical/install/compile.ts), which adds
 * every stored derived relation's table and unique indexes to the obligation graph: storage is the installation's
 * inference (analysis/derived/storage.ts), so no installation leaves a stored relation to an extension its caller may
 * not supply. Its table columns' patterns are among the installation's structural text domains
 * (physical/install/plan.ts artifactDomains).
 *
 * Each derived relation lowers to exactly these objects of the one obligation graph, through the installer's
 * extensions, so they share its install order, manifest and determinism with every native object:
 *
 * - the stored table `storedTable:<schema>.<relation>`, in Structure: `CREATE TABLE <schema>.<relation> (<columns>)
 *   AS <definition> WITH NO DATA`, the definition being the compiler's ordinary lowering of the query
 *   (`lowerDefinition`), so each column has the type the definition delivers; then `ALTER TABLE <relation> ADD
 *   CONSTRAINT <key> PRIMARY KEY (<cols>)` over its narrowest inherited key, the full heading when no narrower key is
 *   proven, the fields carrying its declared unit first (`unitFirst`), which marks each of them NOT NULL, as no
 *   derived column is NULL; then `REVOKE ALL ON TABLE <relation> FROM PUBLIC` at once, so PUBLIC never holds a
 *   privilege on it. It is created after the tables, roster domains, constants and lower stored relations its
 *   definition reads and after the domains its columns are typed by. WITH NO DATA makes creation cost nothing; the
 *   migration that creates the table fills it in Structure, once every row it reads is written (deploy/diff/diff.ts
 *   view, `fillStatement`), and the judge's upkeep keeps it equal to its definition at every COMMIT after
 *   (physical/ddl/rules.ts). Its primary key is the replica identity a live source decodes its changes by, as any
 *   table's is (physical/ddl/live.ts);
 * - one unique index per other inherited key, in Structure beside its table: `CREATE UNIQUE INDEX <key> ON
 *   <schema>.<relation> USING btree (<cols>)`, plain columns, no expression and no predicate. Every key, the primary
 *   one's included, is named at the naming door (identity.derivedKey), as every evidence catalog names the relation's
 *   key, and compares a key's spans as values. The keys and their representability are the derived analysis's;
 * - the workload's indexes on the table, in Indexes like any relation's: the table registers its fields, its primary
 *   key and its unique indexes with the builder (addIndexedView), and the one index engine plans the workload requests on it with every
 *   other request, the upkeep's among them; its unique indexes serve a request as a table's key indexes do.
 *
 * A role reads a stored relation it holds whole through its own view of it, granted with the role's other privileges.
 * No role holds INSERT, UPDATE, DELETE or TRUNCATE on a stored table: only the judge's upkeep writes it, SECURITY
 * DEFINER, as its owner.
 *
 * Each object's reason is the enforcement of its declaration, the derived relation, and the proof of the key its
 * index rests on: the stored table's its primary key's, a unique index's its own. No law names a derived relation, so
 * none carries a law reason. */
export const storedTablesExtension: InstallExtension = {
	contribute: (b: InstallBuilder): Result.Result<InstallContribution, CompileError> =>
		catchRefusal(() => {
			const analysis = derivedAnalysis(b.checked)
			const keys: Array<CatalogKey> = []
			for (const a of analysis.order) {
				appendAll(keys, viewObjects(b, analysis, a, keys))
			}
			return noContribution
		}),
	params: servesNoParams,
	certifies: noCertificates,
	carriers: noCarriers,
	calls: noCalls,
	live: noLive,
	fences: noFences
}

/** A stored relation's fill: every row of its definition, into the table `create` makes (sql/ast.ts FillStored). */
export const fillStatement = (create: CreateStoredTable): FillStored => ({
	kind: "fillStored",
	table: create.name,
	columns: create.columns,
	query: create.query
})
