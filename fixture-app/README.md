# Roastery Order Desk

A small order desk for a wholesale coffee roastery: wholesale orders for Cardamom Coffee
Roasters, with line items, discount codes, shipping, tax and order status.

The behaviour this application is built to is written down in [REQUIREMENTS.md](REQUIREMENTS.md).

## Running it

```sh
bun run start
```

The desk is then at <http://127.0.0.1:4173>. Set `ORDER_DESK_PORT` to listen somewhere else
(`ORDER_DESK_PORT=5000 bun run start`).

Nothing to install, no account, no API key: the whole application is Bun's built-in HTTP
server and the three files in `src/`.

## Using it

* `/` is the order list, with the "New order" form underneath it.
* Clicking an order id opens the order: its line items, its totals, the add-item form, the
  discount code form and the status buttons.
* The "Reset demo data" button at the bottom of the list restores the sample orders. The
  samples live in memory only, so restarting the server has the same effect.
* `/health` answers `ok` — used to check the desk is up.

## Tests

```sh
bun test
```

The suite starts the desk on a spare port and drives it over HTTP, alongside unit tests for
the order arithmetic.

## Layout

```
server.ts        routes and form handling
src/orders.ts    line totals, subtotal, discount, shipping, tax, total
src/store.ts     the orders, the sample data and the operations on them
src/views.ts     the two pages, as HTML
tests/           the test suite
REQUIREMENTS.md  the agreed behaviour
```
