/**
 * A closed constant's pack stated as its literal whatever its size: the form generate drafts a pack in past what one
 * statement carries (physical/ddl/constants.ts packFormOf), so a suite installs, drafts and checks literal packs over
 * relations small enough to enumerate.
 */
import { Array as Arr } from "effect"
import { constantDigestOf } from "#compiler/ir/cells.ts"
import { type PackBounds, packFormOf } from "#compiler/physical/ddl/constants.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import type { PackConstant, SqlStatement } from "#compiler/sql/ast.ts"

/** Bounds no pack fits: with a declaration of hex, two reasons packFormOf states every pack as its literal. */
const noBytes: PackBounds = { statementBytes: 0, executedBytes: 0 }

/** A pack that lists its rows, stated as its literal instead; a literal pack as it is. */
export const statedAsLiteral = (pack: PackConstant): PackConstant => {
	if (pack.form.kind === "literal") {
		return pack
	}
	const constant = {
		cells: pack.cells,
		width: pack.width,
		entries: Arr.map(pack.form.rows, (r) => ({ index: r.index, payload: r.payload }))
	}
	return packFormOf(
		pack.function,
		{ constant, rows: pack.form.rows, digest: constantDigestOf(constant) },
		"hex",
		noBytes
	)
}

/** A statement with its pack, where it is one, stated as its literal. */
const restated = (s: SqlStatement): SqlStatement =>
	s.kind === "packConstant" ? statedAsLiteral(s) : s

/**
 * The installation with every closed constant stated as its literal, the owner functions' too: in its install script,
 * and in its manifest, which its snapshot records.
 */
export const literalInstallation = (installation: Installation): Installation => ({
	...installation,
	statements: Arr.map(installation.statements, restated),
	manifest: {
		...installation.manifest,
		objects: Arr.map(installation.manifest.objects, (o) => ({
			...o,
			ddl: Arr.map(o.ddl, restated)
		}))
	}
})
