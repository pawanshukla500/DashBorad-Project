# Marketplace Data Upload Specification & System Architecture

This document is the **single source of truth** for all data upload pipelines, validations, parameter logic, database schemas, and edge cases across every supported marketplace in the **DashBorad Project**.

All autonomous agents, engineers, and data pipelines must conform to the logic, table mappings, and validation contracts documented here.

---

## 1. System-Wide Ingestion Architecture

The ingestion architecture standardizes file parsing, validation, batch processing, logging, and downstream rollups across all marketplaces.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             Client Upload (UI / API)                             │
│                  Multipart Form: file, columnMap, parameters                     │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      Validation & Pre-Flight Checks                              │
│   • Auth & Mutation Guard (Firebase / Session)                                   │
│   • Database Readiness Guard (isDbConfigured / databaseSchemaReady)              │
│   • File Structure & Header Validation (Layout & Required Columns)               │
│   • Account Matching Guard (e.g. Myntra EJ 45833 vs VB 10708)                    │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      Parsing & Field Normalization                               │
│   • Date Normalizer (MDY vs DMY inference, epoch 1970 fallbacks)                 │
│   • Currency / Money Parsers (symbol stripping, negative credit handling)        │
│   • Identity Cleaners (leading apostrophe removal, case normalization)            │
│   • Column Mapping (user-mapped or auto-detected headers)                        │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      Batched Database Ingestion                                  │
│   • Database batching via forEachDbBatch (prevents PG 65,535 param limit)        │
│   • Atomic transactions & conflict handling (ON CONFLICT DO UPDATE / REPLACE)    │
│   • Detailed raw table + normalized summary table dual-write                     │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                      Post-Ingest Rollups & Notifications                         │
│   • Refresh order_settlement_totals                                              │
│   • Refresh marketplace reporting rollups (Amazon / Myntra)                      │
│   • Invalidate dashboard aggregate cache & SKU benchmark cache                   │
│   • Record to upload_log and save malformed rows to upload_skipped_rows          │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Standard API Response Schema
Every upload endpoint returns a structured JSON payload:
```json
{
  "ok": true,
  "marketplace": "flipkart | myntra | amazon | meesho",
  "seller_account": "myntra_ej | myntra_vb | default",
  "inserted": 1250,
  "updated": 45,
  "skipped": 2,
  "total": 1297,
  "logId": 482,
  "batch": "2026-09-10T19-30-00-000Z"
}
```

### 1.2 Centralized Audit & Error Logging
- **`upload_log` Table**: Every upload attempt (successful or errored) writes a record containing `id`, `upload_type`, `filename`, `marketplace`, `records_inserted`, `records_updated`, `records_skipped`, `status` (`'ok'` or `'error'`), `error_message`, and `uploaded_at`.
- **`upload_skipped_rows` Table**: Any row failing validation is skipped without crashing the entire batch (unless an account or layout guard fails). Skipped rows record `upload_log_id`, `row_num`, `skip_reason`, and full original row data in `raw_json`.
- **Skipped Rows API**: `GET /api/upload/log/:id/skipped?page=1&pageSize=100` allows operators to inspect and export rejected rows directly in the Data Hub UI.

---

## 2. Flipkart Data Ingestion Pipeline

Flipkart ingestion handles three primary datasets: Orders, Returns, and the comprehensive multi-sheet Settlement Report.

### 2.1 Flipkart Orders
- **Route**: `POST /api/upload/orders`
- **Parameters**: `marketplace = "flipkart"`, `file` (multipart), `columnMap` (JSON string).
- **Target Table**: `orders` (upsert on `(marketplace, seller_account, order_item_id)`).
- **Required Columns / Alternatives**:
  - `Order Item ID`
  - `Order ID`
  - `Order Date`
  - `QTY` (or `Qty`)
  - `Amount` (or `Final Invoice Amount`)
- **Full Standard Template Headers**:
  `Order ID`, `Order Item ID`, `FSN`, `SKU`, `Selling Channel`, `Category`, `Brand`, `HSN Code`, `Order Type`, `Fulfilment Type`, `Order Date`, `QTY`, `Amount`, `Customer's Delivery State`, `Customer's Delivery Pincode`, `Warehouse ID`, `Warehouse City`.
- **Validation Rules**:
  - `order_id` and `order_item_id` must not be blank.
  - `order_date` must parse to a valid SQL date (`YYYY-MM-DD`).
  - `QTY` must be a positive integer `>= 1`.
  - `Amount` must be a valid numeric value.

### 2.2 Flipkart Returns
- **Route**: `POST /api/upload/returns`
- **Parameters**: `marketplace = "flipkart"`, `file` (multipart), `columnMap` (JSON string).
- **Target Table**: `returns` (upsert on `(marketplace, seller_account, order_item_id)`).
- **Required Columns / Alternatives**: `return_id` OR `order_item_id`.
- **Synthetic Key Fallback**: If `order_item_id` is missing but `return_id` is present, the system synthesizes `order_item_id = 'RET_' + return_id`.
- **Upsert Guard**: Only updates an existing return record if `EXCLUDED.return_requested_date > returns.return_requested_date` or if existing return was marked `cancelled` and incoming is not cancelled.
- **Physical Verification Headers**:
  `primary_pv_output`, `detailed_pv_output`, `final_condition_of_returned_product`, `tech_visit_sla`, `return_completion_type`.

### 2.3 Flipkart Multi-Sheet Settlement Report
- **Route**: `POST /api/upload/flipkart-settlement`
- **Architecture**: Asynchronous background worker. Responds immediately with `{ jobId, status: "started" }`. Client polls progress via `GET /api/upload/flipkart-settlement/progress/:jobId`.
- **Atomic Replacement by NEFT**: To guarantee data integrity and allow clean re-uploads, all rows in the destination tables belonging to any `neft_id` found in the file are deleted before inserting the new batch (`deleteByNeftIds`).
- **Processed Sheets**:
  1. **`Orders` Sheet**:
     - Target: `fk_settlement_orders` (60+ itemized deduction columns).
     - Extracts: `neft_id`, `payment_date`, `bank_settlement`, `sale_amount`, `marketplace_fee`, `taxes`, `commission`, `fixed_fee`, `collection_fee`, `pick_pack_fee`, `shipping_fee`, `reverse_shipping`, `tcs`, `tds`, `gst_on_mp_fees`, `dead_weight`, `chargeable_weight_slab`, etc.
     - **Unknown Column Detection**: Scans headers against `ORDERS_KNOWN_PREFIXES`. If Flipkart adds a new unexpected deduction column, it is captured in `newColumnsFound` and logged.
     - Downstream: Triggers `refreshOrderSettlementTotals(client)`.
  2. **`Non_Order_SPF` Sheet**:
     - Target: `fk_spf_claims`.
     - Unique constraint: composite `UNIQUE(claim_id, neft_id)` (Flipkart frequently reuses claim IDs across deduction and credit cycles).
  3. **`Storage_Recall` Sheet**:
     - Target: `fk_storage_recall`.
     - Captures warehouse storage units, regular storage fees, removal fees, and GST.
  4. **`Ads` Sheet**:
     - Target: `fk_ads`.
     - Tracks campaign IDs, wallet redemptions, top-ups, refunds, and GST on ads.
  5. **`Google Ads Services` Sheet**:
     - Target: `fk_google_ads`.
     - Tracks external Google Ads billing, service order IDs, service amounts, and GST.
