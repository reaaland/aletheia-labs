import { describe, expect, test } from "bun:test";
import { OrderStore } from "../src/store.ts";
import {
  SHIPPING_PENCE,
  discountPence,
  formatPence,
  isWholeQuantity,
  lineTotalPence,
  parsePounds,
  subtotalPence,
} from "../src/orders.ts";
import { renderDetailPage } from "../src/views.ts";

describe("order arithmetic", () => {
  test("the subtotal is the sum of the line totals", () => {
    const order = new OrderStore().byId("ORD-1001")!;
    const expected = order.items.reduce((sum, item) => sum + lineTotalPence(item), 0);
    expect(subtotalPence(order)).toBe(6575);
    expect(subtotalPence(order)).toBe(expected);
    expect(formatPence(subtotalPence(order))).toBe("£65.75");
  });

  test("shipping is a flat £4.95 on every order", () => {
    expect(SHIPPING_PENCE).toBe(495);
    const store = new OrderStore();
    for (const id of ["ORD-1001", "ORD-1003", "ORD-1005"]) {
      const page = renderDetailPage(store.byId(id)!);
      expect(page).toMatch(/data-testid="shipping">£4\.95</);
    }
  });

  test("a discount code takes its percentage off the subtotal", () => {
    const store = new OrderStore();
    const tenPercent = store.byId("ORD-1002")!;
    expect(tenPercent.discountCode).toBe("SAVE10");
    expect(discountPence(tenPercent)).toBe(819);

    const twentyPercent = store.setDiscountCode("ORD-1001", "SAVE20")!;
    expect(discountPence(twentyPercent)).toBe(1315);
  });

  test("no code means no discount", () => {
    const order = new OrderStore().byId("ORD-1003")!;
    expect(order.discountCode).toBeNull();
    expect(discountPence(order)).toBe(0);
  });

  test("amounts are formatted in pounds with two decimals", () => {
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(5123)).toBe("£51.23");
    expect(formatPence(2460)).toBe("£24.60");
  });

  test("prices and quantities are read from the form", () => {
    expect(parsePounds("12.50")).toBe(1250);
    expect(parsePounds("12.5")).toBe(1250);
    expect(parsePounds("12")).toBe(1200);
    expect(parsePounds("twelve")).toBeNull();
    expect(isWholeQuantity("3")).toBe(true);
    expect(isWholeQuantity("0")).toBe(false);
    expect(isWholeQuantity("2.5")).toBe(false);
  });
});

describe("the store", () => {
  test("the list keeps live orders, newest first", () => {
    const list = new OrderStore().list();
    expect(list.map((order) => order.id)).toEqual(["ORD-1005", "ORD-1003", "ORD-1002", "ORD-1001"]);
  });

  test("an order is created as a draft with no items and no code", () => {
    const store = new OrderStore();
    const order = store.create({ customerName: "Jo Blake", customerEmail: "jo@example.com", address: "1 High Street" });
    expect(order.id).toBe("ORD-1006");
    expect(order.status).toBe("draft");
    expect(order.items).toEqual([]);
    expect(order.discountCode).toBeNull();
  });
});
