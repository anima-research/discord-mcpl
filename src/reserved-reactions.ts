/**
 * Reserved-reaction projection policy (issue #21).
 *
 * Some reaction emojis are reserved for classifier signaling: if a model
 * ever sees the glyph — in an event line, an event id, a history snapshot,
 * a diagnostic — it might reproduce it and trip the classifier. This module
 * decides, centrally, which reactions may be projected into model-visible
 * output. It is projection policy, not deletion: raw Discord state is never
 * mutated, only what the model gets shown.
 *
 * The policy lives in a JSON file named by DISCORD_RESERVED_REACTIONS_FILE
 * (never inline in env/recipe values — resolved-config logs would reproduce
 * the glyphs):
 *
 *   {
 *     "version": 1,
 *     "customEmojiIds": ["123456789012345678"],
 *     "unicodeExact": ["🛑"],
 *     "unicodeFamilies": ["👍"]
 *   }
 *
 * - customEmojiIds match by snowflake id, before any name/token formatting;
 * - unicodeExact match after NFC normalization with presentation selectors
 *   (VS15/VS16) stripped, so the same visible emoji matches however a
 *   client encoded it;
 * - unicodeFamilies additionally strip skin-tone modifiers, deliberately
 *   covering every tone/presentation variant of the configured base — one
 *   codepoint is not one visible emoji.
 *
 * The schema is strict because this is a safety boundary: an unknown key,
 * a malformed snowflake, or an entry that normalizes to nothing would each
 * turn a typo into "active protection with zero effect", so all of them are
 * load errors. A file that is valid but contains no entries is accepted —
 * but reported as "configured-empty", never "active", so deployment checks
 * can't mistake mechanism presence for a real set.
 *
 * Failure semantics:
 * - env UNSET: empty policy, backwards compatible — but status says
 *   "unset", it never implies protection is active;
 * - env set but the file is missing/unreadable/malformed at first load:
 *   FAIL CLOSED — every model-visible reaction is suppressed until the
 *   file is repaired. A configured policy silently becoming empty is the
 *   one outcome this must never produce;
 * - reload failure after a good load: keep last-known-good atomically,
 *   report degraded. Stale correct policy beats no policy.
 *
 * Reloads key off a file signature (mtime + size + ctime + inode), and a
 * failed attempt is cached against that signature too, so an unchanged
 * broken file costs one read/parse total, not one per reaction. A file
 * that vanishes and later reappears is force-reloaded even if the restored
 * metadata matches — restored-from-backup files can preserve mtime while
 * carrying different content.
 *
 * Status/diagnostics expose version, content hash, per-category counts and
 * load state — never the configured glyphs.
 */

import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

export interface ReservedReactionsFileV1 {
  version: 1;
  customEmojiIds?: string[];
  unicodeExact?: string[];
  unicodeFamilies?: string[];
}

export type ReservedReactionsStatus =
  | { state: 'unset' }
  | {
      state: 'active';
      version: number;
      contentHash: string;
      counts: { customEmojiIds: number; unicodeExact: number; unicodeFamilies: number };
      /** Set when the most recent reload failed and last-known-good is in effect. */
      staleSince?: string;
    }
  | {
      /** File loaded and valid but holds zero entries: the mechanism is
       *  present, the protection is not. Deliberately not 'active'. */
      state: 'configured-empty';
      version: number;
      contentHash: string;
      staleSince?: string;
    }
  | { state: 'failed-closed'; error: string };

/** Strip presentation selectors (VS15 text / VS16 emoji) after NFC. */
function normalizeExact(s: string): string {
  return s.normalize('NFC').replace(/[\uFE0E\uFE0F]/gu, '');
}

/** Family key: normalized form with skin-tone modifiers removed wherever
 *  they appear (U+1F3FB–U+1F3FF), so a configured base covers all variants. */
