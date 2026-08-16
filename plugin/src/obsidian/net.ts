/**
 * Obsidian's networking, bound once.
 *
 * `transport.ts` next to this takes `requestUrl` as a parameter and imports nothing from the
 * application, which is what lets it be tested outside one. This file is the other half: the
 * single place that actually reaches into `obsidian` for it.
 *
 * It is a module rather than a line in the composition root because two edges need it now —
 * the plugin, and the settings screen asking a server for its version — and the alternative
 * was the screen importing the plugin at runtime, which is a cycle for the sake of one const.
 */
import { requestUrl } from 'obsidian';

import { makeObsidianTransport } from './transport.js';

export const transport = makeObsidianTransport(requestUrl);
