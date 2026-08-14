/** Package-owned invariant companion for `dsh-acp-full`. @module dsh-acp-full/invariant */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "dsh-acp-full-invariant";
/** Service required before package ownership can be reserved. */
export declare const inject: string[];
/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map