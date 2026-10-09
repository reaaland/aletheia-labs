import type { LineItem, Order, OrderStatus } from "./orders.ts";

/**
 * The order store.
 *
 * Orders live in the process for the life of the desk — there is no database to
 * install and nothing to configure. The sample orders below are what the desk
 * opens with; "Reset demo data" puts them back.
 */

export interface OrderRow {
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

const SAMPLE_ORDERS: OrderRow[] = [
  {
    id: "ORD-1001",
    customerName: "Ada Whitfield",
    customerEmail: "ada.whitfield@example.com",
    address: "12 Mill Lane, Bristol BS1 4TR",
    items: [
      { product: "Ethiopia Guji 1kg", quantity: 2, unitPence: 1840 },
      { product: "Colombia Huila 1kg", quantity: 1, unitPence: 1620 },
      { product: "Filter papers (100)", quantity: 3, unitPence: 425 },
    ],
    discountCode: null,
    status: "confirmed",
    createdAt: "2026-08-14T09:12:00.000Z",
    confirmedAt: "2026-08-14T09:40:00.000Z",
    shippedAt: null,
    cancelledAt: null,
  },
  {
    id: "ORD-1002",
    customerName: "Marcus Bell",
    customerEmail: "marcus.bell@example.com",
    address: "8 Quay Street, Cardiff CF10 2AB",
    items: [
      { product: "Brazil Cerrado 1kg", quantity: 4, unitPence: 1560 },
      { product: "Decaf Colombia 500g", quantity: 2, unitPence: 975 },
    ],
    discountCode: "SAVE10",
    status: "draft",
    createdAt: "2026-08-28T14:05:00.000Z",
    confirmedAt: null,
    shippedAt: null,
    cancelledAt: null,
  },
  {
    id: "ORD-1003",
    customerName: "Sofia Marchetti",
    customerEmail: "sofia.marchetti@example.com",
    address: "3 Lantern Yard, Leeds LS1 5DL",
    items: [
      { product: "Sumatra Mandheling 1kg", quantity: 1, unitPence: 1785 },
      { product: "Cold brew filters", quantity: 8, unitPence: 310 },
    ],
    discountCode: null,
    status: "confirmed",
    createdAt: "2026-09-05T11:30:00.000Z",
    confirmedAt: "2026-09-05T12:02:00.000Z",
    shippedAt: null,
    cancelledAt: null,
  },
  {
    id: "ORD-1004",
    customerName: "Dev Kapoor",
    customerEmail: "dev.kapoor@example.com",
    address: "44 Bridge Road, Manchester M3 3BN",
    items: [{ product: "Kenya Nyeri 1kg", quantity: 1, unitPence: 1920 }],
    discountCode: null,
    status: "cancelled",
    createdAt: "2026-07-29T16:44:00.000Z",
    confirmedAt: "2026-07-29T17:10:00.000Z",
    shippedAt: null,
    cancelledAt: "2026-07-30T08:05:00.000Z",
  },
  {
    id: "ORD-1005",
    customerName: "Elena Petrova",
    customerEmail: "elena.petrova@example.com",
    address: "9 Harbour View, Newcastle NE1 2QT",
    items: [
      { product: "Ethiopia Guji 1kg", quantity: 1, unitPence: 1840 },
      { product: "Cold brew filters", quantity: 2, unitPence: 310 },
    ],
    discountCode: null,
    status: "shipped",
    createdAt: "2026-09-11T08:20:00.000Z",
    confirmedAt: "2026-09-11T08:45:00.000Z",
    shippedAt: "2026-09-12T07:15:00.000Z",
    cancelledAt: null,
  },
];

/**
 * An order's status follows its timeline: once cancelled it stays cancelled,
 * once shipped it stays shipped, once confirmed it stays confirmed, and
 * anything else is still a draft.
 */
function hydrate(row: OrderRow): Order {
  const status: OrderStatus = row.cancelledAt
    ? "cancelled"
    : row.shippedAt
      ? "shipped"
      : row.confirmedAt
        ? "confirmed"
        : "draft";
  return { ...row, status, items: row.items.map((item) => ({ ...item })) };
}

function clone(row: OrderRow): OrderRow {
  return { ...row, items: row.items.map((item) => ({ ...item })) };
}

export interface NewOrderInput {
  customerName: string;
  customerEmail: string;
  address: string;
}

export class OrderStore {
  private rows: OrderRow[];
  private nextNumber = 1006;

  constructor(rows: OrderRow[] = SAMPLE_ORDERS) {
    this.rows = rows.map(clone);
  }

  reset(): void {
    this.rows = SAMPLE_ORDERS.map(clone);
    this.nextNumber = 1006;
  }

  /** Every order the desk holds, newest first. */
  all(): Order[] {
    return this.rows.map(hydrate).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The list the desk works from: live orders, newest first. */
  list(): Order[] {
    return this.rows
      .filter((row) => !row.cancelledAt)
      .map(hydrate)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  byId(id: string): Order | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ? hydrate(row) : null;
  }

  create(input: NewOrderInput): Order {
    const row: OrderRow = {
      id: `ORD-${this.nextNumber++}`,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      address: input.address,
      items: [],
      discountCode: null,
      status: "draft",
      createdAt: new Date().toISOString(),
      confirmedAt: null,
      shippedAt: null,
      cancelledAt: null,
    };
    this.rows.push(row);
    return hydrate(row);
  }

  addItem(id: string, item: LineItem): Order | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    row.items.push({ ...item });
    return hydrate(row);
  }

  removeItem(id: string, position: number): Order | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    if (position < 0 || position >= row.items.length) return hydrate(row);
    row.items.splice(position, 1);
    return hydrate(row);
  }

  setDiscountCode(id: string, code: string | null): Order | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) return null;
    row.discountCode = code;
    return hydrate(row);
  }

  markShipped(id: string): Order | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.cancelledAt || row.shippedAt) return row ? hydrate(row) : null;
    row.status = "shipped";
    return hydrate(row);
  }

  cancel(id: string): Order | null {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.cancelledAt || row.shippedAt) return row ? hydrate(row) : null;
    row.status = "cancelled";
    row.cancelledAt = new Date().toISOString();
    return hydrate(row);
  }
}

export { SAMPLE_ORDERS };
