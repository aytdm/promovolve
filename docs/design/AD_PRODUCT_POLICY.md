# Ad product category: identity, blocklists, and operator prohibition

Every campaign declares **what it advertises** as one IAB Ad Product
Taxonomy 2.0 category (`adProductCategory`, e.g. `1529` Travel). This is
a different axis from *content targeting* (IAB Content Taxonomy 3.0,
which decides **where** the campaign bids): the ad-product category
describes the product being sold, and it exists so that policy can act
on it. Three mechanisms hang off it, in increasing strength:

| Mechanism | Who decides | Effect | Where enforced |
|---|---|---|---|
| Publisher ad-product blocklist | each publisher, per site | campaign never serves on that site | serve-time candidate filter (`AdServer`) |
| Auto-approval / manual review | each publisher | creative waits in the approval queue | approval pipeline |
| **Operator prohibition** | platform operator, network-wide | campaign **cannot be registered at all** | campaign write endpoints (core API) |

## Operator prohibition

The operator's disallow list lives in the dashboard database
(`platform_settings` key `prohibited_ad_products`, a CSV of ids) and is
edited on `/admin/settings`. The core API node reads the same row
through its dashboard-DB handle (30-second cache) and rejects any
campaign write — create, edit, or the single-field category endpoint —
whose category resolves into the prohibited set, with error code
`prohibited_ad_product`.

Prohibition is **subtree-aware**: the check walks the category's
ancestor chain (`AdProductTaxonomy.selfAndAncestors`), so prohibiting
Tobacco (1544) covers Cigarettes, Vaping, and anything the taxonomy
later adds beneath it. Prohibit branches, not leaves.

Search pickers stop offering prohibited categories (the search-filtered
taxonomy endpoint drops them); the *no-query* full listing keeps them so
historical campaigns' names remain resolvable in reports.

Deliberate limits: prohibition gates **registration**, not serving —
campaigns that existed before a prohibition keep running (pausing them
is an operator decision, not a side effect). The list ships empty;
which categories are restricted or banned is a per-market call
(tobacco in JP is restricted-not-banned; the EU bans it outright).

## Why "no category" is not writable

The category is the handle every policy mechanism grips. A campaign
with an **empty** category would be invisible to the operator
prohibition *and* to every publisher's ad-product blocklist — a
complete policy bypass. Therefore, on every write path:

- `adProductCategory` is **required** and must exist in the taxonomy
  (`invalid_ad_product` otherwise);
- the single-field endpoint can backfill a legacy campaign's category
  but can never **clear** one.

Campaigns created before the field existed remain readable (the read
path tolerates their absence and logs a warning); the strictness lives
entirely on writes. The dashboard's category picker mirrors this: the
form will not submit until a suggestion is actually selected — typed
text alone never was a category.

## Compliance note

Prohibition is a *platform capability*, not legal advice. For
restricted-but-legal categories (e.g. tobacco advertising in Japan
under the Finance Ministry guideline and the industry voluntary code),
carrying the category compliantly needs more than this gate: publisher
opt-in rather than opt-out, unconditional manual creative review, and
mandated warning copy. Until such a restricted-category regime exists,
the safe operator posture for those categories is prohibition.
