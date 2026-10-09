# Roastery Order Desk — Requirements

**Document version:** 1.0
**Date:** 2026-06-02
**Owner:** Priya Raman, Roastery Operations
**Status:** approved for build

This is the agreed description of how the Order Desk must behave. Each numbered item is
something we will check by using the application.

## 1. Order list

1.1 The order list is the application's home page, at `/`.
1.2 The order list shows every order that has been created, including orders that have been
cancelled, with the order id, the customer name, the status and the total.
1.3 Cancelled orders are removed from the order list.
1.4 The list is ordered with the most recently created order first.
1.5 The order id in each row is a link to that order's own page.
1.6 The total shown in a row is the same total that appears on that order's own page.

## 2. Creating an order

2.1 The home page has a "New order" form with a customer name, a customer email and a
shipping address, submitted with a button labelled "Create order".
2.2 If the customer name is empty when the form is submitted, the page shows the message
`Customer name is required` by the form and no order is created.
2.3 If the customer email is empty or does not contain an `@`, the page shows the message
`A valid email is required` by the form and no order is created.
2.4 An order created through the form starts as a draft, with no line items and no discount
code.

## 3. Line items

3.1 An order's own page lists its line items, each showing the product, the quantity, the
unit price and the line total (quantity × unit price).
3.2 A line item is added from the order's page using the "Add item" form — product,
quantity and unit price in pounds — and appears at the bottom of the list of line items.
3.3 If the quantity is not a whole number of at least 1, the page shows the message
`Quantity must be a whole number of at least 1` and no line item is added.
3.4 Each line item has a "Remove" button, and removing a line item recalculates the
subtotal.
3.5 Removing a line item must not change the order total.

## 4. Amounts

4.1 All amounts are shown in pounds sterling with two decimal places and a `£` sign.
4.2 The subtotal is the sum of the line totals of the order's line items.
4.3 Shipping is £4.95 per order.
4.4 Shipping is charged per line item at £1.95 each, so an order with three line items pays
£5.85.
4.5 Tax is 8.5% of the subtotal after the discount has been taken off, rounded to the
nearest penny.
4.6 The total is the subtotal, minus the discount, plus shipping, plus tax.
4.7 An order's page shows the subtotal, the discount, the shipping, the tax and the total as
separate lines.

## 5. Discount codes

5.1 The discount code field accepts `SAVE10` (10% off the subtotal) and `SAVE20` (20% off
the subtotal). The discount is rounded to the nearest penny.
5.2 Any other code is rejected: no discount is applied, the code is not saved, and the page
shows the message `That code is not valid`.
5.3 A saved discount code is shown next to the discount line.
5.4 A saved discount code can be removed with the "Remove code" button, which restores the
full subtotal.

## 6. Order status

6.1 An order's status is one of `draft`, `confirmed`, `shipped` or `cancelled`.
6.2 A "Mark shipped" button is shown on draft and confirmed orders.
6.3 Once an order has been marked as shipped, every later view of that order shows the
status `shipped`, and the "Mark shipped" button is not shown.
6.4 A draft or confirmed order can be cancelled with the "Cancel order" button, which sets
the status to `cancelled`.
6.5 A cancelled order cannot be edited: the "Add item" form and the discount form are not
shown, and the "Mark shipped" button is not shown.

---

Behaviour that is not described above is left to the build team's judgement.
