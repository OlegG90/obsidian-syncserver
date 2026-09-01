/**
 * `deviceLabel`, bound to what Obsidian reports.
 *
 * Two lines, and both of them are the binding: this file imports `obsidian` at run time, so nothing
 * that can be decided elsewhere is decided here. The decision is `device-label.ts` (#301).
 */
import { Platform } from 'obsidian';
import { labelFor } from '../device-label.js';

export const deviceLabel = (): string => labelFor(Platform);
