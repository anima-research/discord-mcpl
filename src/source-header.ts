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
const STRUCTURAL = /[[\]\u00b7"\\\u0000-\u001f\u007f-\u009f\u2028\u2029]| \/ /u;
const UNSEEN_OUTSIDE_EMOJI = new RegExp(`[${INVISIBLE}]|(?! )\\p{Zs}`, 'u');
const UNSEEN = new RegExp(`[\\u007f-\\u009f\\u2028\\u2029${INVISIBLE}]|(?! )\\p{Zs}`, 'gu');
const EMOJI_SEQUENCE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}])?(?:\u{200D}\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}])?)*/gu;
const QUOTED_ESCAPES = new RegExp(`(${EMOJI_SEQUENCE.source})|${UNSEEN.source}`, 'gu');

export function headerValue(value: string): string {
  return STRUCTURAL.test(value) || UNSEEN_OUTSIDE_EMOJI.test(value.replace(EMOJI_SEQUENCE, '')) ? quotedValue(value) : value;
}

export function labelValue(label: string): string {
  return /^\s*(?:thread|reply\s+to|unscoped)(?:\s|$)/i.test(label) ? quotedValue(label) : headerValue(label);
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
