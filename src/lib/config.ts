import { z } from 'zod'

const env = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    HUTCH_DATABASE_URL: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    HUTCH_BASE_URL: z.string().optional(),
  })
  .parse(process.env)

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isDevelopment: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',

  db: {
    url: env.HUTCH_DATABASE_URL || env.DATABASE_URL,
  },

  baseUrl: env.HUTCH_BASE_URL ?? 'http://localhost:3000',
} as const

export type Config = typeof config
