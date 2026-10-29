import type { CompileError } from "#compiler/core/errors.ts"
import type { LawId } from "#compiler/core/ids.ts"
import * as Result from "#compiler/core/result.ts"
import type { ResidualLaw } from "#compiler/ir/law.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { emitResidualLaw, type ResidualLawObjects } from "#compiler/laws/residual/skeleton.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import type { InstallOptions } from "#compiler/physical/install/compile.ts"
import {
	type InstallContribution,
	type InstallExtension,
	noContribution
} from "#compiler/physical/install/extension.ts"

import { lawReasons, type Node } from "#compiler/physical/obligations/graph.ts"
import type { PlFunction, TypeRef } from "#compiler/sql/ast.ts"

/** The enums and domains of the installed schema a function's declarations name, in declaration order: the objects
 * it must follow. */
const declaredTypes = (b: InstallBuilder, fn: PlFunction): ReadonlyArray<Node<"setup">> =>
	fn.body.declare.flatMap((d) => {
		const t: TypeRef = d.type
		const node = t.kind === "named" ? b.typeNamed(t) : undefined
		return node === undefined ? [] : [node]
	})

/** The objects of one emitted residual law: its function after the schema and the types its declarations name, and
 * each trigger after the function, its own table and the law's anchor table. */
const addResidualLaw = (b: InstallBuilder, law: ResidualLaw, objects: ResidualLawObjects): void => {
	const reasons: ReadonlyArray<PhysicalReason> = lawReasons([law.lawId])
	const fn = b.add(
		{
			kind: "lawFunction",
			ident: b.qualified("function", law.function),
			ddl: [objects.function, objects.revoke],
			reasons,
			phase: "setup"
		},
		[b.schemaNode, ...declaredTypes(b, objects.function)]
	)
	const anchor = b.table(law.anchor.relation.name)
	for (const t of objects.triggers) {
		const relation = t.participant.relation.name
		b.add(
			{
				kind: "lawTrigger",
				ident: {
					kind: "trigger",
					schema: b.settings.installation,
					relation: b.names.relationNamed(relation),
					name: t.participant.trigger
				},
				ddl: [t.trigger],
				reasons,
				phase: "validate"
			},
			[fn, b.table(relation), anchor]
		)
	}
}

/** The installer extension that adds every residual law's function and triggers to the obligation graph and claims the
 * law, so the installation does not report it deferred.
 *
 * Residual law objects in the installation manifest. Each residual law the law model records lowers to exactly one function and one deferred
 * constraint trigger per participating table, which the residual skeleton emits, plus its
 * supporting indexes. This module turns them into physical objects of the one obligation graph, through the
 * installer's extensions, so they share the graph's install order, its manifest and its
 * determinism with every native object:
 *
 * - the function `function:<schema>.<law function>` (identity.lawFunction), kind lawFunction, in Setup; a migration replaces a changed one
 *   in place, in the law's Validate transaction. Its DDL is the CREATE OR REPLACE FUNCTION and the
 *   REVOKE EXECUTE ... FROM PUBLIC that follows it at
 *   once, so PUBLIC never holds EXECUTE even before Publish resets the owner's default privileges. The function is
 *   owned by the role that runs the installation, the migration identity that owns the schema. It is created after
 *   the schema and after any enum or domain its declarations name; its SQL statements are parsed, not resolved, at
 *   creation, so it needs no table;
 * - one trigger `trigger:<schema>.<table>.<law trigger>` (identity.lawTrigger) per participating table, kind lawTrigger, in
 *   Validate, after its function, its own table and the law's anchor table;
 * - the supporting indexes are the law's IndexRequests (`ResidualLaw.indexes`), one per probe, which the installer already
 *   hands the index engine with every other law-maintenance and workload request: each lands on a
 *   key or enforcement index that serves it, merging the law id into that object's reasons, or becomes an access index
 *   justified by the law, partial with the law's selection when its probe reads only the
 *   selected rows. Indexes are built in the Indexes phase, so they precede the law's triggers.
 *
 * Every object's reason is the law's identity, the constraint name the function raises; the
 * constraint-to-law map already carries the law's identity to the law.
 *
 * The phases are the migration phases, which refine the installation's dependency order. On a
 * fresh install every phase runs in the one install transaction, and the triggers are created in
 * the same transaction as their empty tables, so the lawful-state validation, that every law holds of the existing
 * rows, holds by construction: the baseline is empty and no violation query has rows to find. A migration onto
 * existing data runs the full violation query under a writer-excluding lock in its Validate file; that is the
 * migration generator's.
 *
 * A residual law the skeleton refuses refuses the installation: the natives without it are not a complete
 * implementation. */
const residualLawExtension = (): InstallExtension => ({
	contribute,
	textDomainUses: noTextDomainUses
})

const contribute = (b: InstallBuilder): Result.Result<InstallContribution, CompileError> => {
	const claimed: Array<LawId> = []
	for (const law of b.model.residuals) {
		const emitted = emitResidualLaw(law, {
			schema: b.schema,
			holders: (relation) => b.wholeHolders(relation)
		})
		if (!emitted.ok) {
			return emitted
		}
		addResidualLaw(b, law, emitted.value)
		claimed.push(law.lawId)
	}
	const out: InstallContribution = { ...noContribution, residualLaws: claimed }
	return Result.ok(out)
}

/** Installer options with the residual law extension first, before any extension the caller adds. */
export const withResidualLaws = (options: InstallOptions): InstallOptions => ({
	...options,
	extensions: [residualLawExtension(), ...options.extensions]
})