- **Ignored / Informational Sheets**: `MP Fee Rebate`, `Value Added Services`, `TCS_Recovery`, `TDS`, `GST_Details`, `Report Help`, `Summary of report`.
- **Post-Upload Triggers**: Clears SKU benchmark cache and triggers `notifySkuSettlementBenchmarkAfterImport(pool, 'flipkart')`.

---

## 3. Myntra Data Ingestion Pipeline (EJ vs VB)

Myntra processes orders and returns via dedicated layouts and payments via the SOR invoice/settlement importer.

### 3.1 Strict Account Separation Contract
The business operates two distinct Myntra seller accounts:
- **Myntra VB (`myntra_vb`)**: Seller ID `10708`
- **Myntra EJ (`myntra_ej`)**: Seller ID `45833`

#### Enforcement Rules:
1. **Selection Requirement**: Every Myntra upload request must explicitly supply `seller_account = 'myntra_ej'` or `'myntra_vb'`.
2. **Account Guard Validation (`validateSellerIds` & `validateMyntraInvoiceSellerIds`)**:
   - Inspects the `seller id` / `seller_id` column of every row in the uploaded file.
   - If a file uploaded under `myntra_ej` contains Seller ID `10708` (or vice versa), the upload is **immediately rejected with HTTP 400**.
   - Zero rows are saved to the database.
   - The error message specifically informs the user: *"Wrong Myntra account selected. Myntra (EJ) accepts seller ID 45833, but rows contain 10708. This appears to be the Myntra (VB) file. No data was saved."*

### 3.2 Myntra Orders
- **Route**: `POST /api/upload/myntra/orders?seller_account=myntra_ej|myntra_vb`
- **Layout Validation**: Headers must contain `order release id`, `order line id`, `po_type`, `created on`.
- **Primary & Natural Keys**:
  - `Order Release ID` is the customer order ID (`orders.order_id`).
  - `Order Line ID` is the unique order item code (`orders.order_item_id`).
- **Fulfillment Mapping**:
  - `po_type = 'PPMP'` is classified as **`Non-FBM`**.
  - All other PO types are classified as **`FBM`**.
- **Blank Tracking Number & Synthesized Return Rule**:
  - When `order tracking number` is empty or blank:
    1. Order in `orders` is marked with `orders_status = 'Cancelled'` and `return_type = 'Courier Return'`.
    2. A synthesized return row is automatically generated and inserted into `returns` with:
       - `return_id = 'RTO-' + order_line_id`
       - `order_item_id = order_line_id`
       - `return_reason = 'Cancel Before Dispached'`
       - `return_type = 'Courier Return'`
       - `return_status = 'Cancelled'`
       - `return_requested_date = cancelled_on || created_on`
- **Dual Table Ingestion**:
  1. `myntra_order_details`: Full 46-column audit record (`seller_account`, `order_line_id`, `order_release_id`, `store_order_id`, `style_id`, `vendor_article_number`, `brand`, `final_amount`, `seller_price`, raw `source_data` JSONB).
  2. `orders`: Normalized ledger record with unified column naming.
- **Post-Upload Hooks**:
  - `backfillOrdersFromMyntraPayment(pool, sellerAccount)`
  - `refreshOrderSettlementTotals(pool)`

### 3.3 Myntra Returns
- **Route**: `POST /api/upload/myntra/returns?seller_account=myntra_ej|myntra_vb`
- **Layout Validation**: Headers must contain `order_id`, `order_line_id`, `type`, `return_created_date`.
- **Date Fallback Logic (`resolveReturnCreatedDate`)**:
  - If `return_created_date` is empty OR contains the 1970 epoch placeholder (`<= 1970-01-05`), or if `type` is `RTO`:
  - The system inspects `order_rto_date`. If valid, `order_rto_date` is used as the official return created date.
- **Dual Table Ingestion**:
  1. `myntra_return_details`: Stores comprehensive operational logistics data including `partner_warehouse_code`, `warehouse_id`, `store_packet_id`, `forward_tracking_number`, `return_tracking_number`, `gatepass_id`, `gatepass_status`, `lmdo_status`.
  2. `returns`: Normalized return ledger record.
- **Order State Synchronization**:
  - Executes immediate cross-table update on `orders`:
    - Updates `return_type`.
    - Updates `orders_status`: `'Cancelled'` if return reason is 'Cancel Before Dispached', `'RTO'` if return type is RTO, `'Return Orders'` if customer return.

### 3.4 Myntra Payments / Invoices (SOR Settlement) & NOD
- **Route**: `POST /api/mp-settlement/invoices/upload?marketplace=myntra&seller_account=myntra_ej|myntra_vb`
- **Layout Nuances**:
  - **Date Format**: Myntra payment exports output dates in `M/D/YY` format (e.g., `4/2/26` for April 2, 2026). Parser tests MDY first to avoid swapping day and month.
  - **Apostrophe Stripping**: Excel prepends leading apostrophes to large IDs (`'132509375680735653501`). `stripIdApostrophe` sanitizes all IDs.
  - **Unique Deduplication Hash (`source_fingerprint`)**: MD5 hash generated from `[marketplace, sellerAccount, invoiceNumber, invoiceDate, sku, paymentReference, orderType, orderLineId, returnId]`. Prevents constraint collisions when forward orders, reverse returns, and multiple NEFT cycles share identical store order IDs.
