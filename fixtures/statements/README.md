# Simulated statements

Invented data for the demo: no real card, account, merchant or person. Card
numbers are printed masked, as many issuers export them.

What each file is for:

| File | Shows |
| --- | --- |
| `maple-2026-08.csv` … `-10.csv` | The main app (card-watch). The "Maple Card" export format is not the template's generic one, so the input agent has to write an adapter. |
| `STREAMLY*PREMIUM` / `STREAMLY.COM PREMIUM` / `STRMLY*PREM` | One merchant under three descriptors. Without normalisation the October price rise (15.99 → 17.99) is invisible: segment 2's three competing strategies. |
| `TUNEBOX MONTHLY` 9.99 → 11.99 | A plain price increase the first build finds. |
| `PIXELPRESS PLUS` (October) | A new subscription. |
| `maple-2026-11.csv`, `"ACME, INC. SOFTWARE"` | A quoted comma. Template v1.0's CSV reader splits on every comma, so this row breaks: segment 3's template fix and fan-out. |

Still to come from the video lead (by 10/6): the sibling apps' data —
a second card (`card2-watch`, clean merge), the phone bill with `;` delimiters
(`phone-watch`, whose customisation of `splitLine` must conflict with the
template fix), and the bank account as PDF (`bank-watch`, which declares
`npm test` as a merge gate and has a test the fix makes fail).
