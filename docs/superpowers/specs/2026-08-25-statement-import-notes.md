# Statement Import — findings, shelved

**Status:** SHELVED before design. Recorded so the format analysis is not
re-derived. Resumed work should start from the open question at the end.

These notes come from reading real DBS/POSB and OCBC statements. **The
statements themselves are not in this repository** — `samples/` and `*.pdf`
are gitignored, because they contain account numbers, a full card number, a
home address and complete transaction histories, and this repository is
public.

## Format comparison

| | DBS/POSB consolidated | OCBC 365 credit card |
|---|---|---|
| Date | `DD/MM/YYYY` | `DD/MM` — **no year** |
| Amount | Two columns: `Withdrawal (-)` / `Deposit (+)` | One column; **parentheses = credit** |
| Description | **Multi-line**, 2–4 lines per transaction | Single line + city + country code |
| Accounts per file | Several, each its own section with account no. | One |
| Currency | `CURRENCY: SINGAPORE DOLLAR` subheaders per account | Single |
| Also contains | Account summary, unit-trust holdings | Credit limit, minimum due, marketing text |

## Four parsing hazards

1. **DBS rows span multiple lines.** A single transaction looks like:

   ```
   12/07/2026   Advice Funds Transfer        148.22    3,207.70
                TOP-UP TO PAYLAH! :
                93805442
                VALUE DATE : 12/07/2026
   ```

   Splitting on newlines does not work. Rows must be grouped by vertical
   position, or by treating "everything until the next line beginning with a
   date" as one record.

2. **OCBC card dates carry no year.** `30/06` on an August statement is June
   of the statement year — but `28/12` on a January statement belongs to the
   *previous* year. Year must be inferred from the statement date, with the
   rollover handled explicitly.

3. **Non-transaction rows must be filtered.** `Balance Brought Forward`,
   `Balance Carried Forward`, `Total Balance Carried Forward in SGD:`,
   `LAST MONTH'S BALANCE`, `SUBTOTAL`, `TOTAL`, `TOTAL AMOUNT DUE`, plus
   marketing paragraphs and the cardholder/card-number line. Treating any of
   these as a transaction corrupts totals.

4. **Not every row is an expense**, which matters because budgets count
   expenses only:
   - PayLah top-ups (DBS) — a transfer between the person's own accounts
   - `PAYMENT BY INTERNET` in parentheses (OCBC card) — paying the card off,
     a transfer, not spending
   - `Interest Earned` (DBS) — income
   - `CASH REBATE` (OCBC card) — a credit, not spending
   - `Advice HDB Housing Loan` (DBS) — a genuine expense

   Importing these as expenses would silently corrupt budgets and the
   dashboard.

## Recommendation reached before shelving

**Split the approach rather than parsing PDFs for everything.**

- **Deposit accounts → CSV.** DBS digibank exports the last 6 months as CSV
  (Deposits → account → Download icon). A delimited file with a four-digit
  year and separate columns is far more reliable than reconstructing rows
  from PDF geometry. OCBC's retail banking exports CSV from
  *Details / Transactions* with columns `Transaction date, Value date,
  Description, Withdrawals (SGD), Deposits (SGD)`.
- **Credit cards → PDF**, because no CSV export exists for them. This is the
  only case where PDF parsing genuinely earns its fragility.

Note DBS's CSV window is **6 months**; older history is PDF eStatements only.
Anyone wanting a longer backfill should export before it ages out.

## Security constraints for whenever this is built

- The OCBC statement contains a **full 16-digit card number**; both contain
  account numbers and a home address. The parser must extract transactions
  and discard everything else. A card number must never be stored.
- Strongly prefer **parsing in the browser**, so the file never reaches a
  server. Nothing about this feature requires server-side parsing.
- Redacted fixtures belong in `tests/`, committed deliberately. Never move a
  real statement out of `samples/`.

## The open question that shelved this

Whether to build **cards-only PDF parsing with CSV for deposits**, or **PDF
for everything** so no CSV export is ever needed. Everything else follows
from that answer.

De-duplication was identified as the other hard part and was never designed:
bank exports carry no stable transaction id, so re-importing an overlapping
period needs a fingerprint (date + amount + normalised description) and a
review step for near-matches.
