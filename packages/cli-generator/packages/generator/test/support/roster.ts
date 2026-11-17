/**
 * The generator's property modules, from the package root: the test modules toolchain-test runs (test.config.ts) and
 * Vitest leaves out (vitest.config.ts). Both runners read this one list, so a module runs on exactly one of them, and a
 * module converted to properties moves from Vitest to the runner by entering it, in the commit that converts it. The
 * list grows as each directory is converted, until it names every test module and Vitest's configs go.
 */
export const propertyModules: ReadonlyArray<string> = [
	"test/emit/domain-module.test.ts",
	"test/emit/help-text.test.ts",
	"test/emit/printer.test.ts",
	"test/load/document-set.test.ts",
	"test/load/read.test.ts",
	"test/load/ref-root.test.ts",
	"test/load/strict-json.test.ts",
	"test/load/yaml.test.ts",
	"test/model/author-config.test.ts",
	"test/model/brands.test.ts",
	"test/model/diagnostic.test.ts",
	"test/model/json-tree.test.ts",
	"test/model/path-item.test.ts",
	"test/model/pointer.test.ts",
	"test/names/alias-cycles.test.ts",
	"test/names/credential-collision-mtls.test.ts",
	"test/names/flatten.test.ts",
	"test/names/fold.test.ts",
	"test/names/naming-precedence.test.ts",
	"test/names/password-file.test.ts",
	"test/names/plan.test.ts",
	"test/names/reserved-namespaces.test.ts",
	"test/normalize/event-stream.test.ts",
	"test/runtime/client-retry-after.test.ts",
	"test/runtime/error-rendering.test.ts",
	"test/runtime/input-refusal.test.ts",
	"test/runtime/output-sequential.test.ts",
	"test/runtime/output-sink.test.ts",
	"test/runtime/presenter.test.ts",
	"test/runtime/redact.test.ts",
	"test/runtime/response-headers.test.ts",
	"test/runtime/response.test.ts",
	"test/runtime/sequential.test.ts",
	"test/runtime/sse.test.ts"
]
