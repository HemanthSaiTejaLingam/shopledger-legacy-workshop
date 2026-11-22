var assert = require('node:assert/strict');
var test = require('node:test');
var invoice = require('../lib/invoice');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');

function billedOrder(items, coupon) {
  var billed = pricing.computeTotals(items, coupon);
  return {
    id: 101,
    status: 'completed',
    items: items,
    coupon: coupon || '',
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  };
}

function mixedSlabOrder() {
  return billedOrder([
    { name: 'Rice', price: 600, qty: 2, hsn: '1006' },
    { name: 'Ghee', price: 800, qty: 1, hsn: '0405' }
  ], 'SAVE10');
}

test('invoice shows the billed total and GST for a mixed-slab order with a capped coupon', function () {
  var order = mixedSlabOrder();
  var printed = invoice.computeInvoiceFigures(order);
  var html = invoice.render(order);

  assert.deepEqual(
    [printed.total, printed.discount, printed.tax, printed.cgst, printed.sgst],
    [1994.3, 150, 144.3, 72.15, 72.15]
  );
  assert.deepEqual(printed.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 55.5], [12, 88.8]]);
  assert.match(html, /Invoice Total<\/td><td[^>]*>[^<]*1994\.30<\/td>/);
  assert.match(html, /CGST<\/td><td[^>]*>[^<]*72\.15<\/td>/);
  assert.match(html, /SGST<\/td><td[^>]*>[^<]*72\.15<\/td>/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>[^<]*144\.30<\/td>/);
});

test('billing and invoicing agree for a default-rate order without a coupon', function () {
  var order = billedOrder([{ name: 'Item', price: 100, qty: 2 }]);
  var printed = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 36);
  assert.equal(order.total, 236);
  assert.equal(printed.tax, 36);
  assert.equal(printed.cgst, 18);
  assert.equal(printed.sgst, 18);
  assert.equal(printed.total, 236);
});

test('billing apportions the capped discount before applying the HSN slabs', function () {
  var order = mixedSlabOrder();
  var billed = pricing.computeTotals(order.items, order.coupon);

  assert.deepEqual(billed.lines.map(function (line) {
    return [line.gstPercent, line.discount, line.taxable, line.tax];
  }), [[5, 90, 1110, 55.5], [12, 60, 740, 88.8]]);
  assert.deepEqual(
    [order.subtotal, order.discount, order.tax, billed.cgst, billed.sgst, order.total],
    [2000, 150, 144.3, 72.15, 72.15, 1994.3]
  );

});

test('invoice GST reflects the reduced taxable value after a flat coupon', function () {
  var order = billedOrder([{ name: 'Item', price: 300, qty: 1 }], 'FLAT50');
  var printed = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 45, 295]);
  assert.deepEqual([printed.discount, printed.tax, printed.total], [50, 45, 295]);
  assert.equal(printed.rows[0].lineTax, 45);
});

test('invoice handles decimal, zero, and percentage GST rates the same way as billing', function () {
  var order = billedOrder([
    { name: 'Decimal rate', price: 100, qty: 1, gstRate: 0.05 },
    { name: 'Zero rate', price: 100, qty: 1, gstRate: 0 },
    { name: 'Percentage rate', price: 100, qty: 1, gstRate: 12 }
  ]);
  var printed = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 17);
  assert.deepEqual(printed.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[5, 5], [0, 0], [12, 12]]);
  assert.equal(printed.tax, 17);
});

test('invoice GST sums the same rounded line amounts as billing', function () {
  var order = billedOrder([
    { name: 'First item', price: 0.03, qty: 1 },
    { name: 'Second item', price: 0.03, qty: 1 }
  ]);
  var printed = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual(printed.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([printed.tax, printed.cgst, printed.sgst, printed.total], [0.02, 0.01, 0.01, 0.08]);
});

test('legacy invoices keep stored amounts and omit line GST when it cannot be reconstructed', function () {
  var order = Object.assign(mixedSlabOrder(), { discount: 0, tax: 0, total: 2000 });
  var printed = invoice.computeInvoiceFigures(order);
  var html = invoice.render(order);

  assert.deepEqual([printed.discount, printed.tax, printed.cgst, printed.sgst, printed.total], [0, 0, 0, 0, 2000]);
  assert.deepEqual(printed.rows.map(function (row) {
    return [row.gstPercent, row.lineTax];
  }), [[null, null], [null, null]]);
  assert.match(html, /GST by item is unavailable for this order/);
});

test('reconciliation reports matching billed and invoice figures and skips cancelled orders', function () {
  var order = mixedSlabOrder();
  var cancelled = Object.assign({}, order, { id: 102, status: 'cancelled' });
  var reconciliation = reports.getGstReconciliation({ orders: [order, cancelled] });

  assert.equal(reconciliation.totalChecked, 1);
  assert.equal(reconciliation.mismatchCount, 0);
  assert.equal(reconciliation.totalDelta, 0);
  assert.deepEqual(reconciliation.rows.map(function (row) {
    return [row.orderId, row.ledgerTax, row.invoiceTax, row.delta, row.matched];
  }), [[101, 144.3, 144.3, 0, true]]);
});
