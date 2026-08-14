/** Package-owned invariant companion for `dsh-acp-full`. @module dsh-acp-full/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-acp-full'

/** Cordis companion plugin name. */
export const name = 'dsh-acp-full-invariant'

/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

/** No runtime invariant: this plugin produces no durable session events and owns no event/data relation; protocol framing is validated by the ACP SDK's wire parser. */
const install: InvariantInstaller = () => {}

/**
 * Register the package invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