- **Fee Extraction & GST-Exclusive Separation**:
  - Myntra reports fees GST-inclusive. The backend decomposes:
    - `Commission (ex-GST) = commission_incl / 1.18`
    - `Commission GST = commission_incl - commission_ex`
    - `TCS = igst_tcs + cgst_tcs + sgst_tcs`
    - Itemized operational fees: `fixed_fee`, `shipping_fee`, `pick_and_pack_fee`, `payment_gateway_fee`.
    - `Logistics Commission` reconciled against itemized sum.
- **Non-Order Deductions (NOD) Classification (`classifyMyntraNod`)**:
  - Rows with `order_type = 'nod'` or populated `NOD_Comment` are classified into dedicated financial categories:
    1. **Brand Deductions**: Myntra Fashion Brands (MFB), Brand Association Fee, Cataloging, Creative Shoots.
    2. **Marketing Deductions**: Product Listing Ads (PLA), Performance Marketing, Campaign participation fees.
    3. **Logistics & Operations**: Storage fees, lost shipment compensation, return penalties.
    4. **Administrative / Other**: Penalty adjustments, trade discounts.
- **Destination Table**: `mp_invoices`.

---

## 4. Amazon Multi-Source Ingestion Pipeline

Amazon uses a multi-source pipeline with **Zero Synthetic Keys**. Natural keys are preserved end-to-end.

```
   ┌───────────────────────┐           ┌───────────────────────┐
   │   Sale Orders Export  │           │   Settlement Report   │
   │  (Amazon Order ID +   │           │    (Flat File V2)     │
   │      Merchant SKU)    │           │ (amazon_settlements + │
   └───────────┬───────────┘           │ amazon_settlement_    │
               │                       │        lines)         │
               ▼                       └───────────┬───────────┘
   ┌───────────────────────┐                       │
   │     orders Table      │                       │
   │  Natural Key Joins    │◄──────────────────────┘
   └───────────▲───────────┘          Query-Time Join:
               │                      • By order_item_code
               │                      • By order_id (Fee Refunds)
   ┌───────────┴───────────┐          • Non-order lines
   │     returns Table     │
   │  FBA: LPN             │
   │  Flex: RMA ID         │
   └───────────────────────┘
```

### 4.1 Zero Synthetic Keys Policy
Previous migrations attempted to synthesize composite keys like `AMZ-{order_id}-{sku}`. **This is deprecated and strictly forbidden.**
- Natural keys from Amazon Seller Central exports are stored directly.
- Cross-table linkages happen at query time using indexed natural columns.

### 4.1.1 Natural Uniqueness: Order ID + SKU Invariant
- **Flipkart vs. Amazon Architecture**:
  - In **Flipkart**, reconciliation is item-centric because Flipkart exports always supply a distinct, native `order_item_id` across sales, returns, and settlements.
  - In **Amazon**, Seller Central sale order reports do **not** have an item ID column; they carry forward orders with `Amazon Order Id` and `Merchant SKU`.
- **The Multi-SKU Reality**:
  - In Amazon, thousands of orders (**1,518+ orders** in active dataset) are multi-SKU orders where the **Order ID is identical but the SKU changes** (spanning 2 to 12 distinct SKUs per order).
  - Uniqueness and reconciliation for Amazon **must always be created and preserved on `(Order ID, SKU)`**.
- **Critical Business Benefits of `(Order ID, SKU)`**:
  1. **Partial Return Isolation**: If a buyer orders 2 or 3 distinct SKUs under the same `Order ID` and returns only 1 item, the system accurately marks only that specific SKU as `CUSTOMER_RETURN`, while the remaining SKUs stay `Delivered` with positive settlement earnings.
  2. **Granular Unit Economics**: Product price, 5% GST, FBA pick & pack, and referral commissions are calculated and tracked per SKU line item.
  3. **Database Enforcement**: Backed by PostgreSQL unique index `uq_orders_amazon_natural ON orders (order_id, sku) WHERE marketplace = 'amazon'`.

### 4.2 Key Vocabulary Across Amazon Exports
| Export Type | File Column for Seller SKU | File Column for FNSKU | File Column for ASIN |
| :--- | :--- | :--- | :--- |
| **Sale Orders** | `Merchant SKU` | `FNSKU` | `ASIN` |
| **FBA Returns** | `sku` | `fnsku` | `asin` |
| **Flex Returns** | **`mSKU`** ⚠️ | **`SKU`** ⚠️ | `ASIN` |
| **Settlement V2** | `sku` | *(N/A)* | *(N/A)* |

### 4.3 Amazon Sale Orders (Current Sale Source)
- **Route**: `POST /api/upload/amazon-sale-orders`
- **Format**: 14-column template from Amazon Seller Central.
- **Headers**:
  `Customer Shipment Date`, `Merchant SKU`, `FNSKU`, `ASIN`, `FC`, `Quantity`, `Amazon Order Id`, `Currency`, `Product Amount`, `Shipping Amount`, `Gift Amount`, `Shipment To City`, `Shipment To State`, `Shipment To Postal Code`.
- **Target Table**: `orders` (upsert on natural key `(order_id, sku)`).
- **Warehouse Master**: Upserts fulfillment center codes into `amazon_fc_master` (`fc_code`, `state`, `city`).
- **Shipment Date Formatting**:
  - `Customer Shipment Date` ISO strings (e.g. `2026-04-01T00:04:56+05:30`) are normalized strictly into SQL standard `DATE` (`YYYY-MM-DD`, e.g. `2026-04-01`) for `orders.order_date`.
- **Zero Product Amount & Exchange Orders**:
  - When `Product Amount = 0` (1,092 rows in export), the transaction represents an Amazon customer replacement/exchange order.
  - The pipeline sets `orders.order_type = 'exchange'`, `orders.product_amount = 0`, `orders.item_tax = 0`, and `orders.final_invoice_amount = 0`. Non-zero orders receive `order_type = 'standard'`.
