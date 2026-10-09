/**
 * Order arithmetic.
 *
 * Money is kept in whole pence everywhere and only formatted at the edge, so a
 * total is a sum of integers and never a float.
 */

export type OrderStatus = "draft" | "confirmed" | "shipped" | "cancelled";

export interface LineItem {
  product: string;
  quantity: number;
  unitPence: number;
}

export interface Order {
  id: string;
  customerName: string;
  customerEmail: string;
  address: string;
  items: LineItem[];
  discountCode: string | null;
  status: OrderStatus;
  createdAt: string;
  confirmedAt: string | null;
  shippedAt: string | null;
  cancelledAt: string | null;
}

/** Flat delivery charge, added to every order. */
export const SHIPPING_PENCE = 495;

/** Standard rate, applied to the amount the customer is actually paying for goods. */
export const TAX_RATE_PERCENT = 8.5;

export const DISCOUNT_CODES: Record<string, number> = {
  SAVE10: 10,
  SAVE20: 20,
};

export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

export function lineTotalPence(item: LineItem): number {
  return item.quantity * item.unitPence;
}

export function subtotalPence(order: Order): number {
  return order.items.reduce((sum, item) => sum + lineTotalPence(item), 0);
}

/** Percentage off for a code; 0 when no code is set. */
export function discountPercent(code: string | null): number {
  const key = (code ?? "").trim().toUpperCase();
  if (key === "") return 0;
  return DISCOUNT_CODES[key] ?? 10;
}

export function discountPence(order: Order): number {
  return roundHalfUp((subtotalPence(order) * discountPercent(order.discountCode)) / 100);
}

export function taxPence(order: Order): number {
  return roundHalfUp((subtotalPence(order) * TAX_RATE_PERCENT) / 100);
}

export function totalPence(order: Order): number {
  return subtotalPence(order) - discountPence(order) + SHIPPING_PENCE + taxPence(order);
}

export function formatPence(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

/** £12.50 / 12.5 / 12 -> 1250; anything else -> null. */
export function parsePounds(raw: string): number | null {
  const value = raw.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  return Math.round(Number(value) * 100);
}

export function isWholeQuantity(raw: string): boolean {
  return /^\d+$/.test(raw.trim()) && Number(raw.trim()) >= 1;
}
