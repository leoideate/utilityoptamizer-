import type { PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, z } from "zod";

/** Validates a body/query with a shared Zod schema. Errors are mapped to 400 by HttpErrorFilter. */
export class ZodPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    return this.schema.parse(value);
  }
}