- **5% GST & Per-Unit Price Invariant**:
  - In Amazon Seller Central exports, `Product Amount` is the **per-unit base price exclusive of 5% GST**.
  - Consumer listing prices in India are whole-rupee integers (e.g. ₹429, ₹499), from which Amazon calculates `Product Amount = unitPrice / 1.05` (e.g. ₹408.58).
  - Pipeline computes:
    - $\text{unitSellingPrice} = \text{round}(\text{Product Amount} \times 1.05) \quad (\text{if within 0.05 of whole rupee})$ (e.g. ₹408.58 $\rightarrow$ ₹429.00)
    - $\text{orders.product\_amount} = \text{final\_invoice\_amount} = \text{round}(\text{unitSellingPrice} \times \text{Quantity}, 2)$ (e.g. $12 \times 429 = \text{₹5,148}$, $20 \times 429 = \text{₹8,580}$) — stored with 5% price added up directly at upload time so there is zero confusion between product amount and final invoice.
    - $\text{Line Product Base} = \text{round}(\text{Quantity} \times \text{Product Amount}, 2)$ (e.g. $20 \times 408.58 = \text{₹8,171.60}$)
    - $\text{item\_tax (5\% GST)} = \text{round}(\text{final\_invoice\_amount} - \text{Line Product Base}, 2)$ (e.g. $8,580 - 8,171.60 = \text{₹408.40}$, exactly matching Amazon settlement `Product Tax`!)
  - **No Shipping or Gift in Product Invoice Amount**: Shipping Amount and Gift Amount are buyer charges (often reversed or discounted by Amazon via shipping promotions/chargebacks) and are **strictly excluded** from $\text{final\_invoice\_amount}$ and $\text{product\_amount}$. They are preserved in separate audit columns (`sale_shipping_amount`, `sale_gift_amount`) on `orders`.
- **Multi-Kind Order Aggregation**:
  - **Same Order ID, Same SKU (Split Shipments)**: When an order is split into multiple packages for the same SKU, the pipeline aggregates across rows: $\sum \text{qty}$, $\sum \text{product\_amount} = \sum \text{final\_invoice\_amount}$, and $\sum \text{item\_tax}$.
  - **Same Order ID, Different SKUs (Multi-SKU Orders)**: Preserved as distinct natural rows `(order_id, sku1)`, `(order_id, sku2)` in the `orders` table. Composite reconciliation joins always use `(order_id, sku)`.

### 4.4 Amazon FBA Returns (Amazon Fulfilled)
- **Route**: `POST /api/upload/amazon-fba-returns`
- **Natural Key**: **License Plate Number (LPN)** (`license-plate-number`). Stored directly in `returns.order_item_id` (composite `${lpn}-${order_id}` to prevent cross-order collision).
- **Headers**: `return-date`, `order-id`, `sku`, `asin`, `fnsku`, `product-name`, `quantity`, `fulfillment-center-id`, `detailed-disposition`, `reason`, `license-plate-number`, `customer-comments`.
- **Query Join**: Links to `orders` on `(order_id, sku)`.
- **Customer Return vs. RTO (Undelivered) Classification**:
  - **RTO / Courier Return (`return_type = 'RTO'`)**: Triggered when `reason` starts with `UNDELIVERABLE` (e.g. `UNDELIVERABLE_REFUSED`, `UNDELIVERABLE_UNKNOWN`) or `UNDELIVERED`. Amazon courier failed delivery or customer refused delivery before receipt. In settlements, Amazon refunds 100% of FBA fulfillment and closing fees via `Item Fee Adjustment`.
  - **Customer Return (`return_type = 'CUSTOMER_RETURN'`)**: Triggered for all buyer-initiated reasons (`QUALITY_UNACCEPTABLE`, `APPAREL_TOO_SMALL`, `POOR_FIT`, `APPAREL_STYLE`, `APPAREL_TOO_LARGE`, `DID_NOT_LIKE_COLOR`, `DEFECTIVE`, `SWITCHEROO`, etc.). Buyer received item and returned it. In settlements, Amazon retains fulfillment fees and charges `Refund commission` (20% fee + GST).
- **QC Disposition Mapping (`final_condition`)**:
  - `detailed-disposition` is mapped directly to `returns.final_condition`.
  - `SELLABLE` $\rightarrow$ Counted in **Good Returns** KPI.
  - `CUSTOMER_DAMAGED`, `DEFECTIVE`, `DAMAGED`, `CARRIER_DAMAGED` $\rightarrow$ Counted in **Bad Returns** (QC Damaged / Rejected) KPI.
- **Main Orders Ledger Sync**:
  - Post-upsert sync query updates `orders` for matching `(order_id, sku)` pairs:
    - `orders.return_type = returns.return_type`
    - `orders.orders_status = 'RTO'` (for RTO) or `'Returned'` (for Customer Return).

### 4.5 Amazon Flex Returns (Seller Fulfilled)
- **Route**: `POST /api/upload/amazon-flex-returns`
- **Natural Key**: **RMA ID** (`RMA ID`). If RMA ID is missing, falls back to `FLEX-TRACK-{reverse_tracking_id}-{sku}` or `{forward_tracking_id}-{sku}`. Stored directly in `returns.order_item_id`.
- **CRITICAL COLUMN SWAP**:
  - In Amazon Flex exports, the column header `SKU` contains the Amazon FNSKU barcode.
  - The column header `mSKU` contains the actual merchant seller SKU.
  - Ingestion mapping: `mSKU -> sku` and `SKU -> fnsku`.
- **Exclusion Filter (Customer Cancelled Pick-up)**:
  - **Rule**: If `Return Status` matches `Customer cancelled pick-up` (or variant `canceled pick-up`), the return request was cancelled by the buyer prior to courier handover.
  - **Action**: These rows are **strictly filtered out and excluded** from insertion into `returns` (`skipped: true`). This prevents phantom return records and false RTO/return classification on active or delivered orders.
- **Return Type & RTO Classification**:
  - **RTO (`return_type = 'RTO'`)**: Triggered when `Return Type = 'UNDELIVERED'` or starts with `UNDELIVERABLE`. The parcel was never delivered to the customer and was returned by the courier. In Flex files, 100% of these rows have a blank `Return Reason`.
  - **Customer Return (`return_type = 'CUSTOMER_RETURN'`)**: Triggered when `Return Type = 'CUSTOMER_RETURN'`. The customer received the shipment and initiated a return with explicit return reasons (`Too small`, `Item doesn't fit`, `Too large`, `Performance or quality not adequate`, etc.).
- **Transit Days Normalization**:
  - Amazon exports transit durations with inequality prefixes (e.g. `>90`, `>7`).
  - The parser cleans leading `>` signs to store clean integer values in `returns.days_in_transit` and `returns.days_since_return_complete`.