function familyKey(s: string): string {
  return normalizeExact(s).replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

interface CompiledPolicy {
  version: number;
  contentHash: string;
  customEmojiIds: Set<string>;
  unicodeExact: Set<string>;
  unicodeFamilies: Set<string>;
}

const KNOWN_KEYS = ['version', 'customEmojiIds', 'unicodeExact', 'unicodeFamilies'];

/** Discord snowflakes are 64-bit decimal ids; every real one is 17–20
 *  digits. Anything else in customEmojiIds is a typo that would never
 *  match a reaction, i.e. silent zero protection. */
const SNOWFLAKE = /^\d{17,20}$/;

/** Entry problems are reported by index, never by value — compile errors
 *  flow into status/logs, which must not reproduce configured glyphs. */
function compile(raw: string): CompiledPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`not valid JSON: ${(err as Error).message}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('root must be an object');
  }
  for (const key of Object.keys(obj)) {
    // An unrecognized key is likely a typo of a recognized one, and a typo
    // here means a policy that loads "active" and reserves nothing.
    if (!KNOWN_KEYS.includes(key)) {
      throw new Error(`unknown key ${JSON.stringify(key)} (known keys: ${KNOWN_KEYS.join(', ')})`);
    }
  }
  if (obj.version !== 1) {
    throw new Error(`unsupported version: ${JSON.stringify(obj.version)} (expected 1)`);
  }
  const strings = (field: string): string[] => {
    const v = obj[field];
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw new Error(`${field} must be an array of strings`);
    }
    return v as string[];
  };
  const customEmojiIds = strings('customEmojiIds');
  customEmojiIds.forEach((id, i) => {
    if (!SNOWFLAKE.test(id)) {
      throw new Error(`customEmojiIds[${i}] is not a Discord snowflake (expected 17-20 digits)`);
    }
  });
  const unicodeExact = strings('unicodeExact').map((e, i) => {
    const n = normalizeExact(e);
    if (n === '') {
      throw new Error(`unicodeExact[${i}] is empty after normalization — it would match nothing`);
    }
    return n;
  });
  const unicodeFamilies = strings('unicodeFamilies').map((e, i) => {
    const k = familyKey(e);
    if (k === '') {
      throw new Error(`unicodeFamilies[${i}] is empty after selector/tone stripping — it would match nothing`);
    }
    return k;
  });
  return {
    version: 1,
    contentHash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    customEmojiIds: new Set(customEmojiIds),
    unicodeExact: new Set(unicodeExact),
    unicodeFamilies: new Set(unicodeFamilies),
  };
}

/** Identity of the file content we last attempted to load. mtime alone is
 *  not enough: coarse timestamps and restore-from-backup can hand back
 *  different bytes under an identical mtime. */
interface FileSig {
  mtimeMs: number;
  size: number;
  ctimeMs: number;
  ino: number;
}

function sigEquals(a: FileSig | null, b: FileSig): boolean {
  return a !== null && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ctimeMs === b.ctimeMs && a.ino === b.ino;
}

export class ReservedReactionsPolicy {
  private readonly filePath: string | undefined;
  private policy: CompiledPolicy | null = null;
  private failedClosed: string | null = null;
  private staleSince: string | null = null;
  /** Signature of the last read+parse attempt — kept on failure too, so an
   *  unchanged broken file is not reparsed on every reaction. */
  private lastAttemptSig: FileSig | null = null;
  /** The file was absent at some point since the last attempt; the next
   *  successful stat must force a reload even if the signature matches. */
  private fileMissing = false;
  private loadedOnce = false;
  /** Count of actual read+parse attempts. Diagnostic seam so tests can
   *  prove the caching behavior (one attempt per distinct file state). */
  private loadAttempts = 0;

  constructor(filePath?: string) {
    this.filePath = filePath || undefined;
  }

  /** Load or signature-revalidate. Called lazily from every decision so an
   *  operator can repair the file without a restart. */
  private ensureLoaded(): void {
    if (!this.filePath) return;

    let sig: FileSig;
    try {
      const st = statSync(this.filePath);
      sig = { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, ino: st.ino };
    } catch (err) {
      this.fileMissing = true;
      if (!this.loadedOnce) {
        // Configured but unreadable at first load: fail closed.
        this.failedClosed = `cannot stat ${this.filePath}: ${(err as Error).message}`;
        this.logOnce(`failed closed (${this.failedClosed}) — ALL model-visible reactions suppressed until repaired`);
        this.loadedOnce = true;
      } else if (this.policy && !this.staleSince) {
        // File vanished after a good load: keep last-known-good, report stale.
        this.staleSince = new Date().toISOString();
        this.logOnce(`reload failed (cannot stat): keeping last-known-good policy ${this.policy.contentHash}`);
      }
      return;
    }

    // Fast path: we already attempted exactly this file state — whether it
    // parsed or not — and it was never missing in between.
    if (this.loadedOnce && !this.fileMissing && sigEquals(this.lastAttemptSig, sig)) return;
    this.fileMissing = false;
    this.lastAttemptSig = sig;
    this.loadAttempts++;

    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const compiled = compile(raw);
      const recovering = this.failedClosed !== null || this.staleSince !== null;
      this.policy = compiled;
      this.failedClosed = null;
      this.staleSince = null;
      this.lastLogged = null;
      if (!this.loadedOnce || recovering) {
        const total = compiled.customEmojiIds.size + compiled.unicodeExact.size + compiled.unicodeFamilies.size;
        console.error(
          total === 0
            ? `[discord-mcpl] reserved-reactions policy loaded but EMPTY: version ${compiled.version}, hash ${compiled.contentHash} — zero entries, no reaction is reserved`
            : `[discord-mcpl] reserved-reactions policy active: version ${compiled.version}, hash ${compiled.contentHash}, ` +
                `${compiled.customEmojiIds.size} custom ids, ${compiled.unicodeExact.size} exact, ${compiled.unicodeFamilies.size} families`,
        );
      }
    } catch (err) {
      // lastAttemptSig already records this file state, so the broken bytes
      // are read and parsed once, not once per reaction.
      if (this.policy) {
        // Bad rewrite of a previously good file: last-known-good, atomically.
        if (!this.staleSince) {
          this.staleSince = new Date().toISOString();
          this.logOnce(`reload failed (${(err as Error).message}): keeping last-known-good policy ${this.policy.contentHash}`);
        }
      } else {
        this.failedClosed = `${(err as Error).message}`;
        this.logOnce(`failed closed (${this.failedClosed}) — ALL model-visible reactions suppressed until repaired`);
      }
    }
    this.loadedOnce = true;
  }

  private lastLogged: string | null = null;
  private logOnce(msg: string): void {
    if (this.lastLogged === msg) return;
    this.lastLogged = msg;
    console.error(`[discord-mcpl] reserved-reactions: ${msg}`);
  }

  /** True when a configured policy could not be loaded and no known-good
   *  version exists — every model-visible reaction must be suppressed. */
  suppressAll(): boolean {
    this.ensureLoaded();
    return this.failedClosed !== null;
  }

  /** Is this reaction reserved? Custom emoji by id; unicode by exact
   *  normalized form, then by family. */
  isReserved(reaction: { emojiId?: string | null; emoji: string }): boolean {
    this.ensureLoaded();
    if (!this.policy) return false;
    if (reaction.emojiId) return this.policy.customEmojiIds.has(reaction.emojiId);
    const exact = normalizeExact(reaction.emoji);
    if (this.policy.unicodeExact.has(exact)) return true;
    return this.policy.unicodeFamilies.has(familyKey(reaction.emoji));
  }

  /** Project a reaction list for model-visible output. `unavailable` is set
   *  when suppression happened for policy-failure reasons — callers should
   *  surface a structured flag rather than an empty list that falsely
   *  means "none". */
  project<T extends { emojiId?: string | null; emoji: string }>(
    reactions: T[] | undefined,
  ): { reactions: T[]; unavailable: boolean } {
    if (this.suppressAll()) return { reactions: [], unavailable: true };
    if (!reactions || reactions.length === 0) return { reactions: reactions ?? [], unavailable: false };
    return { reactions: reactions.filter((r) => !this.isReserved(r)), unavailable: false };
  }

  status(): ReservedReactionsStatus {
    this.ensureLoaded();
    if (!this.filePath) return { state: 'unset' };
    if (this.failedClosed !== null) return { state: 'failed-closed', error: this.failedClosed };
    if (this.policy) {
      const counts = {
        customEmojiIds: this.policy.customEmojiIds.size,
        unicodeExact: this.policy.unicodeExact.size,
        unicodeFamilies: this.policy.unicodeFamilies.size,
      };
      const stale = this.staleSince ? { staleSince: this.staleSince } : {};
      if (counts.customEmojiIds + counts.unicodeExact + counts.unicodeFamilies === 0) {
        return {
          state: 'configured-empty',
          version: this.policy.version,
          contentHash: this.policy.contentHash,
          ...stale,
        };
      }
      return {
        state: 'active',
        version: this.policy.version,
        contentHash: this.policy.contentHash,
        counts,
        ...stale,
      };
    }
    // Configured, never touched yet (ensureLoaded always resolves one of the
    // above; this is unreachable in practice but type-honest).
    return { state: 'failed-closed', error: 'policy not loaded' };
  }
}
