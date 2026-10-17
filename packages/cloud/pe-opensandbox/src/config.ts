import z from '@deepseek-ai/schemastery'

/** Validate only the declared modes; target evidence remains an independent requirement. */
export const executionRequirementsSchema = z.object({
  requiredCapabilities: z.array(z.union([
    z.const('argv-collect'), z.const('pipes'), z.const('control'), z.const('inherit'), z.const('terminal'),
  ])).required(),
})