- **Headers**: `Return Type`, `Customer Order ID`, `Shipment ID`, `SKU` (FNSKU), `mSKU` (Seller SKU), `ASIN`, `Units`, `Forward Leg Tracking ID`, `Reverse Leg Tracking ID`, `RMA ID`, `Return Status`, `Carrier`, `Pick -up date`, `Last Updated On`, `Return Reason`, `Days In-transit`, `Days Since Return Complete`, `Returned with OTP`.
- **Main Orders Ledger Sync**:
  - Post-upsert sync query updates `orders` for matching `(order_id, sku)` pairs:
    - `orders.return_type = r.return_type`
    - `orders.orders_status = CASE WHEN r.return_type = 'RTO' THEN 'RTO' WHEN o.orders_status IS NULL OR o.orders_status IN ('Delivered', 'Shipped', 'Complete', '') THEN 'Returned' ELSE o.orders_status END`.
- **Physical Warehouse Receipt Sync**:
  - If `Return Status = 'Returned to Seller'`, the backend automatically marks physical receipt in `returns_received` and flags `returns.is_received = TRUE`.


### 4.6 Amazon Settlement (Flat-File V2 Long Format)
- **Route**: `POST /api/upload/amazon-settlement` (Async background execution by default; optional `?sync=true` for scripts/tests)
- **Progress Endpoint**: `GET /api/upload/amazon-settlement/progress/:jobId`
- **File Limit**: 150MB Multer memory buffer.
- **Multi-Sheet Discovery**:
  - Automatically iterates over all sheets in the workbook (e.g. `Electronic`, `COD`).
  - Evaluates header columns (`settlement-id`, `amount-description`, `amount-type`) to detect valid settlement sheets.
  - Seamlessly handles multi-month workbooks containing multiple sheets and tens of weekly cycles.
- **Dense Mode Streaming**:
  - Parsed with SheetJS `dense: true` (`cellDates: false, cellNF: false, cellStyles: false`).
  - Reads 800k+ rows in <25 seconds with ~350MB peak heap, eliminating Node.js out-of-memory errors.
  - Sheet worksheet matrix and per-settlement line arrays are deleted from memory as soon as each settlement commits to PostgreSQL.
- **Repeated Embedded Header Skipping**:
  - When sellers merge weekly settlement exports, embedded header rows (`settlement-id = 'settlement-id'`) appear inside data sections. The parser detects and skips these cleanly with zero false validation errors.
- **Date & Timestamp Normalization**:
  - Amazon uses `DD.MM.YYYY HH:mm:ss UTC` for envelope start/end/deposit dates and `DD.MM.YYYY` for transaction posted dates.
  - The pipeline normalizes them to SQL `DATE` (`YYYY-MM-DD`) and ISO 8601 `TIMESTAMPTZ` (`YYYY-MM-DDTHH:mm:ssZ`).
- **Tables**:
  - `amazon_settlements`: Settlement envelope summary (`settlement_id`, `settlement_start_date`, `settlement_end_date`, `deposit_date`, `total_amount`, `currency`).
  - `amazon_settlement_lines`: Granular transaction line items (15,000 to 40,000+ rows per weekly cycle).
  - `amazon_order_settlement_rollups`: Precomputed read model at `(settlement_id, posted_month, order_id, sku)`.
- **Query-Time Linkage Rules**:
  1. If `order_item_code` is present -> `JOIN orders ON orders.order_item_id = lines.order_item_code` (exact item match).
  2. If only `order_id` is present (e.g. Fulfillment Fee Refunds) -> `JOIN orders ON orders.order_id = lines.order_id`.
  3. If neither `order_item_code` nor `order_id` is present -> categorized as **Non-Order Deductions** (storage fees, subscription fees, coupon redemption fees, Amazon Advertising).
- **Orphan SKU Resolution (`resolveOrphanSkus`)**:
  - Amazon Fulfillment Fee Refund rows lack a SKU. The resolver pairs each refund row to its original order charge row by `(order_id, amount_description, ABS(amount))` to assign the Merchant SKU.
- **Row-to-Column Aggregation Bridge (`backfillOrdersFromSettlement`)**:
  - Pivots row-level line items (`Principal`, `Product Tax`, `order_commission`, `order_closing_fee`, `order_fba_fee`, `order_shipping`, `order_tcs`, `order_tds`, `inventory_reimbursement`) into order columns: `final_invoice_amount`, `settlement_amount`, `commission`, `fixed_fee`, `pick_pack_fee`, `shipping_fee`, `tcs`, `tds`, `spf_amount`.
- **Post-Upload Hooks**:
  - `refreshAmazonSettlementRollups(client, settlementId)`
  - `refreshAmazonSettlementReportingRollups(pool, settlementId)`
  - `refreshOrderSettlementTotals(pool)`
  - `invalidateAmazonReconciliationCache()`
  - `clearSkuSettlementBenchmarkCache('amazon')`
  - `notifySkuSettlementBenchmarkAfterImport(pool, 'amazon')`

### 4.7 Amazon Order Lifecycle Invariants & Financial Mechanics
Real-world audit of Amazon settlement data (`APril-2026 to may2026.xlsx`) reveals three distinct financial lifecycles across Order, Refund, and Fee Adjustment transaction types:

| Metric / Stage | 1. Clean Sale (`404-6721619-9765160`) | 2. Customer Return (`407-7285146-4911556`) | 3. RTO / Courier Return (`171-5824998-0676344`) |
| :--- | :--- | :--- | :--- |
| **Transaction Types** | `Order` (13 rows) | `Order` (13 rows) + `Refund` (5 rows) | `Order` (16 rows) + `Refund` (9 rows) + `Fulfillment Fee Refund` (6 rows) |
| **Gross Customer Bill** | +₹429.00 (`Principal` + `Product Tax`) | +₹854.00 (Sale) | +₹599.00 (Sale) |
| **Customer Refund** | ₹0.00 | **-₹854.00** (100% reversed to buyer) | **-₹599.00** (100% reversed to buyer) |
| **FBA Pick & Pack** | -₹20.06 (₹17 + GST) | -₹20.06 (*Retained by Amazon*) | -₹20.06 $\rightarrow$ **+₹20.06 Refunded by Amazon** |
| **FBA Weight Handling**| -₹28.32 (₹24 + GST) | -₹28.32 (*Retained by Amazon*) | -₹50.74 $\rightarrow$ **+₹50.74 Refunded by Amazon** |
| **Fixed Closing Fee** | -₹16.52 (₹14 + GST) | -₹31.86 (*Retained by Amazon*) | -₹31.86 $\rightarrow$ **+₹31.86 Refunded by Amazon** |
| **Refund Commission** | ₹0.00 | **-₹60.18** (20% fee + GST charged to seller) | ₹0.00 |
| **Statutory Taxes** | TCS -₹2.04, TDS -₹0.42 | TCS ₹0.00 net, TDS -₹0.82 | TCS ₹0.00 net, TDS -₹0.58 |
| **Net Bank Payout** | **+₹361.64** (*Clean positive payout*) | **-₹141.24** (*Direct loss to seller*) | **-₹0.58** (*Near-zero loss, only TDS rounding*) |

