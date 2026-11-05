import type * as ts from "typescript/ast"
import type { Checker } from "typescript/sync"
import type { SuperlintOptions } from "#lint/options.ts"
import type { Report } from "#shared/finding.ts"
import type { Semantics } from "#shared/semantic.ts"

/** What a rule sees: one owned source file, its program's checker, the file's prepared semantic lookups, and the
 * repository's options. */
export type RuleContext = Readonly<{
	sourceFile: ts.SourceFile
	checker: Checker
	semantics: Semantics
	options: SuperlintOptions
	/** The directory the options' paths are relative to: the repository root, or the fixtures' for a fixture run. */
	root: string
}>

/** A rule prepares once per file and answers the visitor that the engine's one traversal calls with every node of
 * the file, in document order. It reports nodes; the engine stamps the rule's id. */
export type Visit = (context: RuleContext) => (node: ts.Node) => ReadonlyArray<Report>

/** What a rule sees of the program a run lints, once, before any file: the program's checker, and its public surface,
 * the source module of every public subpath of the linted package's `exports` map (lint/surface.ts), empty for a
 * package that exports nothing. */
export type ProgramContext = Readonly<{
	checker: Checker
	surface: ReadonlyArray<string>
}>

/** A rule starts once per program, where it may read the whole program, and answers the Visit each file gets. */
export type Start = (program: ProgramContext) => Visit
