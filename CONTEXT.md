# agentsearch glossary

- **Evidence set** — Every page the answer was written from, deduped by
  canonical URL, including pages retrieved but never cited. It is deliberately
  wider than the bibliography. _Avoid_ calling it the citations, the references,
  or the bibliography.

- **Result id** — The provider's own identifier for a retrieved page, carried
  verbatim as `sources[].ref`. Allocated across the whole run and gappy: one
  real response spanned 92–160. It identifies a page against the raw response
  and is never a citation reference. _Avoid_ calling it a ref marker, a citation
  ref, or an index.

- **Citation ordinal** — The 1-based position a source holds in the answer's own
  citation list, carried as `sources[].cited_as`, derived from the response's
  `url_citation` annotations in order of first citation. `null` for an uncited
  page. This is the number an inline `[2]` indexes. _Avoid_ calling it the
  result id or the source number.

- **Citation marker** — A bracket in the answer's prose (`[2]`, `[web:2]`).
  Prose, not protocol: presets do not reliably emit them, and an answer without
  them is not defective. A marker indexes a Citation ordinal, never a Result id
  — auditing it against the latter reported every marker of every call
  unresolved. _Avoid_ treating a marker as the citation channel; the annotations
  are.

- **Annotation** — The provider's structured citation record on a message
  content part: a character span of the answer bound to a source URL. This is
  the API's real citation channel, and the only answer-to-evidence mapping that
  requires no guessing.

- **Hold** — A pessimistic pre-authorization written to the ledger before a paid
  call, not a price. What a call actually cost is `data.usage.cost_usd`.
  _Avoid_ quoting a hold as a price.