#### Core Invariant: Customer Return vs RTO Return
- **On Customer Returns** (delivered, then returned by buyer): Amazon does **NOT** refund Pick & Pack, Weight Handling, or Closing fees, and charges an additional `Refund commission` (20% fee + GST). The seller suffers a substantial cash deficit on the settlement ledger.
- **On RTO Returns** (courier delivery failed / cancelled before delivery): Amazon issues separate `Fulfillment Fee Refund` rows under `Item Fee Adjustment` that refund 100% of Pick & Pack, Weight Handling, and Closing fees back to the seller. The seller's net settlement impact is virtually ₹0.

### 4.8 Dynamic Fee Adaptation Model (Zero Schema Breakage)
Amazon frequently adds or renames fee descriptions over time (e.g. `ItemFees :: Discount Fee`, `High Return Rate Fee`, `Inventory Placement Service Fee`). The pipeline guarantees zero schema breakage and zero data loss through a hybrid columnar + JSONB design:

1. **Tier 1 (Raw Ledger Table `amazon_settlement_lines`)**: Stores every raw row verbatim with full transaction descriptions, types, and amounts.
2. **Tier 2 (Rollup Models `amazon_order_settlement_rollups` & `orders`)**:
   - Standard known fees map to dedicated columns: `commission`, `fixed_fee`, `pick_pack_fee`, `shipping_fee`, `tcs`, `tds`.
   - **`other_fee` / `mp_other_fee NUMERIC(14,2)`**: Automatically captures any newly introduced debit that does not match standard column definitions.
   - **`fee_breakdown JSONB`**: Stores the complete key-value dictionary of all exact fee descriptions and amounts (e.g. `{"ItemFees :: Discount Fee": -15.00, "Fixed closing fee": -27.00, ...}`).
   - **Mathematical Invariant**: `net_settlement` / `bank_settlement` is always computed as the exact algebraic sum of all credits minus debits (`SUM(amount)`), guaranteeing that new fees never cause payment reconciliation drifts.

### 4.9 Complete Non-Order Expense Segregation & 117-Fee Taxonomy
Amazon settlement reports mix operational account-level charges with order transactions. In accordance with the 117-fee catalog defined in the `Settelments Description` master sheet, non-order items must be segregated strictly into dedicated ledger domains and **never** rolled into order-level unit profitability:

1. **`storage_fee` (FBA Warehouse Storage)**:
   - Matches: `amount_description ILIKE 'Storage%Fee%'`, `StorageBillingCGST`, `StorageBillingSGST`, `StorageRenewalBilling%`, `FBAStorageFee%`, `%Long%Term%Storage%`, `FBA%Storage%`.
   - Covers monthly cubic-foot warehouse rent and long-term storage penalties.
2. **`removal_fee` (Stock Returns & Disposal)**:
   - Matches: `RemovalComplete%`, `RemovalCompleteCGST/SGST`, `DisposalComplete%`, `DisposalCompleteCGST/SGST`, `FBA Removal Order%`.
   - Covers return of unsellable stock to the seller's factory or scrapping inside Amazon fulfillment centers.
3. **`ads_billing` (Sponsored Products & PPC)**:
   - Matches: `Cost of Advertising`, `Sponsored%`, `Advertising%`, `Ads%`, `CPC%`.
   - Covers Amazon Sponsored Product PPC click spend.
4. **`service_fee` (Warehouse Prep & Account Services)**:
   - Matches: `WarehousePrep%`, `WarehousePrepCGST/SGST`, `Manual Processing Fee%`, `Unplanned Service Fee%`, `Service%Fee%`, `Subscription%` (Professional selling plan).
5. **`inventory_reimbursement` (Amazon Warehouse & Transit Claims)**:
   - Matches: `amount_type = 'FBA Inventory Reimbursement'`, `Damaged:Warehouse`, `Lost:Warehouse`, `MISSING_FROM_INBOUND`, `COMPENSATED_CLAWBACK`, `CRETURN_WRONG_ITEM` (buyer returned wrong item), `CS_ERROR_ITEMS`, `SAFE-T Reimbursement`.
6. **`other_credit` / `other_debit`**:
   - Matches: `Seller Rewards` (growth incentives), `BalanceAdjustment`, `Current Reserve Amount`.

---

## 5. Meesho Ingestion Pipeline

Meesho processing handles Orders, Returns, and the consolidated Payments Excel export.

### 5.1 Meesho Orders & Returns
- **Routes**:
  - Orders: `POST /api/upload/orders` with `marketplace = 'meesho'`.
  - Returns: `POST /api/upload/returns` with `marketplace = 'meesho'`.
- **Validation**: Same base validation as Flipkart generic routes.

### 5.2 Meesho Settlement / Payments
- **Route**: `POST /api/upload/meesho-settlement`
- **Target Table**: `meesho_settlement_items`
- **Auto-Sheet Discovery**:
  - Automatically searches for sheet name containing `'Order Payments'`.
  - If file has a `Disclaimer` sheet, defaults to the second sheet (index 1).
- **Header Row Offset**: Uses `range: 1` when parsing the sheet to bypass the top-level group header row and read field names from row 2.
- **Field Mappings**:
  - `Sub Order No` -> `order_item_id`
  - `Supplier SKU` -> `sku`
  - `Payment Date` / `Order Date` -> `payment_date`
  - `Final Settlement Amount` -> `bank_settlement`
  - `Total Sale Amount (Incl. Shipping & GST)` -> `sale_amount`
  - `Meesho Commission (Incl. GST)` -> `commission_fee`
  - `Fixed Fee (Incl. GST)` -> `fixed_fee`
  - `Shipping Charge (Incl. GST)` -> `shipping_fee`
  - `Return Shipping Charge (Incl. GST)` -> `reverse_shipping`
  - `TCS` / `TDS` -> `tcs` / `tds`
  - `Compensation` / `Recovery` / `Claims` -> `claims`
  - `Live Order Status` -> `transaction_type`
  - `Transaction ID` -> `settlement_id`
- **Automated SKU Backfill**: After inserting settlement items, the backend updates `orders.sku` for any matching Meesho order item where SKU was previously null or blank.
- **Downstream Rollups**: Executes `refreshOrderSettlementTotals(pool)`.

