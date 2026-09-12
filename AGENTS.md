# Agent Guidelines & Project Memory

## TaskFlow Pro Integration (Mandatory Workflow)

All autonomous agents and coding assistants operating on this codebase must track and record their work on **TaskFlow Pro**.

### Lifecycle Rules:
1. **Start of Work**:
   - Call `sync_coding_work` on the `taskflow-pro` MCP server:
     - `project_name`: `"DashBorad Project"`
     - `task_title`: Specific title for the work item
     - `task_description`: Context and intended changes
     - `status`: `"in_progress"`
   - Save the returned `task.id` for all subsequent updates.
   - All tasks must be assigned to the connected user (**Pawan Shukla** / `returnorders@vbexports.co.in`).

2. **Progress Updates**:
   - Call `sync_coding_work` with `task_id` and `progress_note` as key milestones are reached.
   - Transition status to `"in_review"` when changes are ready for human verification or PR review.
   - Transition status to `"done"` once tests pass, database migrations run, and changes are verified.

3. **TaskFlow Server Details**:
   - Endpoint: `https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server`
   - Configured in: `~/.gemini/config/mcp_config.json`
   - Web App UI: `https://task.youthnic.shop/`

## Marketplace Data Upload Architecture & Specifications

Whenever modifying, extending, or debugging data ingestion, orders, returns, settlements, or rate card mappings across any marketplace, **agents must strictly conform to [MARKETPLACE_DATA_UPLOAD_SPEC.md](MARKETPLACE_DATA_UPLOAD_SPEC.md)**.

### Core Architectural Invariants:
1. **Myntra Account Separation**:
   - `myntra_vb`: Seller ID `10708`
   - `myntra_ej`: Seller ID `45833`
   - Files with mismatched seller IDs must be rejected immediately with zero rows saved.
   - Blank tracking number rule: If tracking number is blank, order is marked `Delivered` with `return_type = 'RTO'`, and a synthesized return (`Cancel before ship`) is inserted into `returns`.
   - Return date resolution: If `return_created_date` is empty or 1970 epoch, fallback to `order_rto_date`.
2. **Amazon Pipeline**:
   - Zero synthetic keys: Never create synthetic `AMZ-{order_id}-{sku}` keys.
   - Flex returns column swap: file `SKU` = FNSKU; file `mSKU` = Merchant SKU (backend maps `mSKU -> sku` and `SKU -> fnsku`).
   - Settlement V2 join strategy: joins via `order_item_code` or `order_id` at query time; unlinked rows are non-order deductions.
   - Customer Return vs RTO: Customer returns retain FBA fulfillment fees and charge refund commission (-₹141.24 loss); RTO returns refund 100% of FBA fulfillment and closing fees via `Fulfillment Fee Refund` rows (net loss ~₹0).
   - Dynamic fee resilience: Store unknown fees in `other_fee` and full key-value maps in `fee_breakdown JSONB`.
   - Non-order segregation: Segregate storage, removal/disposal, and PPC advertising from order-level unit economics.
3. **Database Batching**:
   - Always batch multi-row inserts via `forEachDbBatch` to avoid PostgreSQL's 65,535 parameter limit.
   - Always invoke `refreshOrderSettlementTotals(pool)` after ingesting orders or settlement items.
4. **Automated Marketplace Discovery**:
   - Any new portal (Meesho, Ajio, Shopsy, etc.) uploaded into `orders`, or configured in `mp_config` / `marketplace_accounts`, automatically surfaces across the Outstanding Payments matrix and filter tabs without code changes.
   - Outstanding calculations strictly adhere to: `Total Orders - Returns - Marketplace Fees - Payment Received = Outstanding`.


