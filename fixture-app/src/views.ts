import type { LineItem, Order } from "./orders.ts";
import { SHIPPING_PENCE, discountPence, formatPence, lineTotalPence, subtotalPence, taxPence, totalPence } from "./orders.ts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLES = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #241f1c; background: #faf7f4; }
  header { background: #2f2622; color: #f6f1ec; padding: 14px 24px; display: flex; align-items: baseline; gap: 16px; }
  header h1 { font-size: 18px; margin: 0; letter-spacing: 0.02em; }
  header p { margin: 0; font-size: 13px; opacity: 0.75; }
  main { max-width: 900px; margin: 0 auto; padding: 24px; }
  h2 { font-size: 17px; margin: 28px 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #efe8e2; font-size: 14px; }
  th { background: #f3ece6; font-weight: 600; }
  td.numeric, th.numeric { text-align: right; font-variant-numeric: tabular-nums; }
  fieldset { border: 1px solid #e2d8d0; background: #fff; padding: 14px 16px; margin: 0 0 16px; }
  legend { padding: 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b5c52; }
  label { display: block; font-size: 13px; margin: 8px 0 2px; color: #4a3f39; }
  input { font: inherit; padding: 6px 8px; border: 1px solid #cfc3ba; border-radius: 3px; width: 100%; max-width: 320px; }
  button { font: inherit; padding: 7px 14px; border: 1px solid #6b5c52; background: #fff; border-radius: 3px; cursor: pointer; margin-top: 10px; }
  button.primary { background: #2f2622; color: #f6f1ec; border-color: #2f2622; }
  .error { color: #9c2b1b; font-size: 13px; margin: 8px 0 0; }
  .totals { background: #fff; border: 1px solid #e2d8d0; padding: 12px 16px; max-width: 340px; }
  .totals div { display: flex; justify-content: space-between; padding: 3px 0; font-size: 14px; }
  .totals .grand { border-top: 1px solid #e2d8d0; margin-top: 6px; padding-top: 8px; font-weight: 700; }
  .meta { background: #fff; border: 1px solid #e2d8d0; padding: 12px 16px; margin-bottom: 16px; }
  .meta div { font-size: 14px; padding: 2px 0; }
  .meta .label { display: inline-block; width: 130px; color: #6b5c52; }
  .muted { color: #6b5c52; font-size: 13px; }
  footer { max-width: 900px; margin: 0 auto; padding: 0 24px 40px; }
  a { color: #7a3b1d; }
  .status { text-transform: capitalize; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Roastery Order Desk</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <h1>Roastery Order Desk</h1>
  <p>Wholesale orders for Cardamom Coffee Roasters</p>
</header>
<main>
${body}
</main>
<footer>
  <form method="post" action="/demo/reset">
    <button type="submit" data-testid="reset-demo-data">Reset demo data</button>
    <span class="muted">Restores the sample orders.</span>
  </form>
</footer>
</body>
</html>
`;
}

export interface ListPageOptions {
  errors?: string[];
  values?: { name?: string; email?: string; address?: string };
  notice?: string | null;
}

export function renderListPage(orders: Order[], options: ListPageOptions = {}): string {
  const rows = orders
    .map(
      (order) => `      <tr data-testid="order-row-${order.id}">
        <td><a href="/orders/${order.id}" data-testid="order-link-${order.id}">${escapeHtml(order.id)}</a></td>
        <td data-testid="order-customer-${order.id}">${escapeHtml(order.customerName)}</td>
        <td class="status" data-testid="order-status-${order.id}">${escapeHtml(order.status)}</td>
        <td class="numeric" data-testid="order-total-${order.id}">${formatPence(totalPence(order))}</td>
      </tr>`,
    )
    .join("\n");

  const errors = (options.errors ?? [])
    .map((message) => `<p class="error" data-testid="new-order-error">${escapeHtml(message)}</p>`)
    .join("\n      ");

  const body = `<h2>Orders</h2>
<table data-testid="order-list">
  <thead>
    <tr><th>Order</th><th>Customer</th><th>Status</th><th class="numeric">Total</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>

<h2>New order</h2>
<fieldset>
  <legend>New order</legend>
  <form method="post" action="/orders">
    <label for="customer_name">Customer name</label>
    <input id="customer_name" name="customer_name" data-testid="new-order-name" value="${escapeHtml(options.values?.name ?? "")}">
    <label for="customer_email">Customer email</label>
    <input id="customer_email" name="customer_email" data-testid="new-order-email" value="${escapeHtml(options.values?.email ?? "")}">
    <label for="address">Shipping address</label>
    <input id="address" name="address" data-testid="new-order-address" value="${escapeHtml(options.values?.address ?? "")}">
    <button type="submit" class="primary" data-testid="new-order-submit">Create order</button>
    ${errors}
  </form>
</fieldset>`;

  return layout("Orders", body);
}

export interface DetailPageOptions {
  addItemError?: string | null;
  discountError?: string | null;
  addItemValues?: { product?: string; quantity?: string; unitPrice?: string };
}

export function renderDetailPage(order: Order, options: DetailPageOptions = {}): string {
  const editable = order.status !== "cancelled";
  const canShip = order.status === "draft" || order.status === "confirmed";
  const discount = discountPence(order);

  const itemRows = order.items
    .map((item: LineItem, index: number) => {
      const position = index + 1;
      return `      <tr data-testid="line-item-${position}">
        <td data-testid="line-item-product-${position}">${escapeHtml(item.product)}</td>
        <td class="numeric" data-testid="line-item-quantity-${position}">${item.quantity}</td>
        <td class="numeric" data-testid="line-item-unit-price-${position}">${formatPence(item.unitPence)}</td>
        <td class="numeric" data-testid="line-item-total-${position}">${formatPence(lineTotalPence(item))}</td>
        <td>${
          editable
            ? `<form method="post" action="/orders/${order.id}/items/remove">
          <input type="hidden" name="position" value="${position}">
          <button type="submit" data-testid="remove-item-${position}">Remove</button>
        </form>`
            : ""
        }</td>
      </tr>`;
    })
    .join("\n");

  const addItemForm = editable
    ? `<fieldset>
  <legend>Add item</legend>
  <form method="post" action="/orders/${order.id}/items">
    <label for="product">Product</label>
    <input id="product" name="product" data-testid="add-item-product" value="${escapeHtml(options.addItemValues?.product ?? "")}">
    <label for="quantity">Quantity</label>
    <input id="quantity" name="quantity" data-testid="add-item-quantity" value="${escapeHtml(options.addItemValues?.quantity ?? "")}">
    <label for="unit_price">Unit price (£)</label>
    <input id="unit_price" name="unit_price" data-testid="add-item-unit-price" value="${escapeHtml(options.addItemValues?.unitPrice ?? "")}">
    <button type="submit" data-testid="add-item-submit">Add item</button>
    ${options.addItemError ? `<p class="error" data-testid="add-item-error">${escapeHtml(options.addItemError)}</p>` : ""}
  </form>
</fieldset>`
    : "";

  const discountForm = editable
    ? `<fieldset>
  <legend>Discount code</legend>
  <form method="post" action="/orders/${order.id}/discount">
    <label for="code">Code</label>
    <input id="code" name="code" data-testid="discount-code-input">
    <button type="submit" data-testid="discount-submit">Apply code</button>
    ${options.discountError ? `<p class="error" data-testid="discount-error">${escapeHtml(options.discountError)}</p>` : ""}
  </form>
  ${
    order.discountCode
      ? `<form method="post" action="/orders/${order.id}/discount/remove">
    <button type="submit" data-testid="discount-remove">Remove code</button>
  </form>`
      : ""
  }
</fieldset>`
    : "";

  const statusActions = `<fieldset>
  <legend>Status</legend>
  ${
    canShip
      ? `<form method="post" action="/orders/${order.id}/ship">
    <button type="submit" data-testid="mark-shipped">Mark shipped</button>
  </form>`
      : ""
  }
  ${
    canShip
      ? `<form method="post" action="/orders/${order.id}/cancel">
    <button type="submit" data-testid="cancel-order">Cancel order</button>
  </form>`
      : ""
  }
  ${canShip ? "" : `<p class="muted" data-testid="status-note">This order can no longer be changed.</p>`}
</fieldset>`;

  const body = `<h2>Order <span data-testid="order-id">${escapeHtml(order.id)}</span></h2>
<div class="meta">
  <div><span class="label">Customer</span> <span data-testid="order-customer">${escapeHtml(order.customerName)}</span></div>
  <div><span class="label">Email</span> <span data-testid="order-email">${escapeHtml(order.customerEmail)}</span></div>
  <div><span class="label">Address</span> <span data-testid="order-address">${escapeHtml(order.address)}</span></div>
  <div><span class="label">Status</span> <span class="status" data-testid="order-status">${escapeHtml(order.status)}</span></div>
  <div><span class="label">Created</span> <span data-testid="order-created">${escapeHtml(order.createdAt)}</span></div>
</div>

<h2>Line items</h2>
<table data-testid="line-items">
  <thead>
    <tr><th>Product</th><th class="numeric">Quantity</th><th class="numeric">Unit price</th><th class="numeric">Line total</th><th></th></tr>
  </thead>
  <tbody>
${itemRows}
  </tbody>
</table>

<h2>Totals</h2>
<div class="totals" data-testid="totals">
  <div><span>Subtotal</span> <span data-testid="subtotal">${formatPence(subtotalPence(order))}</span></div>
  <div><span>Discount${order.discountCode ? ` (<span data-testid="discount-code">${escapeHtml(order.discountCode)}</span>)` : ""}</span> <span data-testid="discount">${discount > 0 ? `-${formatPence(discount)}` : formatPence(0)}</span></div>
  <div><span>Shipping</span> <span data-testid="shipping">${formatPence(SHIPPING_PENCE)}</span></div>
  <div><span>Tax (8.5%)</span> <span data-testid="tax">${formatPence(taxPence(order))}</span></div>
  <div class="grand"><span>Total</span> <span data-testid="total">${formatPence(totalPence(order))}</span></div>
</div>

${addItemForm}
${discountForm}
${statusActions}

<p><a href="/" data-testid="back-to-orders">Back to orders</a></p>`;

  return layout(`Order ${order.id}`, body);
}

export function renderErrorPage(message: string): string {
  return layout("Not found", `<h2>Not found</h2>\n<p data-testid="error-message">${escapeHtml(message)}</p>\n<p><a href="/">Back to orders</a></p>`);
}
