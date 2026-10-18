/** Browser-safe structural schema, request expectations and bounded C-11 metadata decoding. */
export { AccessConfigSchema } from './config-schema.ts'
export { decodeCloudBootstrap } from './bootstrap.ts'
export { RequestBindingError, parseRequestExpectation, assertExpectedAccount, assertExpectedGeneration } from './binding.ts'
export type { AccessConfig, AuthenticatedPrincipal, BindingFieldNames, RequestBindingFailure, RequestExpectation, RequestExpectationValues } from './types.ts'
