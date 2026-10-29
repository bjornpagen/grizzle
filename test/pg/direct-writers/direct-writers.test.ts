/**
 * The direct-writer suites: the model over generated schemas (suite.ts), and the law kinds its schemas do not draw
 * (suites/native-errors.ts).
 */
import { directWriterSuite } from "#test/pg/direct-writers/suite.ts"
import { nativeErrorsSuite } from "#test/pg/direct-writers/suites/native-errors.ts"

directWriterSuite()
nativeErrorsSuite()
