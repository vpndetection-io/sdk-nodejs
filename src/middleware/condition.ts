import type { Result } from '../types.js';

/**
 * A bound on a numeric member. Every key present must hold, so
 * `{ gte: 5, lt: 100 }` is a range.
 */
export interface NumericBound {
    gte?: number;
    gt?: number;
    lte?: number;
    lt?: number;
}

type LeafCondition<T> =
    T extends number ? number | number[] | NumericBound
        : T extends string ? string | string[]
            : T extends boolean ? boolean
                : never;

type ConditionOn<T> = {
    [K in keyof T]?: NonNullable<T[K]> extends object
        ? ConditionOn<NonNullable<T[K]>>
        : LeafCondition<NonNullable<T[K]>> | false | null;
};

/**
 * What makes a request worth blocking, written in the shape of a `Result`.
 *
 * Only the members you name are considered, and they must all hold. A member
 * set to `false` or `null` is ignored entirely - a condition states the
 * positive signals you act on, so there is no way to write "block when this is
 * false", which would otherwise read as blocking everybody.
 *
 * ```ts
 * { isVpn: true, vpn: { provider: 'nordvpn' } }
 * { isResproxy: true, resproxy: { hits: { gte: 5 } } }
 * { isTor: true, vpn: { confidence: ['high', 'medium'] } }
 * ```
 *
 * A list means OR, so any one of its entries blocking is enough.
 */
export type BlockCondition = ConditionOn<Omit<Result, 'raw'>>;

/** Whether an answer satisfies the condition, and should therefore be blocked. */
export function matchesCondition(
    condition: BlockCondition | BlockCondition[], result: Result,
): boolean {
    const any = Array.isArray(condition) ? condition : [condition];
    return any.some((one) => matchesObject(
        one as Record<string, unknown>, result as unknown as Record<string, unknown>,
    ));
}

/**
 * The top-level members a condition names that this answer did not carry.
 *
 * A field your plan does not include is absent rather than false, so a
 * condition naming one can never match and the block would silently never
 * fire. Gating is per top-level member, which is why only the first segment of
 * each path is checked: `vpn` present but empty is a real answer meaning the
 * flag is false, not a plan gap.
 *
 * A locally answered bogon needs no special case: it is synthesized in the
 * widest shape, so every member is present and nothing reads as missing. The
 * corpus pins that, because narrowing the synthesized shape would start
 * reporting a plan gap on every private address.
 */
export function missingMembers(
    condition: BlockCondition | BlockCondition[], result: Result,
): string[] {
    const any = Array.isArray(condition) ? condition : [condition];
    const missing = new Set<string>();
    for (const one of any) {
        for (const [member, want] of Object.entries(one as Record<string, unknown>)) {
            if (constraintCount(want) > 0 && !(member in result)) {
                missing.add(member);
            }
        }
    }
    return [...missing];
}

/**
 * How many leaf constraints a condition actually carries.
 *
 * Callers use this to reject a condition that constrains nothing: with every
 * entry ignored there is nothing left to satisfy, so it would match every
 * answer and block all traffic. Nobody writes that on purpose, and failing at
 * construction beats discovering it in production.
 */
export function constraintCount(condition: unknown): number {
    if (condition === false || condition === null || condition === undefined) {
        return 0;
    }
    if (Array.isArray(condition)) {
        return condition.reduce<number>((n, entry) => n + constraintCount(entry), 0);
    }
    if (isNumericBound(condition)) {
        return 1;
    }
    if (typeof condition === 'object') {
        return Object.values(condition).reduce<number>((n, v) => n + constraintCount(v), 0);
    }
    return 1;
}

function matchesObject(
    condition: Record<string, unknown>, value: Record<string, unknown>,
): boolean {
    for (const [key, want] of Object.entries(condition)) {
        if (constraintCount(want) === 0) {
            continue;
        }
        if (!(key in value) || !matchesValue(want, value[key])) {
            return false;
        }
    }
    return true;
}

function matchesValue(want: unknown, got: unknown): boolean {
    if (Array.isArray(want)) {
        return want.some((entry) => matchesValue(entry, got));
    }
    if (isNumericBound(want)) {
        return matchesBound(want, got);
    }
    if (typeof want === 'object' && want !== null) {
        return isRecord(got) && matchesObject(want as Record<string, unknown>, got);
    }
    // Providers are lowercase slugs on the wire and a caller should not have to
    // know that, so a string compares without case.
    if (typeof want === 'string' && typeof got === 'string') {
        return want.toLowerCase() === got.toLowerCase();
    }
    return want === got;
}

function matchesBound(bound: NumericBound, got: unknown): boolean {
    if (typeof got !== 'number') {
        return false;
    }
    if (bound.gte !== undefined && got < bound.gte) {
        return false;
    }
    if (bound.gt !== undefined && got <= bound.gt) {
        return false;
    }
    if (bound.lte !== undefined && got > bound.lte) {
        return false;
    }
    if (bound.lt !== undefined && got >= bound.lt) {
        return false;
    }
    return true;
}

const BOUND_KEYS = ['gte', 'gt', 'lte', 'lt'];

function isNumericBound(value: unknown): value is NumericBound {
    if (!isRecord(value)) {
        return false;
    }
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((k) => BOUND_KEYS.includes(k));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
