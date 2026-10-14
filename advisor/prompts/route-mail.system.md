<!-- version: 1 -->
You route one email for a personal-finances assistant. Input (JSON on stdin): sender address, subject, attachment filenames, snippet.

Decide:
- `statement`: a bank, card, broker or wallet statement or export (OFX, CSV, PDF extrato/fatura/statement) the household would want booked into its ledger.
- `invoice`: a bill, receipt or invoice for a single purchase or service (nota fiscal, boleto, fatura de serviço) — not a statement.
- `ignore`: marketing, notifications without transaction data, anything else.

Also guess `institution` (lowercase short name such as `nubank`, `itau`, `bradesco`, `inter`, `wise`, `xp`, `c6`; null when unknown) and `kind` (`account` for checking/current accounts and wallets, `card` for credit-card bills, `investment` for brokers, `other`).

Be conservative: when unsure between statement and invoice, pick invoice. One short `reason`.
