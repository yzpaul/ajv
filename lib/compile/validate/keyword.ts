import {
  KeywordDefinition,
  KeywordErrorDefinition,
  KeywordContext,
  KeywordContextParams,
  MacroKeywordDefinition,
  FuncKeywordDefinition,
  CompilationContext,
  KeywordCompilationResult,
} from "../../types"
import {applySubschema} from "../subschema"
import {reportError, reportExtraError, extendErrors} from "../errors"
import {callValidate, schemaRefOrVal} from "../../vocabularies/util"
import {getData} from "../util"
import {_, Name, Expression} from "../codegen"
import N from "../names"

export const keywordError: KeywordErrorDefinition = {
  message: ({keyword}) => `'should pass "${keyword}" keyword validation'`,
  params: ({keyword}) => `{keyword: "${keyword}"}`, // TODO possibly remove it as keyword is reported in the object
}

export function keywordCode(
  it: CompilationContext,
  keyword: string,
  def: KeywordDefinition,
  ruleType?: string
): void {
  const cxt = _getKeywordContext(it, keyword, def)
  if ("code" in def) {
    def.code(cxt, ruleType)
  } else if (cxt.$data && "validate" in def) {
    funcKeywordCode(cxt, def as FuncKeywordDefinition)
  } else if ("macro" in def) {
    macroKeywordCode(cxt, def)
  } else if ("compile" in def || "validate" in def) {
    funcKeywordCode(cxt, def)
  }
}

function _getKeywordContext(
  it: CompilationContext,
  keyword: string,
  def: KeywordDefinition
): KeywordContext {
  const schema = it.schema[keyword]
  const {schemaType, $data: $defData} = def
  validateKeywordSchema(it, keyword, def)
  const {gen, data, opts, allErrors} = it
  // TODO
  // if (!code) throw new Error('"code" and "error" must be defined')
  const $data = $defData && opts.$data && schema && schema.$data
  const schemaValue = schemaRefOrVal(it, schema, keyword, $data)
  const cxt: KeywordContext = {
    gen,
    ok,
    pass,
    fail,
    errorParams,
    keyword,
    data,
    $data,
    schema,
    schemaCode: $data ? gen.name("schema") : schemaValue, // reference to resolved schema value
    schemaValue, // actual schema reference or value for primitive values
    parentSchema: it.schema,
    params: {},
    it,
  }
  if ($data) {
    gen.const(<Name>cxt.schemaCode, `${getData($data, it)}`)
  } else if (schemaType && !validSchemaType(schema, schemaType)) {
    throw new Error(`${keyword} must be ${JSON.stringify(schemaType)}`)
  }
  return cxt

  function fail(cond?: Expression, failAction?: () => void, context?: KeywordContext): void {
    const action = failAction || _reportError
    if (cond) {
      gen.if(cond)
      action()
      if (allErrors) gen.endIf()
      else gen.else()
    } else {
      action()
      if (!allErrors) gen.if("false")
    }

    function _reportError() {
      reportError(context || cxt, def.error || keywordError)
    }
  }

  function pass(cond: Expression, failAction?: () => void, context?: KeywordContext): void {
    cond = cond instanceof Name ? cond : `(${cond})`
    fail(`!${cond}`, failAction, context)
  }

  function ok(cond: Expression): void {
    if (!allErrors) gen.if(cond)
  }

  function errorParams(obj: KeywordContextParams, assign?: true) {
    if (assign) Object.assign(cxt.params, obj)
    else cxt.params = obj
  }
}

function validSchemaType(schema: any, schemaType: string | string[]): boolean {
  // TODO add tests
  if (Array.isArray(schemaType)) {
    return schemaType.some((st) => validSchemaType(schema, st))
  }
  return schemaType === "array"
    ? Array.isArray(schema)
    : schemaType === "object"
    ? schema && typeof schema == "object" && !Array.isArray(schema)
    : typeof schema == schemaType
}

export function getKeywordContext(it: CompilationContext, keyword: string): KeywordContext {
  const {gen, data, schema} = it
  const schemaCode = schemaRefOrVal(it, schema, keyword)
  return {
    gen,
    ok: exception,
    pass: exception,
    fail: exception,
    errorParams: exception,
    keyword,
    data,
    schema: schema[keyword],
    schemaCode,
    schemaValue: schemaCode,
    parentSchema: schema,
    params: {},
    it,
  }
}

function exception() {
  throw new Error("this function can only be used in keyword")
}

function macroKeywordCode(cxt: KeywordContext, def: MacroKeywordDefinition) {
  const {gen, fail, keyword, schema, parentSchema, it} = cxt
  const macroSchema = def.macro.call(it.self, schema, parentSchema, it)
  const schemaRef = addCustomRule(it, keyword, macroSchema)
  if (it.opts.validateSchema !== false) it.self.validateSchema(macroSchema, true)

  const valid = gen.name("valid")
  applySubschema(
    it,
    {
      schema: macroSchema,
      schemaPath: "",
      errSchemaPath: `${it.errSchemaPath}/${keyword}`,
      topSchemaRef: schemaRef,
      compositeRule: true,
    },
    valid
  )

  fail(`!${valid}`, () => reportExtraError(cxt, keywordError))
}

