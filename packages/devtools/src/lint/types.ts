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
}>

/** A rule prepares once per file and answers the visitor that the engine's one traversal calls with every node of
 * the file, in document order. It reports nodes; the engine stamps the rule's id. */
export type Visit = (context: RuleContext) => (node: ts.Node) => ReadonlyArray<Report>
