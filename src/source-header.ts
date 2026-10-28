/**
 * Labels come from Discord (guild, channel and thread names, members'
 * display names), and any of them may hold `]`, `·`, quotes, controls or
 * invisible characters: format and default-ignorable characters, and spaces
 * other than U+0020, can hide a header word, reorder the line for a human
 * reader, or make a lookalike ` / `.
 */

/**
 * Characters a reader can't see: every format character (`\p{Cf}`: zero-width
 * characters, bidi overrides and isolates) and every default-ignorable code
 * point, which adds fillers that are letters (U+3164, U+115F, U+1160, U+FFA0),
 * the combining grapheme joiner and the variation selectors. A visible
 * look-alike, such as U+2800 BRAILLE PATTERN BLANK, stays as it is.
 */
const INVISIBLE = '\\p{Cf}\\p{Default_Ignorable_Code_Point}';
// eslint-disable-next-line no-control-regex
const STRUCTURAL = /[[\]<>\u00b7"\\\u0000-\u001f\u007f-\u009f\u2028\u2029]| \/ /u;
const UNSEEN_OUTSIDE_EMOJI = new RegExp(`[${INVISIBLE}]|(?! )\\p{Zs}`, 'u');
const UNSEEN = new RegExp(`[\\u007f-\\u009f\\u2028\\u2029${INVISIBLE}]|(?! )\\p{Zs}`, 'gu');
const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}])?(?:\u{200D}\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}])?)*/gu;
const QUOTED_ESCAPES = new RegExp(`(${EMOJI_SEQUENCE.source})|${UNSEEN.source}`, 'gu');
const PLAIN_NAME = /^[\p{L}\p{M}\p{N}_.-]+(?: [\p{L}\p{M}\p{N}_.-]+)*$/u;
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_TYPE = new RegExp(`^${TOKEN}\\/${TOKEN}(?:; ?${TOKEN}=${TOKEN})*$`);
const INVISIBLE_CHARACTER = new RegExp(`[${INVISIBLE}]`, 'u');
// eslint-disable-next-line no-control-regex
const LINE_BREAK = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/g;
const GAP = `[\\s\\p{Cc}\\p{M}\\u2800${INVISIBLE}]`;
const JSON_GAP = `(?:${GAP}|\\\\[nrtbf]|\\\\u00[01][0-9a-fA-F])`;
const serverTag = (gap: string, end: string): RegExp => {
  const names = ['system', 'backscroll', 'missed'].map((name) => [...name].join(`${gap}*`));
  return new RegExp(`<(?=${gap}*(?:\\/${gap}*)?(?:${names.join('|')})(?:${gap}|${end}))`, 'giu');
};
const SERVER_TAG = serverTag(GAP, '[>/="\']|$');
const SERVER_TAG_IN_JSON = serverTag(JSON_GAP, '[>/=\'"]|\\\\"|$');

export function headerValue(value: string): string {
  return STRUCTURAL.test(value) || UNSEEN_OUTSIDE_EMOJI.test(value.replace(EMOJI_SEQUENCE, '')) ? quotedLabel(value) : value;
}

export function labelValue(label: string): string {
  return /^\s*(?:thread|reply\s+to|unscoped)(?:\s|$)/i.test(label) ? quotedLabel(label) : headerValue(label);
}

export function nameValue(name: string): string {
  return PLAIN_NAME.test(name) && !INVISIBLE_CHARACTER.test(name) ? name : quotedLabel(name);
}

export function mediaTypeValue(contentType: string): string {
  if (!contentType) return 'unknown type';
  return MEDIA_TYPE.test(contentType) ? contentType : quotedLabel(contentType);
}

// The URL parser drops line breaks and percent-encodes spaces, controls, < and
// > in an http(s) URL, but leaves [ and ] in its path, query and fragment.
export function urlValue(url: string): string {
  const parsed = URL.canParse(url) ? new URL(url) : null;
  if (parsed?.protocol !== 'https:' && parsed?.protocol !== 'http:') return quotedLabel(url);
  for (const part of ['pathname', 'search', 'hash'] as const) {
    if (/[[\]]/.test(parsed[part])) parsed[part] = parsed[part].replace(/\[/g, '%5B').replace(/]/g, '%5D');
  }
  return parsed.href;
}

export function errorValue(err: unknown): string {
  let text: string;
  try {
    const carried = (err as { message?: unknown } | null | undefined)?.message;
    text = typeof carried === 'string' && carried !== '' ? carried : String(err);
  } catch {
    text = `an unprintable ${typeof err}`;
  }
  const chars = Array.from(text);
  return quotedLabel(chars.length > 300 ? `${chars.slice(0, 299).join('')}…` : text);
}

export function senderText(text: string): string {
  return text.replace(LINE_BREAK, '\n  ').replace(SERVER_TAG, '&lt;');
}

export function agentValue(value: string): string {
  return value
    .replace(SERVER_TAG, '&lt;')
    .replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function agentJson(value: unknown): string {
  return JSON.stringify(value)
    ?.replace(SERVER_TAG_IN_JSON, '\\u003c')
    .replace(/[\u0085\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function renderSourceHeader(channelId: string, label?: string | null): string {
  return `[source: ${headerValue(channelId)}${label ? ` · ${labelValue(label)}` : ''}]`;
}

export function quotedValue(value: string): string {
  // JSON.stringify escapes the C0 controls, quotes and backslashes, but
  // leaves DEL, the C1 controls (U+0085 NEL breaks a line), U+2028 / U+2029,
  // invisible characters and non-ASCII spaces literal: escape those visibly
  // too, per UTF-16 unit, so a quoted bidi override can't reorder what
  // follows it. An emoji sequence stays as it is. JSON.parse still gives the
  // value back.
  return JSON.stringify(value).replace(
    QUOTED_ESCAPES,
    (c, emoji?: string) => emoji ?? [...Array(c.length).keys()].map((i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`).join(''),
  );
}

export function quotedLabel(value: string): string {
  return quotedValue(value).replace(/[<>]/g, (c) => (c === '<' ? '\\u003c' : '\\u003e'));
}
