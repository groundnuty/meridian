import Ajv, { type ValidateFunction } from "ajv"
import Ajv2019 from "ajv/dist/2019.js"
import Ajv2020 from "ajv/dist/2020.js"
import { fullFormats } from "ajv-formats/dist/formats.js"
import { AntigravityError } from "./antigravityProtocol"

/** Per-turn validators: no global schema cache, coercion, defaults or remote fetches. */
export class AgSchemaCompiler {
  private readonly compilers = new Map<string, Ajv>()
  compile(schema: Record<string, unknown>, label: string): ValidateFunction {
    try {
      const dialect = typeof schema.$schema === "string" ? schema.$schema : "http://json-schema.org/draft-07/schema#"
      let compiler = this.compilers.get(dialect)
      if (!compiler) {
        const options = { strict: false, addUsedSchema: false, logger: false as const }
        compiler = dialect.includes("2020-12") ? new Ajv2020(options) : dialect.includes("2019-09") ? new Ajv2019(options) : new Ajv(options)
        for (const [name, format] of Object.entries(fullFormats)) compiler.addFormat(name, format)
        this.compilers.set(dialect, compiler)
      }
      const validate = compiler.compile(schema)
      if ("$async" in validate && validate.$async) throw new Error("Async schemas are not supported")
      return validate
    } catch (error) { throw new AntigravityError(`${label}: Invalid or unsupported JSON Schema: ${String(error)}`) }
  }
}

export function agSchemaError(validate: ValidateFunction, value: unknown): string | undefined {
  if (validate(value)) return undefined
  return JSON.stringify(validate.errors).slice(0, 4096)
}
