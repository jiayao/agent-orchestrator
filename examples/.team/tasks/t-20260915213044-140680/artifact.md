# Example artifact under review

## Proposal: ship a cached settings endpoint

We will add a `GET /settings` endpoint backed by a 60-second in-process
cache. The cache key is the user's session id. Settings rarely change, so
staleness is acceptable.

## Assumptions

- Settings writes are rare (no invalidation path needed).
- In-process cache is fine because we run a single replica.
- Session ids are stable across deploys.

## Failure modes

(none listed)
