declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(filename: string);
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
      run(...params: unknown[]): unknown;
    };
    exec(sql: string): void;
    close(): void;
  }
}