---

## 6. Catalog, COGS & Return Physical Verification

### 6.1 SKU Master
- **Route**: `POST /api/upload/sku-master`
- **Target Table**: `sku_master` (upsert on `(marketplace, listing_sku)`).
- **Fields**: `master_sku`, `listing_sku`, `marketplace`, `cogs`, `launch_date`, `product_name`, `weight_slab`, `brand_name`.
- **Validation**:
  - `weight_slab` must be a positive number or valid range (e.g. `"0-0.5 kg"` -> stored as `0.5`).
  - `cogs` must be non-negative.

### 6.2 Catalog COGS
- **Route**: `POST /api/upload/catalog-cogs`
- **Target Table**: `catalog_cogs` (upsert on `(marketplace, catalog_id)`).
- **Fields**: `marketplace`, `catalog_id` (FSN / ASIN / Style ID), `category`, `cogs`, `product_name`, `brand_name`.

### 6.3 Physical Returns Verification (Warehouse Receipt)
- **Route**: `POST /api/upload/returns-received`
- **Target Table**: Directly updates `returns` table columns:
  - `return_received` (BOOLEAN)
  - `is_bad_return` (BOOLEAN: Good = false, Bad/Damaged = true)
  - `received_date` (DATE)
  - `receipt_notes` (TEXT)
- **Validation**: If `Return Received? = 'Yes'`, both `Condition` and `Received Date` are strictly required. If `No`, condition and received date must be blank.

---

## 7. Database Entity Relationship Matrix

| Dataset | Primary / Natural Key | Table Name | Join Key to Orders | Join Key to Settlements |
| :--- | :--- | :--- | :--- | :--- |
| **Flipkart Orders** | `order_item_id` | `orders` | `order_item_id` | `order_item_id` |
| **Flipkart Returns** | `order_item_id` | `returns` | `order_item_id` | `order_item_id` |
| **Flipkart Settlement** | `neft_id` + line | `fk_settlement_orders` | `order_item_id` | `neft_id` |
| **Flipkart SPF** | `claim_id` + `neft_id` | `fk_spf_claims` | `order_item_id` | `neft_id` |
| **Myntra Orders** | `marketplace, seller_account, order_line_id` | `myntra_order_details` & `orders` | `order_item_id = order_line_id` | `order_line_id` |
| **Myntra Returns** | `marketplace, seller_account, order_line_id` | `myntra_return_details` & `returns` | `order_item_id = order_line_id` | `order_line_id` |
| **Myntra Invoices / NOD**| `source_fingerprint` | `mp_invoices` | `order_line_id` or `order_release_id` | `payment_reference` (NEFT) |
| **Amazon Sale Orders** | `order_id, sku` | `orders` | `order_id, sku` | `order_item_code` or `order_id` |
| **Amazon FBA Returns** | `license-plate-number` | `returns` | `order_id, sku` | `order_id` |
| **Amazon Flex Returns**| `RMA ID` | `returns` | `order_id, sku = mSKU` | `order_id` |
| **Amazon Settlement** | `settlement_id` + line | `amazon_settlements` & `_lines` | `order_item_code` or `order_id` | `settlement_id` |
| **Meesho Settlement** | `settlement_id, order_item_id` | `meesho_settlement_items` | `order_item_id` | `settlement_id` |

---

## 8. Summary for Autonomous Agents & Engineers

When adding new marketplace features or maintaining existing upload routines:
1. **Never bypass account guards**: Myntra VB (`10708`) and EJ (`45833`) must remain completely separate across orders, returns, and invoices.
2. **Never generate synthetic keys for Amazon**: Preserve natural keys (`Amazon Order Id`, `Merchant SKU`, `LPN`, `RMA ID`).
3. **Always use `forEachDbBatch`**: Any multi-row database write must be batched to respect PostgreSQL's 65,535 positional parameter boundary.
4. **Always trigger downstream rollups**: After ingesting orders or settlement rows, call `refreshOrderSettlementTotals(pool)` and marketplace-specific rollups.
5. **Always log uploads and skipped rows**: Use `logUpload` and `saveSkippedRows` so data health is auditable in the Data Hub UI.

---

## 9. Dynamic Marketplace Auto-Discovery & Outstanding Payments Architecture

The system features an automated, zero-code discovery pipeline for any new marketplace portal (e.g. **Meesho**, **Ajio**, **Shopsy**, **Cocoblue**, **Zepto**, **JioMart**, or any future channel). When data for a new portal is uploaded, it automatically surfaces across the application without requiring code modifications or UI redeployment.

### 9.1 Multi-Source Portal Discovery Engine
The backend (`outstandingPaymentsService.js`) dynamically discovers all marketplaces via a unified database union query:

```sql
SELECT DISTINCT LOWER(marketplace) AS marketplace FROM (
  SELECT marketplace FROM orders WHERE marketplace IS NOT NULL
  UNION
  SELECT marketplace FROM mp_config WHERE is_active = true
  UNION
  SELECT marketplace FROM marketplace_accounts WHERE is_active = true
  UNION
  SELECT marketplace FROM mp_invoices WHERE marketplace IS NOT NULL
) sub WHERE marketplace != ''
```

Any channel found in `orders`, `mp_config`, `marketplace_accounts`, or `mp_invoices` is immediately registered in the reconciliation matrix.

### 9.2 Pure Live Database Reconciliation Formula
All metrics on the Outstanding Payments dashboard are 100% computed from live database tables with zero mock or baseline fallbacks:

$$\text{Total Orders} - \text{Returns} - \text{Marketplace Fees} - \text{Payment Received} = \text{Outstanding}$$

| Metric | Source Table / Field | Calculation Logic |
| :--- | :--- | :--- |
| **Total Orders** | `orders.final_invoice_amount` | `SUM(o.final_invoice_amount)` across all orders for this marketplace. |
| **Orders Count** | `orders.order_item_id` | `COUNT(DISTINCT o.order_item_id)` |
| **Returns** | `order_settlement_totals.refund_amount` | `SUM(ost.refund_amount)` for refunds linked to orders. |
| **Marketplace Fees** | `order_settlement_totals` | `SUM(commission + fixed_fee + collection_fee + pick_pack_fee + shipping_fee + reverse_shipping + franchise_fee + tcs + tds + gst_on_mp_fees)` |
| **Payment Received** | `order_settlement_totals.net_bank` | `SUM(ost.net_bank)` deposited payouts from the marketplace. |
| **Outstanding** | `orders` + `mp_invoices` | Sum of `final_invoice_amount` for unsettled orders (`WHERE ost.order_item_id IS NULL`) + unpaid invoices. |
| **Overdue (>60d)** | `orders.order_date` | Unsettled orders where `CURRENT_DATE - o.order_date::date > 60`. |

