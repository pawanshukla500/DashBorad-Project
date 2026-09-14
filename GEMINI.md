# Antigravity Agent Guidelines & Core Memory

## Mandatory Workflow: TaskFlow Pro Integration

Whenever working on this codebase, **all coding sessions, tasks, bug fixes, refactors, and feature work must be tracked and synchronized on the TaskFlow Pro application**.

### Instructions:
1. **At the start of any coding session**:
   - Always call `sync_coding_work` with:
     - `project_name`: `"DashBorad Project"`
     - `task_title`: A clear, descriptive title of the specific task or feature being worked on.
     - `task_description`: Summary of what is being implemented, fixed, or audited.
     - `status`: `"in_progress"` (default)
   - This automatically creates/finds the project and assigns the task to the connected user (**Pawan Shukla** / `returnorders@vbexports.co.in`).

2. **During the session**:
   - Keep the same task updated by passing:
     - `task_id`: The task UUID returned from the initial call.
     - `progress_note`: What changed, what was tested, decisions made, PR links, etc.
     - `status`:
       - `"in_progress"` while implementing
       - `"in_review"` when a review or approval is needed / PR open
       - `"done"` when finished and verified

3. **Rules**:
   - **Do not create unassigned tasks**: The task must always be assigned to the connected user.
   - **Persistence**: Git commits, PRs, and documentation stay in the repo/coding tool; TaskFlow Pro tracks progress, accountability, and project status.
   - **MCP Server Connection**:
     - Remote Server URL: `https://nekdjoquirhecmejuoba.supabase.co/functions/v1/mcp-server`
     - MCP Config: Stored in `~/.gemini/config/mcp_config.json` under `taskflow-pro`.

## Marketplace Data Upload Architecture & Specifications

Whenever modifying, extending, or debugging data ingestion, orders, returns, settlements, or rate card mappings across any marketplace, **agents must strictly conform to [MARKETPLACE_DATA_UPLOAD_SPEC.md](MARKETPLACE_DATA_UPLOAD_SPEC.md)**.

### Core Architectural Invariants:
1. **Myntra Account Separation**:
   - `myntra_vb`: Seller ID `10708`
   - `myntra_ej`: Seller ID `45833`
   - Files with mismatched seller IDs must be rejected immediately with zero rows saved.
   - Blank tracking number rule: If tracking number is blank, order is marked `Cancelled` with `return_type = 'Courier Return'`, and a synthesized return (`Cancel Before Dispached`) is inserted into `returns`.
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
5. **VB EXPORT SKU & Product Category Normalization Architecture**:
   - Master Product Key: `vb_export_sku` (e.g. `EJ1201-16001`) is our primary master product identifier across all marketplace channels.
   - Master Product Category: Disparate marketplace category taxonomies (e.g. Flipkart's "Women Kurtas", Myntra's "Kurta Sets", Amazon's "Apparel") must NEVER fragment the dashboard or reports. All category breakdowns, filters, and reports across Dashboard, Sales, and Profit Analysis must select, group, and filter by `COALESCE(o.vb_export_category, o.category, 'Uncategorized')`.
   - Master Catalog Management in `vb_sku_master`: COGS price and Weight Slabs are configured against the master `vb_export_sku` and cascade automatically to `sku_master` and `orders`.
   - Unmerged Listings Trigger: Any marketplace listing in `orders.sku` lacking a mapping to a `vb_export_sku` automatically triggers an alert banner and appears in the Unmerged Listings review queue with a 1-click merge workflow.
   - Master Catalog Upload Template: Downloadable template format strictly has columns: `Marketplace SKU`, `VB EXPORT SKU's`, `VB Export Product Category`, `Weight Slab (kg)`, `COGS (₹)`, `Marketplace`.
   - UI Layout & Anti-Clutter Rule: Strictly maintain 6 clean top-level tabs on Profit Analysis (`Overview`, `By Category`, `By SKU`, `By Account`, `By Zone`, `COGS & Weight Slabs`). Do NOT create redundant top-level tabs; use in-tab toggles or sub-tabs instead.



