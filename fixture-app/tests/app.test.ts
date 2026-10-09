import { describe, expect, test } from "bun:test";
import { createServer } from "../server.ts";
import { OrderStore } from "../src/store.ts";

async function withApp(run: (base: string) => Promise<void>): Promise<void> {
  const app = createServer(new OrderStore(), 0);
  try {
    await run(app.url);
  } finally {
    app.server.stop(true);
  }
}

function post(base: string, path: string, fields: Record<string, string>, redirect: "follow" | "manual" = "follow"): Promise<Response> {
  return fetch(new URL(path, base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
    redirect,
  });
}

describe("the order list", () => {
  test("shows the live orders newest first, each linking to its order", async () => {
    await withApp(async (base) => {
      const body = await (await fetch(new URL("/", base))).text();
      const order = ["ORD-1005", "ORD-1003", "ORD-1002", "ORD-1001"];
      const positions = order.map((id) => body.indexOf(`order-row-${id}`));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(body).toContain('href="/orders/ORD-1001"');
    });
  });

  test("a new order appears at the top of the list", async () => {
    await withApp(async (base) => {
      const created = await post(base, "/orders", {
        customer_name: "Jo Blake",
        customer_email: "jo.blake@example.com",
        address: "1 High Street",
      });
      const detail = await created.text();
      expect(detail).toContain("Jo Blake");

      const list = await (await fetch(new URL("/", base))).text();
      expect(list.indexOf("Jo Blake")).toBeLessThan(list.indexOf("ORD-1005"));
    });
  });

  test("an order without a usable email is refused", async () => {
    await withApp(async (base) => {
      const response = await post(base, "/orders", { customer_name: "Jo Blake", customer_email: "no-at-sign", address: "1 High Street" });
      const body = await response.text();
      expect(body).toContain("A valid email is required");
      const rows = (body.match(/order-row-/g) ?? []).length;
      expect(rows).toBe(4);
    });
  });

  test("an order submitted without a customer name is handled without an error", async () => {
    await withApp(async (base) => {
      const response = await post(base, "/orders", {
        customer_name: "",
        customer_email: "ada@example.com",
        address: "12 Mill Lane",
      });
      expect(response.status).not.toBe(500);
    });
  });
});

describe("line items", () => {
  test("adding a line item recalculates the subtotal", async () => {
    await withApp(async (base) => {
      const body = await (
        await post(base, "/orders/ORD-1003/items", { product: "House blend 1kg", quantity: "1", unit_price: "12.50" })
      ).text();
      expect(body).toContain("House blend 1kg");
      expect(body).toContain('data-testid="subtotal">£55.15<');
    });
  });

  test("a quantity that is not a whole number of at least 1 is refused", async () => {
    await withApp(async (base) => {
      const body = await (await post(base, "/orders/ORD-1003/items", { product: "House blend 1kg", quantity: "0", unit_price: "12.50" })).text();
      expect(body).toContain("Quantity must be a whole number of at least 1");
      expect(body).not.toContain("House blend 1kg</td>");
    });
  });

  test("removing a line item takes its line total off the subtotal", async () => {
    await withApp(async (base) => {
      const body = await (await post(base, "/orders/ORD-1003/items/remove", { position: "2" })).text();
      expect(body).not.toContain("Cold brew filters");
      expect(body).toContain('data-testid="subtotal">£17.85<');
    });
  });
});

describe("discount codes", () => {
  test("SAVE20 takes twenty percent off the subtotal", async () => {
    await withApp(async (base) => {
      const body = await (await post(base, "/orders/ORD-1001/discount", { code: "SAVE20" })).text();
      expect(body).toContain('data-testid="discount-code">SAVE20<');
      expect(body).toContain('data-testid="discount">-£13.15<');
    });
  });

  test("an unknown discount code leaves the order page intact", async () => {
    await withApp(async (base) => {
      const body = await (await post(base, "/orders/ORD-1001/discount", { code: "NOTACODE" })).text();
      expect(body).toContain("Discount");
    });
  });

  test("removing the code puts the subtotal back", async () => {
    await withApp(async (base) => {
      const body = await (await post(base, "/orders/ORD-1002/discount/remove", {})).text();
      expect(body).toContain('data-testid="discount">£0.00<');
      expect(body).toContain('data-testid="subtotal">£81.90<');
    });
  });
});

describe("order status", () => {
  test("marking an order shipped redirects to the order page", async () => {
    await withApp(async (base) => {
      const response = await post(base, "/orders/ORD-1002/ship", {}, "manual");
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/orders/ORD-1002");
    });
  });

  test("cancelling an order takes it off the list", async () => {
    await withApp(async (base) => {
      const detail = await (await post(base, "/orders/ORD-1001/cancel", {})).text();
      expect(detail).toContain('data-testid="order-status">cancelled<');
      const list = await (await fetch(new URL("/", base))).text();
      expect(list).not.toContain("ORD-1001");
    });
  });

  test("the sample orders can be restored", async () => {
    await withApp(async (base) => {
      await post(base, "/orders/ORD-1001/cancel", {});
      const body = await (await post(base, "/demo/reset", {})).text();
      expect(body).toContain("ORD-1001");
      expect((body.match(/order-row-/g) ?? []).length).toBe(4);
    });
  });
});
