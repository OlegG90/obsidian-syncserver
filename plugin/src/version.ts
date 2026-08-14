/**
 * What release this plugin is, and whether it can talk to the server it is pointed at.
 *
 * **One number for the whole solution** (#111). The server, the plugin, `shared/` and the
 * management console when it exists all ship the same `major.minor.patch`, bumped together.
 * They are one program split across two machines by necessity, not four products with
 * independent lives, and a compatibility matrix between them would be a fiction nobody
 * tests.
 *
 * **The rule: the major number carries the promise.** Two builds with the same major are
 * meant to work together; a different major means the wire changed in a way one side
 * cannot absorb.
 *
 * **While the major is 0 the minor carries it instead**, because that is what a leading
 * zero means and this project is nowhere near promising otherwise. `0.1` and `0.2` are as
 * unrelated as `1.x` and `2.x` will be. The rule collapses to the plain "same major" on the
 * day the first `1.0.0` ships, and the code below needs no change for that — the zero test
 * simply stops being true.
 *
 * **A mismatch warns; it does not block.** The check is worth having because it names a
 * failure that otherwise costs an hour: on 14 August a server eight commits behind its
 * client answered `404` to a route it had never heard of, and nothing on screen said why.
 * Naming that is the whole win. Refusing to sync would be a worse trade — it would lock
 * someone out of their own vault over a string, in the one situation where the version
 * numbers are least likely to be trustworthy.
 */

// Replaced at build time by esbuild's `define`, from `manifest.json` — the file Obsidian
// itself reads, so the version shown in its plugin list and the version reported here
// cannot disagree. Under `tsx` in a test there is no define and no such global; `typeof`
// on an undeclared name is the one way to ask without throwing.
declare const __SYNCSERVER_VERSION__: string | undefined;

/** This plugin's release. `0.0.0-dev` when running from source rather than a bundle. */
export const PLUGIN_VERSION: string =
  typeof __SYNCSERVER_VERSION__ === 'string' ? __SYNCSERVER_VERSION__ : '0.0.0-dev';

interface Release {
  major: number;
  minor: number;
}

/** `major.minor.patch`, and nothing looser: a version this cannot read is not guessed at. */
const parse = (v: string): Release | null => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
};

/**
 * Compare this plugin against a server's reported release.
 *
 * @param serverVersion what `/health` reported, or `undefined` from a server too old to
 *   report anything — which is itself an answer: older than 0.1.0.
 * @param pluginVersion defaults to this build; a parameter so tests need no bundler.
 * @returns the sentence to put in front of the person, or `null` when the two agree.
 */
export const versionWarning = (
  serverVersion: string | undefined,
  pluginVersion: string = PLUGIN_VERSION,
): string | null => {
  if (serverVersion === undefined) {
    return `This server predates version reporting (before 0.1.0), and this plugin is ${pluginVersion}. Update the server.`;
  }

  const server = parse(serverVersion);
  const plugin = parse(pluginVersion);
  if (!server || !plugin) {
    return `Cannot read a version: the server reports “${serverVersion}” and this plugin is “${pluginVersion}”.`;
  }

  // Same major, and while that major is 0, the same minor as well.
  const agreed =
    server.major === plugin.major && (server.major !== 0 || server.minor === plugin.minor);
  if (agreed) return null;

  return `Version mismatch: the server is ${serverVersion} and this plugin is ${pluginVersion}. They are not meant to be used together — update whichever is behind.`;
};
