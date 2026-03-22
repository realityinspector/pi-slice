/**
 * Minimal type declarations for Bun-specific APIs.
 * These allow server code to compile in a Node.js-only environment.
 * At runtime, Bun-specific code paths are only executed when Bun is detected.
 */

declare namespace Bun {
  function write(path: string, data: ArrayBuffer | Uint8Array | string): Promise<number>;
  function file(path: string): { size: number; exists(): Promise<boolean>; arrayBuffer(): Promise<ArrayBuffer>; type: string };
  function serve(options: Record<string, unknown>): { port: number; hostname: string; stop(): void };
  function which(cmd: string): string | null;
}

declare var Bun: typeof Bun | undefined;
