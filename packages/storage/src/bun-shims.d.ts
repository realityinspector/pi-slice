/**
 * Minimal type declarations for Bun-specific APIs.
 * These allow the bun-backend.ts to compile in a Node.js-only environment.
 * At runtime, the bun-backend is only loaded when Bun is detected.
 */

declare module 'bun:sqlite' {
  export type SQLQueryBindings = Record<string, unknown> | unknown[];

  export class Statement<T = Record<string, unknown>> {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): T | undefined;
    all(...params: unknown[]): T[];
    finalize(): void;
    columnNames: string[];
    toString(): string;
  }

  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean; strict?: boolean });
    query<T = Record<string, unknown>>(sql: string): Statement<T>;
    prepare<T = Record<string, unknown>>(sql: string): Statement<T>;
    run(sql: string, ...params: unknown[]): void;
    exec(sql: string): void;
    transaction<T>(fn: () => T): () => T;
    close(): void;
    filename: string;
  }
}

declare namespace Bun {
  function which(cmd: string): string | null;
  function file(path: string): { size: number };
}

declare var Bun: typeof Bun;
