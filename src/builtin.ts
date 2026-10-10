// Builtins are looked up where they are used, never imported: webpack's Edge build, Next.js 15's
// default for middleware, refuses any `node:` import, even on a path the middleware never takes.

type BuiltinLoader = (id: string) => unknown;

/** The builtin, or undefined on a runtime without `process.getBuiltinModule` (Node 22.3). */
export function nodeBuiltin<T>(id: string): T | undefined {
    const process = (globalThis as { process?: { getBuiltinModule?: BuiltinLoader } }).process;
    return process?.getBuiltinModule?.(id) as T | undefined;
}

/** The builtin, for a path that can wait: older Nodes get it through an import no bundler follows. */
export async function loadNodeBuiltin<T>(id: string): Promise<T> {
    return nodeBuiltin<T>(id) ?? (await import(/* webpackIgnore: true */ /* @vite-ignore */ id) as T);
}
