import { OrderStore } from "./src/store.ts";
import { isWholeQuantity, parsePounds } from "./src/orders.ts";
import { renderDetailPage, renderErrorPage, renderListPage } from "./src/views.ts";

/** The desk listens here unless ORDER_DESK_PORT says otherwise. */
const DEFAULT_PORT = 4173;

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function htmlDocument(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const data = await request.formData();
  const fields: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    fields[key] = typeof value === "string" ? value : value.name;
  }
  return fields;
}

async function handleCreateOrder(request: Request, store: OrderStore): Promise<Response> {
  const form = await readForm(request);
  const customerName = (form.customer_name ?? "").trim();
  const customerEmail = (form.customer_email ?? "").trim();
  const address = (form.address ?? "").trim();

  const errors: string[] = [];
  if (!customerEmail.includes("@")) errors.push("A valid email is required");

  if (errors.length > 0) {
    return htmlDocument(renderListPage(store.list(), { errors, values: { name: customerName, email: customerEmail, address } }));
  }

  const order = store.create({ customerName, customerEmail, address });
  return redirect(`/orders/${order.id}`);
}

async function handleAddItem(request: Request, store: OrderStore, id: string): Promise<Response> {
  const order = store.byId(id);
  if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);

  const form = await readForm(request);
  const product = (form.product ?? "").trim();
  const quantity = (form.quantity ?? "").trim();
  const unitPrice = (form.unit_price ?? "").trim();

  const errors: string[] = [];
  if (product === "") errors.push("Product is required");
  if (!isWholeQuantity(quantity)) errors.push("Quantity must be a whole number of at least 1");
  const unitPence = parsePounds(unitPrice);
  if (unitPence === null) errors.push("Unit price must be an amount in pounds");

  if (errors.length > 0) {
    return htmlDocument(
      renderDetailPage(order, {
        addItemError: errors.join(" "),
        addItemValues: { product, quantity, unitPrice },
      }),
    );
  }

  store.addItem(id, { product, quantity: Number(quantity), unitPence: unitPence as number });
  return redirect(`/orders/${id}`);
}

async function handleRemoveItem(request: Request, store: OrderStore, id: string): Promise<Response> {
  const order = store.byId(id);
  if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);
  const form = await readForm(request);
  store.removeItem(id, Number.parseInt(form.position ?? "", 10) - 1);
  return redirect(`/orders/${id}`);
}

async function handleDiscount(request: Request, store: OrderStore, id: string): Promise<Response> {
  const order = store.byId(id);
  if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);
  const form = await readForm(request);
  const code = (form.code ?? "").trim();
  store.setDiscountCode(id, code === "" ? null : code.toUpperCase());
  return redirect(`/orders/${id}`);
}

async function handleDiscountRemove(_request: Request, store: OrderStore, id: string): Promise<Response> {
  const order = store.byId(id);
  if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);
  store.setDiscountCode(id, null);
  return redirect(`/orders/${id}`);
}

async function handleShip(request: Request, store: OrderStore, id: string): Promise<Response> {
  const order = store.byId(id);
  if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);
  store.markShipped(id);
  return redirect(`/orders/${id}`);
}

async function handleCancel(request: Request, store: OrderStore, id: string): Promise<Response> {
  const order = store.byId(id);
  if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);
  store.cancel(id);
  return redirect(`/orders/${id}`);
}

export async function handleRequest(request: Request, store: OrderStore): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const method = request.method.toUpperCase();

  if (method === "GET" && path === "/health") {
    return new Response("ok\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (method === "GET" && path === "/") {
    return htmlDocument(renderListPage(store.list()));
  }

  if (method === "POST" && path === "/orders") {
    return handleCreateOrder(request, store);
  }

  if (method === "POST" && path === "/demo/reset") {
    store.reset();
    return redirect("/");
  }

  const orderPath = path.match(/^\/orders\/(ORD-\d+)$/);
  if (orderPath) {
    const id = orderPath[1];
    if (method === "GET") {
      const order = store.byId(id);
      if (!order) return htmlDocument(renderErrorPage(`There is no order ${id}.`), 404);
      return htmlDocument(renderDetailPage(order));
    }
    if (method === "POST") return htmlDocument(renderErrorPage(`Unsupported action on ${id}.`), 405);
  }

  const itemsPath = path.match(/^\/orders\/(ORD-\d+)\/items$/);
  if (method === "POST" && itemsPath) return handleAddItem(request, store, itemsPath[1]);

  const removePath = path.match(/^\/orders\/(ORD-\d+)\/items\/remove$/);
  if (method === "POST" && removePath) return handleRemoveItem(request, store, removePath[1]);

  const discountPath = path.match(/^\/orders\/(ORD-\d+)\/discount$/);
  if (method === "POST" && discountPath) return handleDiscount(request, store, discountPath[1]);

  const discountRemovePath = path.match(/^\/orders\/(ORD-\d+)\/discount\/remove$/);
  if (method === "POST" && discountRemovePath) return handleDiscountRemove(request, store, discountRemovePath[1]);

  const shipPath = path.match(/^\/orders\/(ORD-\d+)\/ship$/);
  if (method === "POST" && shipPath) return handleShip(request, store, shipPath[1]);

  const cancelPath = path.match(/^\/orders\/(ORD-\d+)\/cancel$/);
  if (method === "POST" && cancelPath) return handleCancel(request, store, cancelPath[1]);

  return htmlDocument(renderErrorPage(`No page at ${path}.`), 404);
}

export function createServer(store: OrderStore = new OrderStore(), port = 0) {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch: (request) => handleRequest(request, store),
  });
  return { server, store, url: String(server.url).replace(/\/$/, "") };
}

if (import.meta.main) {
  const port = Number(process.env.ORDER_DESK_PORT ?? DEFAULT_PORT);
  const app = createServer(new OrderStore(), port);
  process.stdout.write(`Roastery Order Desk running at http://127.0.0.1:${app.server.port}\n`);
}