### 9.3 Behavior When a New Portal is Added
1. **Before Files Are Uploaded**:
   - The portal appears with status `No Orders` and values set to `₹0` (clean display, zero artificial numbers).
2. **After Order File Ingestion (`POST /api/upload/orders`)**:
   - `Total Orders` and order counts immediately populate in real time.
   - Status transitions to `Current` or `Overdue` based on order age.
   - Outstanding balance reflects gross invoice value pending settlement.
3. **After Settlement / Return Ingestion**:
   - `order_settlement_totals` is automatically refreshed via `refreshOrderSettlementTotals(pool)`.
   - `Returns`, `Marketplace Fees`, and `Payment Received` update in real time.
   - `Outstanding` decreases exactly as payouts and deductions are settled.
   - When all orders are settled (like Amazon), `Outstanding` becomes `₹0` with status `Settled`.

### 9.4 Multi-Account Hierarchies
- If a marketplace has multiple seller accounts (e.g. `myntra_ej` with Seller ID `45833` and `myntra_vb` with Seller ID `10708`, or future multi-account portals like Meesho Account 1 & Account 2), the system automatically groups them under the parent channel.
- Operators can click the expandable chevron (`>`) to reveal individual account balances, orders counts, seller IDs, fees, and overdue amounts.

### 9.5 Adding a New Portal: Step-by-Step Guide
To introduce a new marketplace (e.g. `ajio` or `meesho`):
1. **Step 1 (Optional Configuration)**:
   Add an entry to `mp_config` or `marketplace_accounts`:
   ```sql
   INSERT INTO mp_config (marketplace, display_name, reco_type, is_active, color)
   VALUES ('ajio', 'Ajio', 'order', true, 'amber');
   ```
2. **Step 2 (Upload Orders)**:
   Upload the orders file via the Data Hub UI or `POST /api/upload/orders` with `marketplace = 'ajio'`.
3. **Step 3 (Immediate Visibility)**:
   - The new channel automatically appears in the **Outstanding Payments** table.
   - The channel appears in the marketplace filter tabs across **Reconciliation**, **Sales**, and **Profit & Loss**.
   - The channel is included in consolidated Excel exports and order drilldown drawers.

---

## 10. VB EXPORT SKU & Product Category Normalization Architecture

### 10.1 Master Hierarchy Invariant
In multi-channel e-commerce, every marketplace uses its own arbitrary SKU strings, listings, and category names (e.g. Flipkart uses `FSN` + custom listing SKU and categories like "Women Kurtas"; Myntra uses style IDs and categories like "Kurta Sets"; Amazon uses `Merchant SKU`, `ASIN`, `FNSKU`, and category "Apparel").
To track true unit economics, profitability, COGS, and weight slabs across all portals, the system establishes a master catalog anchored to the internal **VB EXPORT SKU** (`vb_sku_master`).

| Field | Database Column | Purpose |
| :--- | :--- | :--- |
| **VB EXPORT SKU** | `vb_sku_master.vb_export_sku` / `orders.vb_export_sku` | Master product identifier (e.g. `EJ1201-16001`). All marketplace listing SKUs map to this master key. |
| **VB Export Product Category** | `vb_sku_master.category` / `orders.vb_export_category` | Consolidated internal product category (e.g. `Kurta Set`, `Kurti`, `Top`, `Saree`). |
| **COGS (₹)** | `vb_sku_master.cogs` / `sku_master.cogs` | Cost of goods sold per unit, configured on the master SKU. |
| **Weight Slab (kg)** | `vb_sku_master.weight_slab` / `sku_master.weight_slab` | Shipping weight tier (e.g. `0.5`, `1.0`, `1.5`, `2.0`), configured on the master SKU. |
| **Marketplace Listing SKU** | `sku_master.listing_sku` / `orders.sku` | Marketplace-specific listing code from order files. |

### 10.2 Category Normalization Everywhere
All queries, dashboards, and reports across the application must select, group, and filter by:
```sql
COALESCE(o.vb_export_category, o.category, 'Uncategorized')
```
This ensures that fragmented marketplace category strings never pollute the dashboard.

### 10.3 Master Catalog Upload Template
The official upload template (`vb_export_product_category_template.xlsx` and `GET /api/upload/template/sku-master`) contains the following columns:
1. `Marketplace SKU`
2. `VB EXPORT SKU's`
3. `VB Export Product Category`
4. `Weight Slab (kg)`
5. `COGS (₹)`
6. `Marketplace` (defaults to 'all' if omitted)

Ingestion of this template:
1. Upserts `vb_sku_master` (`vb_export_sku`, `category`, `cogs`, `weight_slab`).
2. Upserts `sku_master` (`listing_sku`, `master_sku`, `category`, `cogs`, `weight_slab`, `marketplace`).
3. Automatically backfills `orders.vb_export_sku` and `orders.vb_export_category` across all historical orders.

### 10.4 Unmerged Listings Trigger & Workflow
Any order row where `orders.vb_export_sku` is NULL or `orders.sku` does not have a matching entry in `sku_master` triggers an alert banner in the UI:
- Visual notification with count of unmerged SKUs, affected orders, and gross revenue.
- 1-click navigation into the Unmerged Listings queue inside the `COGS & Weight Slabs` tab.
- Inline modal with auto-suggested VB EXPORT SKU based on prefix/suffix stripping to merge the listing SKU into the master catalog in 1 click.

### 10.5 UI Layout & Anti-Clutter Invariant
Profit Analysis strictly maintains 6 top-level tabs:
1. `Overview`: P&L trend, profit waterfall, marketplace fee pie chart, and fee summary.
2. `By Category`: Breakdown grouped by consolidated VB Export Category.
3. `By SKU`: Master product profitability with in-tab toggle between `⭐ Master SKU (VB EXPORT)` and `Marketplace Listing SKU`.
4. `By Account`: Brand and seller account comparison (e.g. Myntra VB vs Myntra EJ).
5. `By Zone`: Shipping zone profitability.
6. `COGS & Weight Slabs`: Master Catalog configuration, Listing Mappings, and Unmerged Listings trigger.


