import type { Diagnostic } from "#compiler/core/diag.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type * as Result from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"

type PassMeasure = "single-traversal" | "bounded-worklist"

interface CertificateLog {
	readonly record: (certificate: Certificate) => void
	readonly all: () => ReadonlyArray<Certificate>
}

interface DiagnosticSink {
	readonly emit: (diagnostic: Diagnostic) => void
	readonly all: () => ReadonlyArray<Diagnostic>
}

export interface PassContext {
	readonly certificates: CertificateLog
	readonly diagnostics: DiagnosticSink
	readonly evidenceContext: TemplateContext
	/** The installed constraints behind declared keys and containments, named as ownership installs them. */
	readonly catalog: EvidenceCatalog
}

/**
 * Passes and their context.
 *
 * A pass is a pure function from its input to a Result: passes never throw, and a bound overrun is a source-located
 * ResourceBound. Each pass states its measure: one traversal, or a bounded worklist; there is no unrestricted rewrite loop. The context is the optimized pipeline's: it carries the compilation's
 * certificate log, the diagnostics, the evidence context the artifact is compiled for, the evidence
 * catalog its proofs resolve declared keys and containments through.
 * Every pass reads the one catalog of its compilation, so no pass can prove over constraints named another way. The conservative lowering is no pass: it runs outside any context,
 * deduplicates at every set boundary and records no certificate.
 */
export interface Pass<I, O> {
	readonly name: string
	readonly measure: PassMeasure
	readonly run: (input: I, ctx: PassContext) => Result.Result<O, CompileError>
}

const certificateLog = (): CertificateLog => {
	const certificates: Array<Certificate> = []
	return {
		record: (certificate) => {
			certificates.push(certificate)
		},
		all: () => [...certificates]
	}
}

const diagnosticSink = (): DiagnosticSink => {
	const diagnostics: Array<Diagnostic> = []
	return {
		emit: (diagnostic) => {
			diagnostics.push(diagnostic)
		},
		all: () => [...diagnostics]
	}
}

/** A fresh context for one compilation. The log and the sink are local to it and never shared. */
export const makePassContext = (input: {
	readonly evidenceContext: TemplateContext
	readonly catalog: EvidenceCatalog
}): PassContext => ({
	certificates: certificateLog(),
	diagnostics: diagnosticSink(),
	evidenceContext: input.evidenceContext,
	catalog: input.catalog
})
