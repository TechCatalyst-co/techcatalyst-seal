import type { ZodType, ZodTypeDef } from 'zod';
import { HttpError } from './security';

export function parse<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const msg = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HttpError(400, 'invalid_request', msg);
  }
  return r.data;
}
