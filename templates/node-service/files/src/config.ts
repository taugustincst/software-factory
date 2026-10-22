import { z } from 'zod';

/** Dev-only default for SESSION_SECRET. Production refuses to start with it (see below). */
export const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me';

/** All configuration comes from the environment, validated once at startup. */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    // Keys the HMAC of stored session tokens. Set a real random secret (>= 32 chars) in production.
    SESSION_SECRET: z.string().min(16).default(DEV_SESSION_SECRET),
    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 90)
      .default(24 * 7),
    // Local default matches docker-compose.yml; CI and production set DATABASE_URL explicitly.
    DATABASE_URL: z.string().min(1).default('postgres://app:app@127.0.0.1:5432/app'),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.NODE_ENV === 'production' && cfg.SESSION_SECRET === DEV_SESSION_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_SECRET'],
        message: 'must be set to a real secret in production (the dev default is public)',
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
