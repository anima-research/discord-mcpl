import { formatAgentDateTime, type TimestampStyle } from './timezone.js';

/** A message delivered more than this after Discord says it was sent is a
 *  late delivery (reconnect catch-up, a restored range, a delayed queue). */
export const LATE_DELIVERY_THRESHOLD_MS = 2 * 60 * 1000;

export function isLateDelivery(sent: Date, received: Date, thresholdMs: number = LATE_DELIVERY_THRESHOLD_MS): boolean {
  return received.getTime() - sent.getTime() > thresholdMs;
}

export function deliveryTime(d: Date, timeZone: string, style: TimestampStyle): string {
  return formatAgentDateTime(d, timeZone, style === 'time' ? 'compact' : style) || d.toISOString();
}

export function receivedAttribute(d: Date, timeZone: string, style: TimestampStyle): string {
  const shown = formatAgentDateTime(d, timeZone, style);
  return shown ? `received="${shown}"` : '';
}

/** The line shown above a late message so it can't read as just-arrived:
 *  `[delayed delivery · sent <t> · received <t>]`, or '' when on time. */
export function lateDeliveryLine(
  sent: Date,
  received: Date,
  timeZone: string,
  style: TimestampStyle,
  thresholdMs: number = LATE_DELIVERY_THRESHOLD_MS,
  what: 'delayed delivery' | 'edit of a late delivery' = 'delayed delivery',
): string {
  if (!isLateDelivery(sent, received, thresholdMs)) return '';
  return `[${what} · sent ${deliveryTime(sent, timeZone, style)} · received ${deliveryTime(received, timeZone, style)}]\n`;
}