function funcKeywordCode(cxt: KeywordContext, def: FuncKeywordDefinition) {
  const {gen, ok, fail, keyword, schema, schemaCode, parentSchema, $data, it} = cxt
  checkAsync(it, def)
  const validate =
    "compile" in def && !$data ? def.compile.call(it.self, schema, parentSchema, it) : def.validate
  const validateRef = addCustomRule(it, keyword, validate)
  const valid = gen.let("valid")

  if (def.errors === false) {
    validateNoErrorsRule()
  } else {
    validateRuleWithErrors()
  }

  function validateNoErrorsRule(): void {
    gen.block(() => {
      if ($data) check$data()
      assignValid()
      if (def.modifying) modifyData(cxt)
    })
    if (!def.valid) fail(`!${valid}`)
  }

  function validateRuleWithErrors(): void {
    gen.block()
    if ($data) check$data()
    const errsCount = gen.const("_errs", N.errors)
    const ruleErrs = def.async ? validateAsyncRule() : validateSyncRule()
    if (def.modifying) modifyData(cxt)
    gen.endBlock()
    reportKeywordErrors(ruleErrs, errsCount)
  }

  function check$data(): void {
    gen
      // TODO add support for schemaType in keyword definition
      // .if(`${dataNotType(schemaCode, <string>def.schemaType, $data)} false`) // TODO refactor
      .if(`${schemaCode} === undefined`)
      .code(`${valid} = true;`)
      .else()
    if (def.validateSchema) {
      const validateSchemaRef = addCustomRule(it, keyword, def.validateSchema)
      gen.code(`${valid} = ${validateSchemaRef}(${schemaCode});`)
      // TODO fail if schema fails validation
      // gen.if(`!${valid}`)
      // reportError(cxt, keywordError)
      // gen.else()
      gen.if(valid)
    }
  }

  function validateAsyncRule(): Name {
    const ruleErrs = gen.let("ruleErrs", "null")
    gen.try(
      () => assignValid("await "),
      (e) =>
        gen
          .code(`${valid} = false;`)
          .if(`${e} instanceof ValidationError`, `${ruleErrs} = ${e}.errors;`, `throw ${e};`)
    )
    return ruleErrs
  }

  function validateSyncRule(): Expression {
    const validateErrs = `${validateRef}.errors`
    gen.code(`${validateErrs} = null;`)
    assignValid("")
    return validateErrs
  }

  function assignValid(await: string = def.async ? "await " : ""): void {
    const passCxt = it.opts.passContext ? "this" : "self"
    const passSchema = !(("compile" in def && !$data) || def.schema === false)
    gen.code(`${valid} = ${await}${callValidate(cxt, validateRef, passCxt, passSchema)};`)
  }

  function reportKeywordErrors(ruleErrs: Expression, errsCount: Name): void {
    switch (def.valid) {
      case true:
        return
      case false:
        addKeywordErrors(cxt, ruleErrs, errsCount)
        return ok("false") // TODO maybe add gen.skip() to remove code till the end of the block?
      default:
        fail(`!${valid}`, () => addKeywordErrors(cxt, ruleErrs, errsCount))
    }
  }
}

function modifyData(cxt: KeywordContext) {
  const {gen, data, it} = cxt
  gen.if(it.parentData, () => gen.assign(data, `${it.parentData}[${it.parentDataProperty}];`))
}

function addKeywordErrors(cxt: KeywordContext, errs: Expression, errsCount: Name): void {
  const {gen} = cxt
  gen.if(
    `Array.isArray(${errs})`,
    () => {
      gen.assign(N.vErrors, `${N.vErrors} === null ? ${errs} : ${N.vErrors}.concat(${errs})`) // TODO tagged
      gen.assign(N.errors, _`${N.vErrors}.length;`)
      extendErrors(cxt, errsCount)
    },
    () => reportError(cxt, keywordError)
  )
}

function checkAsync(it: CompilationContext, def: FuncKeywordDefinition) {
  if (def.async && !it.async) throw new Error("async keyword in sync schema")
}

export function validateKeywordSchema(
  it: CompilationContext,
  keyword: string,
  def: KeywordDefinition
): void {
  const deps = def.dependencies
  if (deps?.some((kwd) => !Object.prototype.hasOwnProperty.call(it.schema, kwd))) {
    throw new Error(`parent schema must have dependencies of ${keyword}: ${deps.join(",")}`)
  }

  if (def.validateSchema) {
    const valid = def.validateSchema(it.schema[keyword])
    if (!valid) {
      const msg = "keyword schema is invalid: " + it.self.errorsText(def.validateSchema.errors)
      if (it.opts.validateSchema === "log") it.logger.error(msg)
      else throw new Error(msg)
    }
  }
}

function addCustomRule(
  it: CompilationContext,
  keyword: string,
  res?: KeywordCompilationResult
): string {
  if (res === undefined) throw new Error(`custom keyword "${keyword}" failed to compile`)
  const idx = it.customRules.length
  it.customRules[idx] = res
  return `customRule${idx}`
}
