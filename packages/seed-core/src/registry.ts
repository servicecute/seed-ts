import { SeedError } from "./error.js";

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Generic named-key registry per spec §4. Explicit registration only;
 * no auto-discovery. Names match `[a-z][a-z0-9_-]*`. Duplicates error
 * rather than silently overwrite.
 */
export class Registry<T> {
  private readonly entries = new Map<string, T>();

  register(name: string, entry: T): this {
    if (!NAME_PATTERN.test(name)) {
      throw new SeedError(
        `registry name ${JSON.stringify(name)} must match [a-z][a-z0-9_-]*`,
      );
    }
    if (this.entries.has(name)) {
      throw new SeedError(
        `registry already has entry named ${JSON.stringify(name)}`,
      );
    }
    this.entries.set(name, entry);
    return this;
  }

  lookup(name: string): T | undefined {
    return this.entries.get(name);
  }

  names(): string[] {
    return Array.from(this.entries.keys()).sort();
  }

  size(): number {
    return this.entries.size;
  }
}
